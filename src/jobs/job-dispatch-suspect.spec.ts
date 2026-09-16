import { JobDispatchService } from './job-dispatch.service';

/**
 * ADR 0018 §3.2 — the actual ambiguity fix. `JobDispatchService.runNamed`
 * must tell "genuinely found nothing" apart from "blocked by an unbound
 * TenantContext", both of which a naive read of `lastStatus` would otherwise
 * report identically as 'ok'.
 */
describe('JobDispatchService.runNamed — suspect status (ADR 0018 §3.2)', () => {
  const record = jest.fn().mockResolvedValue(undefined);

  const make = (checkSLAViolations: jest.Mock) =>
    new JobDispatchService(
      { checkSLAViolations } as any, // slaWatchdogService
      undefined as any, // alertRuleService
      undefined as any, // sequenceRunner
      undefined as any, // billingService
      undefined as any, // queueService
      undefined as any, // jobProcessor
      undefined as any, // taskService
      undefined as any, // notificationsService
      undefined as any, // analyticsService
      undefined as any, // retentionService
      undefined as any, // regulatoryRadar
      { record } as any, // jobRunService
      undefined as any, // rescreeningService
      undefined as any, // notificationDispatch
      undefined as any, // watchlistIngest
      undefined as any, // screeningEngine
    );

  beforeEach(() => {
    record.mockClear();
  });

  it('records "suspect" when a handler reports eligible tenants but scanned none', async () => {
    const checkSLAViolations = jest
      .fn()
      .mockResolvedValue({ scope: { eligible: 3, scanned: 0, failures: [] } });

    await make(checkSLAViolations).runNamed('sla-watchdog');

    expect(record).toHaveBeenCalledWith(
      'sla-watchdog',
      expect.objectContaining({ status: 'suspect' }),
    );
  });

  it('records "ok" when a handler reports it scanned every eligible tenant', async () => {
    const checkSLAViolations = jest
      .fn()
      .mockResolvedValue({ scope: { eligible: 3, scanned: 3, failures: [] } });

    await make(checkSLAViolations).runNamed('sla-watchdog');

    expect(record).toHaveBeenCalledWith(
      'sla-watchdog',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('a genuinely empty result (eligible: 0, scanned: 0) is "ok", not "suspect"', async () => {
    const checkSLAViolations = jest
      .fn()
      .mockResolvedValue({ scope: { eligible: 0, scanned: 0, failures: [] } });

    await make(checkSLAViolations).runNamed('sla-watchdog');

    expect(record).toHaveBeenCalledWith(
      'sla-watchdog',
      expect.objectContaining({ status: 'ok' }),
    );
  });

  it('a handler with no scope to report (e.g. regulatory-radar) records "ok" and never evaluates the suspect check', async () => {
    const checkSLAViolations = jest.fn().mockResolvedValue({ checked: 0 });

    await make(checkSLAViolations).runNamed('sla-watchdog');

    expect(record).toHaveBeenCalledWith(
      'sla-watchdog',
      expect.objectContaining({ status: 'ok', scope: undefined }),
    );
  });
});
