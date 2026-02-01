import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppConfigModule } from './config/config.module';
import { IamModule } from './iam/iam.module';
import { TenantModule } from './tenant/tenant.module';
import { CrmModule } from './crm/crm.module';

// --- IMPORT ALL ENTITIES ---
import { User } from './iam/entities/user.entity';
import { Tenant } from './iam/entities/tenant.entity';
import { TenantSetting } from './tenant/entities/tenant-setting.entity';
import { UniversalEntity } from './crm/entities/universal-entity.entity';

@Module({
  imports: [
    // 1. Configuration & Validation
    AppConfigModule,

    // 2. Event Emitter for @OnEvent decorators
    EventEmitterModule.forRoot(),

    // 3. Database Setup (Connecting all modules)
    TypeOrmModule.forRootAsync({
      imports: [AppConfigModule],
      useFactory: (configService: ConfigService): any => {
        const isDevelopment = configService.get('NODE_ENV') === 'development';

        return {
          type: 'postgres' as const,
          host: configService.get('database.host'),
          port: configService.get('database.port'),
          username: configService.get('database.username'),
          password: configService.get('database.password'),
          database: configService.get('database.name'),

          // CRITICAL: All entities from all modules must be listed here
          // so TypeORM can manage them and create tables (if synchronize: true)
          entities: [User, Tenant, TenantSetting, UniversalEntity],

          // WARNING: synchronize: true is for DEVELOPMENT ONLY.
          // It automatically creates/updates tables. Disable for Production!
          synchronize: false, // Disabled for production - use migrations

          logging: isDevelopment,
        };
      },
      inject: [ConfigService],
    }),

    // 3. Feature Modules
    IamModule,
    TenantModule,
    CrmModule,
  ],
})
export class AppModule {}
