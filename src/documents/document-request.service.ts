import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UniversalEntity } from '../crm/entities/universal-entity.entity';
import { Tenant } from '../iam/entities/tenant.entity';
import { DocumentAccessService } from './document-access.service';
import { DocumentChecklistService } from './document-checklist.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VerticalPackService } from '../tenant/services/vertical-pack.service';
import type { Actor } from '../common/access';

/**
 * The two record fields the immigration pack's document chase reads.
 *
 * They are `verticalAttributes` keys, not columns: core knows "a record that
 * can be worked" and nothing about visas (CLAUDE.md §7.1). What core *does*
 * own is the generic lifecycle fact — documents were asked for, and documents
 * are all in — and `RuleEvaluatorService.augment` flattens
 * `verticalAttributes` one level, so a pack rule reads them as
 * `{"var": "documentsRequestedAt"}`.
 *
 * Named constants because two packs already reference them by string
 * (`verticals/immigration.json`: the `chase_outstanding_documents` sequence
 * and the `documents_outstanding_14d` alert rule) and nothing in `src` wrote
 * either one — the sequence was authored, validated, stored and had never
 * executed for any tenant.
 */
export const DOCUMENTS_REQUESTED_AT = 'documentsRequestedAt';
export const DOCUMENTS_RECEIVED_AT = 'documentsReceivedAt';

/** Why a receipt did not stamp `documentsReceivedAt`. Never "it did". */
export type IntakeOutcome =
  | 'received'
  /** Nothing was ever asked for on this record — see §7.3. */
  | 'no-request-recorded'
  | 'already-received'
  | 'entity-not-found'
  /** No pack resolved, so "is the checklist complete" is unknown. */
  | 'vertical-unresolved'
  | 'checklist-unavailable'
  | 'still-outstanding';

export interface IntakeResult {
  outcome: IntakeOutcome;
  receivedAt: string | null;
  /** From the pack checklist. `null` means unknown, never "none". */
  outstandingRequired: number | null;
}

export interface DocumentRequestResult {
  entityId: string;
  requestedAt: string;
  /** The previous request on this record, if it is being re-opened. */
  previouslyRequestedAt: string | null;
  outstandingRequired: number | null;
  outstanding: Array<{ key: string; label: string }>;
  /** Whether a message actually went to the client, and if not, why not. */
  notified: boolean;
  notNotifiedReason: string | null;
}

/**
 * "We have asked this client for documents", and "they are all in".
 *
 * Both facts existed only in someone's head. The pack authored a three-step
 * chase off `documentsRequestedAt` / `documentsReceivedAt` and neither field
 * was written anywhere in `src`, so FR-6.7-class missing-document chasing has
 * never fired — the fourth recurrence of the built-validated-stored-read-by-
 * nobody pattern this repo's own docs record.
 *
 * Two rules shape the design:
 *
 *  - **A chase must never fire for a document nobody asked for** (§7.3:
 *    "not asked" is not "missing"). So the trigger field is written by a
 *    deliberate act — a staff member requesting documents — and never
 *    inferred from a record merely existing.
 *  - **Core writes no client-facing prose.** The only message this service
 *    can send is a template the tenant's pack author wrote, addressed by key.
 *    That is what keeps an automated message administrative: core cannot
 *    compose immigration advice it has no authority to give, and cannot
 *    invent a consequence — no deadline, no threat to the client's access to
 *    their own documents.
 */
@Injectable()
export class DocumentRequestService {
  private readonly logger = new Logger(DocumentRequestService.name);

  constructor(
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly access: DocumentAccessService,
    private readonly checklist: DocumentChecklistService,
    private readonly notifications: NotificationsService,
    // Layer 4: `uiConfig.clientDocumentUploadUrl` — the one client-facing
    // URL this service sends, authored by the pack (see `uploadUrlFor`).
    private readonly packs: VerticalPackService,
  ) {}

