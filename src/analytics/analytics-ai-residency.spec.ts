import { AnalyticsService } from './analytics.service';

/**
 * `generateAIInsights` (private — called from `executeReport`, reached both
 * by `AnalyticsController.executeReport` on a normal authenticated request
 * and by `processScheduledReports` → `exportReport` → `executeReport`, the
 * ADR 0018 per-item `TenantContext.run`-bound scheduled path) used to set
 * `context: { tenantId: report.tenantId }` only. `AiService.execute` reads
 * the TOP-LEVEL `tenantId` field for `clientFor` routing, so this call
 * always used the platform key regardless of the tenant's own connector.
 * Invoked via bracket notation because it is private and the surrounding
 * `executeQuery` path needs a real `DataSource` query runner — this test's
 * job is the one line that changed, not the whole report-execution pipeline.
 */
describe('AnalyticsService — AI residency (tenantId passed top-level)', () => {
  it('generateAIInsights passes tenantId to execute() top-level, not just via context', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ summary: 'ok' }) });
    const aiService = { execute };

    const service = new AnalyticsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      aiService as any,
      {} as any,
    );

    const report = { tenantId: 'tenant-1', name: 'Weekly report', dataSource: 'crm' };
    await (service as any).generateAIInsights(report, [{ id: 1 }]);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
    );
  });
});
