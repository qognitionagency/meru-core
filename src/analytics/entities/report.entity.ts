import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ReportType {
  TABLE = 'table',
  CHART = 'chart',
  KPI = 'kpi',
  DASHBOARD = 'dashboard',
}

export enum ChartType {
  BAR = 'bar',
  LINE = 'line',
  PIE = 'pie',
  AREA = 'area',
  SCATTER = 'scatter',
  TABLE = 'table',
}

export enum DataSource {
  CRM = 'crm',
  WORKFLOW = 'workflow',
  DOCUMENTS = 'documents',
  TASKS = 'tasks',
  FORMS = 'forms',
  BILLING = 'billing',
  AUDIT = 'audit',
}

@Entity('reports')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'dataSource'])
export class Report {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'enum', enum: ReportType })
  reportType: ReportType;

  @Column({ type: 'enum', enum: DataSource })
  dataSource: DataSource;

  @Column({ type: 'jsonb' })
  configuration: {
    // For charts
    chartType?: ChartType;
    xAxis?: string;
    yAxis?: string;
    groupBy?: string;
    filters?: Array<{
      field: string;
      operator: string;
      value: any;
    }>;
    // For tables
    columns?: Array<{
      field: string;
      header: string;
      width?: number;
      format?: string;
    }>;
    sort?: {
      field: string;
      direction: 'asc' | 'desc';
    };
    limit?: number;
    aggregations?: Array<{
      field: string;
      function: 'sum' | 'avg' | 'count' | 'min' | 'max';
      alias: string;
    }>;
  };

  @Column({ type: 'jsonb', default: {} })
  schedule: {
    enabled: boolean;
    frequency: 'daily' | 'weekly' | 'monthly';
    dayOfWeek?: number; // 0-6 for weekly
    dayOfMonth?: number; // 1-31 for monthly
    time: string; // HH:MM format
    recipients: string[];
    subject?: string;
    format: 'pdf' | 'csv' | 'xlsx';
  };

  @Column({ default: true })
  isPublic: boolean;

  @Column()
  createdBy: string;

  @Column({ default: 'active' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
