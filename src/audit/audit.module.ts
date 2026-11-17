import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { RetentionService } from './retention.service';
import { AuditReconcilerService } from './audit-reconciler.service';
import { AuditReconcileStore } from './audit-reconcile.store';
import { Tenant } from '../iam/entities/tenant.entity';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { AuditLog } from './entities/audit-log.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLog, Tenant]),
    // Retention periods are Layer 4: `compliance.retentionYears`.
    VerticalPackModule,
  ],
  controllers: [AuditController],
  // AuditReconcilerService: ADR 0023 D15 item 2, run from /jobs/tick?scope=daily
  // as `audit-reconcile`. Its state readers (AUDIT_STATE_READERS) are optional
  // and none is provided yet — see the service's doc comment.
  providers: [
    AuditService,
    RetentionService,
    AuditReconcileStore,
    AuditReconcilerService,
  ],
  exports: [AuditService, RetentionService, AuditReconcilerService],
})
export class AuditModule {}
