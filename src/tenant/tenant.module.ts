import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantSetting } from './entities/tenant-setting.entity';
import { TenantSettingsService } from './tenant-settings.service';
import { TenantController } from './tenant.controller';
import { CoreModule } from '../core/core.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TenantSetting]),
    CoreModule,
    BillingModule,
  ],
  controllers: [TenantController],
  providers: [TenantSettingsService],
  exports: [TenantSettingsService],
})
export class TenantModule {}
