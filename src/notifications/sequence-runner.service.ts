import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { SequenceEnrolment } from './entities/sequence-enrolment.entity';
import { NotificationsService } from './notifications.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant, TenantStatus } from '../iam/entities/tenant.entity';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import { TenantContext } from '../core/tenancy/tenant-context';

/** One `messaging.sequences[]` entry, as the pack declares it. */
export interface SequenceDefinition {
  key: string;
  label: string;
  trigger: { entityType: string; when: unknown };
  steps: Array<{ templateKey: string; afterHours?: number; when?: unknown }>;
  stopWhen?: unknown;
  stopOnReply?: boolean;
  maxMessages?: number;
}

export interface SequenceRunSummary {
  tenantsScanned: number;
  sequencesEvaluated: number;
  enrolled: number;
  sent: number;
  stopped: number;
  /**
   * A step that was NOT sent because its rendered subject/body still
   * declared a variable neither the sequence runner nor the pack could
   * supply — CLAUDE.md §5.2's `documentTemplates[].requires` reasoning
   * applied to outbound messaging: a client must never receive a literal
   * `{{portalUrl}}` in their inbox. A pack authoring error rather than a
   * code fault, but the refusal is what keeps it from becoming a client's
   * problem too. The step still counts as attempted (`sendDueSteps` always
   * advances `stepsSent`) so a permanently-unresolvable template cannot loop
   * a sequence forever — it is reported here instead, once per attempt.
   */
  refused: Array<{
    sequenceKey: string;
    templateKey: string;
    entityId: string;
    variables: string[];
  }>;
  invalidSequences: Array<{
    tenantId: string;
    sequenceKey: string;
    reason: string;
  }>;
}

/** Same reasoning as the alert sweep: one tenant's data volume must not starve the rest. */
const MAX_ENTITIES_PER_SEQUENCE = 2_000;

/**
 * Multi-step outbound messaging, driven entirely by the pack.
 *
 * Payment reminders, RFI follow-ups, document chasers, onboarding nurture,
 * newsletters — eight separately-named features across the two specs that are
 * one state machine (docs/FEATURE_PARITY_MAP.md §5, item 4). Core supplies the
 * machine; the vertical supplies the trigger, the steps and the words.
 */
@Injectable()
export class SequenceRunnerService {
  private readonly logger = new Logger(SequenceRunnerService.name);

