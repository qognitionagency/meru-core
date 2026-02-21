import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

export enum EntityType {
  PERSON = 'person',
  ORGANIZATION = 'organization',
}

@Entity('universal_entities')
@Index(['tenantId', 'email']) // Optimization for dedup queries
export class UniversalEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ type: 'enum', enum: EntityType })
  type: EntityType;

  // --- CORE FIELDS ---
  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column({ nullable: true, unique: false }) // Unique constraint handled at DB level if needed
  email: string;

  @Column({ nullable: true })
  phoneNumber: string;

  // --- VERTICAL INJECTION ---
  // Stores the data matching the schema from Tenant Settings
  @Column({ type: 'jsonb', default: {} })
  verticalAttributes: Record<string, any>;

  // --- RELATIONSHIP GRAPH ---
  // Storing relationships as a JSON array for flexibility (Graph-like structure)
  // Format: [{ id: "target-uuid", type: "EMPLOYEE_OF" }]
  @Column({ type: 'jsonb', default: [] })
  relationships: Array<{ id: string; type: string }>;

  @CreateDateColumn()
  createdAt: Date;
}
