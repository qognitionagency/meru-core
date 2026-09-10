import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UniversalEntity } from '../entities/universal-entity.entity';
import { Notification } from '../../notifications/entities/notification.entity';

/** One recorded stage change. Written by `CrmService.updateEntity`, never by a caller. */
export interface StageHistoryEntry {
  stage: string;
  /** ISO instant the change was recorded. */
  at: string;
  /** `users.id` of whoever made it, or null for a system write. */
  by: string | null;
}

export interface StageAging {
  /** The record's current stage, or null when it carries none. */
  value: string | null;
  /** When it entered that stage. Null when no change has been recorded. */
  since: string | null;
  /** Whole days in the current stage. **Null means unknown, never zero.** */
  days: number | null;
  /**
   * What the number is derived from:
   * - `stageChangeRecorded` — a real recorded transition into this stage.
   * - `unknown`             — no stage, or the stage predates stage recording.
   *
   * There is deliberately no `recordCreated` basis. Falling back to the
   * record's age would answer the question that was asked with a number that
   * measures something else, and it would look identical to a real one.
   */
  basis: 'stageChangeRecorded' | 'unknown';
  unavailableReason?: string;
  /** Most recent first, capped. Empty until a change is recorded. */
  history: StageHistoryEntry[];
}

export interface ClientContactAging {
  /** The instant of the most recent contact, or null when there is none. */
  at: string | null;
  /** Whole days since. **Null means no contact is recorded — never 0.** */
  days: number | null;
  channel: string | null;
  direction: 'inbound' | 'outbound' | null;
  unavailableReason?: string;
}

export interface EntityAging {
  entityId: string;
  /** Always knowable, and deliberately reported separately from stage age. */
  recordAge: { createdAt: string; days: number };
  stage: StageAging;
  lastClientContact: ClientContactAging;
}

/** How many stage changes are kept on the record. */
export const STAGE_HISTORY_LIMIT = 50;
/** How many are returned in an aging report. */
const STAGE_HISTORY_RETURNED = 20;

/**
 * Case aging — FR-5.10: days in the current stage, days since last client
 * contact.
 *
 * ## The rule this file exists to obey
 *
 * CLAUDE.md §5.2, in the sharpest form it takes anywhere in the product: **a
 * missing measurement is not a measurement of zero.** A case nobody has
 * contacted the client about does not have "0 days since last contact"; it has
 * no recorded contact, and the two render differently or a caseworker
 * de-prioritises the file that most needs chasing. Every field here is
 * therefore nullable with a stated reason, and there is no fallback that
 * quietly substitutes a different clock.
 *
 * ## What counts as client contact
 *
 * A message in `notifications` addressed to the record's `subjectEmail` that
 * either travelled inbound, or went out and was actually **sent** — `sentAt`
 * or `deliveredAt` is set. A `pending`, `queued` or `failed` row is not
 * contact: notification dispatch has been silently dead for 34 hours before
 * (AGENTS.md §2.1), and every one of those rows would have read as an
 * up-to-date file.
 *
 * **Known limitation, stated rather than papered over:** contact is matched by
 * the subject's email address across the tenant, so a message to the same
 * person about a *different* matter counts as contact on this one. Attributing
 * a message to a record needs a link column on `notifications` that does not
 * exist; inventing one from `threadKey` would be a guess. Per-matter contact
 * is a follow-up, not something to fake here.
 */
@Injectable()
export class CaseAgingService {
  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  /** Aging for one record. */
  async forEntity(
    tenantId: string,
    entity: UniversalEntity,
    now: Date = new Date(),
  ): Promise<EntityAging> {
    const contacts = await this.lastContactByEmail(tenantId, [entity]);
    return this.assemble(entity, contacts, now);
  }

  /**
   * Aging for a page of records — FR-5.10 asks for this "on the list", and a
   * per-row query would be 50 round trips per page on a serverless function
   * with a pool of one. One grouped statement instead.
   */
  async forEntities(
    tenantId: string,
    entities: UniversalEntity[],
    now: Date = new Date(),
  ): Promise<Map<string, EntityAging>> {
    const contacts = await this.lastContactByEmail(tenantId, entities);
    return new Map(
      entities.map((e) => [e.id, this.assemble(e, contacts, now)]),
    );
  }