  constructor(
    @InjectRepository(SequenceEnrolment)
    private readonly enrolmentRepo: Repository<SequenceEnrolment>,
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly evaluator: RuleEvaluatorService,
    private readonly packs: VerticalPackService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Enrol newly-matching records and send whatever steps are now due.
   *
   * Tenant enumeration runs as system because crossing tenants is the job;
   * each tenant's work is then bound to that tenant so the database enforces
   * isolation (CLAUDE.md §6.4).
   */
  async run(now: Date = new Date()): Promise<SequenceRunSummary> {
    const summary: SequenceRunSummary = {
      tenantsScanned: 0,
      sequencesEvaluated: 0,
      enrolled: 0,
      sent: 0,
      stopped: 0,
      refused: [],
      invalidSequences: [],
    };

    const tenants = await TenantContext.runAsSystem(
      'sequence runner: enumerate tenants',
      () =>
        this.tenantRepo.find({
          where: { status: In([TenantStatus.ACTIVE, TenantStatus.TRIAL]) },
        }),
    );

    for (const tenant of tenants) {
      const messaging = await TenantContext.runAsSystem(
        'sequence runner: read pack',
        () =>
          this.packs.section<{ sequences?: SequenceDefinition[] }>(
            tenant.vertical,
            'messaging',
          ),
      );

      const sequences = messaging?.sequences ?? [];
      if (!sequences.length) continue;
      summary.tenantsScanned++;

      await TenantContext.run({ tenantId: tenant.id }, async () => {
        for (const sequence of sequences) {
          await this.runSequence(tenant, sequence, now, summary);
        }
      });
    }

    this.logger.log(
      `Sequence run: ${summary.tenantsScanned} tenants, ` +
        `${summary.sequencesEvaluated} sequences → enrolled ${summary.enrolled}, ` +
        `sent ${summary.sent}, stopped ${summary.stopped}`,
    );

    return summary;
  }

  private async runSequence(
    tenant: Tenant,
    sequence: SequenceDefinition,
    now: Date,
    summary: SequenceRunSummary,
  ): Promise<void> {
    // Validate every condition the sequence carries before it can enrol
    // anybody. A trigger that cannot compile would otherwise throw mid-sweep;
    // a stop condition that cannot compile is worse, because the sequence
    // would enrol correctly and then never stop.
    for (const [label, condition] of [
      ['trigger.when', sequence.trigger?.when],
      ['stopWhen', sequence.stopWhen],
      ...sequence.steps.map(
        (s, i) => [`steps[${i}].when`, s.when] as [string, unknown],
      ),
    ] as Array<[string, unknown]>) {
      if (condition === undefined || condition === null) continue;
      const check = this.evaluator.validate(condition);
      if (!check.valid) {
        summary.invalidSequences.push({
          tenantId: tenant.id,
          sequenceKey: sequence.key,
          reason: `${label}: ${check.reason}`,
        });
        this.logger.error(
          `Sequence '${sequence.key}' (${tenant.vertical}) has an unevaluable ` +
            `${label} and was skipped: ${check.reason}`,
        );
        return;
      }
    }

    if (!sequence.steps.length) return;
    summary.sequencesEvaluated++;

    const entities = await this.entityRepo.find({
      where: {
        tenantId: tenant.id,
        type: sequence.trigger.entityType as UniversalEntity['type'],
        deletedAt: IsNull(),
      },
      take: MAX_ENTITIES_PER_SEQUENCE,
      order: { updatedAt: 'DESC' },
    });

    const enrolments = await this.enrolmentRepo.find({
      where: { tenantId: tenant.id, sequenceKey: sequence.key },
    });
    const byEntity = new Map(enrolments.map((e) => [e.entityId, e]));

    for (const entity of entities) {
      const data = entity as unknown as Record<string, unknown>;
      let enrolment = byEntity.get(entity.id);

      // A stopped enrolment is final. Re-enrolling on a later match would
      // restart a sequence someone was deliberately taken out of — including
      // one stopped because they replied.
      if (enrolment?.stoppedAt) continue;

      if (!enrolment) {
        if (!this.evaluator.matches(sequence.trigger.when, data)) continue;

        enrolment = this.enrolmentRepo.create({
          tenantId: tenant.id,
          sequenceKey: sequence.key,
          entityId: entity.id,
          entityType: entity.type,
          enrolledAt: now,
          stepsSent: 0,
          lastSentAt: null,
          stoppedAt: null,
          stopReason: null,
        });
        summary.enrolled++;
      }

      const stop = this.stopReasonFor(sequence, enrolment, data);
      if (stop) {
        enrolment.stoppedAt = now;
        enrolment.stopReason = stop;
        await this.enrolmentRepo.save(enrolment);
        summary.stopped++;
        continue;
      }

      await this.sendDueSteps(tenant, sequence, enrolment, entity, now, summary);
      await this.enrolmentRepo.save(enrolment);
    }
  }

  /**
   * Why this enrolment should end, or null to continue.
   *
   * Checked before every send, not only at enrolment: the whole hazard of
   * automated messaging is continuing to ask someone for something they have
   * already done, which is the single most reliable way to damage a client
   * relationship with software.
   */
  private stopReasonFor(
    sequence: SequenceDefinition,
    enrolment: SequenceEnrolment,
    data: Record<string, unknown>,
  ): string | null {
    if (sequence.stopWhen && this.evaluator.matches(sequence.stopWhen, data)) {
      return 'stop_condition';
    }

    // The trigger no longer holding is itself a stop condition. A document
    // chaser must stop when the document arrives even if the pack author
    // forgot to write `stopWhen` — the trigger already encodes "still needs
    // chasing".
    if (!this.evaluator.matches(sequence.trigger.when, data)) {
      return 'trigger_cleared';
    }

    if (sequence.stopOnReply !== false && this.hasRepliedSince(data, enrolment)) {
      return 'replied';
    }

    const max = sequence.maxMessages ?? 5;
    if (enrolment.stepsSent >= Math.min(max, sequence.steps.length)) {
      return enrolment.stepsSent >= max ? 'max_messages' : 'completed';
    }

    return null;
  }

  /**
   * Whether the recipient answered since enrolling.
   *
   * Honest limitation: COM is a one-way delivery log with no inbound channel
   * and no thread key, so nothing in this system currently sets `repliedAt`.
   * The check reads a `repliedAt` / `lastInboundAt` attribute so that whatever
   * lands first — an inbound webhook, an IMAP poller, a portal reply — makes
   * `stopOnReply` work without touching this file. Until then the flag is
   * declared and inert, and saying so is better than implying a guard that
   * does not exist.
   */
  private hasRepliedSince(
    data: Record<string, unknown>,
    enrolment: SequenceEnrolment,
  ): boolean {
    const attrs = (data.verticalAttributes ?? {}) as Record<string, unknown>;
    const raw = attrs.repliedAt ?? attrs.lastInboundAt;
    if (typeof raw !== 'string' && !(raw instanceof Date)) return false;

    const repliedAt = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(repliedAt.getTime())) return false;

    return repliedAt.getTime() > enrolment.enrolledAt.getTime();
  }

