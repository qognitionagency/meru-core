import { JobProcessor } from './queue.processor';
import { TenantContext } from '../core/tenancy/tenant-context';
import { JobType } from './interfaces/job.interface';

/**
 * ADR 0018 §2.3 — `queue-drain` is a documented exception to
 * `runTenantBoundSweep`: the claim (`getNextJob`) is inherently cross-tenant
 * by priority ordering, so it cannot enumerate tenant-first. This suite pins
 * the two-phase binding by hand: the claim runs under system bypass, and
 * everything after a job is claimed — `completeJob`/`failJob`'s writes —
 * runs bound to *that job's own tenant*, not the bypass. This is exactly the
 * failure mode ADR §1.5 describes: binding only the claim and leaving the
 * write phase unbound means `completeJob`/`failJob` silently filter to zero
 * rows under RLS, and a unit test constructing `JobProcessor` with mocked
 * repos (the usual approach in this repo) cannot see that without asserting
 * on the bound tenant directly, which is what this does.
 */
describe('JobProcessor.drainQueue', () => {
  function buildProcessor(jobs: any[]) {
    let cursor = 0;
    const claimBypassObserved: boolean[] = [];
    const writeBinding: Array<{ tenantId?: string; bypassed: boolean }> = [];

    const queueService = {
      getNextJob: async () => {
        claimBypassObserved.push(TenantContext.isBypassed());
        return jobs[cursor++] ?? null;
      },
      completeJob: async () => {
        writeBinding.push({
          tenantId: TenantContext.getTenantId(),
          bypassed: TenantContext.isBypassed(),
        });
      },
      failJob: async () => {
        writeBinding.push({
          tenantId: TenantContext.getTenantId(),
          bypassed: TenantContext.isBypassed(),
        });
      },
    };

    // No listener registered for any `queue.job.*` event — the processor's
    // own 100ms "no handler registered" fallback resolves each job, which is
    // the exact path that exercises `completeJob`.
    const eventEmitter = { emit: () => undefined };

    const processor = new JobProcessor(
      queueService as any,
      eventEmitter as any,
    );

    return { processor, claimBypassObserved, writeBinding };
  }

  const job = (id: string, tenantId: string) => ({
    id,
    tenantId,
    type: JobType.EMAIL_SEND,
    options: {},
    attempts: 0,
    maxAttempts: 3,
  });

  it("claims the next job under system bypass, then binds that job's completeJob write to its own tenant — not the bypass", async () => {
    const { processor, claimBypassObserved, writeBinding } = buildProcessor([
      job('j1', 't1'),
    ]);

    const result = await processor.drainQueue(5, 5_000);

    expect(result.drained).toBe(1);
    expect(claimBypassObserved).toEqual([true, true]); // claim, then the final null claim
    expect(writeBinding).toEqual([{ tenantId: 't1', bypassed: false }]);
  }, 10_000);

  it('drains jobs from different tenants in one pass, each write bound to its own claimant — never to another tenant or an open bypass', async () => {
    const { processor, writeBinding } = buildProcessor([
      job('j1', 't1'),
      job('j2', 't2'),
    ]);

    await processor.drainQueue(5, 5_000);

    expect(writeBinding).toEqual([
      { tenantId: 't1', bypassed: false },
      { tenantId: 't2', bypassed: false },
    ]);
  }, 10_000);

  it('reports eligible: null — a priority claim has no tenant denominator, so the suspect check never fires for this job', async () => {
    const { processor } = buildProcessor([]);

    const result = await processor.drainQueue(5, 1_000);

    expect(result.drained).toBe(0);
    expect(result.scope).toEqual({ eligible: null, scanned: 0 });
  });
});
