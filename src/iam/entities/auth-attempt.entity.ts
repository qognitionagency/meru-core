import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * One counted sign-in attempt: a wrong password or MFA code (`failed`), or an
 * attempt refused because its source was locked (`refused_locked`,
 * rate-limited to one per source per minute). Read and written only by
 * `AuthAttemptLimiter`.
 *
 * Deliberately NOT `audit_logs`. Anyone on the internet can generate these
 * rows, and an `audit_logs` append takes the tenant's hash-chain lock: an
 * unauthenticated burst queued on that lock, held pool connections while it
 * waited, and made the tenant's strict audited writes answer 503 (Owen's
 * gate, 2026-11-17). This table has no chain and no unique index, so an
 * insert waits on nobody. The decision that does belong in the chain — an
 * operator's unlock — is written there (`auth.login.unlocked`).
 *
 * Tenant-scoped with the standard `tenant_isolation` policy (migration
 * 1757500000000). Nothing updates a row. `AuthAttemptLimiter.begin` writes an
 * attempt as `failed` before the secret is checked and `release` deletes it
 * when it was not a failure; the daily `auth-attempts-prune` job deletes rows
 * older than 30 days [NEEDS DATA: a proposal].
 */
@Entity('auth_attempts')
@Index(['tenantId', 'userId', 'kind', 'createdAt'])
export class AuthAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid' })
  userId: string;

  /** `login` | `mfa`. */
  @Column({ type: 'varchar', length: 16 })
  kind: string;

  /** `failed` | `refused_locked`. */
  @Column({ type: 'varchar', length: 24 })
  outcome: string;

  /** `attemptSource(req.ip)`: IPv4, an IPv6 /64, or `unknown`. */
  @Column({ type: 'varchar', length: 64 })
  source: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
