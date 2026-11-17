import { JobDispatchService } from './job-dispatch.service';

/**
 * Owen's gate: `audit-reconcile` was recorded `ok` whatever its summary said.
 * A run that stopped at its time budget (`complete: false`) or failed to
 * write some reconciled rows (`failures`) left requests unanswered and still
 * read as healthy on `/jobs/status`. It is now recorded `suspect`, with the
 * reason, the same status the scope check uses for a sweep that cannot be
 * trusted.
 */
describe('audit-reconcile job status', () => {
  function run(summary: Record<string, unknown>) {
    const record = jest.fn().mockResolvedValue(undefined);
    const args: any[] = new Array(17).fill(undefined);
    args[11] = { record }; // jobRunService
    args[16] = { reconcile: jest.fn().mockResolvedValue(summary) }; // auditReconciler
    const service = new (JobDispatchService as any)(...args) as JobDispatchService;
    return service.runNamed('audit-reconcile').then(() => record.mock.calls[0][1]);
  }
  const base = { examined: 4, reconciled: [], scope: { eligible: null, scanned: 4 } };

  it('is suspect when the run stopped before the end', async () => {
    const recorded = await run({ ...base, complete: false, failures: [] });
    expect(recorded.status).toBe('suspect');
    expect(recorded.error).toMatch(/incomplete/i);
  });

  it('is suspect when any reconciled row failed to write', async () => {
    const recorded = await run({
      ...base,
      complete: true,
      failures: [{ tenantId: 't', changeId: 'c', error: 'x' }],
    });
    expect(recorded.status).toBe('suspect');
    expect(recorded.error).toMatch(/1 failure/);
  });

  it('is ok when complete with no failures', async () => {
    const recorded = await run({ ...base, complete: true, failures: [] });
    expect(recorded.status).toBe('ok');
  });
});
