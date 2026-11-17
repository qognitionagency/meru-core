import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `auth_attempts` — sign-in attempt counting outside the audit hash chain.
 *
 * Owen's gate (2026-11-17) on the first attempt limiter: it stored every
 * failed login in `audit_logs`, so each unauthenticated failure took the
 * tenant's chain lock and a burst could hold pool connections on that lock
 * and make strict audited writes in the tenant answer 503. Counting here
 * instead is one plain insert per failure that waits on nobody. See
 * `AuthAttempt` and `AuthAttemptLimiter`.
 *
 * Additive: one new table, nothing existing altered, so no current query,
 * grant or policy changes and neither vertical is affected.
 *
 * **RLS is the standard `tenant_isolation` predicate**, matching
 * `1757000000000-AddLeadIntake`. The limiter reads and writes on a
 * connection bound to the account's own tenant (resolved server-side from the
 * user row), so every statement is policed by the same policy as any other
 * tenant write. Also listed in `MigrateService`'s replay list; the dynamic
 * `tenantId` loop would cover it too, and listing it costs nothing because
 * this migration is idempotent.
 *
 * **Apply before deploying the code that reads it.** Until it is applied the
 * limiter's boot self-test fails, and under NODE_ENV=production the app
 * refuses to start (`AuthAttemptLimiter.onModuleInit`); anywhere else it logs
 * and degrades to a per-process count.
 *
 * **The grant is explicit** (Owen's gate, 2026-11-17), as in 1753900000000,
 * 1754100000000, 1754200000000 and 1756800000000. The default privileges set
 * by 1753500000000 apply only to tables created by the role that set them;
 * run by any other owner, `meru_app` got no privilege on this table, the
 * self-test failed with "permission denied for table auth_attempts", and
 * production refused to boot — measured against a real Postgres.
 * 1753500000000 creates `meru_app`, so the grant needs no existence guard.
 */
export class AddAuthAttempts1757500000000 implements MigrationInterface {
  name = 'AddAuthAttempts1757500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_attempts" (
        "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"  uuid NOT NULL,
        "userId"    uuid NOT NULL,
        "kind"      character varying(16) NOT NULL,
        "outcome"   character varying(24) NOT NULL,
        "source"    character varying(64) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_auth_attempts_kind" CHECK ("kind" IN ('login', 'mfa')),
        CONSTRAINT "CHK_auth_attempts_outcome" CHECK ("outcome" IN ('failed', 'refused_locked'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_auth_attempts_tenant_user_kind_created" ON "auth_attempts" ("tenantId", "userId", "kind", "createdAt")`,
    );

    await queryRunner.query(`ALTER TABLE "auth_attempts" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "auth_attempts" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`DROP POLICY IF EXISTS tenant_isolation ON "auth_attempts"`);
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "auth_attempts" FOR ALL TO public
        USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
        WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
    `);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_attempts" TO meru_app`,
    );
  }

  /**
   * Reversible with no loss of pre-existing data: the table is new. The
   * reverse destroys only attempt history recorded after the forward ran,
   * which means every source's count restarts from zero — the same effect as
   * the window elapsing. Roll the code back first: the limiter left running
   * against a dropped table degrades to per-process counting, logged.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_attempts"`);
  }
}
