import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR 0025 — a review sub-state machine on `Document`, orthogonal to
 * `DocumentStatus` (storage lifecycle).
 *
 * `DocumentStatus` answers "does this object still exist"; it has never
 * answered "has anyone looked at it". This adds that second, independent
 * question: `reviewStatus` (`uploaded | under_review | approved | rejected`),
 * who decided and when, why a rejection happened, and an append-only
 * `reviewHistory` of every decision.
 *
 * `varchar` + `CHECK`, not a Postgres `ENUM` type — matching
 * `AddUserPractitionerCredential1756920000000`'s reasoning: `ALTER TYPE ...
 * ADD VALUE` cannot run inside a transaction and cannot be removed, which
 * would make a fifth review state (if one is ever needed) a migration that
 * cannot follow this repo's usual deploy discipline.
 *
 * Purely additive. Every existing document reads `reviewStatus: 'uploaded'`
 * at the default — honest, because nobody has used a review button that did
 * not exist before this migration; rendering it as `approved` by default
 * would be the §5.2 failure (unknown reported as a positive).
 */
export class AddDocumentReviewStatus1757300000000
  implements MigrationInterface
{
  name = 'AddDocumentReviewStatus1757300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD COLUMN IF NOT EXISTS "reviewStatus" character varying(20) NOT NULL DEFAULT 'uploaded',
        ADD COLUMN IF NOT EXISTS "reviewedById" uuid NULL,
        ADD COLUMN IF NOT EXISTS "reviewedAt" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "rejectionReasonKey" character varying(64) NULL,
        ADD COLUMN IF NOT EXISTS "rejectionReasonNote" text NULL,
        ADD COLUMN IF NOT EXISTS "reviewHistory" jsonb NOT NULL DEFAULT '[]'
    `);
    await queryRunner.query(`
      ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_review_status_valid";
      ALTER TABLE "documents" ADD CONSTRAINT "CHK_documents_review_status_valid"
        CHECK ("reviewStatus" IN ('uploaded','under_review','approved','rejected'));
    `);
    await queryRunner.query(`
      ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_rejection_reason_paired";
      ALTER TABLE "documents" ADD CONSTRAINT "CHK_documents_rejection_reason_paired"
        CHECK ("reviewStatus" <> 'rejected' OR "rejectionReasonKey" IS NOT NULL);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Every review decision (who reviewed it, when, why it was rejected) is
    // destroyed by this rollback — there is no schema to put it back into.
    // Export `reviewHistory` first if the decisions must survive for
    // compliance reasons (FR-6.10) before running this.
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_rejection_reason_paired"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_review_status_valid"`,
    );
    await queryRunner.query(`
      ALTER TABLE "documents"
        DROP COLUMN IF EXISTS "reviewHistory",
        DROP COLUMN IF EXISTS "rejectionReasonNote",
        DROP COLUMN IF EXISTS "rejectionReasonKey",
        DROP COLUMN IF EXISTS "reviewedAt",
        DROP COLUMN IF EXISTS "reviewedById",
        DROP COLUMN IF EXISTS "reviewStatus"
    `);
  }
}
