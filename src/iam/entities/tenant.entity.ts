import { Entity, Column, PrimaryGeneratedColumn, OneToMany, Index } from 'typeorm';
import { User } from './user.entity';
import { VerticalType } from '../enums/vertical.enum';

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
  TRIAL = 'trial',
}

export enum TenantPlan {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

@Entity('tenants')
@Index(['slug'])
@Index(['status'])
@Index(['vertical'])
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string; // e.g. 'acme-immigration' used for subdomains: acme-immigration.meru.com

  @Column()
  name: string;

  @Column({ type: 'enum', enum: VerticalType })
  vertical: VerticalType;

  @Column({ type: 'enum', enum: TenantStatus, default: TenantStatus.TRIAL })
  status: TenantStatus;

  @Column({ type: 'enum', enum: TenantPlan, default: TenantPlan.FREE })
  plan: TenantPlan;

  @Column({ type: 'jsonb', default: {} })
  settings: {
    branding?: {
      logo?: string;
      colors?: {
        primary?: string;
        secondary?: string;
      };
      customDomain?: string; // e.g. workspace.example.com
    };
    limits?: {
      users?: number;
      storageGB?: number;
      documents?: number;
      apiCallsPerMonth?: number;
    };
    features?: {
      aiAnalysis?: boolean;
      advancedSearch?: boolean;
      customWorkflows?: boolean;
      sso?: boolean;
      apiAccess?: boolean;
    };
  };

  @Column({ type: 'jsonb', default: {} })
  ssoConfig: {
    provider?: 'saml' | 'oidc' | 'local';
    entryPoint?: string;
    cert?: string;
    issuer?: string;
  };

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  trialEndsAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  subscriptionRenewsAt: Date;

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    industry?: string;
    companySize?: string;
    source?: string; // e.g., 'signup', 'referral', 'direct'
    referralCode?: string;
    suspensionReason?: string;
    suspendedAt?: string;
  };

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;

  @OneToMany('User', 'tenant')
  users: User[];
}
