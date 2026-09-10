import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * A platform_admin-issued, single-use invitation gating `POST /tenants/signup`.
 *
 * Unauthenticated `POST /tenants/signup` with `{}` cleared auth and reached
 * DTO validation, proving anyone could self-provision a TRIAL tenant and a
 * `firm_admin` login with a caller-supplied password — the same defect class
 * `POST /auth/register` was removed for on 2026-09-04, one controller over.
 * This closes it the same way: nothing self-provisions without a
 * `platform_admin` having said so first, via `POST /tenants/invitations`.
 *
 * Deliberately not `AuthToken`: that entity requires both `userId` and
 * `tenantId`, and neither exists yet when this invite is minted — creating
 * them is the whole point of redeeming it. Same SHA-256-only storage
 * discipline as `AuthToken`/`sessions.refreshTokenHash`: only the digest of
 * the raw token is ever persisted, never the token itself.
 *
 * No `tenantId` column, and that is not an oversight — see the migration
 * comment on why this table's RLS policy is bypass-only rather than the
 * standard `tenant_isolation` predicate every other tenant-scoped table gets.
 */
@Entity('tenant_signup_invites')
@Index(['tokenHash'], { unique: true })
@Index(['email'])
export class TenantSignupInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * The address this invite is bound to. Redemption requires
   * `CreateTenantDto.email` to match this exactly (case-insensitively) —
   * checked server-side, never trusted from the client alone.
   */
  @Column()
  email: string;

  @Column({ length: 128 })
  tokenHash: string;

  /** Pins the workspace slug, when the issuer chose one. */
  @Column({ type: 'varchar', nullable: true })
  allowedSlug: string | null;

  /**
   * Pins the vertical, when the issuer chose one. Stored as the raw string
   * rather than the `VerticalType` enum: validated against the real enum at
   * mint time by `MintTenantSignupInviteDto`, and re-validating a column type
   * here would only be a second copy of that same enum to keep in step.
   */
  @Column({ type: 'varchar', nullable: true })
  allowedVertical: string | null;

  /** Pins the plan, when the issuer chose one. */
  @Column({ type: 'varchar', nullable: true })
  allowedPlan: string | null;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  /** Set when redeemed. An invite with this set is dead, permanently. */
  @Column({ type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  /**
   * `users.id` of the platform_admin who minted this. **NOT NULL** —
   * deliberately: there is no self-service issuance path, so a row with no
   * issuer could only mean the insert bypassed `POST /tenants/invitations`.
   */
  @Column({ type: 'uuid' })
  issuedBy: string;

  @CreateDateColumn()
  createdAt: Date;
}
