import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Tenant } from '../../iam/entities/tenant.entity';

export interface VerticalSchemaField {
  key: string;
  type: 'text' | 'number' | 'date' | 'select';
  label: string;
  required: boolean;
  options?: string[]; // For select types
}

export interface VerticalConfig {
  vertical: string;
  entityName: string; // "Client", "Applicant", "Patient"
  fields: VerticalSchemaField[];
}

@Entity('tenant_settings')
@Index(['tenantId'])
export class TenantSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  tenantId: string;

  @ManyToOne(() => Tenant)
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  // The JSON Configuration Pack
  @Column({ type: 'jsonb', default: {} })
  config: VerticalConfig;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}