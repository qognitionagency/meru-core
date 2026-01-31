import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { VerticalType } from '../../iam/enums/vertical.enum';

export interface VerticalPolicy {
  vertical: VerticalType;
  rules: {
    mfaRequired: boolean;
    ipWhitelist?: string[];
    businessHours?: { start: number; end: number };
    dataRetentionDays: number;
  };
}

@Injectable()
export class VerticalPolicyService {
  private readonly logger = new Logger(VerticalPolicyService.name);

  // Mock DB of Vertical Configs
  private verticalConfigs: Record<VerticalType, VerticalPolicy> = {
    [VerticalType.GRC]: {
      vertical: VerticalType.GRC,
      rules: {
        mfaRequired: true,
        ipWhitelist: [],
        businessHours: { start: 0, end: 24 },
        dataRetentionDays: 2555,
      },
    },
    [VerticalType.IMMIGRATION]: {
      vertical: VerticalType.IMMIGRATION,
      rules: {
        mfaRequired: false,
        ipWhitelist: ['10.0.0.1'], // Mock internal IP
        businessHours: { start: 9, end: 17 },
        dataRetentionDays: 3650,
      },
    },
    [VerticalType.LABOUR]: {
      vertical: VerticalType.LABOUR,
      rules: {
        mfaRequired: true,
        ipWhitelist: [],
        businessHours: { start: 8, end: 18 },
        dataRetentionDays: 1825,
      },
    },
    [VerticalType.FINTECH]: {
      vertical: VerticalType.FINTECH,
      rules: {
        mfaRequired: true,
        ipWhitelist: [],
        businessHours: { start: 0, end: 24 },
        dataRetentionDays: 2555,
      },
    },
    [VerticalType.LEGAL]: {
      vertical: VerticalType.LEGAL,
      rules: {
        mfaRequired: false,
        ipWhitelist: [],
        businessHours: { start: 9, end: 17 },
        dataRetentionDays: 3650,
      },
    },
  };

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  async getPolicy(vertical: VerticalType): Promise<VerticalPolicy> {
    const cacheKey = `vertical_policy:${vertical}`;

    // 1. Try Cache
    const cachedPolicy = await this.cacheManager.get<VerticalPolicy>(cacheKey);
    if (cachedPolicy) {
      return cachedPolicy;
    }

    // 2. Fetch Source
    const policy = this.verticalConfigs[vertical];

    // 3. Set Cache (1 Hour TTL)
    await this.cacheManager.set(cacheKey, policy, 3600);

    this.logger.log(`Policy loaded for ${vertical}`);
    return policy;
  }
}
