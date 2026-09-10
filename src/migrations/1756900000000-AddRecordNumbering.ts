import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR 0010 §2.2 / §2.1 — the client and case numbering mechanism.
 *
 * Two additive changes:
 *
 * 1. `tenant_record_counters` — one row per `(tenantId, series)`, advanced by
 *    a single `INSERT … ON CONFLICT … DO UPDATE … RETURNING` so two concurrent
 *    Vercel invocations (each with its own pool of `max: 1`) cannot mint the
 *    same number. The UNIQUE constraint is not decoration: it is what gives
 *    `ON CONFLICT` a row to lock.
 * 2. `universal_entities."recordNumber"` — nullable, plus a PARTIAL unique
 *    index per tenant. Partial because every non-eligible type leaves it null
 *    and a plain unique index would admit exactly one null-numbered row per
 *    tenant.
 *
 * Standard tenant_isolation RLS, ENABLE + FORCE at creation — same shape as
 * `1756700000000-AddTenantFeeOverrides.ts` and `1754700000000-AddTenantConnectors.ts`,
 * the two direct precedents for a small per-tenant table. `universal_entities`
 * already carries RLS; a new column on it needs nothing further.
 *
 * The backfill of existing rows is deliberately a SEPARATE migration
 * (`1756910000000-BackfillRecordNumbers`) so the schema change can stand
 * without it, per ADR 0010 §6's rollback table.
 */
export class AddRecordNumbering1756900000000 implements MigrationInterface {
  name = 'AddRecordNumbering1756900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_record_counters" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "series" character varying(8) NOT NULL,
        "value" bigint NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_tenant_record_counters_tenant_series" UNIQUE ("tenantId", "series"),
        CONSTRAINT "CHK_tenant_record_counters_value_non_negative" CHECK ("value" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_tenant_record_counters_tenant" ON "tenant_record_counters" ("tenantId")`,
    );

    await queryRunner.query(
      `ALTER TABLE "tenant_record_counters" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_record_counters" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "tenant_record_counters"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "tenant_record_counters" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);

    await queryRunner.query(
      `ALTER TABLE "universal_entities" ADD COLUMN IF NOT EXISTS "recordNumber" character varying(32)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_universal_entities_tenant_record_number"
         ON "universal_entities" ("tenantId", "recordNumber")
         WHERE "recordNumber" IS NOT NULL`,
    );
  }

  /**
   * `down` drops both. ADR 0010 §6 carries the standing caution: once a number
   * has appeared on a real invoice or document, drop the CODE PATH that
   * assigns new numbers, not the column — the column holds issued identities
   * that nothing else can reconstruct.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_universal_entities_tenant_record_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "universal_entities" DROP COLUMN IF EXISTS "recordNumber"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_record_counters"`);
  }
}
