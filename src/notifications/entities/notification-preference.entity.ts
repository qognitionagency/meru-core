import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  IN_APP = 'in_app',
  SLACK = 'slack',
}

@Entity('notification_preferences')
@Index(['tenantId', 'userId'])
export class NotificationPreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  userId: string;

  @Column({ type: 'jsonb', default: {} })
  channels: {
    email?: {
      enabled: boolean;
      address: string;
      verified: boolean;
    };
    sms?: {
      enabled: boolean;
      phoneNumber: string;
      verified: boolean;
    };
    push?: {
      enabled: boolean;
      deviceTokens: string[];
    };
    slack?: {
      enabled: boolean;
      webhookUrl: string;
      channel: string;
    };
    inApp?: {
      enabled: boolean;
      soundEnabled: boolean;
      showPreview: boolean;
    };
  };

  @Column({ type: 'jsonb', default: {} })
  categoryPreferences: {
    system?: { enabled: boolean; channels: NotificationChannel[] };
    workflow?: { enabled: boolean; channels: NotificationChannel[] };
    task?: { enabled: boolean; channels: NotificationChannel[] };
    billing?: { enabled: boolean; channels: NotificationChannel[] };
    security?: { enabled: boolean; channels: NotificationChannel[] };
    marketing?: { enabled: boolean; channels: NotificationChannel[] };
  };

  @Column({ type: 'jsonb', default: {} })
  quietHours: {
    enabled: boolean;
    startTime: string; // HH:mm format
    endTime: string;
    timezone: string;
  };

  @Column({ type: 'jsonb', default: {} })
  digestSettings: {
    enabled: boolean;
    frequency: 'daily' | 'weekly';
    time: string;
    categories: string[];
  };

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