  /**
   * Send every step whose delay has elapsed.
   *
   * Delays are measured from enrolment rather than from the previous send, so
   * a sweep that does not run for a day does not push the entire remaining
   * schedule a day later — it catches up. That also means a long outage can
   * make two steps due at once, which is why sending is capped by
   * `maxMessages` here and not only in the stop check.
   */
  private async sendDueSteps(
    tenant: Tenant,
    sequence: SequenceDefinition,
    enrolment: SequenceEnrolment,
    entity: UniversalEntity,
    now: Date,
    summary: SequenceRunSummary,
  ): Promise<void> {
    const max = sequence.maxMessages ?? 5;
    const elapsedHours =
      (now.getTime() - enrolment.enrolledAt.getTime()) / 3_600_000;

    for (let i = enrolment.stepsSent; i < sequence.steps.length; i++) {
      if (enrolment.stepsSent >= max) break;

      const step = sequence.steps[i];
      if (elapsedHours < (step.afterHours ?? 0)) break;

      const data = entity as unknown as Record<string, unknown>;
      if (step.when && !this.evaluator.matches(step.when, data)) {
        // A step whose own condition fails is skipped, not deferred —
        // otherwise one unmet condition stalls the rest of the sequence
        // forever.
        enrolment.stepsSent = i + 1;
        continue;
      }

      const sent = await this.send(tenant, sequence, step, entity, summary);
      enrolment.stepsSent = i + 1;
      if (sent) {
        enrolment.lastSentAt = now;
        summary.sent++;
      }
    }

    if (enrolment.stepsSent >= Math.min(max, sequence.steps.length)) {
      enrolment.stoppedAt = now;
      enrolment.stopReason =
        enrolment.stepsSent >= max ? 'max_messages' : 'completed';
      summary.stopped++;
    }
  }

