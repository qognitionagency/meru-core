import { QueueService } from './queue.service';
import { TenantContext } from '../core/tenancy/tenant-context';
import { JobType } from './interfaces/job.interface';

/**
 * ADR 0018, Anton's secops review point 1 — `processScheduledJobs` is the
 * ninth job with the same defect the ADR's other eight close: dispatched
 * from `job-dispatch.service.ts`'s `'scheduled-jobs'` case
 * (`JOB_CADENCE_MINUTES['scheduled-jobs']`), it ran outside any tenant
 * context, so the RLS-bound connection matched zero rows on every tenant's
 * `queue_scheduled_jobs` and no recurring cron-style job was ever created.
 * This suite pins the `runTenantBoundSweep` rewrite: enumeration runs under
 * system bypass, and `createJob` + the following `scheduledRepo.save` are
 * bound to the scheduled job's own tenant, not the bypass.
 */
describe('QueueService.processScheduledJobs', () => {
  function buildService(scheduled: any[]) {
    const savedScheduled: Array<{
      tenantId?: string;
      bypassed: boolean;
      jobId: string;
    }> = [];
    const createJobBinding: Array<{ tenantId?: string; bypassed: boolean }> =
      [];

    const jobRepo = {
      create: (data: any) => data,
      save: async (job: any) => {
        createJobBinding.push({
          tenantId: TenantContext.getTenantId(),
          bypassed: TenantContext.isBypassed(),
        });
        return job;
      },
    };
    const logRepo = { create: (d: any) => d, save: async () => undefined };
    const scheduledRepo = {
      find: async () => {
        expect(TenantContext.isBypassed()).toBe(true);
        return scheduled;
      },
      save: async (job: any) => {
        savedScheduled.push({
          tenantId: TenantContext.getTenantId(),
          bypassed: TenantContext.isBypassed(),
          jobId: job.id,
        });
        return job;
      },
    };
    const workerRepo = {};
    const dataSource = {};
    const eventEmitter = { emit: () => undefined };

    const service = new QueueService(
      jobRepo as any,
      logRepo as any,
      scheduledRepo as any,
      workerRepo as any,
      dataSource as any,
      eventEmitter as any,
    );

    return { service, savedScheduled, createJobBinding };
  }

  const scheduledJob = (id: string, tenantId: string) => ({
    id,
    tenantId,
    type: JobType.EMAIL_SEND,
    data: {},
    cronExpression: '* * * * *',
    nextRun: new Date(Date.now() - 1000),
    lastRun: null,
    runCount: 0,
    maxRuns: null,
    endDate: null,
    isActive: true,
  });

  it("binds createJob + scheduledRepo.save to the scheduled job's own tenant, for every due job across tenants", async () => {
    const { service, savedScheduled, createJobBinding } = buildService([
      scheduledJob('s1', 't1'),
      scheduledJob('s2', 't2'),
    ]);

    const result = await service.processScheduledJobs();

    expect(result.scheduled).toBe(2);
    expect(createJobBinding).toEqual([
      { tenantId: 't1', bypassed: false },
      { tenantId: 't2', bypassed: false },
    ]);
    expect(
      savedScheduled.map((s) => ({ tenantId: s.tenantId, bypassed: s.bypassed })),
    ).toEqual([
      { tenantId: 't1', bypassed: false },
      { tenantId: 't2', bypassed: false },
    ]);
    expect(result.scope).toEqual({ eligible: 2, scanned: 2, failures: [] });
  });

  it('enumerates due scheduled jobs under system bypass — asserted inside scheduledRepo.find itself', async () => {
    const { service } = buildService([]);

    const result = await service.processScheduledJobs();

    expect(result.scheduled).toBe(0);
    expect(result.scope).toEqual({ eligible: 0, scanned: 0, failures: [] });
  });

  it('one tenant failing partway through does not stop the others, and is recorded in scope.failures', async () => {
    const jobs = [scheduledJob('s1', 't1'), scheduledJob('s2', 't2')];
    const { service, savedScheduled, createJobBinding } = buildService(jobs);

    // Make the first tenant's item throw AFTER createJob has already run:
    // CronExpressionParser.parse(scheduled.cronExpression) throws, which is
    // after the createJob binding for t1 but before its scheduledRepo.save —
    // exactly the "partial per-item work" case runTenantBoundSweep's
    // try/catch has to isolate without corrupting t2's processing.
    jobs[0].cronExpression = 'not-a-cron-expression';

    const result = await service.processScheduledJobs();

    // createJob ran for both tenants (it precedes the poisoned parse); only
    // t2 reached the final save.
    expect(createJobBinding).toEqual([
      { tenantId: 't1', bypassed: false },
      { tenantId: 't2', bypassed: false },
    ]);
    expect(savedScheduled.map((s) => s.tenantId)).toEqual(['t2']);

    expect(result.scope.eligible).toBe(2);
    expect(result.scope.scanned).toBe(1);
    expect(result.scope.failures).toHaveLength(1);
    expect(result.scope.failures![0].tenantId).toBe('t1');
  });
});
