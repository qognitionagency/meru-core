import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum WidgetType {
  KPI = 'kpi',
  CHART = 'chart',
  TABLE = 'table',
  GAUGE = 'gauge',
  PROGRESS = 'progress',
  LIST = 'list',
}

@Entity('dashboard_widgets')
@Index(['tenantId', 'status'])
export class DashboardWidget {
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

  @Column({ type: 'enum', enum: WidgetType })
  widgetType: WidgetType;

  @Column({ type: 'jsonb' })
  configuration: {
    // Data source configuration
    dataSource: string;
    query: {
      table: string;
      fields: string[];
      filters?: Record<string, any>;
      groupBy?: string[];
      aggregations?: Array<{
        field: string;
        function: string;
        alias: string;
      }>;
    };
    // Visual configuration
    display: {
      width?: number; // Grid columns (1-12)
      height?: number; // Rows
      color?: string;
      title?: string;
      subtitle?: string;
      refreshInterval?: number; // Seconds
    };
    // For KPIs
    kpi?: {
      valueField: string;
      labelField?: string;
      target?: number;
      trend?: 'up' | 'down' | 'neutral';
      format?: 'number' | 'currency' | 'percentage';
    };
    // For charts
    chart?: {
      type: 'bar' | 'line' | 'pie' | 'area';
      xAxis: string;
      yAxis: string;
      stacked?: boolean;
      legend?: boolean;
    };
  };

  @Column({ default: 0 })
  position: number;

  @Column({ default: true })
  isDefault: boolean;

  @Column({ default: 'active' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
