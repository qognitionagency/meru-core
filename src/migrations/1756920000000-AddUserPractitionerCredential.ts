import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FR-1.2 — a registered practitioner's credential becomes a first-class field
 * on the user who holds it.
 *
 * The ImmiStack onboarding wizard has collected a MARN per staff invite since
 * it shipped (`immistack/app/(auth)/onboarding/steps/practitioners.tsx`) and
 * has correctly told the operator it is not saved, because `InviteUserDto` had
 * nowhere to put it. This is that column.
 *
 * **Two columns, not one, and neither of them is named `marn`.** "MARN" is
 * Australian immigration vocabulary; core does not learn it (CLAUDE.md §5.5).
 * `practitionerCredentialType` carries the registry — `marn`, `oisc`,
 * `rcic` — as a VALUE supplied by the vertical, and
 * `practitionerCredential` carries the registration number as issued.
 *
 * **Both nullable, and the absence of a verification column is deliberate.**
 * The number is self-asserted by the firm; nothing in this system checks it
 * against the OMARA/OISC/CICC register, and there is no adapter that could
 * (CLAUDE.md §13 — every regulator adapter is sandbox). Storing a
 * `verified: true` alongside it, or defaulting one, would be §5.2's exact
 * failure: unknown rendered as settled. A UI must present this as "recorded,
 * not verified". When a real registry check exists, it adds its own
 * `practitionerCredentialVerifiedAt` column and its own provenance — it does
 * not retro-fit meaning onto these two.
 *
 * `users` already carries ENABLE + FORCE RLS; a plain column on it needs
 * nothing further. Purely additive: every existing row reads NULL, meaning
 * "not a credentialed practitioner", which is the correct answer for every
 * GovernanceX user and every uncredentialed ImmiStack user alike (§7.2).
 */
export class AddUserPractitionerCredential1756920000000
  implements MigrationInterface
{
  name = 'AddUserPractitionerCredential1756920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "practitionerCredential" character varying(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "practitionerCredentialType" character varying(32)`,
    );
    // A credential type with no number is a half-filled form, and a number with
    // no registry is unattributable — "1234567" means nothing without knowing
    // which register it is on. Refuse both halves of that at the database, so
    // a future producer cannot write one without the other.
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP CONSTRAINT IF EXISTS "CHK_users_practitioner_credential_paired"
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "CHK_users_practitioner_credential_paired"
      CHECK (
        ("practitionerCredential" IS NULL AND "practitionerCredentialType" IS NULL)
        OR ("practitionerCredential" IS NOT NULL AND "practitionerCredentialType" IS NOT NULL)
      )
    `);
    // "Which of our people are credentialed" is the question the sign-off gate
    // and the firm's practitioner register both ask. Partial, because the vast
    // majority of rows — every client-portal user, every GovX user — are NULL.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_tenant_practitioner_credential"
         ON "users" ("tenantId")
         WHERE "practitionerCredential" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_users_tenant_practitioner_credential"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_practitioner_credential_paired"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "practitionerCredentialType"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "practitionerCredential"`,
    );
  }
}
