import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantSetting, VerticalConfig } from './entities/tenant-setting.entity';

@Injectable()
export class TenantSettingsService {
  constructor(
    @InjectRepository(TenantSetting)
    private settingsRepo: Repository<TenantSetting>,
  ) {}

  async getSettings(tenantId: string): Promise<VerticalConfig> {
    let setting = await this.settingsRepo.findOne({ where: { tenantId } });

    // If no custom settings exist, return default for Fintech (Fail-safe)
    if (!setting) {
      return this.getDefaultConfig();
    }

    return setting.config;
  }

  async updateSettings(tenantId: string, config: VerticalConfig) {
    let setting = await this.settingsRepo.findOne({ where: { tenantId } });
    if (!setting) {
      setting = this.settingsRepo.create({ tenantId, config });
    } else {
      setting.config = config;
    }
    return this.settingsRepo.save(setting);
  }

  // Default "Fintech" Config if tenant hasn't customized yet
  private getDefaultConfig(): VerticalConfig {
    return {
      vertical: 'fintech',
      entityName: 'Customer',
      fields: [
        { key: 'taxId', type: 'text', label: 'Tax ID', required: true },
        { key: 'riskScore', type: 'number', label: 'Risk Score', required: false },
      ],
    };
  }
}