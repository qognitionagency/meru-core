import { JobProcessor } from './queue.processor';
import { TenantContext } from '../core/tenancy/tenant-context';
import { JobType } from './interfaces/job.interface';

/**
 * The long-running queue loop — the one that matters once the API is a single
 * long-lived process on Render rather than per-request Vercel functions.
 *
 *  · It starts only when INTERNAL_SCHEDULER=on, and never under VERCEL (an
 *    infinite loop there just burns each invocation to its timeout). Default
 *    off: /api/v1/jobs/tick is the single driver, and two drivers would run
 *    every job twice.
 *  · It used to call `getNextJob` and run handlers with NO tenant bound, so
 *    under FORCE RLS the claim matched nothing and `completeJob`/`failJob`
 *    wrote nothing. It now binds exactly as the bounded `drainQueue` does
 *    (ADR 0018 §2.3): claim under system context, process under the job's own
 *    tenant. `queue.processor.spec.ts` pins the same property for the drain.
 */
describe('JobProcessor — long-running loop', () => {
  const saved = {
    VERCEL: process.env.VERCEL,
    INTERNAL_SCHEDULER: process.env.INTERNAL_SCHEDULER,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function setEnv(env: { VERCEL?: string; INTERNAL_SCHEDULER?: string }) {
    delete process.env.VERCEL;
    delete process.env.INTERNAL_SCHEDULER;
    Object.assign(process.env, env);
  }

  function build(jobs: any[] = []) {
    let cursor = 0;
    const claimBypassObserved: boolean[] = [];
    const writeBinding: Array<{ tenantId?: string; bypassed: boolean }> = [];
    let processor!: JobProcessor;

    const queueService = {
      getNextJob: jest.fn(async () => {
        claimBypassObserved.push(TenantContext.isBypassed());
        const next = jobs[cursor++] ?? null;
        // Stop the loop once the queue is empty, as a shutdown would.
        if (!next) processor.onModuleDestroy();
        return next;
      }),
      completeJob: jest.fn(async () => {
        writeBinding.push({
          tenantId: TenantContext.getTenantId(),
          bypassed: TenantContext.isBypassed(),
        });
      }),
      failJob: jest.fn(async () => {
        writeBinding.push({
          tenantId: TenantContext.getTenantId(),
          bypassed: TenantContext.isBypassed(),
        });
      }),
    };
    processor = new JobProcessor(
      queueService as any,
      { emit: () => undefined } as any,
    );
    jest.spyOn(processor as any, 'sleep').mockResolvedValue(undefined);
    return { processor, queueService, claimBypassObserved, writeBinding };
  }

  const job = (id: string, tenantId: string) => ({
    id,
    tenantId,
    type: JobType.EMAIL_SEND,
    options: {},
    attempts: 0,
    maxAttempts: 3,
  });

  describe('whether the loop starts', () => {
    it('does not start when INTERNAL_SCHEDULER is unset (default off)', async () => {
      setEnv({});
      const { processor } = build();
      const loop = jest
        .spyOn(processor as any, 'startProcessorLoop')
        .mockResolvedValue(undefined);
      await processor.onModuleInit();
      expect(loop).not.toHaveBeenCalled();
    });

    it('does not start when INTERNAL_SCHEDULER=off', async () => {
      setEnv({ INTERNAL_SCHEDULER: 'off' });
      const { processor } = build();
      const loop = jest
        .spyOn(processor as any, 'startProcessorLoop')
        .mockResolvedValue(undefined);
      await processor.onModuleInit();
      expect(loop).not.toHaveBeenCalled();
    });

    it('never starts under VERCEL, even with INTERNAL_SCHEDULER=on', async () => {
      setEnv({ VERCEL: '1', INTERNAL_SCHEDULER: 'on' });
      const { processor } = build();
      const loop = jest
        .spyOn(processor as any, 'startProcessorLoop')
        .mockResolvedValue(undefined);
      await processor.onModuleInit();
      expect(loop).not.toHaveBeenCalled();
    });

    it('starts when INTERNAL_SCHEDULER=on outside VERCEL', async () => {
      setEnv({ INTERNAL_SCHEDULER: 'on' });
      const { processor } = build();
      const loop = jest
        .spyOn(processor as any, 'startProcessorLoop')
        .mockResolvedValue(undefined);
      await processor.onModuleInit();
      expect(loop).toHaveBeenCalledTimes(1);
      processor.onModuleDestroy();
    });
  });

  it("claims under system context and binds each job's writes to its own tenant", async () => {
    const { processor, claimBypassObserved, writeBinding } = build([
      job('j1', 't1'),
      job('j2', 't2'),
    ]);

    (processor as any).running = true;
    await (processor as any).startProcessorLoop();

    expect(claimBypassObserved).toEqual([true, true, true]);
    expect(writeBinding).toEqual([
      { tenantId: 't1', bypassed: false },
      { tenantId: 't2', bypassed: false },
    ]);
  }, 10_000);
});
