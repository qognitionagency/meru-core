import { RegulatoryRadarEngine } from './regulatory-radar.engine';

/**
 * ADR 0018 §9.15. `scheduledScan()` — what `JobDispatchService`'s
 * `'regulatory-radar'` handler calls directly — used to discard
 * `runScan()`'s result and return `void`. `JobDispatchService.run()` reads
 * whatever a handler returns as the job's `summary`, so a scan that hit every
 * source and errored on all of them still reported a well-formed 200 with
 * nothing inside it at `GET /jobs/status` — the exact "sweep that legitimately
 * found nothing and one that told you nothing look identical" failure this
 * ADR's own §1 names.
 *
 * `runScan()` itself is not exercised here — it makes real HTTP requests to
 * public regulator pages, which is not something a unit test should do. The
 * one thing worth pinning is the forwarding: `scheduledScan()`'s return value
 * IS `runScan()`'s result, and radar-disabled still short-circuits to
 * `undefined` without calling it.
 */
describe('RegulatoryRadarEngine.scheduledScan', () => {
  function build(enabled: boolean) {
    const configService = {
      get: jest.fn((key: string) =>
        key === 'REGULATORY_RADAR_ENABLED' ? String(enabled) : undefined,
      ),
    };
    const eventEmitter = { emit: jest.fn() };
    const engine = new RegulatoryRadarEngine(
      configService as never,
      eventEmitter as never,
    );
    return { engine };
  }

  it('returns runScan()\'s result — not void — when the radar is enabled', async () => {
    const { engine } = build(true);
    const fakeResult = {
      scannedAt: new Date('2026-09-17T01:00:00Z'),
      sourcesScanned: 12,
      changesDetected: 1,
      errors: 3,
      changes: [],
    };
    const runScan = jest.spyOn(engine, 'runScan').mockResolvedValue(fakeResult);

    const result = await engine.scheduledScan();

    expect(runScan).toHaveBeenCalledWith();
    expect(result).toBe(fakeResult);
    // The evidence this fix exists for: errors are now visible to whoever
    // reads the job summary, not silently dropped on the floor.
    expect(result?.errors).toBe(3);
  });

  it('never calls runScan, and returns undefined, when the radar is disabled', async () => {
    const { engine } = build(false);
    const runScan = jest.spyOn(engine, 'runScan');

    const result = await engine.scheduledScan();

    expect(runScan).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
