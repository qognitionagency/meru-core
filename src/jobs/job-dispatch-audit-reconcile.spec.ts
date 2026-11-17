import { JobDispatchService } from './job-dispatch.service';
import { TICK_SCOPES } from './job-catalogue';

/**
 * ADR 0023 D15 item 2: the audit reconciler runs on the daily tick, as
 * `audit-reconcile`, through the one dispatch table both front doors use.
 */
describe('audit-reconcile job registration', () => {
  it('is in the daily tick scope and not the fast one', () => {
    expect(TICK_SCOPES.daily).toContain('audit-reconcile');
    expect(TICK_SCOPES.fast).not.toContain('audit-reconcile');
  });

  it('dispatches to AuditReconcilerService.reconcile and records the outcome', async () => {
    const reconcile = jest.fn().mockResolvedValue({
      examined: 2,
      reconciled: [],
      failures: [],
      complete: true,
      scope: { eligible: null, scanned: 2 },
    });
    const record = jest.fn().mockResolvedValue(undefined);
    const args: any[] = new Array(17).fill(undefined);
    args[11] = { record }; // jobRunService
    args[16] = { reconcile }; // auditReconciler
    const service = new (JobDispatchService as any)(...args) as JobDispatchService;

    const result = await service.runNamed('audit-reconcile');

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
    expect(result.scope).toEqual({ eligible: null, scanned: 2 });
    expect(record).toHaveBeenCalledWith(
      'audit-reconcile',
      expect.objectContaining({ status: 'ok' }),
    );
  });
});
