import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';

export enum AuthProvider {
  LOCAL = 'local',
  SAML = 'saml',
  OIDC = 'oidc',
  GOOGLE = 'google',
  MICROSOFT = 'microsoft',
}

export enum UserStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  INVITED = 'invited',
  LOCKED = 'locked',
}

@Entity('users')
@Index(['tenantId'])
@Index(['email'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ unique: true })
  email: string;

  @Column({ select: false })
  password: string;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true })
  avatarUrl: string;

  @Column({ nullable: true })
  phone: string;

  @Column({ nullable: true })
  timezone: string;

  @Column({ type: 'enum', enum: AuthProvider, default: AuthProvider.LOCAL })
  provider: AuthProvider;

  @Column({ default: false })
  mfaEnabled: boolean;

  @Column({ nullable: true, select: false })
  mfaSecret: string;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.ACTIVE })
  status: UserStatus;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt: Date;

  @Column({ default: 0 })
  loginCount: number;

  @Column({ type: 'jsonb', default: {} })
  preferences: {
    theme?: 'light' | 'dark';
    locale?: string;
    notifications?: {
      email?: boolean;
      push?: boolean;
      inApp?: boolean;
    };
  };

  @Column({ type: 'simple-array', default: '' })
  roles: string[];

  @Column({ type: 'jsonb', default: {} })
  attributes: Record<string, any>;

  // ── Practitioner credential (FR-1.2) ──────────────────────────────────────
  //
  // A dedicated pair of columns, NOT a key under `attributes`, for the reason
  // ADR 0001 §3 gives for `verticalRoles`: `attributes` is a free-form bag and
  // every future writer of it has to remember to spread — `IamService.updateUser`
  // does `user.attributes = { ...user.attributes, department }` correctly today,
  // and one careless edit silently drops a credential a sign-off gate depends on.
  //
  // Also NOT a practice-role tag. ADR 0001's carrier is a `text[]` of pack
  // `roles[].key` values, validated against the tenant's resolved pack; a
  // registration NUMBER is a value, not a vocabulary member, and putting
  // "1234567" in that array would break the ADR's own validation contract.
  // The two are complementary: the role says what someone does, the credential
  // says under whose register they are permitted to do it.
  //
  // Neither column is named `marn`. "MARN" is Australian immigration
  // vocabulary and core does not learn it (CLAUDE.md §5.5) — the registry
  // arrives as a VALUE from the vertical.

  /**
   * The registration number exactly as the register issues it — a MARN
   * (`1234567`), an OISC number, an RCIC number. Free-form on purpose: format
   * rules differ per register and per country, and a regex baked into core
   * would be the 80/20 violation this column exists to avoid.
   *
   * **Self-asserted, never verified.** Nothing in this system checks it
   * against OMARA, OISC or CICC, and no adapter could — every regulator
   * adapter is sandbox (CLAUDE.md §13). There is deliberately no `verified`
   * flag beside it: a `false` default would invite a UI to render a green tick
   * the day someone flips it, and a `true` would be a fabricated positive
   * (§5.2). A surface collecting or showing this must say "recorded, not
   * verified".
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  practitionerCredential: string | null;

  /**
   * Which register the number above is on — `marn`, `oisc`, `rcic`. Paired
   * with it by a database CHECK constraint: a number with no register is
   * unattributable, and a register with no number is a half-filled form.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  practitionerCredentialType: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}