  /**
   * Record that this record's documents have been asked for, and optionally
   * send the pack template that asks for them.
   *
   * Tenant scope: the record is loaded on `{ id, tenantId }` with `tenantId`
   * taken from the caller's JWT (never a header, never the body), on a
   * connection already bound to that tenant by `TenantBindingInterceptor`, so
   * RLS is the second of the two barriers. Within the tenant,
   * `assertOwnsEntity` is the user-scoping check RLS does not perform — the
   * route is staff-only, and this is what holds if that ever changes.
   */
  async recordRequest(params: {
    tenantId: string;
    vertical: string | null;
    actor: Actor;
    entityId: string;
    templateKey?: string;
    now?: Date;
  }): Promise<DocumentRequestResult> {
    const now = params.now ?? new Date();

    await this.access.assertOwnsEntity(
      params.tenantId,
      params.entityId,
      params.actor,
    );

    const entity = await this.entityRepo.findOne({
      where: { id: params.entityId, tenantId: params.tenantId },
    });
    if (!entity) throw new NotFoundException('Record not found');

    const attributes = { ...(entity.verticalAttributes ?? {}) } as Record<
      string,
      unknown
    >;
    const previous = attributes[DOCUMENTS_REQUESTED_AT];
    const requestedAt = now.toISOString();

    attributes[DOCUMENTS_REQUESTED_AT] = requestedAt;
    // A fresh request re-opens the loop: whatever arrived against the last
    // request no longer answers this one. Deleted rather than set to null, so
    // the record carries no key at all where nothing is known — the same
    // meaning `null` has on a `PATCH /crm/entities` deep-merge.
    delete attributes[DOCUMENTS_RECEIVED_AT];

    entity.verticalAttributes = attributes;
    await this.entityRepo.save(entity);

    const snapshot = await this.checklistSnapshot(
      params.tenantId,
      params.vertical,
      params.actor,
      params.entityId,
    );

    const { notified, reason } = await this.sendRequestTemplate(
      params,
      entity,
      snapshot,
    );

    this.logger.log(
      `Documents requested on ${entity.type} ${entity.id} ` +
        `(outstanding: ${snapshot.outstandingRequired ?? 'unknown'}, ` +
        `notified: ${notified})`,
    );

    return {
      entityId: entity.id,
      requestedAt,
      previouslyRequestedAt: typeof previous === 'string' ? previous : null,
      outstandingRequired: snapshot.outstandingRequired,
      outstanding: snapshot.outstanding,
      notified,
      notNotifiedReason: reason,
    };
  }

  /**
   * A document arrived against a record. Stamp `documentsReceivedAt` only when
   * the pack's required checklist is actually complete.
   *
   * Called after a document is filed, and deliberately conservative in one
   * direction only: it will keep a chase running when it should not (a client
   * uploaded a passport but the uploader tagged nothing, so the checklist
   * cannot match it), and it will never stop one on an assumption. Telling a
   * client we are still waiting costs them an email; recording "all documents
   * received" when they are not costs them a refusal.
   *
   * Never throws to its caller: an upload has already succeeded by the time
   * this runs, and a bookkeeping failure must not turn a stored document into
   * a 500.
   *
   * Tenant scope: as `recordRequest` — `{ id, tenantId }` from the JWT, on the
   * tenant-bound connection. `DocumentsService` has already asserted the
   * uploader may attach to this record before any of this runs.
   */
  async recordIntake(params: {
    tenantId: string;
    vertical: string | null;
    actor: Actor;
    entityId: string;
    now?: Date;
  }): Promise<IntakeResult> {
    const now = params.now ?? new Date();

    const entity = await this.entityRepo.findOne({
      where: { id: params.entityId, tenantId: params.tenantId },
    });
    if (!entity) {
      return {
        outcome: 'entity-not-found',
        receivedAt: null,
        outstandingRequired: null,
      };
    }

    const attributes = { ...(entity.verticalAttributes ?? {}) } as Record<
      string,
      unknown
    >;

    // Nothing was asked for, so nothing has been "received" against a request.
    // Stamping here would let a chase start already satisfied — and worse,
    // would leave a stale receipt sitting on the record for the next request
    // to trip over.
    if (!attributes[DOCUMENTS_REQUESTED_AT]) {
      return {
        outcome: 'no-request-recorded',
        receivedAt: null,
        outstandingRequired: null,
      };
    }

    const existing = attributes[DOCUMENTS_RECEIVED_AT];
    if (typeof existing === 'string' && existing) {
      return {
        outcome: 'already-received',
        receivedAt: existing,
        outstandingRequired: null,
      };
    }

    if (!params.vertical) {
      // No pack resolves without a vertical, so "is the checklist complete"
      // has no answer. Unknown is not complete.
      return {
        outcome: 'vertical-unresolved',
        receivedAt: null,
        outstandingRequired: null,
      };
    }

    const snapshot = await this.checklistSnapshot(
      params.tenantId,
      params.vertical,
      params.actor,
      params.entityId,
    );

    if (snapshot.outstandingRequired === null) {
      return {
        outcome: 'checklist-unavailable',
        receivedAt: null,
        outstandingRequired: null,
      };
    }

    if (snapshot.outstandingRequired > 0) {
      return {
        outcome: 'still-outstanding',
        receivedAt: null,
        outstandingRequired: snapshot.outstandingRequired,
      };
    }

    const receivedAt = now.toISOString();
    attributes[DOCUMENTS_RECEIVED_AT] = receivedAt;
    entity.verticalAttributes = attributes;
    await this.entityRepo.save(entity);

    this.logger.log(
      `All required documents received on ${entity.type} ${entity.id} — ` +
        `chase sequences stop on the next sweep`,
    );

    return { outcome: 'received', receivedAt, outstandingRequired: 0 };
  }

