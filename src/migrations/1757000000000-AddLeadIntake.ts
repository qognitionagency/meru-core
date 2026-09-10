import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-3.3 — website lead capture: a documented public endpoint with a
 * per-tenant key and spam protection.
 *
 * Two additive tables. Nothing existing is altered, so every current query,
 * grant and policy keeps working exactly as it did — this cannot affect
 * GovernanceX, which simply never mints a key (CLAUDE.md §5.5b).
 *
 * 1. `lead_intake_keys` — the capture credential. Only the SHA-256 digest of
 *    the token is stored, and the digest is uniquely indexed because the
 *    public route's whole authentication is "find the row with this digest".
 *    Two rows sharing one would make that ambiguous.
 * 2. `lead_intake_submissions` — every submission, including the ones that
 *    were refused. A held enquiry that leaves no trace is indistinguishable
 *    from one that was never sent.
 *
 * **RLS is the standard `tenant_isolation` predicate on both**, matching
 * `1756900000000-AddRecordNumbering` and `1756700000000-AddTenantFeeOverrides`.
 * Both tables have a real `tenantId`, so unlike `tenant_signup_invites` there
 * is something to compare against. The public route reaches the key table
 * through `TenantContext.runAsSystem` — the `app.rls_bypassed()` branch — for
 * exactly one statement: resolving the digest to its tenant. It cannot do
 * otherwise, because before that statement runs there is no tenant to bind.
 * Every statement after it runs on a connection bound to the tenant the key
 * named, so the write is policed by the same policy as any other tenant write.
 */
export class AddLeadIntake1757000000000 implements MigrationInterface {
  name = 'AddLeadIntake1757000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lead_intake_keys" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"        uuid NOT NULL,
        "name"            character varying(120) NOT NULL,
        "tokenHash"       character varying(128) NOT NULL,
        "tokenPrefix"     character varying(16) NOT NULL,
        "defaultChannel"  character varying(60),
        "defaultPartner"  character varying(120),
        "maxPerHour"      integer NOT NULL DEFAULT 60,
        "windowStartedAt" TIMESTAMPTZ,
        "windowCount"     integer NOT NULL DEFAULT 0,
        "active"          boolean NOT NULL DEFAULT true,
        "lastUsedAt"      TIMESTAMPTZ,
        "createdBy"       uuid,
        "createdAt"       TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_lead_intake_keys_max_per_hour" CHECK ("maxPerHour" > 0)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lead_intake_keys_token_hash" ON "lead_intake_keys" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lead_intake_keys_tenant" ON "lead_intake_keys" ("tenantId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lead_intake_submissions" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId"        uuid NOT NULL,
        "keyId"           uuid NOT NULL,
        "status"          character varying(30) NOT NULL,
        "leadId"          uuid,
        "matchedEntityId" uuid,
        "email"           character varying(320),
        "firstName"       character varying(200),
        "lastName"        character varying(200),
        "phoneNumber"     character varying(50),
        "channel"         character varying(60),
        "campaign"        character varying(200),
        "referrer"        character varying(500),
        "landingPage"     character varying(500),
        "partner"         character varying(120),
        "payload"         jsonb NOT NULL DEFAULT '{}'::jsonb,
        "sourceIp"        character varying(64),
        "userAgent"       character varying(500),
        "sourceOrigin"    character varying(255),
        "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lead_intake_submissions_tenant_created" ON "lead_intake_submissions" ("tenantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_lead_intake_submissions_tenant_key" ON "lead_intake_submissions" ("tenantId", "keyId")`,
    );

    for (const table of ['lead_intake_keys', 'lead_intake_submissions']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(
        `DROP POLICY IF EXISTS tenant_isolation ON "${table}"`,
      );
      await queryRunner.query(`
        CREATE POLICY tenant_isolation ON "${table}" FOR ALL TO public
          USING (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
          WITH CHECK (app.rls_bypassed() OR "tenantId" = app.current_tenant_id()::uuid)
      `);
    }
  }

  /**
   * Reversible with no loss of pre-existing data: both tables are new, so the
   * reverse destroys only keys minted and submissions received after the
   * forward ran. Any live capture key must be re-minted and re-pasted into the
   * firm's website after a rollback — and the leads already created from
   * submissions are ordinary `universal_entities` rows, which are untouched.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_intake_submissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lead_intake_keys"`);
  }
}
