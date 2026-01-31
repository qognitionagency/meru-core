import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantSetting } from './entities/tenant-setting.entity';
import { TenantSettingsService } from './tenant-settings.service';

@Module({
  imports: [TypeOrmModule.forFeature([TenantSetting])],
  providers: [TenantSettingsService],
  exports: [TenantSettingsService], // Export so CRM can use it
})
export class TenantModule {}
