import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { AuthProvider } from '../enums/auth-provider.enum';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false }) // eager false to avoid circular ref issues in some queries
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ unique: true })
  email: string;

  @Column({ select: false }) // Never return in queries unless explicitly asked
  password: string;

  @Column({ type: 'enum', enum: AuthProvider, default: AuthProvider.LOCAL })
  provider: AuthProvider;

  // Roles are stored as an array for flexibility (RBAC)
  @Column({ type: 'simple-array', default: ['user'] })
  roles: string[];

  // Attributes for Context-Aware logic (e.g., department, clearance level)
  @Column({ type: 'jsonb', nullable: true })
  attributes: Record<string, any>;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;
}
