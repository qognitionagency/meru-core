import { Entity, Column, PrimaryGeneratedColumn, OneToMany } from 'typeorm';
import { User } from './user.entity';
import { VerticalType } from '../enums/vertical.enum';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string; // e.g. 'acme-bank' used for subdomains

  @Column()
  name: string;

  @Column({ type: 'enum', enum: VerticalType })
  vertical: VerticalType;

  // Enterprise SAML Configuration stored as JSONB per tenant
  @Column({ type: 'jsonb', nullable: true })
  ssoConfig: {
    provider: 'saml' | 'oidc';
    entryPoint: string;
    cert: string;
    issuer: string;
  };

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @OneToMany('User', 'tenant')
  users: User[];
}
