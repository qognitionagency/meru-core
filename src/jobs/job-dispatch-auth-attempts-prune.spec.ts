import { JobDispatchService } from './job-dispatch.service';
import { JOB_CADENCE_MINUTES, TICK_SCOPES } from './job-catalogue';

/**
 * Retention for `auth_attempts` (Anton, second gate): a daily job, run by
 * `/jobs/tick?scope=daily` through the one dispatch table both front doors
 * use. 30 days is a proposal — see `AUTH_ATTEMPT_RETENTION_DAYS`.
 */
describe('auth-attempts-prune job registration', () => {
  it('is a daily job, in the daily tick scope and not the fast one', () => {
    expect(JOB_CADENCE_MINUTES['auth-attempts-prune']).toBe(1440);
    expect(TICK_SCOPES.daily).toContain('auth-attempts-prune');
    expect(TICK_SCOPES.fast).not.toContain('auth-attempts-prune');
  });

  it('dispatches to AuthAttemptLimiter.prune and records the outcome', async () => {
    const prune = jest.fn().mockResolvedValue({
      cutoff: '2026-10-18T00:00:00.000Z',
      deleted: 3,
      batches: 1,
      complete: true,
      scope: { eligible: null, scanned: 3 },
    });
    const record = jest.fn().mockResolvedValue(undefined);
    const args: any[] = new Array(18).fill(undefined);
    args[11] = { record }; // jobRunService
    args[17] = { prune }; // authAttempts
    const service = new (JobDispatchService as any)(...args) as JobDispatchService;

    const result = await service.runNamed('auth-attempts-prune');

    expect(prune).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
    expect(result.summary).toMatchObject({ deleted: 3, complete: true });
    expect(record).toHaveBeenCalledWith(
      'auth-attempts-prune',
      expect.objectContaining({ status: 'ok' }),
    );
  });
});
