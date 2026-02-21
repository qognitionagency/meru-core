import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { UniversalEntity } from './entities/universal-entity.entity';
import { TenantModule } from '../tenant/tenant.module';
import { CoreModule } from '../core/core.module';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UniversalEntity]),
    TenantModule,
    CoreModule,
    SearchModule,
    DocumentsModule,
    AuditModule,
  ],
  controllers: [CrmController],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmModule {}