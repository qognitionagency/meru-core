import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { TenantContext } from '../core/tenancy/tenant-context';
import { SYSTEM_ACTOR } from '../common/access';
import { AuditService } from './audit.service';
import { AuditReconcileStore, ReconcileCursor } from './audit-reconcile.store';
import { AuditAction, AuditLog, AuditSeverity } from './entities/audit-log.entity';

/**
 * ADR 0023 D15 item 2 (Anton, AC.C2) — closes every strict-change request that
 * was left without an outcome.
 *
 * `IamService.auditedChange` writes `<x>.requested` strictly BEFORE a
 * security-posture change and a best-effort outcome after it (the applied row,
 * or `<x>.not_applied`). If the process dies between the change and the
 * outcome, the request stands alone and nobody can tell from the trail whether
 * the change happened. This job finds those requests once they are older than
 * N minutes and writes `<x>.reconciled` with the same `changeId` and a
 * `context.outcome`:
 *
 *  - `applied` — a state reader for the family says the entity's current state
 *    is what was requested, and no later request exists for the entity;
 *  - `not_applied` — the reader says it differs, and no later request exists;
 *  - `indeterminate` — a later request exists for the same entity, the entity
 *    is gone, the reader could not tell or failed, or **no reader exists for
 *    the family**.
 *
 * It never assumes `applied`. Every reconciled row is an alert.
 *
 * **State readers.** Today none is registered, so every outcome is
 * `indeterminate` with `outcomeReason: 'no_state_reader'`. Reading a user's
 * current role, status or MFA flag is IAM state; the reader belongs in
 * `src/iam` and is provided under {@link AUDIT_STATE_READERS}. This module
 * deliberately does not reach into the `users` table itself.
 *
 * **Tenancy.** Runs under `TenantContext.runAsSystem`: it reads across
 * tenants by design, so RLS is bypassed and does not scope it. Every read
 * after the candidate scan carries the request row's `tenantId` explicitly
 * (`AuditReconcileStore`), every returned row's tenant is checked again here,
 * a state reader is called with the request's `tenantId`, and the reconciled
 * row is written into the request row's tenant through `AuditService.logEvent`
 * (which holds that tenant's chain lock).
 */

export type ReconcileOutcome = 'applied' | 'not_applied' | 'indeterminate';

export type ReconcileOutcomeReason =
  | 'state_matches'
  | 'state_differs'
  | 'later_request'
  | 'entity_gone'
  | 'state_unreadable'
  | 'no_state_reader';

/** What a state reader can say about the entity's current state. */
export type StateReading = 'applied' | 'not_applied' | 'entity_gone' | 'unknown';

/**
 * Compares an entity's current state with what a request asked for. Must
 * filter on `tenantId`: the reconciler calls it under `runAsSystem`.
 */
export interface AuditStateReader {
  /** Event families it answers for, e.g. `role.change` for `role.change.requested`. */
  readonly families: readonly string[];
  read(request: {
    tenantId: string;
    entityType: string;
    entityId: string;
    family: string;
    /** `context.requested` from the request row, when the writer set one. */
    requested: unknown;
  }): Promise<StateReading>;
}

/** Multi-provider token for {@link AuditStateReader}s. */
export const AUDIT_STATE_READERS = Symbol('AUDIT_STATE_READERS');

/**
 * The applied event for each `IamService.auditedChange` family. Needed because
 * one call can carry two steps under one `changeId` (role + status in
 * `updateUser`), and the applied name is not derivable from the request name
 * (`role.change.requested` → `role.changed`). A family missing here still
 * works for a single-step call — every other row of that call is its outcome —
 * but in a multi-step call it would be reconciled although it applied.
 * `audit-reconciler.spec.ts` reads `iam.service.ts` and fails when the two
 * disagree.
 */
export const APPLIED_EVENT_BY_FAMILY: Readonly<Record<string, string>> = {
  'mfa.enable': 'mfa.enabled',
  'mfa.disable': 'mfa.disabled',
  'role.change': 'role.changed',
  'status.change': 'status.changed',
};

/** ADR 0023 D15 proposes 15. `[UNVERIFIED: N — Anton to set.]` */
const DEFAULT_AFTER_MINUTES = 15;
const DEFAULT_PAGE_SIZE = 200;
/**
 * Own time budget, inside the tick's 45 s (`TICK_BUDGET_MS`). An engineering
 * choice, not a measured figure. When it runs out the summary says
 * `complete: false` and the job is recorded `suspect`. There is no persisted
 * cursor: the next run starts again from the oldest request that has no
 * outcome row. Answered requests are excluded in SQL and every orphan this run
 * handled now has a `.reconciled` row, so the next run does not re-walk them.
 * Requests answered only by `isAnswered`'s single-step fallback are the
 * exception and are still re-read.
 */
const DEFAULT_BUDGET_MS = 30_000;

const REQUESTED = '.requested';

const configLogger = new Logger('AuditReconcilerConfig');

/** N, from `AUDIT_RECONCILE_AFTER_MINUTES`; a bad value falls back to 15, loudly. */
export function reconcileAfterMinutes(): number {
  const raw = process.env.AUDIT_RECONCILE_AFTER_MINUTES;
  if (raw === undefined) return DEFAULT_AFTER_MINUTES;
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  // Too small a value would reconcile changes still in flight; refuse it.
  configLogger.warn(
    `AUDIT_RECONCILE_AFTER_MINUTES="${raw}" is not a positive integer; using ${DEFAULT_AFTER_MINUTES}`,
  );
  return DEFAULT_AFTER_MINUTES;
}

interface ReconciledEntry {
  tenantId: string;
  changeId: string;
  requestedEvent: string;
  outcome: ReconcileOutcome;
  outcomeReason: ReconcileOutcomeReason;
}

export interface ReconcileSummary {
  afterMinutes: number;
  cutoff: string;
  /** Stale request rows looked at, answered or not. */
  examined: number;
  reconciled: ReconciledEntry[];
  /** Reconciled rows that could not be written; those requests stay open. */
  failures: Array<{ tenantId: string; changeId: string; message: string }>;
  /** False when the time budget ran out before the scan finished. */
  complete: boolean;
  /** ADR 0018 §3: cross-tenant scan, no per-tenant enumeration to compare against. */
  scope: { eligible: null; scanned: number };
}

const ctx = (row: AuditLog): Record<string, unknown> =>
  (row.context as Record<string, unknown> | null) ?? {};
const eventOf = (row: AuditLog) =>
  typeof ctx(row).event === 'string' ? (ctx(row).event as string) : undefined;
const changeIdOf = (row: AuditLog) =>
  typeof ctx(row).changeId === 'string' ? (ctx(row).changeId as string) : undefined;

/** `role.change` for `role.change.requested`; undefined for any other event. */
function familyOf(event: string | undefined): string | undefined {
  return event?.endsWith(REQUESTED)
    ? event.slice(0, -REQUESTED.length)
    : undefined;
}

/**
 * Whether `request` has an outcome among `siblings` (rows of the same tenant
 * and `changeId`): its own `not_applied` or `reconciled`, the family's applied
 * event, or — in a single-step call — any non-request row of that call.
 */
function isAnswered(request: AuditLog, family: string, siblings: AuditLog[]): boolean {
  const others = siblings.filter((s) => s.id !== request.id);
  const singleStep = !others.some((s) => familyOf(eventOf(s)) !== undefined);
  const applied = APPLIED_EVENT_BY_FAMILY[family];

  return others.some((s) => {
    const event = eventOf(s);
    if (!event) return false;
    if (event === `${family}.not_applied` || event === `${family}.reconciled`) {
      return true;
    }
    if (applied && event === applied) return true;
    return singleStep && familyOf(event) === undefined;
  });
}

@Injectable()
export class AuditReconcilerService {
  private readonly logger = new Logger(AuditReconcilerService.name);
  private readonly readers = new Map<string, AuditStateReader>();

  constructor(
    private readonly store: AuditReconcileStore,
    private readonly audit: AuditService,
    @Optional()
    @Inject(AUDIT_STATE_READERS)
    readers?: AuditStateReader[],
  ) {
    for (const reader of readers ?? []) {
      for (const family of reader.families) this.readers.set(family, reader);
    }
  }

  reconcile(
    opts: {
      now?: Date;
      afterMinutes?: number;
      pageSize?: number;
      budgetMs?: number;
    } = {},
  ): Promise<ReconcileSummary> {
    return TenantContext.runAsSystem('audit reconcile (D15)', () =>
      this.sweep(opts),
    );
  }

  private async sweep(opts: {
    now?: Date;
    afterMinutes?: number;
    pageSize?: number;
    budgetMs?: number;
  }): Promise<ReconcileSummary> {
    const now = opts.now ?? new Date();
    const afterMinutes = opts.afterMinutes ?? reconcileAfterMinutes();
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
    const cutoff = new Date(now.getTime() - afterMinutes * 60_000);

    const summary: ReconcileSummary = {
      afterMinutes,
      cutoff: cutoff.toISOString(),
      examined: 0,
      reconciled: [],
      failures: [],
      complete: true,
      scope: { eligible: null, scanned: 0 },
    };

    let cursor: ReconcileCursor | null = null;
    for (;;) {
      if (Date.now() > deadline) {
        summary.complete = false;
        this.logger.warn(
          `Audit reconcile stopped at its time budget after ${summary.examined} requests; ` +
            'incomplete — the next run restarts from the oldest request with no outcome row',
        );
        break;
      }

      const page = await this.store.pageStaleRequests(
        cutoff,
        cursor,
        pageSize,
        APPLIED_EVENT_BY_FAMILY,
      );
      if (page.length === 0) break;
      summary.examined += page.length;
      const last = page[page.length - 1];
      cursor = { timestamp: last.timestamp, id: last.id };

      await this.reconcilePage(page, now, summary);

      if (page.length < pageSize) break;
    }

    summary.scope.scanned = summary.examined;
    return summary;
  }

