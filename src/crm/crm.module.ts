import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { UniversalEntity } from './entities/universal-entity.entity';
import { TenantModule } from '../tenant/tenant.module'; // Import to inject settings service

@Module({
  imports: [TypeOrmModule.forFeature([UniversalEntity]), TenantModule],
  controllers: [CrmController],
  providers: [CrmService],
})
export class CrmModule {}
