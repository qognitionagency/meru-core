import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum TemplateType {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
}

export enum TemplateStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity('notification_templates')
export class NotificationTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  name: string;

  @Column({ unique: true })
  key: string;

  @Column({ type: 'enum', enum: TemplateType })
  type: TemplateType;

  @Column({ type: 'enum', enum: TemplateStatus, default: TemplateStatus.DRAFT })
  status: TemplateStatus;

  @Column()
  subject: string;

  @Column({ type: 'text' })
  content: string; // Can contain {{variables}}

  @Column({ type: 'text', nullable: true })
  htmlContent: string;

  @Column({ type: 'jsonb', default: {} })
  variables: Array<{
    name: string;
    type: 'string' | 'number' | 'date' | 'boolean';
    required: boolean;
    defaultValue?: any;
    description?: string;
  }>;

  @Column({ type: 'jsonb', default: {} })
  design: {
    layout?: string;
    colors?: {
      primary?: string;
      secondary?: string;
      background?: string;
    };
    fonts?: {
      heading?: string;
      body?: string;
    };
    logoUrl?: string;
  };

  @Column({ type: 'jsonb', default: {} })
  metadata: {
    category?: string;
    description?: string;
    tags?: string[];
    version?: number;
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
