import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A per-tenant capture key for the public website lead endpoint
 * (`POST /api/v1/intake/leads`, FR-3.3).
 *
 * **Why a key row rather than the tenant's slug.** `POST /auth/register` was
 * removed on 2026-09-04 and `POST /tenants/signup` was gated on 2026-09-10 for
 * the same defect: an unauthenticated route keyed on a *guessable* tenant
 * identifier. A slug is published on every invoice and every portal URL, so
 * "which tenant is this for" and "may this caller write to that tenant" were
 * the same guess. This row separates them — the key is 32 random bytes, it is
 * revocable (`active = false`, or delete the row), and losing one costs the
 * firm a form re-paste rather than a tenant.
 *
 * **Only the SHA-256 digest is stored**, never the token — the same discipline
 * as `AuthToken`, `sessions.refreshTokenHash` and `TenantSignupInvite`. The
 * lookup is by digest, which is why `tokenHash` is uniquely indexed. A
 * `bearer-token` inbound webhook endpoint stores its secret in the clear
 * because HMAC verification needs the bytes; this one never needs them, so it
 * does not keep them.
 */
@Entity('lead_intake_keys')
@Index(['tenantId'])
export class LeadIntakeKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** What the firm calls it: "immistack.com contact form", "Partner: Alpha Migration". */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** SHA-256 hex of the issued token. The token itself is returned exactly once. */
  @Column({ type: 'varchar', length: 128 })
  tokenHash: string;

  /**
   * The first few characters of the issued token, kept so an operator can tell
   * two keys apart in a list without the secret. Not a credential: a prefix is
   * far too short to brute-force the remainder from.
   */
  @Column({ type: 'varchar', length: 16 })
  tokenPrefix: string;

  /**
   * Attribution this key PINS (FR-3.8). When set, the value on the key wins
   * over anything in the request body — a partner posting through their own
   * key cannot attribute the lead to a different partner, and a website key
   * cannot claim to be a referral.
   *
   * Null means "this key pins nothing"; the body's value is then used, and if
   * the body has none the field stays null. Neither layer ever invents one.
   */
  @Column({ type: 'varchar', length: 60, nullable: true })
  defaultChannel: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  defaultPartner: string | null;

  /**
   * Durable, per-key fixed-window rate limit — the spam control FR-3.3 asks
   * for, and the only one on this route that actually holds.
   *
   * The Express limiter in `src/main.ts` / `api/index.js` is IP-keyed and
   * in-memory, so on Vercel it bounds abuse against ONE warm instance and
   * bounds nothing across them (ADR 0004 is the durable fix, unimplemented).
   * A counter on this row is shared by every instance because Postgres is,
   * and it is advanced by a single UPDATE, so two concurrent submissions
   * cannot both see the same count.
   */
  @Column({ type: 'int', default: 60 })
  maxPerHour: number;

  /** Start of the current counting window. */
  @Column({ type: 'timestamptz', nullable: true })
  windowStartedAt: Date | null;

  /**
   * Attempts in the current window — accepted AND refused. It keeps climbing
   * past `maxPerHour` on purpose: the excess is the only honest measure of how
   * hard a leaked key is being hammered.
   */
  @Column({ type: 'int', default: 0 })
  windowCount: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  /** users.id of the staff member who minted it. Not an FK — see `assignedTo`. */
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
