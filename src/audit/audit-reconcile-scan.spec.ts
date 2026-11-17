import { DataSource, SelectQueryBuilder } from 'typeorm';
import { ALL_ENTITIES } from '../config/entities';
import { AuditLog } from './entities/audit-log.entity';
import { AuditReconcileStore } from './audit-reconcile.store';
import { APPLIED_EVENT_BY_FAMILY } from './audit-reconciler.service';

/**
 * Owen's gate, reproduced: every run restarted from the oldest `.requested`
 * row ever written and re-read every ANSWERED request on the way, so once the
 * answered history took longer than the 30 s budget to page through, an
 * orphan behind it was never reached (two runs, `examined: 4,
 * reconciled: 0` each).
 *
 * The candidate scan now excludes, in SQL, any request that already has an
 * outcome row for its own family in the same tenant under the same
 * `changeId`: `<family>.not_applied`, `<family>.reconciled`, or the family's
 * applied event. Those are exactly the three outcomes `isAnswered` checks,
 * so the filter can only drop rows the service would have skipped anyway;
 * the service's own check stays as the second gate.
 *
 * Asserted on the SQL TypeORM generates over real entity metadata, never
 * connected. `[UNVERIFIED: not executed against Postgres — no database.]`
 */
describe('AuditReconcileStore.pageStaleRequests — skips answered requests', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', entities: ALL_ENTITIES as any });
    await (ds as any).buildMetadatas();
  });

  async function captured() {
    const out: { sql?: string; params?: unknown[] } = {};
    const repo = {
      createQueryBuilder: (alias: string) => {
        const qb: SelectQueryBuilder<AuditLog> = ds
          .getRepository(AuditLog)
          .createQueryBuilder(alias);
        jest.spyOn(qb, 'getMany').mockImplementation(async () => {
          [out.sql, out.params] = qb.getQueryAndParameters();
          return [];
        });
        return qb;
      },
    };
    await new AuditReconcileStore(repo as any).pageStaleRequests(
      new Date('2026-11-17T00:00:00Z'),
      null,
      200,
      APPLIED_EVENT_BY_FAMILY,
    );
    return out as { sql: string; params: unknown[] };
  }

  it('correlates the exclusion on the same tenant and changeId, never another row of the request itself', async () => {
    const { sql } = await captured();
    const notExists = sql.slice(sql.indexOf('NOT EXISTS'));

    expect(sql).toContain('NOT EXISTS');
    expect(notExists).toMatch(/o\."tenantId" = "?a"?\."tenantId"/);
    expect(notExists).toMatch(/o\.context ->> 'changeId' = "?a"?\."?context"? ->> 'changeId'/);
    expect(notExists).toMatch(/o\.id <> "?a"?\.id/);
    expect(notExists).toContain(`'.not_applied'`);
    expect(notExists).toContain(`'.reconciled'`);
  });

  it('passes every family\'s applied event as a bound parameter', async () => {
    const { sql, params } = await captured();

    for (const [family, applied] of Object.entries(APPLIED_EVENT_BY_FAMILY)) {
      expect(params).toContain(`${family}.requested`);
      expect(params).toContain(applied);
    }
    // Event names never enter the SQL text.
    expect(sql).not.toContain('role.changed');
  });
});
