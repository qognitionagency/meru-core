import { TenantContext } from './tenant-context';

/**
 * ADR 0018 — one shared helper for every scheduled job that has to enumerate
 * work across every tenant and then process it.
 *
 * The failure this exists to close: a background sweep runs outside a
 * request, so `TenantContext.get()` is `undefined`, the pooled connection
 * binds `app.current_tenant_id = ''`, and every RLS policy on every
 * tenant-scoped table evaluates to zero rows — silently, because a query
 * blocked by RLS and a query that genuinely found nothing return the
 * identical shape, `[]`. See `docs/adr/0018-scheduled-job-tenant-context-and-scope-evidence.md`.
 *
 * The fix: enumerate cross-tenant work in a single system-context query
 * (the one place a sweep legitimately has to see across tenants), then bind
 * *each item* to its own tenant for the full duration of processing it —
 * reads and writes both. RLS stays the enforcement boundary throughout;
 * nothing runs under an open-ended bypass longer than the single query that
 * has to cross tenants to find the work. `queue-drain` does not use this
 * helper — its claim is inherently cross-tenant by priority ordering
 * (`FOR UPDATE SKIP LOCKED`), so it binds in two phases by hand
 * (`queue.processor.ts`), documented as the one structural exception.
 */
export interface SweepFailure {
  tenantId: string;
  itemId?: string;
  message: string;
}

export interface SweepScope {
  /** Distinct tenants represented among the rows the enumeration query found. */
  eligible: number;
  /**
   * Distinct tenants for which at least one item was bound and processed
   * without throwing. The number that matters: `eligible > 0 && scanned === 0`
   * is the RLS-blocked signature, not a legitimate empty result.
   */
  scanned: number;
  itemsFound: number;
  itemsProcessed: number;
  failures: SweepFailure[];
}

/**
 * `job_runs.scope` — where `SweepFailure[]` ultimately lands — is
 * platform-global and carries no RLS of its own (§3.3 of ADR 0018): any
 * `platform_admin` can read it, regardless of which tenant's item failed. A
 * raw `error.message` routinely interpolates tenant data — an amount, a
 * pack-authored state name, occasionally a name (see the arrears message in
 * `workflow.service.ts`'s `transition()`) — so this never stores one
 * verbatim. It records what the error *is* (its class, and a `code`
 * property when the error carries one, which every `HttpException` subclass
 * and this repo's own typed errors do), not what it interpolated, and caps
 * the result well under any reasonable column or log-line limit.
 */
const MAX_FAILURE_MESSAGE_LENGTH = 300;

function summariseFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error).slice(0, MAX_FAILURE_MESSAGE_LENGTH);
  }
  const name = error.constructor?.name || error.name || 'Error';
  const code = (error as { code?: unknown }).code;
  const summary = code ? `${name} (${String(code)})` : name;
  return summary.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

export async function runTenantBoundSweep<
  T extends { tenantId: string; id?: string },
>(
  reason: string,
  enumerate: () => Promise<T[]>,
  fn: (item: T) => Promise<void>,
): Promise<SweepScope> {
  const items = await TenantContext.runAsSystem(`${reason}: enumerate`, enumerate);
  const failures: SweepFailure[] = [];
  const scannedTenants = new Set<string>();
  let processed = 0;

  for (const item of items) {
    try {
      // `TenantContext.run`, not `runAsSystem`: `run()` replaces the store
      // outright rather than merging it, so an inherited `bypass` (e.g. an
      // operator's `runAsGod` invoking this sweep manually) is dropped the
      // moment per-item binding starts. Both entrypoints — Vercel Cron and a
      // human "run now" — process every item under genuine RLS enforcement.
      await TenantContext.run({ tenantId: item.tenantId }, () => fn(item));
      processed++;
      scannedTenants.add(item.tenantId);
    } catch (error) {
      failures.push({
        tenantId: item.tenantId,
        itemId: item.id,
        message: summariseFailure(error),
      });
    }
  }

  return {
    eligible: new Set(items.map((i) => i.tenantId)).size,
    scanned: scannedTenants.size,
    itemsFound: items.length,
    itemsProcessed: processed,
    failures,
  };
}
