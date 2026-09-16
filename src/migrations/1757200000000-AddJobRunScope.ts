import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR 0018 — scope evidence for scheduled-job runs, so "found nothing" and
 * "blocked by RLS" stop looking identical in job_runs / GET /jobs/status.
 * Purely additive: a nullable jsonb column on an existing table. No RLS
 * change — job_runs' policies are row-level (AddJobRuns1755100000000), not
 * column-level, and this column carries no tenant data of its own (it
 * summarises counts and failure messages across tenants, by design — the
 * same platform-global shape as the rest of the table, and every failure
 * message it carries is capped and stripped of interpolated detail before it
 * ever reaches this column — see `tenant-bound-sweep.ts`).
 *
 * Timestamped 1757200000000, not the ADR's originally-specified
 * 1757100000000: that slot was claimed by AddIamAuditActions1757100000000
 * (a concurrent change to src/iam) by the time this landed. Next free slot.
 */
export class AddJobRunScope1757200000000 implements MigrationInterface {
  name = 'AddJobRunScope1757200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_runs" ADD COLUMN IF NOT EXISTS "scope" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_runs" DROP COLUMN IF EXISTS "scope"`,
    );
  }
}
