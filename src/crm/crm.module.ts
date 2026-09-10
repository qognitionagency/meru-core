import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';
import { UniversalEntity } from './entities/universal-entity.entity';
import { EntityRelation } from './entities/entity-relation.entity';
import { EntityRelationService } from './entity-relation.service';
import { CommentService } from './comment.service';
import { TenantModule } from '../tenant/tenant.module';
import { VerticalPackModule } from '../tenant/vertical-pack.module';
import { CoreModule } from '../core/core.module';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';
import { AcceptanceService } from './acceptance.service';
import { PackRuleModule } from '../rules/pack-rule.module';
import { RuleEvaluatorModule } from '../rules/rule-evaluator.module';
import { CrmAccessService } from './crm-access.service';
import { LeadIntakeKey } from './intake/entities/lead-intake-key.entity';
import { LeadIntakeSubmission } from './intake/entities/lead-intake-submission.entity';
import { LeadIntakeService } from './intake/lead-intake.service';
import {
  LeadIntakeAdminController,
  LeadIntakeReceiverController,
} from './intake/lead-intake.controller';
import { ProfileSectionService } from './profile/profile-section.service';
import { CaseAgingService } from './aging/case-aging.service';
import { Notification } from '../notifications/entities/notification.entity';

// CRM module per CLAUDE.md §2 row 3: polymorphic UniversalEntity.
// All types (person, organization, case, note, tag, asset) live in one table.
// Type-specific fields go in verticalAttributes jsonb.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      UniversalEntity,
      EntityRelation,
      // FR-3.3 website capture. Registered here rather than in a module of
      // their own: a captured lead IS a `universal_entities` row, and
      // `LeadIntakeService` creates it through `CrmService` so it inherits the
      // record-numbering, required-field and search-indexing behaviour every
      // other producer gets.
      LeadIntakeKey,
      LeadIntakeSubmission,
      // FR-5.10 reads delivered messages to answer "days since last client
      // contact". Read-only, and only ever through `CaseAgingService`.
      Notification,
    ]),
    TenantModule,
    // `EntityRelationService` reads the pack's `relationships[]`. TenantModule
    // does not export `VerticalPackService`, so without this the app does not
    // boot at all — Nest reports an unresolvable dependency and exits.
    VerticalPackModule,
    CoreModule,
    SearchModule,
    DocumentsModule,
    AuditModule,
    // `GET /crm/entities/:id/rules` — the pack's `rules[]`, evaluated.
    // PackRuleModule, NOT RulesModule: the latter closes an import cycle
    // through Tasks → Documents → Crm. See its header.
    PackRuleModule,
    // `assertNoLockedFieldChanged` evaluates a pack field's `lockedWhen`.
    // Same module PackRuleService uses; importing it here rather than
    // reaching through PackRuleModule keeps the dependency explicit.
    RuleEvaluatorModule,
  ],
  controllers: [
    CrmController,
    // Public — see the controller's own header for why it is separate.
    LeadIntakeReceiverController,
    LeadIntakeAdminController,
  ],
  providers: [
    CrmService,
    EntityRelationService,
    CommentService,
    AcceptanceService,
    // Who may see/change which record — see its own header for the model.
    // Not exported: nothing outside CRM currently reaches getEntity/
    // updateEntity/convertEntity/deleteEntity (grep confirmed before adding
    // it here), so widen `exports` only when a caller actually needs it.
    CrmAccessService,
    LeadIntakeService,
    // FR-4.1–4.5 — reports a record against the fields its pack declares, so
    // "not asked" is never rendered as "none".
    ProfileSectionService,
    // FR-5.10 — days in stage, days since last client contact.
    CaseAgingService,
  ],
  exports: [CrmService, EntityRelationService, CommentService],
})
export class CrmModule {}