  private async send(
    tenant: Tenant,
    sequence: SequenceDefinition,
    step: { templateKey: string },
    entity: UniversalEntity,
    summary: SequenceRunSummary,
  ): Promise<boolean> {
    const attrs = entity.verticalAttributes ?? {};
    const variables = SequenceRunnerService.variablesFor(tenant, entity);

    // `welcome_client` declares `{{portalUrl}}` and nothing supplied it —
    // the same defect class `uploadUrl` was (`document-request.service.ts`).
    // Set CONDITIONALLY, never to a placeholder: `renderTemplate` does
    // `String(value)`, so an empty or undefined value would render as `''`
    // or the literal text "undefined" and pass the unrendered-variable check
    // — a client reading "Sign in: undefined" in the first email their firm
    // sends them. Absent, the placeholder survives and the refusal below
    // reports it by name in `summary.refused` instead.
    const portalUrl = await this.portalUrlFor(tenant.vertical);
    if (portalUrl) variables.portalUrl = portalUrl;

    try {
      // Render FIRST and refuse to dispatch a template this sweep cannot
      // fully fill — the same discipline `DocumentRequestService.
      // sendRequestTemplate` already uses, and CLAUDE.md §5.2's
      // `documentTemplates[].requires` reasoning applied here: a client must
      // never receive a literal `{{portalUrl}}` in their inbox. This used to
      // dispatch first and only inspect the rendered text for leftover
      // placeholders afterwards — by then the client already had it.
      //
      // Vertical-neutral, deliberately: a GRC tenant's `welcome_client` (same
      // unfilled `{{portalUrl}}`, no `clientPortalUrl` authored into
      // `grc.json`) is refused exactly the same way an ImmiStack tenant's
      // would be if its pack similarly lacked a variable. Nothing here knows
      // or cares which vertical it is.
      const rendered = await this.notifications.renderTemplate(
        tenant.id,
        step.templateKey,
        variables,
        tenant.vertical,
      );

      if (rendered.unrendered.length) {
        summary.refused.push({
          sequenceKey: sequence.key,
          templateKey: step.templateKey,
          entityId: entity.id,
          variables: rendered.unrendered,
        });
        // Variable NAMES only — never the rendered subject/body and never a
        // recipient address. The names are pack vocabulary (`portalUrl`,
        // `contactName`), not this record's data.
        this.logger.warn(
          `Sequence '${sequence.key}' refused to send template ` +
            `'${step.templateKey}': unresolved variable(s) ` +
            `${rendered.unrendered.join(', ')} — the template declares ` +
            `variable(s) this sweep cannot supply.`,
        );
        return false;
      }

      await this.notifications.sendFromTemplate(
        tenant.id,
        step.templateKey,
        // The recipient is a CRM record, not a platform user, so its id goes
        // in `recipientId` and the address travels with it — see the options
        // note on sendFromTemplate.
        entity.id,
        variables,
        tenant.vertical,
        {
          recipientEmail:
            entity.email ??
            (typeof attrs.email === 'string' ? attrs.email : null),
          metadata: {
            sequenceKey: sequence.key,
            templateKey: step.templateKey,
            entityId: entity.id,
          },
        },
      );

      return true;
    } catch (err) {
      // One undeliverable message must not stall the enrolment or abandon the
      // tenants queued behind this one. The step still counts as attempted, so
      // a permanently-bad address cannot loop forever.
      this.logger.error(
        `Sequence '${sequence.key}' step '${step.templateKey}' failed for ` +
          `entity ${entity.id}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  /**
   * The variables a sequence step can render — the record's vertical
   * attributes plus the handful every template in both packs relies on.
   * Shared with the preview route so a preview renders exactly what a send
   * would.
   */
  static variablesFor(
    tenant: Pick<Tenant, 'name'>,
    entity: UniversalEntity,
  ): Record<string, unknown> {
    const attrs = entity.verticalAttributes ?? {};
    return {
      ...attrs,
      firstName: entity.firstName ?? '',
      lastName: entity.lastName ?? '',
      // Every client-facing template in both packs greets on behalf of the
      // firm, and the firm is the tenant — so this is always available and
      // there is no reason to make a pack author carry it in every record.
      firmName: tenant.name ?? '',
      entityId: entity.id,
      entityType: entity.type,
      dueDate: entity.dueDate?.toISOString() ?? '',
    };
  }

  /**
   * Where a client signs in to their portal, read from the pack.
   *
   * Same reasoning as `DocumentRequestService.uploadUrlFor`
   * (`src/documents/document-request.service.ts`), which this deliberately
   * mirrors: core does not know the vertical UI's login path — hardcoding it,
   * or holding a base URL and appending one, is the 80/20 rule in reverse
   * (CLAUDE.md §7.1). The pack authors the whole absolute URL; this reads it
   * and passes it through unmodified.
   *
   * `null` when the pack declares none — a real state, not a bug. A GRC
   * tenant's `welcome_client` template keeps today's behaviour (unrendered
   * `portalUrl`, reported by the caller) until GovernanceX's own portal URL
   * is authored into `grc.json`'s `uiConfig`, which is a pack-authoring
   * change, not a code change, and out of scope here.
   *
   * Public so `MessagingController`'s preview route can render exactly what
   * a send would, the same guarantee `variablesFor` above documents.
   */
  async portalUrlFor(vertical: string | null): Promise<string | null> {
    // Tenant scope: `forVertical` reads the ambient `TenantContext` tenant to
    // honour a config pin and otherwise serves the vertical's base pack. No
    // tenant data is read here — a config pack is platform-global — so there
    // is nothing for RLS to confine and nothing that could cross a tenant.
    const pack = await this.packs.forVertical(vertical);
    const url = (pack?.uiConfig as Record<string, unknown> | undefined)
      ?.clientPortalUrl;
    return typeof url === 'string' && url.trim() ? url : null;
  }

  /** The pack's `messaging.sequences[]` for a vertical — what a UI lists. */
  async definitions(vertical: string | null): Promise<SequenceDefinition[]> {
    const section = await this.packs.section<{ sequences?: SequenceDefinition[] }>(
      vertical,
      'messaging',
    );
    return section?.sequences ?? [];
  }

  /** Enrolments for one sequence, optionally filtered by state. */
  async enrolments(
    tenantId: string,
    sequenceKey: string,
    status: 'active' | 'stopped' | 'all' = 'all',
    limit = 200,
  ): Promise<SequenceEnrolment[]> {
    const where: Record<string, unknown> = { tenantId, sequenceKey };
    if (status === 'active') where.stoppedAt = IsNull();
    if (status === 'stopped') where.stoppedAt = Not(IsNull());
    return this.enrolmentRepo.find({
      where,
      order: { enrolledAt: 'DESC' },
      take: limit,
    });
  }

  /** Active / stopped counts per sequence key, one query. */
  async counts(
    tenantId: string,
  ): Promise<Record<string, { active: number; stopped: number }>> {
    const rows = await this.enrolmentRepo
      .createQueryBuilder('e')
      .select('e.sequenceKey', 'sequenceKey')
      .addSelect('COUNT(*) FILTER (WHERE e."stoppedAt" IS NULL)', 'active')
      .addSelect('COUNT(*) FILTER (WHERE e."stoppedAt" IS NOT NULL)', 'stopped')
      .where('e."tenantId" = :tenantId', { tenantId })
      .groupBy('e.sequenceKey')
      .getRawMany<{ sequenceKey: string; active: string; stopped: string }>();
    const out: Record<string, { active: number; stopped: number }> = {};
    for (const r of rows) {
      out[r.sequenceKey] = { active: Number(r.active), stopped: Number(r.stopped) };
    }
    return out;
  }

  /**
   * Enrol one record by hand. The runner enrols on trigger match; this is for
   * "send this client the onboarding nurture now" without waiting for the
   * sweep, and for records the trigger would never match. Idempotent on an
   * active enrolment; a stopped one is re-opened with its step counter reset.
   */
  async enrol(
    tenantId: string,
    vertical: string | null,
    sequenceKey: string,
    entityId: string,
    now: Date = new Date(),
  ): Promise<{ enrolment: SequenceEnrolment; created: boolean }> {
    const definition = (await this.definitions(vertical)).find(
      (d) => d.key === sequenceKey,
    );
    if (!definition) {
      throw new NotFoundException(
        `No sequence '${sequenceKey}' in the pack for vertical '${vertical ?? 'none'}'`,
      );
    }
    const entity = await this.entityRepo.findOne({
      where: { id: entityId, tenantId },
    });
    if (!entity) throw new NotFoundException(`Entity ${entityId} not found`);
    if (entity.type !== definition.trigger.entityType) {
      throw new BadRequestException(
        `Sequence '${sequenceKey}' is for '${definition.trigger.entityType}' records; ${entityId} is a '${entity.type}'`,
      );
    }

    const existing = await this.enrolmentRepo.findOne({
      where: { tenantId, sequenceKey, entityId },
    });
    if (existing && !existing.stoppedAt) {
      return { enrolment: existing, created: false };
    }
    const enrolment = this.enrolmentRepo.create({
      ...(existing ?? {}),
      tenantId,
      sequenceKey,
      entityId,
      entityType: entity.type,
      enrolledAt: now,
      stepsSent: 0,
      lastSentAt: null,
      stoppedAt: null,
      stopReason: null,
    });
    return {
      enrolment: await this.enrolmentRepo.save(enrolment),
      created: !existing,
    };
  }

  /** Stop an enrolment by hand. No-op on one already stopped (its reason is kept). */
  async stop(
    tenantId: string,
    sequenceKey: string,
    entityId: string,
    now: Date = new Date(),
  ): Promise<SequenceEnrolment> {
    const enrolment = await this.enrolmentRepo.findOne({
      where: { tenantId, sequenceKey, entityId },
    });
    if (!enrolment) {
      throw new NotFoundException(
        `Entity ${entityId} is not enrolled in '${sequenceKey}'`,
      );
    }
    if (enrolment.stoppedAt) return enrolment;
    enrolment.stoppedAt = now;
    enrolment.stopReason = 'manual';
    return this.enrolmentRepo.save(enrolment);
  }

  /** Active enrolments for a tenant — what a sequences page renders. */
  async listActive(tenantId: string, limit = 200): Promise<SequenceEnrolment[]> {
    return this.enrolmentRepo.find({
      where: { tenantId, stoppedAt: IsNull() },
      order: { enrolledAt: 'DESC' },
      take: limit,
    });
  }
}
