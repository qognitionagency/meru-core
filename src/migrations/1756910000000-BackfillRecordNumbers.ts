import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR 0010 §2.5 — number every eligible row that predates the mechanism, then
 * seed the counters from the result.
 *
 * A window function in one pass, not a row-by-row loop through the application
 * counter: a loop would take and release the same counter row lock once per
 * record for no benefit, and would run for minutes rather than milliseconds.
 *
 * **Soft-deleted rows are numbered too** (`"deletedAt" IS NOT NULL` is NOT
 * excluded). A number that already appears on a historical invoice or document
 * does not stop being true because the record was later archived, and this
 * system does not delete history.
 *
 * **The concurrency cost, stated rather than engineered around.** This holds a
 * row lock on every touched `(tenantId, series)` counter for the duration of
 * the migration, so a genuinely concurrent `createEntity` for an affected
 * tenant BLOCKS — correct, but a real if brief availability cost. Accepted
 * because the only tenants on this system today are pilot/test tenants, so the
 * backfill set is small. **Trigger to revisit (ADR 0010 §2.5):** if this is
 * ever run against a live-traffic tenant set with a backlog large enough to
 * run for more than a few seconds, replace it with a per-tenant-locked,
 * batched version so unrelated tenants' writers are never blocked.
 *
 * Idempotent: `WHERE "recordNumber" IS NULL` means a second run numbers
 * nothing, and the counter seed takes `GREATEST(existing, computed)` so it can
 * never walk a live counter backwards into reissuing a number.
 */
export class BackfillRecordNumbers1756910000000 implements MigrationInterface {
  name = 'BackfillRecordNumbers1756910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ordered by ("createdAt", id) so the oldest client in a tenant is
    // CL-000001. `id` is the tiebreaker purely to make the result
    // deterministic — two rows created in the same millisecond must not be
    // numbered differently on a re-run against a restored dump.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id,
               "tenantId",
               CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END AS series,
               ROW_NUMBER() OVER (
                 PARTITION BY "tenantId", (CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END)
                 ORDER BY "createdAt", id
               ) AS rn
        FROM "universal_entities"
        WHERE "recordNumber" IS NULL
          AND type IN ('case', 'person', 'organization')
      )
      UPDATE "universal_entities" e
      SET "recordNumber" = ranked.series || '-' || LPAD(ranked.rn::text, 6, '0')
      FROM ranked
      WHERE e.id = ranked.id
    `);

    // Seed from what is now on the rows, not from the window above: if this
    // migration is re-run, or a number was assigned by the live code path
    // between the two statements, the counter must still land at or above the
    // highest issued value. GREATEST is what makes "never reused" hold across
    // that seam.
    await queryRunner.query(`
      INSERT INTO "tenant_record_counters" ("tenantId", "series", "value", "updatedAt")
      SELECT "tenantId",
             CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END AS series,
             COUNT(*),
             now()
      FROM "universal_entities"
      WHERE "recordNumber" IS NOT NULL
        AND type IN ('case', 'person', 'organization')
      GROUP BY "tenantId", CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END
      ON CONFLICT ("tenantId", "series")
      DO UPDATE SET "value" = GREATEST("tenant_record_counters"."value", excluded."value"),
                    "updatedAt" = now()
    `);
  }

  /**
   * Not meaningfully reversible on its own — it only writes into a column this
   * migration does not own. Rolling back `AddRecordNumbering` drops the column
   * and takes this with it; see ADR 0010 §6 and its caution about doing that
   * once a number has been shown to a customer.
   */
  public async down(): Promise<void> {
    // Intentionally empty.
  }
}
