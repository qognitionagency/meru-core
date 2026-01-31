import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  UniversalEntity,
  EntityType,
} from './entities/universal-entity.entity';
import { TenantSettingsService } from '@/tenant/tenant-settings.service';
import { OnEvent } from '@nestjs/event-emitter';
import { VerticalType } from '@/iam/enums/vertical.enum';
import { CreateEntityInput } from '../common/types';

@Injectable()
export class CrmService {
  constructor(
    @InjectRepository(UniversalEntity)
    private entityRepo: Repository<UniversalEntity>,
    private tenantSettingsService: TenantSettingsService,
  ) {}

  // --- CORE BUSINESS LOGIC ---

  async createEntity(
    tenantId: string,
    dto: CreateEntityInput,
  ): Promise<UniversalEntity> {
    // 1. Fetch Tenant Schema to Validate Vertical Attributes
    const settings = await this.tenantSettingsService.getSettings(tenantId);

    // 2. Validate Required Fields
    for (const field of settings.fields) {
      if (field.required && !dto.verticalAttributes?.[field.key]) {
        throw new BadRequestException(
          `Missing required vertical attribute: ${field.label} (${field.key})`,
        );
      }
    }

    // 3. Check for Duplicates (Deduplication Engine)
    // Simple dedup: Check if email exists for this tenant
    if (dto.email) {
      const existing = await this.entityRepo.findOne({
        where: { tenantId, email: dto.email },
      });
      if (existing) {
        throw new BadRequestException('Entity with this email already exists.');
      }
    }

    const entity = this.entityRepo.create({
      tenantId,
      type: dto.type,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      phoneNumber: dto.phoneNumber,
      verticalAttributes: dto.verticalAttributes, // Store the JSONB data
    });

    return this.entityRepo.save(entity);
  }

  // --- INTEGRATION: LISTEN TO IAM EVENTS ---

  // When a user registers in IAM, we automatically create their "Person" profile in CRM
  @OnEvent('user.registered')
  async handleNewUserRegistration(payload: {
    userId: string;
    tenantId: string;
    email: string;
    vertical: VerticalType;
  }) {
    console.log(`CRM: Syncing user ${payload.email} to Universal Entity...`);

    // Create a Person entity linked to this tenant
    await this.createEntity(payload.tenantId, {
      type: EntityType.PERSON,
      email: payload.email,
      verticalAttributes: {
        internalUserId: payload.userId, // Link back to IAM
        source: 'self_registration',
      },
    });
  }

  // --- RELATIONSHIP GRAPH ---

  async addRelationship(
    parentId: string,
    childId: string,
    relationType: string,
  ) {
    const parent = await this.entityRepo.findOne({ where: { id: parentId } });
    const child = await this.entityRepo.findOne({ where: { id: childId } });

    if (!parent || !child) throw new BadRequestException('Entity not found');

    // Add to parent's relationships
    parent.relationships.push({ id: childId, type: relationType });

    // (Optional) Add inverse relationship to child
    // child.relationships.push({ id: parentId, type: `INVERSE_${relationType}` });

    return this.entityRepo.save(parent);
  }

  async getEntitiesByTenant(tenantId: string) {
    return this.entityRepo.find({
      where: { tenantId },
    });
  }
}
