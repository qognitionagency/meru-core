import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seven `audit_logs.action` values for the IAM events that write none today:
 * invite issue, invite resend, password-reset request, credential-token
 * redemption (covers both an invite acceptance and a reset completion — one
 * handler, `IamService.resetPassword`, serves both), session revocation,
 * role change and status change.
 *
 * Distinct values rather than reusing `create`/`update`: a compliance
 * question like "show every role change in the last 90 days" needs to filter
 * on `action`, and burying seven security-relevant IAM events under the two
 * generic CRUD actions the rest of the table already uses for ordinary
 * record writes would make that unanswerable without also reading
 * `entityType`/`description` on every row.
 *
 * `ADD VALUE IF NOT EXISTS` is not transactional on older Postgres — same
 * reasoning as `AddSarEntityType` — so this migration does one value per
 * statement and nothing else.
 */
export class AddIamAuditActions1757100000000 implements MigrationInterface {
  name = 'AddIamAuditActions1757100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const values = [
      'invite_issued',
      'invite_resent',
      'password_reset_requested',
      'token_redeemed',
      'session_revoked',
      'role_changed',
      'status_changed',
    ];
    for (const value of values) {
      await queryRunner.query(
        `ALTER TYPE "audit_logs_action_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a value from an enum. Removing one would mean
    // recreating the type and rewriting every dependent row to undo
    // something inert — same reasoning as AddSarEntityType and its siblings.
  }
}
