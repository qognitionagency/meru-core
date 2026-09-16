import { TenantContext } from './tenant-context';
import { runTenantBoundSweep } from './tenant-bound-sweep';

/**
 * ADR 0018 §2.2. Four properties the whole design depends on:
 *
 * (a) enumeration runs bypassed (system context), because it legitimately has
 *     to see every tenant's rows to find the work at all;
 * (b) each item is then processed under a *genuine*, non-bypassed binding to
 *     its own tenant — the property that makes RLS the enforcement boundary
 *     for the write phase, not just the read;
 * (c) one item throwing does not abort the rest of the sweep;
 * (d) `eligible`/`scanned` count distinct tenants, not items — a tenant with
 *     two due items must not look "twice as eligible" as one with one.
 */
describe('runTenantBoundSweep', () => {
  interface Item {
    id: string;
    tenantId: string;
  }

  it('runs enumerate under system bypass', async () => {
    let observedBypass: string | undefined;

    await runTenantBoundSweep<Item>(
      'test sweep',
      async () => {
        observedBypass = TenantContext.getBypass()?.kind;
        return [];
      },
      async () => {},
    );

    expect(observedBypass).toBe('system');
  });

  it('binds each item to its own tenant, with the bypass dropped, for the full duration of fn', async () => {
    const items: Item[] = [
      { id: 'i1', tenantId: 't1' },
      { id: 'i2', tenantId: 't2' },
    ];
    const seen: Array<{ tenantId: string | undefined; bypassed: boolean }> = [];

    await runTenantBoundSweep<Item>(
      'test sweep',
      async () => items,
      async (item) => {
        seen.push({
          tenantId: TenantContext.getTenantId(),
          bypassed: TenantContext.isBypassed(),
        });
        expect(TenantContext.getTenantId()).toBe(item.tenantId);
      },
    );

    expect(seen).toEqual([
      { tenantId: 't1', bypassed: false },
      { tenantId: 't2', bypassed: false },
    ]);
  });

  it('drops an inherited bypass (e.g. an operator-triggered runAsGod) once per-item binding starts', async () => {
    const items: Item[] = [{ id: 'i1', tenantId: 't1' }];
    let bypassedDuringItem = true;

    await TenantContext.runAsGod('operator-1', 'manual run', async () => {
      await runTenantBoundSweep<Item>(
        'test sweep',
        async () => items,
        async () => {
          bypassedDuringItem = TenantContext.isBypassed();
        },
      );
    });

    expect(bypassedDuringItem).toBe(false);
  });

  it('one item throwing does not stop the loop, and is recorded in failures with its tenantId', async () => {
    const items: Item[] = [
      { id: 'i1', tenantId: 't1' },
      { id: 'i2', tenantId: 't2' },
      { id: 'i3', tenantId: 't3' },
    ];
    const processedIds: string[] = [];

    const scope = await runTenantBoundSweep<Item>(
      'test sweep',
      async () => items,
      async (item) => {
        if (item.id === 'i2') {
          throw new Error('sensitive detail: patient name Jane Doe');
        }
        processedIds.push(item.id);
      },
    );

    expect(processedIds).toEqual(['i1', 'i3']);
    expect(scope.itemsProcessed).toBe(2);
    expect(scope.failures).toHaveLength(1);
    expect(scope.failures[0].tenantId).toBe('t2');
    expect(scope.failures[0].itemId).toBe('i2');
    // Never the raw interpolated message — only the error's class/code.
    expect(scope.failures[0].message).not.toContain('Jane Doe');
    expect(scope.failures[0].message).toContain('Error');
  });

  it('caps a failure message to 300 characters', async () => {
    const longMessage = 'x'.repeat(1000);

    const scope = await runTenantBoundSweep<Item>(
      'test sweep',
      async () => [{ id: 'i1', tenantId: 't1' }],
      async () => {
        const err = new Error(longMessage);
        (err as any).code = 'y'.repeat(1000);
        throw err;
      },
    );

    expect(scope.failures[0].message.length).toBeLessThanOrEqual(300);
  });

  it('eligible/scanned are distinct-tenant counts, not item counts', async () => {
    const items: Item[] = [
      { id: 'i1', tenantId: 't1' },
      { id: 'i2', tenantId: 't1' },
      { id: 'i3', tenantId: 't2' },
    ];

    const scope = await runTenantBoundSweep<Item>(
      'test sweep',
      async () => items,
      async () => {},
    );

    expect(scope.itemsFound).toBe(3);
    expect(scope.itemsProcessed).toBe(3);
    expect(scope.eligible).toBe(2);
    expect(scope.scanned).toBe(2);
  });

  it('eligible > 0 but scanned === 0 is the RLS-blocked signature, distinguishable from a genuinely empty result', async () => {
    const emptyResult = await runTenantBoundSweep<Item>(
      'test sweep',
      async () => [],
      async () => {},
    );
    expect(emptyResult.eligible).toBe(0);
    expect(emptyResult.scanned).toBe(0);

    const blockedResult = await runTenantBoundSweep<Item>(
      'test sweep',
      async () => [{ id: 'i1', tenantId: 't1' }],
      async () => {
        throw new Error('blocked');
      },
    );
    expect(blockedResult.eligible).toBe(1);
    expect(blockedResult.scanned).toBe(0);
  });
});