  /**
   * The pack checklist for one record, reduced to what both callers need.
   *
   * `outstandingRequired: null` is "we could not tell", which is why the
   * checklist's own 404s (no vertical, no active pack for it) are caught here
   * rather than propagated: neither is a reason to fail an upload, and neither
   * is evidence that a document arrived.
   */
  private async checklistSnapshot(
    tenantId: string,
    vertical: string | null,
    actor: Actor,
    entityId: string,
  ): Promise<{
    outstandingRequired: number | null;
    outstanding: Array<{ key: string; label: string }>;
  }> {
    if (!vertical) return { outstandingRequired: null, outstanding: [] };

    try {
      const checklist = await this.checklist.forEntity(
        tenantId,
        vertical,
        actor,
        entityId,
      );
      return {
        outstandingRequired: checklist.outstandingRequired,
        outstanding: checklist.items
          .filter((item) => item.required && item.uploaded === false)
          .map((item) => ({ key: item.key, label: item.label })),
      };
    } catch (err) {
      this.logger.warn(
        `Checklist unavailable for ${entityId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return { outstandingRequired: null, outstanding: [] };
    }
  }

  /**
   * How this record is named to the client who owns it.
   *
   * `recordNumber` first: it is server-assigned (ADR 0010), guaranteed on every
   * eligible record, never invented, and unmistakably a reference rather than a
   * name — which is what a sentence like "To move forward with {{entityLabel}}"
   * wants. The applicant's own name is the fallback, since addressing them by
   * their case is meaningless if there is no case number yet.
   *
   * Returns `null` rather than a stand-in when it has neither. `'Unknown'` or
   * an empty string in the middle of a client-facing sentence is exactly the
   * §7.3 mistake — missing data rendered as a result — and here it also
   * defeats the refuse-to-send check, which is the only thing keeping a
   * half-filled template out of an applicant's inbox.
   */
  private labelFor(entity: UniversalEntity): string | null {
    if (entity.recordNumber) return entity.recordNumber;
    const name = `${entity.firstName ?? ''} ${entity.lastName ?? ''}`.trim();
    return name || null;
  }

  /**
   * Where the client uploads what was asked for, read from the pack.
   *
   * Core does not know this URL and must not: a client-portal path is the
   * vertical UI's vocabulary (`/client/documents` on ImmiStack, something else
   * on GovernanceX), and hardcoding it here — or holding a base URL and
   * appending a path to it — is precisely what CLAUDE.md §7.1 forbids. The
   * pack authors the whole string; this reads it and passes it through.
   *
   * `null` when the pack declares none, which is a real state: the GRC pack
   * ships the same `document_request` template and no upload URL, because
   * whether GovernanceX has a counterparty-facing portal at all is an open
   * question rather than something to guess at. Those tenants keep today's
   * behaviour — request recorded, nothing sent, `uploadUrl` named in the
   * reason — instead of receiving a link into a product that may not exist.
   */
  private async uploadUrlFor(vertical: string | null): Promise<string | null> {
    // Tenant scope: `forVertical` reads the ambient `TenantContext` tenant to
    // honour a config pin and otherwise serves the vertical's base pack. No
    // tenant data is read here — a config pack is platform-global — so there
    // is nothing for RLS to confine and nothing that could cross a tenant.
    const pack = await this.packs.forVertical(vertical);
    const url = (pack?.uiConfig as Record<string, unknown> | undefined)
      ?.clientDocumentUploadUrl;
    return typeof url === 'string' && url.trim() ? url : null;
  }

  /**
   * Send the pack template that asks for the documents, if the caller named
   * one.
   *
   * Optional, and reported rather than assumed. A request recorded with no
   * message sent is a legitimate case — the firm asked on the phone — but it
   * must not *look* like the client was written to, because the chase that
   * follows in 72 hours is worded as a reminder of something already asked.
   */
  private async sendRequestTemplate(
    params: {
      tenantId: string;
      vertical: string | null;
      templateKey?: string;
    },
    entity: UniversalEntity,
    snapshot: {
      outstandingRequired: number | null;
      outstanding: Array<{ key: string; label: string }>;
    },
  ): Promise<{ notified: boolean; reason: string | null }> {
    if (!params.templateKey) {
      return {
        notified: false,
        reason:
          'No templateKey supplied: the request was recorded, nothing was sent from here.',
      };
    }

    const attributes = (entity.verticalAttributes ?? {}) as Record<
      string,
      unknown
    >;
    const email =
      entity.email ??
      (typeof attributes.email === 'string' ? attributes.email : null);
    if (!email) {
      return {
        notified: false,
        reason:
          'This record has no email address, so there was nowhere to send the request.',
      };
    }

    // Tenant scope: the firm's own row, by the id already on the request.
    // `firmName` is what every client-facing template in both packs greets on
    // behalf of — the same variable `SequenceRunnerService.variablesFor`
    // supplies, so a request and the chase that follows it are signed
    // identically.
    const tenant = await this.tenantRepo.findOne({
      where: { id: params.tenantId },
    });

    const variables: Record<string, unknown> = {
      ...attributes,
      firstName: entity.firstName ?? '',
      lastName: entity.lastName ?? '',
      firmName: tenant?.name ?? '',
      entityId: entity.id,
      entityType: entity.type,
      documentCount: snapshot.outstandingRequired ?? '',
      documentList: snapshot.outstanding
        .map((item) => `• ${item.label}`)
        .join('\n'),
    };

    // The two the `document_request` template declares and this route did not
    // supply — which is the whole defect: the stamp landed, the refuse-to-send
    // check below fired every time, and the chase arrived days later about
    // documents nobody had asked for.
    //
    // Both are set CONDITIONALLY, never to a placeholder. `renderTemplate`
    // does `String(value)` on whatever it is handed, so a key present with an
    // empty or undefined value renders as `''` or the literal `undefined` and
    // sails past the unrendered-variable check — a client receiving "You can
    // upload them here: undefined" is the §7.3 failure in email form. Absent,
    // the placeholder survives, the send is refused, and the reason names the
    // variable.
    const label = this.labelFor(entity);
    if (label) variables.entityLabel = label;

    const uploadUrl = await this.uploadUrlFor(params.vertical);
    if (uploadUrl) variables.uploadUrl = uploadUrl;

    try {
      // Render first, and refuse to send a template this route cannot fully
      // fill. Substitution leaves an unknown `{{placeholder}}` in place — the
      // right behaviour for the renderer, but it means a client receives a
      // literal `{{uploadUrl}}` in the first email their firm ever sends them.
      // The request is already recorded either way; what is reported back is
      // exactly which variables the pack template declares that nothing here
      // can supply, which is a pack-authoring error with a name rather than a
      // mystery in someone's inbox.
      const rendered = await this.notifications.renderTemplate(
        params.tenantId,
        params.templateKey,
        variables,
        params.vertical,
      );

      if (rendered.unrendered.length) {
        const reason =
          `Template '${params.templateKey}' was not sent: it declares ` +
          `variable(s) this route cannot supply — ` +
          `${rendered.unrendered.join(', ')}. The request is recorded; ` +
          `send the client a message by hand, or correct the template.`;
        this.logger.error(reason);
        return { notified: false, reason };
      }

      await this.notifications.sendFromTemplate(
        params.tenantId,
        params.templateKey,
        // The recipient is a CRM record, not a platform user, so the address
        // travels with the message — same contract the sequence runner uses.
        entity.id,
        variables,
        params.vertical,
        {
          recipientEmail: email,
          metadata: {
            templateKey: params.templateKey,
            entityId: entity.id,
            reason: 'document-request',
          },
        },
      );
      return { notified: true, reason: null };
    } catch (err) {
      // The request itself is already recorded and is the fact that matters;
      // a failed send is reported to the caller, not rolled back.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Document-request template '${params.templateKey}' failed for ${entity.id}: ${detail}`,
      );
      return { notified: false, reason: detail };
    }
  }
}
