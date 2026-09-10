import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-1 — gates `POST /tenants/signup`.
 *
 * Unauthenticated `POST /tenants/signup` with `{}` returned `MER-VAL-0001`, a
 * *validation* error, proving it cleared auth and reached DTO validation:
 * anyone could self-provision a TRIAL tenant and a `firm_admin` login with a
 * caller-supplied password. `POST /auth/register` was removed on 2026-09-04
 * for this identical defect, one controller over. This table is the gate:
 * `CreateTenantDto.token` must name a live row here, minted by a
 * `platform_admin` via `POST /tenants/invitations`.
 *
 * **RLS is deliberately NOT the standard `tenant_isolation` predicate.**
 * Every other tenant-scoped table checks `"tenantId" = app.current_tenant_id()`
 * because a real tenant already exists to check against. This table has no
 * `tenantId` column, and cannot have one: it is minted before a tenant exists
 * (naming the *future* tenant's slug/vertical/plan, not an existing one) and
 * is read during signup, when no tenant is bound to the connection at all.
 * There is nothing in either row-shape to compare `app.current_tenant_id()`
 * against, so the fail-closed answer is narrower than tenant isolation: this
 * table is invisible on every ordinary, tenant-bound connection, full stop.
 * `FOR ALL ... USING (app.rls_bypassed())` means the only two code paths that
 * can ever touch it are `TenancyService.runAsGod` (minting, by an
 * authenticated `platform_admin`, audited before the write per CLAUDE.md
 * §6.4) and `TenantContext.runAsSystem` (redemption, the same escape hatch
 * every other pre-identity bootstrap lookup uses — `IamService.resetPassword`
 * is the direct precedent for "no session exists yet, so nothing is bound").
 * No policy branch grants an ordinary tenant connection access, by design.
 */
export class AddTenantSignupInvites1756800000000
  implements MigrationInterface
{
  name = 'AddTenantSignupInvites1756800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_signup_invites" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email"           character varying NOT NULL,
        "tokenHash"       character varying(128) NOT NULL,
        "allowedSlug"     character varying,
        "allowedVertical" character varying,
        "allowedPlan"     character varying,
        "expiresAt"       TIMESTAMPTZ NOT NULL,
        "usedAt"          TIMESTAMPTZ,
        "issuedBy"        uuid NOT NULL,
        "createdAt"       TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Unique on the hash: the lookup is by hash, and two live invites sharing
    // one would make redemption ambiguous — same reasoning as auth_tokens.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_tenant_signup_invites_hash" ON "tenant_signup_invites" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tenant_signup_invites_email" ON "tenant_signup_invites" ("email")`,
    );

    // Bypass-only RLS — see the class comment for why this is not the
    // standard tenant_isolation shape.
    await queryRunner.query(
      `ALTER TABLE "tenant_signup_invites" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_signup_invites" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `DROP POLICY IF EXISTS tenant_isolation ON "tenant_signup_invites"`,
    );
    await queryRunner.query(`
      CREATE POLICY tenant_isolation ON "tenant_signup_invites" FOR ALL TO public
        USING (app.rls_bypassed())
        WITH CHECK (app.rls_bypassed())
    `);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_signup_invites" TO meru_app`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "tenant_signup_invites"`);
  }
}
