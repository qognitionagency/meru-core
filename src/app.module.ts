import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AppConfigModule } from './config/config.module';
import { IamModule } from './iam/iam.module';
import { User } from './iam/entities/user.entity';
import { Tenant } from './iam/entities/tenant.entity';

@Module({
  imports: [
    ConfigModule,
    AppConfigModule, // Imports ConfigModule globally with validation
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: parseInt(process.env.DATABASE_PORT || '5432', 10),
      username: process.env.DATABASE_USERNAME || 'meru_admin',
      password: process.env.DATABASE_PASSWORD || 'ChangeMeSecurePassword123!',
      database: process.env.DATABASE_NAME || 'meru_core_prod',
      entities: [User, Tenant],
      synchronize: process.env.NODE_ENV === 'development',
      logging: true,
    }),
    IamModule,
  ],
})
export class AppModule {}