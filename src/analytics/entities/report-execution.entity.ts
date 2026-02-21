import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('report_executions')
@Index(['tenantId', 'reportId'])
@Index(['tenantId', 'executedAt'])
export class ReportExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  reportId: string;

  @Column({ type: 'timestamp' })
  executedAt: Date;

  @Column()
  executedBy: string;

  @Column({ type: 'jsonb' })
  parameters: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  results: any;

  @Column({ type: 'int', default: 0 })
  rowCount: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  executionTimeMs: number;

  @Column({ default: 'success' })
  status: string;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ type: 'text', nullable: true })
  fileUrl: string; // For exported reports

  @CreateDateColumn()
  createdAt: Date;
}