  private async reconcilePage(
    page: AuditLog[],
    now: Date,
    summary: ReconcileSummary,
  ): Promise<void> {
    const byTenant = new Map<string, AuditLog[]>();
    for (const row of page) {
      byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row]);
    }

    for (const [tenantId, requests] of byTenant) {
      const changeIds = [
        ...new Set(requests.map(changeIdOf).filter((c): c is string => !!c)),
      ];
      // Tenant scope: the store filters on tenantId; checked again here.
      const siblings = (await this.store.findByChangeIds(tenantId, changeIds))
        .filter((s) => s.tenantId === tenantId);

      for (const request of requests) {
        const family = familyOf(eventOf(request));
        const changeId = changeIdOf(request);
        if (!family || !changeId) continue;

        const group = siblings.filter((s) => changeIdOf(s) === changeId);
        if (isAnswered(request, family, group)) continue;

        const { outcome, outcomeReason } = await this.decide(request, family, changeId);
        await this.writeReconciled(request, family, changeId, outcome, outcomeReason, now, summary);
      }
    }
  }

  private async decide(
    request: AuditLog,
    family: string,
    changeId: string,
  ): Promise<{ outcome: ReconcileOutcome; outcomeReason: ReconcileOutcomeReason }> {
    // Tenant scope: the store filters on tenantId; checked again here.
    const later = (
      await this.store.findLaterRequests(
        request.tenantId,
        request.entityType,
        request.entityId,
        request.timestamp,
        changeId,
      )
    ).filter(
      (r) =>
        r.tenantId === request.tenantId &&
        r.entityType === request.entityType &&
        r.entityId === request.entityId &&
        changeIdOf(r) !== changeId,
    );
    if (later.length > 0) {
      return { outcome: 'indeterminate', outcomeReason: 'later_request' };
    }

    const reader = this.readers.get(family);
    if (!reader) {
      return { outcome: 'indeterminate', outcomeReason: 'no_state_reader' };
    }

    let reading: StateReading;
    try {
      reading = await reader.read({
        tenantId: request.tenantId,
        entityType: request.entityType,
        entityId: request.entityId,
        family,
        requested: ctx(request).requested,
      });
    } catch (err) {
      this.logger.error(
        `Audit reconcile: state reader for ${family} failed (tenant ${request.tenantId}, changeId ${changeId}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return { outcome: 'indeterminate', outcomeReason: 'state_unreadable' };
    }

    switch (reading) {
      case 'applied':
        return { outcome: 'applied', outcomeReason: 'state_matches' };
      case 'not_applied':
        return { outcome: 'not_applied', outcomeReason: 'state_differs' };
      case 'entity_gone':
        return { outcome: 'indeterminate', outcomeReason: 'entity_gone' };
      default:
        return { outcome: 'indeterminate', outcomeReason: 'state_unreadable' };
    }
  }

  private async writeReconciled(
    request: AuditLog,
    family: string,
    changeId: string,
    outcome: ReconcileOutcome,
    outcomeReason: ReconcileOutcomeReason,
    now: Date,
    summary: ReconcileSummary,
  ): Promise<void> {
    const requestedEvent = `${family}${REQUESTED}`;
    const requested = ctx(request).requested;
    try {
      // No beforeState/afterState: this row states an outcome, not a change.
      // No impersonatedBy: that key is written only from the signed token
      // (ADR 0023 D13), never copied by a job.
      await this.audit.logEvent({
        tenantId: request.tenantId,
        userId: SYSTEM_ACTOR.id,
        action: AuditAction.UPDATE,
        entityType: request.entityType,
        entityId: request.entityId,
        severity: AuditSeverity.WARNING,
        description: `Reconciler closed ${requestedEvent} (changeId ${changeId}) with no outcome row: ${outcome}`,
        context: {
          event: `${family}.reconciled`,
          changeId,
          outcome,
          outcomeReason,
          requestedEvent,
          requestAuditId: request.id,
          requestedAt: request.timestamp.toISOString(),
          reconciledAt: now.toISOString(),
          ...(requested !== undefined ? { requested } : {}),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.failures.push({ tenantId: request.tenantId, changeId, message });
      this.logger.error(
        `Audit reconcile: could not write ${family}.reconciled (tenant ${request.tenantId}, changeId ${changeId}); ` +
          `the request stays open for the next run: ${message}`,
      );
      return;
    }

    summary.reconciled.push({
      tenantId: request.tenantId,
      changeId,
      requestedEvent,
      outcome,
      outcomeReason,
    });

    // The alert. `[UNVERIFIED: the alert channel — ADR 0023 §8 item 29,
    // Jonas.]` Until one is named this is an error-level log line, which is
    // what a log-based alert would match on. Ids only: no email, no
    // description (the request's description names the user's email).
    this.logger.error(
      `AUDIT RECONCILED: tenant=${request.tenantId} changeId=${changeId} ` +
        `event=${requestedEvent} entity=${request.entityType}/${request.entityId} ` +
        `outcome=${outcome} reason=${outcomeReason}`,
    );
  }
}