  private assemble(
    entity: UniversalEntity,
    contacts: Map<string, { at: string; channel: string; direction: string }>,
    now: Date,
  ): EntityAging {
    const attrs = entity.verticalAttributes ?? {};
    const rawStage = attrs.stage;
    const stageValue = typeof rawStage === 'string' && rawStage ? rawStage : null;

    const history = CaseAgingService.historyOf(entity);
    const entered = history.find((h) => h.stage === stageValue) ?? null;

    let stage: StageAging;
    if (!stageValue) {
      stage = {
        value: null,
        since: null,
        days: null,
        basis: 'unknown',
        unavailableReason:
          'This record carries no stage, so time-in-stage does not apply to it.',
        history: history.slice(0, STAGE_HISTORY_RETURNED),
      };
    } else if (!entered) {
      stage = {
        value: stageValue,
        since: null,
        days: null,
        basis: 'unknown',
        unavailableReason:
          'No transition into this stage has been recorded, so how long the ' +
          'record has been here is unknown. It is not the age of the record.',
        history: history.slice(0, STAGE_HISTORY_RETURNED),
      };
    } else {
      stage = {
        value: stageValue,
        since: entered.at,
        days: CaseAgingService.daysBetween(new Date(entered.at), now),
        basis: 'stageChangeRecorded',
        history: history.slice(0, STAGE_HISTORY_RETURNED),
      };
    }

    const subject = entity.subjectEmail?.trim().toLowerCase() ?? null;
    const contact = subject ? contacts.get(subject) : undefined;

    let lastClientContact: ClientContactAging;
    if (!subject) {
      lastClientContact = {
        at: null,
        days: null,
        channel: null,
        direction: null,
        unavailableReason:
          'This record has no subject email, so messages cannot be attributed ' +
          'to the person it is about.',
      };
    } else if (!contact) {
      lastClientContact = {
        at: null,
        days: null,
        channel: null,
        direction: null,
        unavailableReason:
          'No sent or received message to this client is recorded. That is ' +
          'not the same as contact today.',
      };
    } else {
      lastClientContact = {
        at: contact.at,
        days: CaseAgingService.daysBetween(new Date(contact.at), now),
        channel: contact.channel,
        direction: contact.direction === 'inbound' ? 'inbound' : 'outbound',
      };
    }

    return {
      entityId: entity.id,
      recordAge: {
        createdAt: new Date(entity.createdAt).toISOString(),
        days: CaseAgingService.daysBetween(new Date(entity.createdAt), now),
      },
      stage,
      lastClientContact,
    };
  }

  /**
   * Most recent real contact per subject address, in one statement.
   *
   * `tenantId` is bound explicitly as well as by RLS — the app role has no
   * `BYPASSRLS`, so the policy is the boundary, and this predicate is the
   * second layer CLAUDE.md §5.1 asks for rather than a substitute for it.
   */
  private async lastContactByEmail(
    tenantId: string,
    entities: UniversalEntity[],
  ): Promise<Map<string, { at: string; channel: string; direction: string }>> {
    const emails = [
      ...new Set(
        entities
          .map((e) => e.subjectEmail?.trim().toLowerCase())
          .filter((e): e is string => !!e),
      ),
    ];
    if (!emails.length) return new Map();

    const rows: Array<{
      email: string;
      at: Date;
      channel: string;
      direction: string;
    }> = await this.notifications.query(
      `SELECT DISTINCT ON (LOWER(TRIM("recipientEmail")))
              LOWER(TRIM("recipientEmail")) AS email,
              CASE WHEN "direction" = 'inbound'
                   THEN "createdAt"
                   ELSE COALESCE("deliveredAt", "sentAt") END AS at,
              "type"::text AS channel,
              "direction"
         FROM "notifications"
        WHERE "tenantId" = $1
          AND LOWER(TRIM("recipientEmail")) = ANY($2)
          -- A queued or failed message is not contact. Dispatch has been dead
          -- for a day and a half before now without anything going red.
          AND ("direction" = 'inbound'
               OR COALESCE("deliveredAt", "sentAt") IS NOT NULL)
        ORDER BY LOWER(TRIM("recipientEmail")),
                 CASE WHEN "direction" = 'inbound'
                      THEN "createdAt"
                      ELSE COALESCE("deliveredAt", "sentAt") END DESC`,
      [tenantId, emails],
    );

    return new Map(
      rows.map((r) => [
        r.email,
        {
          at: new Date(r.at).toISOString(),
          channel: r.channel,
          direction: r.direction,
        },
      ]),
    );
  }

  /** Recorded stage changes, most recent first. Tolerates a malformed bag. */
  static historyOf(entity: UniversalEntity): StageHistoryEntry[] {
    const raw = (entity.metadata as Record<string, unknown> | undefined)
      ?.stageHistory;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is StageHistoryEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as StageHistoryEntry).stage === 'string' &&
          typeof (e as StageHistoryEntry).at === 'string',
      )
      .slice()
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  /** Whole days, floored, never negative. */
  static daysBetween(from: Date, to: Date): number {
    const ms = to.getTime() - from.getTime();
    return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
  }
}
