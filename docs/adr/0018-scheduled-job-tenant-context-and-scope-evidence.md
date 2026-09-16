# 0018 — Scheduled jobs: system-context tenancy, scope evidence, and automated-actor attribution

**Status:** Proposed — 2026-09-16, amended 2026-09-17 with Anton's secops review findings
folded in (§2.5, §3.4, §4.3, §9's `queue.service.ts`/dead-code items). Still not merged —
requires Owen's gate per `definition-of-done.md`'s auth/tenancy gate, since this changes how
RLS is entered on nine write paths (eight in the original scope plus `queue.service.ts`'s
`processScheduledJobs`, found during the secops pass — §2.5). Implemented by Luke against §4
and §9 as amended. Owen gates it; Kyle does not merge his own work.

**Anton's review — five required changes, all folded into this text and implemented
alongside it (not deferred to a follow-up):**

1. `QueueService.processScheduledJobs` is a ninth job with the identical defect — §2.5, §9.14b.
2. Every `request.automated` transition writes a fail-closed audit entry — §4.3.
3. `SweepFailure.message` is capped and stripped of interpolated detail, never a raw
   `error.message` — §2.2, §3.4.
4. §2.1 states the in-memory cost of cross-tenant enumeration and prefers a narrowed `select`
   where cheap — §2.1.
5. The confirmed-dead `WorkflowEngineService.checkSLAViolations` is deleted, not left beside
   the real implementation — §9.16.

**Scope:** `NEXT-SESSION.md` §2c — eight scheduled jobs run outside a request, so
`TenantContext.get()` is `undefined`, the pooled connection binds
`app.current_tenant_id = ''`, every RLS policy on every tenant-scoped table evaluates to
zero rows, and `JobRunService` records `status: 'ok'`. This is RLS working exactly as
designed (`meru-core/CLAUDE.md` §5.1: "policies fail closed") applied to a caller nobody
built for — a background sweep that never entered a tenant.

---

## 1. Context

### 1.1 The bug, verified per job, not assumed

Six job handlers already enter `TenantContext.runAsSystem` (`src/core/tenancy/tenant-context.ts:78`)
before touching tenant-scoped tables: `src/rules/alert-rule.service.ts:109-136`,
`src/notifications/sequence-runner.service.ts` (`run()`), `src/audit/retention.service.ts`
(`sweep()`), `src/notifications/notification-dispatch.service.ts:54,346`,
`src/ai/engines/watchlist-ingest.service.ts`, `src/ai/engines/rescreening.service.ts`. Grepped
directly (`grep -rl runAsSystem src`), not inherited from a prior report.

The eight named in `NEXT-SESSION.md` §2c do not, **with one correction**:

| Job (`JOB_CADENCE_MINUTES` key) | Handler | `runAsSystem`? | Touches tenant-scoped tables? |
|---|---|---|---|
| `sla-watchdog` | `SlaWatchdogService.checkSLAViolations` (`src/workflow/services/sla-watchdog.service.ts:96`) | **No** | Yes — `workflow_instances`, writes via `WorkflowEngineService.transition` |
| `recurring-tasks` | `TaskService.processRecurringJobs` (`src/tasks/task.service.ts:460`) | **No** | Yes — `recurring_jobs` |
| `scheduled-notifications` | `NotificationsService.processScheduledNotifications` (`:543`) | **No** | Yes — `notifications` (read only; see §1.3) |
| `digest-emails` | `NotificationsService.sendDigestEmails` (`:559`) | **No** | Yes — `notification_preferences`, writes via `sendNotification` |
| `scheduled-reports` | `AnalyticsService.processScheduledReports` (`src/analytics/analytics.service.ts:459`) | **No** | Yes — `reports`, `report_executions` |
| `daily-billing` | `BillingService.processDailyBilling` (`src/billing/billing.service.ts:516`) | **No, confirmed** (task's own finding, re-verified) | Yes — `subscriptions`, writes `invoices` via `generateInvoice` |
| `queue-drain` | `QueueService.getNextJob` → `JobProcessor.drainQueue` (`src/queue/queue.processor.ts:36`, `src/queue/queue.service.ts:174`) | **No, confirmed** | Yes — `queue_jobs` |
| `regulatory-radar` | `RegulatoryRadarEngine.scheduledScan` (`src/ai/engines/regulatory-radar.engine.ts:212`) | **No** | **No.** No `@InjectRepository` in this class at all — grepped. It scans a fixed constant list of external regulator URLs (`MONITORED_SOURCES`), diffs a content hash held in an in-memory `Map`, and writes a proposed diff to the **filesystem** (`writeChangeProposal`, `:352`), not Postgres. |

**Correction to the problem statement: `regulatory-radar` is not part of this defect.** It has
no tenant-scoped read or write to be blocked by RLS. Including it in the fix would be motion
without effect. It is carried in §4.9 only for the scope-evidence plumbing (§3), and its
existing filesystem write is a separate, unrelated problem worth one line: `packages/config-packs/**`
is read-only outside `/tmp` on Vercel (`meru-core/CLAUDE.md` §8.5) — `writeChangeProposal`'s
`fs.mkdirSync`/write almost certainly fails on every production run. `[UNVERIFIED: whether
writeChangeProposal's own try/catch swallows that failure silently or surfaces it in
`errors` — worth Jonas confirming separately; out of scope here.]`

So the actual count is **seven**, not eight.

### 1.2 The failure is silent, and it is silent twice

`sla-watchdog.service.ts:110` logs `Found ${violations.length} SLA violations` — always 0,
forever — and `JobDispatchService.runNamed` (`src/jobs/job-dispatch.service.ts:94-100`) records
`status: 'ok'` on top of it, because the handler never threw. `GET /jobs/status` shows a green
tile for a watchdog that has never once escalated a breach. This is `CLAUDE.md` §5.2 ("unknown
is never clear") at the infrastructure layer: a query blocked by RLS and a query that
legitimately found nothing return the identical shape, `[]`, and nothing downstream can tell
them apart. §3 of this ADR is the fix for that, not just a side effect of §2.

### 1.3 A finding that changes the fix for one job: `scheduled-notifications` may be dead code

`NotificationsService.processScheduledNotifications` (`:543-556`) finds due rows and does
exactly one thing with them: `this.eventEmitter.emit('notification.created', notification)`.
Grepped for a listener (`grep -rn "'notification.created'" src`) — the only two hits are the
two `emit` call sites (`:142` and `:554`) themselves. **Nothing in `src` listens for this
event.** Actual delivery is `NotificationDispatchService.dispatchPending` (already fixed,
§1.1), which queries `PENDING`/`QUEUED` status directly and does not need this job to have run
first. `[UNVERIFIED: whether meru-core-fe listens for this event over a channel this repo
doesn't show — greeped meru-core-fe for the literal string, zero hits, but confirm before
deleting the job]`. This ADR fixes its tenancy gap in §4.4 regardless — deleting a job is a
product decision, not an architecture one, and is out of scope here — but flags it so nobody
spends effort making a possibly-dead job's zero-tenant bug disappear and calls that done.

### 1.4 Why manual "run now" masked this and the cron path didn't

`PlatformJobsController.run` (`src/jobs/platform-jobs.controller.ts:72-79`) wraps every job run
in `TenancyService.runAsGod(operatorId, operatorTenantId, reason, fn)`, which sets
`bypass: { kind: 'god', ... }` on the ambient `TenantStore` for the **entire** call, including
every downstream query the handler makes with no tenant filter. An operator clicking "run
now" in the God UI today gets a *working* sweep, because the whole thing runs RLS-bypassed by
accident of the caller, not by design of the job. The Vercel Cron / `CRON_SECRET` path
(`JobsController`, `@Public()`) has no such bypass — `TenantAlsMiddleware` opens an ALS store
with `tenantId: undefined` and nothing ever populates it, since there is no JWT for
`TenantBindingInterceptor` to read. **The same code behaves correctly from one entrypoint and
returns zero rows from the other**, which is exactly the shape of bug that survives manual
testing. §2's design closes this gap too: `TenantContext.run({ tenantId })` (not `runAsSystem`)
replaces the store outright rather than merging it, so an inherited `god` bypass from
`runAsGod` is dropped the moment per-item binding starts — both entrypoints behave identically
after this change.

### 1.5 The write phase has the same bug one call deeper

`applyRlsToDataSource` (`src/core/tenancy/rls.datasource.ts:77-134`) patches
`obtainMasterConnection`, the **one** choke point every repository call, every raw query and
every `dataSource.createQueryRunner()` transaction goes through, and reads `TenantContext.get()`
**at the moment the connection is checked out**. `WorkflowEngineService.transition`
(`src/workflow/workflow.service.ts:549-597`) opens its own `queryRunner` and updates
`WorkflowInstance` by id inside it; `BillingService.generateInvoice` (`:384`) does the same for
`Invoice`. Wrapping only the *read* that finds the due rows in `runAsSystem` and then calling
into these methods afterward — outside that wrap — reproduces the identical bug one level down:
the `find()` returns real rows, but the subsequent `UPDATE ... WHERE id = $1` runs under an
unbound connection, RLS's `WITH CHECK`/`USING` filters it to nothing, and a TypeORM `.update()`
by id **does not throw when it matches zero rows** — it just silently doesn't happen. Any design
that binds only the enumeration step and not the full per-item processing reintroduces this
defect; §2's helper wraps the **entire** per-item unit of work, reads and writes both, for
exactly this reason.

---

## 2. Decision

**One shared helper enters system context to enumerate cross-tenant work, then binds each
item to its own tenant for the full duration of processing that item — reads and writes both.
RLS stays the enforcement boundary throughout; nothing runs under an open-ended bypass longer
than the single query that has to cross tenants to find the work.**

### 2.1 Why per-item binding, not a whole-sweep bypass

Two patterns already exist in this codebase for exactly this problem, both shipped and
reviewed:

- **Per-tenant binding** (`alert-rule.service.ts:109-136`, `sequence-runner.service.ts`):
  enumerate tenants under `runAsSystem`, then `TenantContext.run({ tenantId: tenant.id }, ...)`
  around each tenant's entire unit of work. RLS enforces isolation for the duration.
- **Whole-sweep bypass** (`notification-dispatch.service.ts:54-124`, `retention.service.ts:59`):
  the entire read-and-write body runs inside one `runAsSystem` call, and every write derives
  its `tenantId` from the row being processed rather than from the (bypassed) ambient context.

The second pattern is real precedent, not a mistake — but `CLAUDE.md` §5.1 is explicit that
application-side filtering is not the isolation boundary, and this codebase has paid for that
gap five times already (`meru-core/CLAUDE.md` §8, the `/crm/entities` → `/payments` →
`/communications/threads` → `/documents` → `/documents/generate/:templateKey` sequence). A
whole-sweep bypass means: for the full duration of `processDailyBilling()` or
`checkSLAViolations()`, **every** tenant's rows are reachable by **every** query the handler
issues, with the database's own safety net switched off, relying entirely on hand-written
`tenantId` filters in application code never drifting. That is precisely the class of mistake
the five prior incidents were.

**Anton's review, point 4 — the enumeration window pulls full cross-tenant rows into memory.**
Every `enumerate()` under `runAsSystem` is a genuine, unfiltered cross-tenant read: `find()`
with no `select`, so every column of every eligible row across every tenant materialises in
the process's memory for the (short) duration of that one call before per-item binding starts.
That is the accepted cost of the design (§2 above: "nothing runs under an open-ended bypass
longer than the single query that has to cross tenants to find the work"), not a gap — the
alternative, per-tenant enumeration, is rejected in §6 for six of these seven jobs on its own
terms. Where a query is cheap to narrow and the handler does not need every column to decide
whether to act (`sla-watchdog`'s `WorkflowInstance` carries `context`/`history` jsonb columns
`processEscalation` does not read to decide *whether* to escalate, only to build the
notification body once it has), `enumerate()` should `select` the routing columns
(`id`, `tenantId`) plus what the item actually needs, rather than `SELECT *` by habit.
**Checked against all seven `enumerate()` calls in this pass (§9) and not applied to any of
them**: every one of them uses most or all of the columns its own `find()` already returns
(`sla-watchdog`'s `processEscalation` reads `workflow.slaConfig`, `currentState.name`,
`escalationLevel`, `slaViolations`, `entityId` and `vertical`; the rest are similarly
whole-row consumers), so a narrowed `select` would save nothing today and would add a second,
harder-to-keep-in-sync field list next to the entity for no measured benefit. Recorded as a
standing review question for a *new* job added against this pattern, not as work skipped here.

Per-item binding costs nothing extra in query count for these eight jobs — the initial
enumeration query is unchanged either way — and it means a bug in the per-item processing logic
(a missing `where: { tenantId }` added later, a nested service call that forgets to pass
`tenantId` through) is caught by the database instead of shipped. The cost is real but small:
one `AsyncLocalStorage.run()` per item, and the loss of a single flat SQL query in favour of
per-item write-time isolation — the reads were already one query; only the *write phase*
changes from bypassed to bound.

**Decided: per-item binding is the standard for all seven originally-scoped jobs plus the
ninth found during Anton's secops review (§2.5)** — eight jobs total go through the shared
helper — via one shared helper (§2.2), except `queue-drain` (§2.3, structural reason) and
`regulatory-radar` (§2.4, not applicable). The four already-shipped whole-sweep-bypass jobs
(`retention`, `notification-dispatch`, `watchlist-ingest`, `rescreening`) are **not** touched
by this ADR — see §5 (Consequences) for why, and §7 for the trigger to reconsider them.

### 2.2 The shared helper

New file, `src/core/tenancy/tenant-bound-sweep.ts` — a plain exported function, not a Nest
provider, so it needs no module wiring and can be imported directly from `workflow`, `tasks`,
`notifications`, `analytics` and `billing` without creating a cross-module dependency (mirrors
how those modules already import `TenantContext` directly, not through DI).

**Anton's review, point 3 — `SweepFailure.message` must not carry raw, potentially tenant-
identifying error text.** `job_runs.scope` — where every `SweepFailure[]` ultimately lands — is
platform-global and carries **no RLS of its own** (§3.4): any `platform_admin` can read it,
regardless of which tenant's item failed. A verbatim `error.message` routinely interpolates
tenant data — an outstanding amount, a pack-authored state name, occasionally a person's name
(`workflow.service.ts`'s arrears-blocking message is one concrete example: `"Cannot progress
past 'passport upload': 2 payment(s) totalling 45000 AUD..."`). The helper therefore never
stores `error.message` verbatim. It records the error's **class** (`error.constructor.name`)
and a `code` property when the error carries one (every `HttpException` subclass and this
repo's own typed errors do), not what either interpolated, capped at 300 characters:

```ts
export interface SweepFailure {
  tenantId: string;
  itemId?: string;
  /** Error class/code only — never a raw, possibly-interpolated `error.message`.
   *  Capped at 300 chars. See `summariseFailure` in the implementation. */
  message: string;
}

export interface SweepScope {
  /** Distinct tenants represented among the rows the enumeration query found. */
  eligible: number;
  /** Distinct tenants for which at least one item was bound and processed
   *  without throwing. The number that matters: eligible > 0 && scanned === 0
   *  is the RLS-blocked signature, not a legitimate empty result. */
  scanned: number;
  itemsFound: number;
  itemsProcessed: number;
  failures: SweepFailure[];
}

export async function runTenantBoundSweep<T extends { tenantId: string; id?: string }>(
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
      await TenantContext.run({ tenantId: item.tenantId }, () => fn(item));
      processed++;
      scannedTenants.add(item.tenantId);
    } catch (error) {
      failures.push({
        tenantId: item.tenantId,
        itemId: item.id,
        // summariseFailure: error class + `code` property if present, capped
        // at 300 chars — never `error.message` verbatim. See point 3 above.
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
```

`TenantContext.run({ tenantId: item.tenantId }, fn)` — **not** `runAsSystem` — for the per-item
call. `run()` replaces the store outright (`storage.run(store, fn)`, no spread of the parent),
so any inherited `bypass` (§1.4's `runAsGod` case) is dropped and the item is processed under
genuine RLS enforcement regardless of which entrypoint triggered the sweep.

This one helper directly produces the per-item error isolation §2c point 4 asks for (a thrown
error inside `fn(item)` is caught, recorded in `failures`, and the loop continues — one bad row
can never abort the rest of the sweep) and the scope evidence §2c point 2 asks for (`eligible`
vs `scanned`) as the same piece of work, not two.

**Spec:** `src/core/tenancy/tenant-bound-sweep.spec.ts` — asserts (a) `enumerate` runs with
`TenantContext.isBypassed() === true`; (b) `fn` runs with `TenantContext.getTenantId() ===
item.tenantId` and `isBypassed() === false`; (c) one item throwing does not stop the loop, and
appears in `failures` with the right `tenantId`; (d) `eligible`/`scanned` are distinct-tenant
counts, not item counts, using a fixture with two items sharing one tenant; (e) — **Anton's
review, point 3** — a failure's `message` never contains the raw, potentially
tenant-identifying text of `error.message` and is capped at 300 characters.

### 2.3 `queue-drain` — a documented exception, not an omission

`QueueService.getNextJob` (`:174-220`) claims the **globally next** pending job across every
tenant by `priority`, then `createdAt`, using `FOR UPDATE SKIP LOCKED` inside one transaction.
That ordering is the entire point of a priority queue — it cannot be reproduced by enumerating
tenants and querying each tenant's queue in turn without inventing a round-robin that discards
the platform-wide priority the queue exists to provide. So `queue-drain` cannot use
`runTenantBoundSweep`'s enumerate-then-iterate shape. Instead:

- The claim itself (`getNextJob`, inherently cross-tenant by design) runs inside
  `TenantContext.runAsSystem('queue-drain: claim next job', ...)`.
- Once a job is claimed, its entire processing — `processJobInternal`, including both the
  success path (`queueService.completeJob`) and the failure path
  (`queueService.failJob`) — runs inside `TenantContext.run({ tenantId: job.tenantId }, ...)`.
  Today `processJobInternal`'s own `try`/`catch` already prevents one job's failure aborting the
  drain loop; that isolation is preserved, just now inside a tenant-bound context so
  `completeJob`/`failJob`'s writes actually land.

### 2.4 `regulatory-radar` — no tenancy change

Per §1.1, this engine has no tenant-scoped database access. It needs no `runAsSystem` and no
per-item binding. Its `RadarScanResult` already reports `sourcesScanned`/`changesDetected`/
`errors` (`:224-230`) — it already carries the scope-evidence discipline §3 asks for; it only
needs its return value to stop being discarded (§3.1).

> **Implementation note, 2026-09-17:** `RegulatoryRadarEngine` lives in `src/ai/engines/`,
> which was under concurrent edit by another backend agent during this ADR's implementation
> pass (workspace convention: do not touch a path another agent is actively editing). §3.1's
> fix for this one handler — `scheduledScan()` returning `this.runScan()` instead of `void` —
> was therefore **not implemented in this ADR's own pass**. **It has since landed**, in the
> same follow-up commit this note asked for: `scheduledScan()` now `return`s `this.runScan()`
> (radar-disabled still short-circuits to `undefined` without calling it), specced in
> `src/ai/engines/regulatory-radar-scheduled-scan.spec.ts` (2 tests, `runScan` spied rather
> than exercised — it makes real HTTP requests to public regulator pages). Every job in this
> ADR (§2.2–§2.5, §9.1–§9.16) is now implemented and specced.

### 2.5 A ninth job, found during Anton's secops review: `QueueService.processScheduledJobs`

Not in `NEXT-SESSION.md` §2c's original eight, and not caught by the initial `grep -rl
runAsSystem src` pass in §1.1 because that pass enumerated `JOB_CADENCE_MINUTES` keys against
their dispatch targets in `job-dispatch.service.ts`, and `'scheduled-jobs'` (cadence: 1 minute,
`job-catalogue.ts:32`) was present in that list the whole time — it was simply not cross-checked
against its handler's own tenancy the way the other eight were.

`QueueService.processScheduledJobs` (`src/queue/queue.service.ts`, dispatched by
`job-dispatch.service.ts`'s `case 'scheduled-jobs'`) enumerates `queue_scheduled_jobs` — rows a
tenant creates via `POST /queue/scheduled` to run a job on a cron-style recurring schedule — and
for each due row calls `createJob(scheduled.tenantId, ...)` followed by
`scheduledRepo.save(scheduled)` to advance `nextRun` and the run count. Identical shape to every
other job in this ADR: outside a request, `TenantContext.get()` is `undefined`, the enumeration
query matches zero rows under RLS, and the job silently never creates anything, forever, with
`JobRunService` recording `status: 'ok'`.

**Same fix, same helper, no new pattern:** `enumerate` is today's
`scheduledRepo.find({ where: { isActive: true, nextRun: LessThan(new Date()) } })` unchanged;
`fn` is today's per-item body (`createJob` + the `nextRun`/`runCount`/`maxRuns`/`endDate`
bookkeeping + `scheduledRepo.save`), wrapped by `runTenantBoundSweep` exactly as §2.2
describes. `QueueScheduledJob` carries both `id` and `tenantId`, so it satisfies the helper's
generic constraint with no adapter needed. This does **not** share `queue-drain`'s structural
exception (§2.3) — `processScheduledJobs` enumerates by due time, not by cross-tenant priority
claim, so there is no `FOR UPDATE SKIP LOCKED` ordering to preserve and the standard
enumerate-then-iterate shape applies directly.

**Spec:** `src/queue/queue.service.spec.ts` — asserts enumeration runs under system bypass,
`createJob` and the following `scheduledRepo.save` are bound to the scheduled job's own tenant
(not the bypass) for every due item across tenants, and one item failing partway through (after
its own `createJob` succeeded, before its `save`) does not stop the others and is recorded in
`scope.failures` against the right tenant.

---

## 3. The ambiguity fix: scope evidence must reach `job_runs`, and today it can't — the return value is discarded

`JobDispatchService.run` (`:172-199`) calls `await fn();` and discards whatever the handler
returned, keeping only `durationMs`. Every summary object these jobs already compute —
`AlertSweepSummary`, `SequenceRunSummary`, `RetentionSweepResult`, `RadarScanResult` — is thrown
away before it reaches `JobRunService.record`. This is the second half of the bug: even a
correctly-scoped sweep cannot currently prove it scanned anything, because nothing plumbs that
proof through to the one place (`job_runs`, read by `GET /jobs/status`, the God UI) an operator
or an alert would look.

### 3.1 `JobResult` and `JobRunService` gain scope, additively

`src/jobs/job-catalogue.ts`:

```ts
export interface JobScopeEvidence {
  eligible: number | null;   // null = "not tenant-scoped, this check does not apply"
  scanned: number;
  failures?: Array<{ tenantId?: string; itemId?: string; message: string }>;
}

export interface JobResult {
  job: string;
  status: 'ok';
  durationMs: number;
  summary?: Record<string, unknown>;   // whatever the handler returned — job-specific
  scope?: JobScopeEvidence;            // summary.scope, normalised, for the suspect check
}
```

`JobDispatchService.run` (`:172-199`): capture `fn()`'s return value, attach it as
`JobResult.summary`, and lift `summary.scope` (by convention — every handler that has scope
evidence to report puts it at `summary.scope`) into `JobResult.scope`.

`JobDispatchService.handlerFor` (`:113-170`): every case that currently discards its service
call's return value must return it instead —

```ts
case 'sla-watchdog':
  return () => this.slaWatchdogService.checkSLAViolations();  // must now return a summary object, see §4.1
```

— and each of the seven affected services' entry method must be changed from `Promise<void>`
(where it currently is one) to `Promise<{ scope: JobScopeEvidence; [k: string]: unknown }>`,
built from the `SweepScope` the shared helper returns: `{ ...jobSpecificCounters, scope: {
eligible: sweep.eligible, scanned: sweep.scanned, failures: sweep.failures } }`.

### 3.2 `'suspect'`, a third status that needs no migration for itself

`JobRun.lastStatus` (`src/jobs/entities/job-run.entity.ts:39-40`) is deliberately `varchar`,
not an enum — its own comment says so: *"kept as text so a new outcome needs no migration."*
`JobDispatchService.runNamed` (`:87-111`), after computing `result`:

```ts
const scope = result.scope;
const suspect = !!scope && scope.eligible !== null && scope.eligible > 0 && scope.scanned === 0;

await this.jobRunService.record(job, {
  status: suspect ? 'suspect' : 'ok',
  durationMs: result.durationMs,
  scope,
});

if (suspect) {
  this.logger.error(
    `Job "${job}" completed without throwing but scanned 0 of ${scope.eligible} eligible ` +
    `tenants — the signature of an unbound TenantContext, not a genuinely empty result. ` +
    `Treat as failed, not ok.`,
  );
}
```

**This is the actual ambiguity fix.** A sweep that genuinely found zero SLA breaches across 40
correctly-scanned tenants reports `scope: { eligible: 40, scanned: 40, ... }`,
`status: 'ok'`. A sweep blocked by an unbound context reports `scope: { eligible: 40, scanned:
0 }`, `status: 'suspect'` — indistinguishable from `'ok'` today, and now impossible to confuse
even by someone only glancing at `lastStatus`.

`JobRunService.record` (`:57-103`): widen `outcome.status` to `'ok' | 'failed' | 'suspect'`,
and add a fourth bind parameter `$5` for `scope` (jsonb), written on every upsert branch (insert
and `ON CONFLICT DO UPDATE`) the same way `lastError` already is.

`JobRunService.status` (`:113-148`) and `JobStatusRow`: add `lastScope: JobScopeEvidence | null`
from the stored column.

`src/jobs/job-status.controller.ts:53-56`: `failing` currently filters
`j.lastStatus === 'failed'` only. Widen to `j.lastStatus === 'failed' || j.lastStatus ===
'suspect'` — a health tile that only reddens on a thrown exception is exactly the gap this ADR
closes; it must also redden on a scope of zero.

### 3.3 Migration — additive, nullable, one column

New file `src/migrations/1757200000000-AddJobRunScope.ts`. **Corrected 2026-09-17**: this
section originally named `1757100000000` as "the next free timestamp after
`1757000000000-AddLeadIntake.ts`" — it was, at the moment this ADR was drafted, but a
concurrent change in `src/iam` claimed that exact slot first
(`1757100000000-AddIamAuditActions.ts`, registered in `ALL_MIGRATIONS` ahead of this one) by
the time implementation started. `1757200000000` is the actual next free slot and the actual
filename/class name on disk; every reference to `1757100000000-AddJobRunScope` below this point
is stale and superseded by this note.

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR 0018 — scope evidence for scheduled-job runs, so "found nothing" and
 * "blocked by RLS" stop looking identical in job_runs / GET /jobs/status.
 * Purely additive: a nullable jsonb column on an existing table. No RLS
 * change — job_runs' policies are row-level (AddJobRuns1755100000000), not
 * column-level, and this column carries no tenant data of its own (it
 * summarises counts and failure messages across tenants, by design — the
 * same platform-global shape as the rest of the table, and per point 3 of
 * Anton's secops review — §2.2, §3.4 — every failure message it can ever
 * carry is capped and stripped of interpolated detail before it reaches
 * this column, precisely because the column itself has no RLS to fall back
 * on).
 */
export class AddJobRunScope1757200000000 implements MigrationInterface {
  name = 'AddJobRunScope1757200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_runs" ADD COLUMN IF NOT EXISTS "scope" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_runs" DROP COLUMN IF EXISTS "scope"`,
    );
  }
}
```

### 3.4 Why `job_runs.scope` has no RLS of its own — and what that means for §2.2 (Anton's review, point 3)

`job_runs` is platform-global, not tenant-scoped (§1.2, and the entity's own standing comment:
"these jobs sweep every tenant, so 'when did the sanctions list last ingest' is a property of
the platform"). It carries row-level policies gating who may read the table at all, but no
column-level or per-row tenant predicate — there is no `tenantId` column for one to key on, by
design, since one row covers every tenant's outcome for one job. Any `platform_admin` who can
read `/jobs/status` can therefore read every `SweepFailure` any job has ever recorded, for every
tenant, in one place. That is fine for the counts (`eligible`, `scanned`) — they are exactly the
aggregate, cross-tenant signal this table exists to hold — but it means a `message` field on
this table is a worse place to put a tenant's data than almost anywhere else in the schema. §2.2
is written against that constraint from the start, not patched afterward: `summariseFailure`
records what an error *is* (class, `code`), never what it interpolated.

**Rollback:** `DROP COLUMN IF EXISTS "scope"`. No data loss beyond the scope-evidence history
itself — `job_runs` is a status table, not a ledger (`AddJobRuns1755100000000`'s own comment:
"a status row rather than an append-only log"), so there is nothing else to preserve. Safe to
run down at any time; `JobRunService.record`'s SQL would need `scope` removed from its column
list first if rolling back while that code is still deployed — **roll back the code before the
migration**, same ordering `meru-core/CLAUDE.md` §8 already requires for every other migration.

**Register in `src/config/entities.ts`? No — `entities.ts` is for new entity classes;
`JobRun` already exists.** **Must register the migration file in `ALL_MIGRATIONS`
(`src/config/migrations.ts`), in the same commit as the file.** This exact omission has been a
real production bug four times in this repo (`AddInboundWebhooks`, and the three prior
instances that comment records) — the array's own trailing comment says so. Luke: add the
import and the array entry in the same diff that adds the file, not after.

---

## 4. Automated-actor attribution (§2c point 3)

### 4.1 The bug

`sla-watchdog.service.ts:190-196`, the `auto_approve` escalation action:

```ts
await this.workflowService.transition({
  instanceId: instance.id,
  tenantId: instance.tenantId,
  transitionId: moved.id,
  userId: instance.startedBy,           // ← the human who started the matter
  context: { autoApprovedBySlaBreach: true },
});
```

`workflow.service.ts:563-571`:

```ts
instance.history.push({
  timestamp: new Date(),
  fromState: oldState.name,
  toState: newState.name,
  transitionId: transition.id,
  triggeredBy: request.userId,          // ← records the human as the approver
  context: newContext,
});
```

`context.autoApprovedBySlaBreach: true` **is** preserved into the history entry's own `context`
sub-object (since `newContext = {...instance.context, ...request.context}` and the whole thing
is stored), so the fact of automation is not literally invisible — but `triggeredBy`, the field
any reasonable reader treats as "who did this", names the case's starting applicant or staff
member, not the system. That is a misattribution, not a missing fact: a compliance review of
"who approved this matter's progression" reads a human's name off a decision that human never
made.

Grepped for consumers of `history[].triggeredBy` across both repos
(`grep -rn triggeredBy src` in `meru-core`, same in `meru-core-fe`): the only other hits are an
unrelated `AgentRun.triggeredBy` column (`src/orchestration/`). **Nothing reads
`WorkflowInstance.history[].triggeredBy` today**, in either repo. Changing its meaning for
automated transitions breaks no shipped UI.

### 4.2 The fix — additive, no migration

`WorkflowInstance.history` (`src/workflow/entities/workflow-instance.entity.ts:69-77`) is
`@Column({ type: 'jsonb', default: [] })` typed only by a TypeScript interface, not a database
schema. Adding optional fields to that interface is a type-level change with no `ALTER TABLE`.

`src/workflow/workflow.service.ts` — `TransitionRequest` (`:47-65`) gains:

```ts
export interface TransitionRequest {
  // ...unchanged fields...
  /**
   * Set when this transition was triggered by a scheduled job, not a human
   * request. `by` names the job/service (e.g. 'sla-watchdog:auto_approve'),
   * not a person. When set, `userId`/`userRoles` should still be a real
   * Actor (SYSTEM_ACTOR, src/common/access.ts) for the permission check —
   * `automated` only changes how the outcome is attributed in history, not
   * who the permission gate evaluates against.
   */
  automated?: { by: string; reason?: string };
}
```

`WorkflowInstance.history[]`'s inline type (`:70-77`) gains two optional fields:

```ts
history: Array<{
  timestamp: Date;
  fromState: string;
  toState: string;
  transitionId: string;
  triggeredBy: string;
  automated?: boolean;        // new
  automatedBy?: string;       // new — e.g. 'sla-watchdog:auto_approve'
  context: Record<string, any>;
}>;
```

`workflow.service.ts:563-571`, the history push:

```ts
instance.history.push({
  timestamp: new Date(),
  fromState: oldState.name,
  toState: newState.name,
  transitionId: transition.id,
  triggeredBy: request.automated ? SYSTEM_ACTOR.id : request.userId,
  automated: !!request.automated,
  automatedBy: request.automated?.by,
  context: newContext,
});
```

`sla-watchdog.service.ts`'s `auto_approve` branch (`:169-200`) changes the `.transition()` call:

```ts
await this.workflowService.transition({
  instanceId: instance.id,
  tenantId: instance.tenantId,
  transitionId: moved.id,
  userId: SYSTEM_ACTOR.id,
  userRoles: SYSTEM_ACTOR.roles,
  automated: { by: 'sla-watchdog:auto_approve', reason: 'SLA breach auto-approval' },
  context: { autoApprovedBySlaBreach: true },
});
```

**A second, adjacent finding this surfaces and fixes in the same change, because it is the same
three lines:** the original call passed no `userRoles` at all, so `checkPermissions`
(`workflow.service.ts:773-790`) evaluated against an empty array. For any transition whose pack
declares `permissions.roles`, `auto_approve` has always silently thrown `BadRequestException
('Insufficient permissions')` — invisible until now because `checkSLAViolations`'s bare `for`
loop (§4.3) turned that one exception into an abort of the entire watchdog run for every other
tenant. Passing `SYSTEM_ACTOR.roles` (`[PlatformRole.FIRM_ADMIN]`, `src/common/access.ts:151-154`)
gives the permission check something real to evaluate. This does not change behaviour for any
pack transition with no `permissions` declared (`checkPermissions` returns `true` immediately
when `!permissions.roles?.length && !permissions.users?.length`) — only for the subset that
does, where it goes from "always silently 400s" to "correctly evaluated against the documented
system actor."

**Spec:** `src/workflow/workflow-automated-transition.spec.ts` — asserts (a) an `automated`
transition writes `triggeredBy: 'system'`, `automated: true`, `automatedBy` as given; (b) an
ordinary transition (`automated` unset) is byte-for-byte unchanged from today —
`triggeredBy: request.userId`, no `automated`/`automatedBy` keys at all (not `false`/`undefined`
— genuinely absent, so a `history[]` entry predating this change and one from an ordinary
human transition after it are indistinguishable, which is the point); (c) a transition whose
`permissions.roles` includes `firm_admin` succeeds when called with `SYSTEM_ACTOR.roles`; (d) —
§4.2b below — an automated transition writes a CRITICAL audit entry naming the tenant and the
instance; (e) an ordinary (non-automated) transition writes no audit entry via this path; (f) if
the audit write throws, `transition()` rejects with that error and nothing changes — no history
entry, no state, no `currentStateId` change.

### 4.2b Audit coverage for an automated transition (Anton's secops review, point 2)

**Not in the original scope of this ADR — added by Anton's secops review**, because §4.1/§4.2
close the misattribution but not the underlying gap it exposes: an automated transition has no
human behind it to hold accountable through the ordinary route (a person's own session, their
own audit trail as an actor elsewhere in the system). `history[].automated`/`automatedBy` (§4.2)
makes the fact discoverable to someone reading *that one instance's* history, but says nothing
to someone auditing *the tenant* — `GET /audit`, `AuditService.getEntityHistory`,
`verifyChain` — none of which look inside a workflow instance's own jsonb column.

**Decision:** `WorkflowEngineService.transition()` writes an `audit_logs` entry via the existing
`AuditService.logEvent` for every `request.automated` transition, with the same fail-closed
discipline `TenancyService.runAsGod` uses for cross-tenant human access
(`tenancy.service.ts:44-72` — write the entry, and if the write itself fails, the underlying
action must not proceed either):

- **Written before the state change, not after.** Placed immediately after the permissions and
  arrears-blocking checks and *before* `this.dataSource.createQueryRunner()` — nothing has
  opened a transaction yet at that point, so a failed audit write means the method throws with
  no transaction ever started and no `instance.history` mutation ever made. This is the literal
  meaning of "if the audit write fails, the transition does not happen": there is nothing to
  roll back, because nothing ran.
- **`action: AuditAction.WORKFLOW_TRANSITION`**, `entityType: 'workflow_instance'`, `entityId`
  the instance id, `tenantId` the instance's own tenant (the write runs inside the per-item
  `TenantContext.run({ tenantId })` binding §2.2's helper already establishes for the caller —
  `sla-watchdog.service.ts` — so no additional bypass is needed or used for this write).
- **Severity: `AuditSeverity.CRITICAL`.** The enum (`audit-log.entity.ts`) has no literal `HIGH`
  member — only `INFO`, `WARNING`, `ERROR`, `CRITICAL` — so "at least HIGH" per the review is
  implemented as `CRITICAL`, the top of that scale and the same severity
  `TenancyService.runAsGod` already uses for an action nobody with a live human session
  reviewed. `[UNVERIFIED: whether a future HIGH-vs-CRITICAL distinction matters to a compliance
  report — flag for Owen/Anton if CRITICAL proves too coarse once real automated-transition
  volume exists.]`
- **`context` carries `{ automated: request.automated, transitionId }`** — the same `by`/`reason`
  pair `history[]` stores, so a reader of the audit trail does not have to cross-reference the
  instance to see why.
- **Failure is loud, not swallowed**: `.catch()` logs at `error` level naming the instance
  before rethrowing, so an audit-write failure is visible in the function logs even though the
  caller (`runTenantBoundSweep`) will also catch the rethrown error and record it in
  `SweepScope.failures` against the instance's tenant.

**Not done:** a symmetric audit entry for an *ordinary* (human-triggered) transition. Those
already run inside an authenticated request with its own actor and are reachable through the
ordinary staff-action audit surface; adding a second, redundant `WORKFLOW_TRANSITION` entry for
every manual transition was judged out of scope for a tenancy ADR and is not what point 2 asked
for — the gap was specifically that an *automated* transition had no audit trail a tenant-level
reviewer would ever see, not that manual transitions lack one today.

### 4.3 `processEscalation`'s bare `for` loop (§2c point 4)

`checkSLAViolations` (`:96-115`) today:

```ts
for (const instance of violations) {
  await this.processEscalation(instance);
}
```

No `try`/`catch`. One instance whose escalation throws — including, before §4.2, the permission
gap above — aborts every remaining instance in the tick, for every tenant, silently (the
exception propagates to `JobDispatchService.run`, which logs it and records the whole job
`'failed'`, giving zero visibility into which instance or how many were never reached).

**Fixed as a consequence of §2.2, not as a separate change**: once `checkSLAViolations` is
rewritten to call `runTenantBoundSweep('sla watchdog', enumerate, (instance) =>
this.processEscalation(instance))`, the helper's own `try`/`catch` around `fn(item)` already
gives per-instance isolation — a thrown escalation is caught, recorded in `SweepScope.failures`
with the instance's `tenantId` and `id`, and the loop continues. No additional code needed in
`sla-watchdog.service.ts` beyond the rewrite in §5.1's file list. This is the concrete payoff of
building point 4's fix as a property of the shared helper rather than a one-off `try`/`catch`
pasted into this one method: every other job gets the same isolation for free, and nobody has to
remember to add it to a ninth job later.

---

## 5. Consequences

**Good:**

- All eight (seven, per §1.1) affected jobs now actually process every tenant's data, not zero
  rows, closing a defect where SLA breaches were never escalated, recurring tasks never ran,
  digest emails never sent, reports never generated, and daily billing never invoiced — silently,
  since the deploy that introduced serverless job dispatch.
- `GET /jobs/status` can no longer report a scope-blocked sweep as healthy. This is a durable,
  general-purpose fix — the next scheduled job anyone adds inherits the same guarantee for free
  by using `runTenantBoundSweep` and returning `scope` in its summary, rather than needing its
  own bespoke ambiguity fix.
- The manual "run now" / cron inconsistency (§1.4) closes as a side effect: both entrypoints now
  produce identical, RLS-enforced behaviour.
- The misattributed-approver defect (§4.1) closes, and the adjacent silent permission-check gap
  (§4.2) closes in the same change, with a spec pinning both.

**Unpleasant, stated plainly:**

- **Nine files change in `src/`, across six modules, in one coordinated commit** (workflow,
  tasks, notifications, analytics, billing, queue — twice, `queue.processor.ts` and
  `queue.service.ts`, §2.3/§2.5 — plus the shared jobs/tenancy plumbing). Corrected from the
  original "eight files, five modules" once Anton's review found the ninth job (§2.5).
  `CLAUDE.md` §10's "one concern per commit" is in tension with that; the concern here is
  singular ("scheduled jobs must enter tenant context correctly and prove they did"), but the
  blast radius touches every scheduled write path in the platform at once. Recommend Luke lands
  this as one PR with per-file commits inside it, gated together by Owen, rather than nine
  separate reviews that each individually look like "add one `runAsSystem` call" and miss the
  shared-contract intent.
- **Query shape is unchanged, but write-time behaviour changes for every one of these jobs
  simultaneously.** Today they are all silently no-ops; after this change they will all start
  actually writing — SLA auto-approvals will fire, invoices will generate, digest emails will
  send. That is the point, but it means the first real run after deploy is not a no-op deploy;
  it is the first time months of accumulated due work executes at once. **Recommend a dry run**
  (log what would be processed without calling `fn`, or run once against a single pilot tenant
  via `TenantContext.run` directly) before this reaches Production, specifically for
  `daily-billing` (money) and `sla-watchdog`'s `auto_approve` (advances a case stage
  irreversibly in the sense that a wrongly-approved matter is not cleanly undoable, per
  `sla-watchdog.service.ts:172-174`'s own comment).
- **The four already-shipped whole-sweep-bypass jobs are left as they are.** This ADR does not
  bring `retention.service.ts`, `notification-dispatch.service.ts`, `watchlist-ingest.service.ts`
  or `rescreening.service.ts` in line with the per-item-binding standard it sets for the other
  seven. That is a deliberate scope cut (§7), not an oversight, but it means the codebase now
  has two sanctioned patterns for the same problem shape, and a future reader has to know which
  four are the exception.
- **`runTenantBoundSweep` adds one `AsyncLocalStorage.run()` per item**, not per tenant, for
  jobs whose enumeration query can return many rows per tenant (`recurring-tasks`,
  `scheduled-notifications` at 1-minute cadence). This is cheap (ALS overhead is microseconds,
  not a query), but it is a change from "N tenants, N context switches" to "N rows, N context
  switches" — worth Owen confirming isn't measurable under `TICK_BUDGET_MS = 45_000` at current
  data volumes; flag as `[NEEDS DATA: row counts per tenant for RecurringJob/Notification at
  production scale]`, since I have no measurement of it.

---

## 6. Options rejected

- **Whole-sweep bypass for all eight, matching the majority of already-shipped jobs.** Rejected
  in §2.1 — repeats the exact class of mistake (application-level filtering as the isolation
  boundary) that has produced five prior cross-tenant/cross-user incidents in this codebase, for
  no query-count saving on the read side and a real loss of write-time safety.
- **Per-tenant enumeration for every job (`Tenant` repo injected everywhere, `TenantContext.run`
  around each tenant's whole batch), matching `alert-rule.service.ts` exactly.** Rejected for
  `queue-drain` specifically (§2.3 — breaks the priority ordering `FOR UPDATE SKIP LOCKED`
  exists to provide) and judged unnecessary complexity for the other six, which are naturally
  row-oriented (a flat queue of already-tenant-tagged work), not tenant-oriented (a per-tenant
  pack lookup deciding whether there's anything to do at all, which is what makes
  `alert-rule`/`sequence-runner` genuinely need tenant-first iteration). `runTenantBoundSweep`
  gets the same RLS guarantee at the row grain instead, with one fewer moving part (no `Tenant`
  repo injection into `TaskService`, `NotificationsService`, `AnalyticsService`, `BillingService`).
- **A new `job_runs.tenantsScanned integer` column instead of a generic `scope jsonb`.**
  Rejected: `queue-drain` and `digest-emails` don't naturally have a "tenants" denominator in
  the same shape (items claimed vs. tenants with a preference row), and a single typed integer
  column can't carry `failures` for operator debugging. `scope jsonb` costs one column instead
  of several, and the entity's own existing convention (`lastStatus` kept as free text
  "so a new outcome needs no migration") already established that this table prefers flexible,
  additive fields over rigid ones.
- **Changing `JobRun.lastStatus` to a Postgres enum type.** Rejected: would need a migration for
  every future status value, contradicting the column's own documented reason for being
  `varchar`. `'suspect'` is added at the TypeScript/application level only.
- **Deleting `scheduled-notifications` now, since §1.3 suggests it may be dead.** Rejected as
  out of scope for an architecture ADR about tenancy — that is a product call on whether the
  `notification.created` event is meant for a consumer that doesn't exist yet or genuinely never
  had one, and belongs in its own one-line decision, not bundled into a tenancy fix. Fixed as if
  live; flagged for someone else to decide whether it should still exist.
- **Fixing `regulatory-radar`'s filesystem write on Vercel's read-only filesystem in this ADR.**
  Rejected as out of scope — unrelated to tenancy, belongs to Jonas/platform, flagged in §1.1
  and not touched further here.

---

## 7. What would make this decision wrong later — the trigger to revisit

- **If tenant count grows large enough that per-item `AsyncLocalStorage.run()` becomes
  measurable** against `TICK_BUDGET_MS` for the 1-minute-cadence jobs (`recurring-tasks`,
  `scheduled-notifications`, `queue-drain`), revisit whether those specific jobs should move to
  a batched or per-tenant-first shape instead of per-row. Nothing here prevents that later; the
  shared helper's contract (enumerate once, bind per item) would just be replaced for those jobs
  specifically.
- **If any of the four whole-sweep-bypass jobs (`retention`, `notification-dispatch`,
  `watchlist-ingest`, `rescreening`) is ever the site of a cross-tenant data exposure**, that is
  the trigger to bring all four in line with `runTenantBoundSweep` retroactively, not a
  hypothetical hardening exercise — this ADR chose not to touch working, shipped code
  speculatively, but the reasoning in §2.1 applies to those four exactly as much as to the seven
  fixed here.
- **If `scheduled-notifications` is confirmed dead** (§1.3, `[UNVERIFIED]`), retire the job
  entry from `JOB_CADENCE_MINUTES` and `handlerFor` in a follow-up, rather than carrying a fixed
  tenancy gap on a job that does nothing.
- **If a ninth scheduled job is added that does not use `runTenantBoundSweep`**, that is a
  regression of the pattern this ADR establishes, not a new decision — Owen's review checklist
  for any new `src/jobs` handler should be "does it call `runTenantBoundSweep` (or document why
  it can't, per §2.3/§2.4)", the same shape `document-access.service.ts`'s `assertOwnsEntity`
  became the one-question check for a new `entityId`-taking route (`CLAUDE.md` §8).

---

## 8. Rollback

Everything in this ADR is additive and independently revertible:

- **The migration** (§3.3): `DROP COLUMN IF EXISTS "scope"` on `job_runs`. Deploy the code
  rollback first (remove the `scope` bind parameter from `JobRunService.record`'s SQL), then
  the migration — same ordering as every other migration in this repo.
- **The `'suspect'` status**: a string literal, not a schema object. Reverting
  `JobDispatchService.runNamed`'s suspect computation returns to always recording `'ok'`/`'failed'`;
  no data migration needed either direction, since `lastStatus` was already free text.
- **The `history[]` fields** (`automated`, `automatedBy`): jsonb, additive, read by nobody
  outside this change (§4.1). Reverting the code stops writing them; existing rows that already
  carry them are simply ignored by code that doesn't look for the field, same as any jsonb
  reader ignoring an unknown key.
- **`runTenantBoundSweep` and its seven call sites**: reverting each call site to its current
  form (a flat `.find()` with no `runAsSystem`) restores today's behaviour exactly — including
  today's bug. This is a real regression if reverted alone without also reverting the awareness
  that the bug exists; note that explicitly in any revert commit message rather than reverting
  silently.
- **`queue-drain`'s two-phase binding** (§2.3): reverting removes both the `runAsSystem` claim
  wrap and the per-job `TenantContext.run`, returning to the current always-empty-queue state.

No destructive step anywhere in this ADR. The riskiest rollback is deploy-ordering on the
migration (code before schema), identical to every other migration in this repo per
`meru-core/CLAUDE.md` §8.

---

## 9. Implementation brief — files, functions, specs

For Luke. Exact changes, in dependency order (shared plumbing first, so each job file can be
implemented and tested independently against it).

### 9.1 New: `src/core/tenancy/tenant-bound-sweep.ts`
`runTenantBoundSweep` + `SweepScope`/`SweepFailure` types, as specified in §2.2. No DI, plain
function, imports only `TenantContext`. Includes `summariseFailure` (§2.2/§3.4, Anton's review
point 3) — error class/code only, capped at 300 chars, never a raw `error.message`.
**Spec:** `src/core/tenancy/tenant-bound-sweep.spec.ts`, per §2.2's five assertions.

### 9.2 `src/jobs/job-catalogue.ts`
Add `JobScopeEvidence` (§3.1). Extend `JobResult` with `summary?: Record<string, unknown>` and
`scope?: JobScopeEvidence`. No changes to `JOB_CADENCE_MINUTES`, `TICK_SCOPES`, `JOB_NAMES`.

### 9.3 `src/jobs/entities/job-run.entity.ts`
Add `@Column({ type: 'jsonb', nullable: true }) scope: Record<string, unknown> | null;`.

### 9.4 New migration: `src/migrations/1757200000000-AddJobRunScope.ts`
As specified verbatim in §3.3 (see that section's 2026-09-17 correction on the timestamp).
**Register in `src/config/migrations.ts`'s `ALL_MIGRATIONS` array, after
`AddIamAuditActions1757100000000`, in the same commit.**

### 9.5 `src/jobs/job-run.service.ts`
- `record()`: widen `outcome.status` to `'ok' | 'failed' | 'suspect'`; add `outcome.scope?:
  Record<string, unknown>`; add `$5` (scope) to the `INSERT ... ON CONFLICT` SQL (`:68-87`),
  written on both insert and the `DO UPDATE SET` branch, same treatment as `lastError`.
- `status()`: add `lastScope: r?.scope ?? null` to the returned `JobStatusRow`.
- `JobStatusRow` interface: add `lastScope: Record<string, unknown> | null`.

### 9.6 `src/jobs/job-dispatch.service.ts`
- `run()` (`:172-199`): capture `const summary = await fn();`, include it in the returned
  `JobResult` as `summary`, and set `scope: (summary as any)?.scope` when present.
- `runNamed()` (`:87-111`): compute `suspect` per §3.2's snippet; pass `status: suspect ?
  'suspect' : 'ok'` and `scope` to `jobRunService.record`; log at `error` when suspect.
- `handlerFor()` (`:113-170`): every case whose handler is changed in §9.7–§9.12 must return
  that handler's now-non-void return value (most already do via implicit return of the awaited
  call — verify each arrow function actually returns rather than just awaiting).

### 9.7 `src/jobs/job-status.controller.ts`
`failing` filter (`:53-56`): `j.lastStatus === 'failed' || j.lastStatus === 'suspect'`.

### 9.8 `src/workflow/services/sla-watchdog.service.ts`
- `checkSLAViolations()` (`:95-115`): rewrite using `runTenantBoundSweep('sla watchdog',
  enumerate, (instance) => this.processEscalation(instance))` where `enumerate` is today's
  `instanceRepo.find(...)` call unchanged. Return `{ violationsFound: sweep.itemsFound,
  escalated: sweep.itemsProcessed, scope: { eligible: sweep.eligible, scanned: sweep.scanned,
  failures: sweep.failures } }` (or equivalent — exact extra counters at Luke's discretion, the
  `scope` key is the load-bearing part).
- `executeEscalationActions`'s `auto_approve` branch (`:169-200`): per §4.2 — `userId:
  SYSTEM_ACTOR.id`, `userRoles: SYSTEM_ACTOR.roles`, `automated: { by:
  'sla-watchdog:auto_approve', reason: 'SLA breach auto-approval' }`.
- Import `TenantContext`/`runTenantBoundSweep`; `SYSTEM_ACTOR` already imported (`:16`).

### 9.9 `src/workflow/workflow.service.ts`
- `TransitionRequest` (`:47-65`): add `automated?: { by: string; reason?: string }` per §4.2.
- `WorkflowInstance.history[]`'s inline type — actually declared on the entity
  (`src/workflow/entities/workflow-instance.entity.ts:69-77`): add `automated?: boolean;
  automatedBy?: string;`.
- `transition()`'s history push (`:563-571`): per §4.2's exact snippet.
- **New, per §4.2b (Anton's secops review point 2):** inject `AuditService` (already exported
  by `AuditModule`, already imported by `WorkflowModule` — no new module wiring). Immediately
  after the permissions/arrears-blocking checks and before `createQueryRunner()`, if
  `request.automated` is set, `await this.auditService.logEvent({...}).catch(err => { log; throw
  err; })` — `AuditAction.WORKFLOW_TRANSITION`, `entityType: 'workflow_instance'`, `entityId:
  instance.id`, `tenantId: instance.tenantId`, `severity: AuditSeverity.CRITICAL`, `context: {
  automated: request.automated, transitionId: transition.id }`.
- **Also per Anton's review point 5:** delete the dead `checkSLAViolations()` method in this
  file (confirmed zero callers — see §9.16).
**Spec:** `src/workflow/workflow-automated-transition.spec.ts`, per §4.2's three assertions plus
§4.2b's three (audit entry written for an automated transition; none for an ordinary one; a
failed audit write aborts the transition with no history/state change).

### 9.10 `src/tasks/task.service.ts`
`processRecurringJobs()` (`:460-491`): rewrite using `runTenantBoundSweep('recurring tasks',
() => this.recurringJobRepo.find({ where: { status: RecurringJobStatus.ACTIVE, nextRunAt:
LessThan(now) } }), (job) => this.executeRecurringJob(job))`. Preserve today's per-job
`runHistory.push` / `retryOnError` handling inside `executeRecurringJob` — that is unrelated to
tenancy and does not move. Import `TenantContext`, `runTenantBoundSweep`.

### 9.11 `src/notifications/notifications.service.ts`
- `processScheduledNotifications()` (`:543-556`): rewrite using `runTenantBoundSweep` with
  `enumerate` = today's `notificationRepo.find(...)`, `fn` = the `eventEmitter.emit(...)` call
  per notification. Per §1.3, confirm with the operator/Jonas whether this job should be
  retired rather than fixed before spending a review cycle on it — fix it as specified either
  way, since retiring it is a separate decision.
- `sendDigestEmails()` (`:559-582`): rewrite using `runTenantBoundSweep` with `enumerate` =
  today's `preferenceRepo.find()`, `fn` = today's per-user body (the `digestSettings.enabled`
  check, `getNotifications`, `sendNotification` call), item type `NotificationPreference` (has
  `tenantId`, `id` — confirmed, `src/notifications/entities/notification.entity.ts:203-213`).

### 9.12 `src/analytics/analytics.service.ts`
`processScheduledReports()` (`:459-...`): rewrite using `runTenantBoundSweep` with `enumerate` =
today's `reportRepo.find({ where: { status: 'active' } })` (the in-code schedule filter stays
where it is, applied inside `fn` per report, unchanged), `fn` = today's per-report body.

### 9.13 `src/billing/billing.service.ts`
`processDailyBilling()` (`:516-561`): rewrite using `runTenantBoundSweep` with `enumerate` =
today's `subscriptionRepo.find(...)`, `fn` = today's per-subscription body (`generateInvoice` +
period advance + `subscriptionRepo.save`). Import `TenantContext`, `runTenantBoundSweep` — this
file currently imports neither (confirmed by grep, §1.1).

### 9.14 `src/queue/queue.processor.ts`
`drainQueue()` (`:36-52`): per §2.3 — wrap `queueService.getNextJob(...)` in
`TenantContext.runAsSystem('queue-drain: claim next job', ...)`; wrap `processJobInternal(job)`
in `TenantContext.run({ tenantId: job.tenantId }, () => this.processJobInternal(job))`. Return
`{ drained: processed, scope: { eligible: null, scanned: processed } }` from `drainQueue` (no
natural "eligible tenants" denominator for a priority claim loop — `eligible: null` per
`JobScopeEvidence`'s documented meaning, "not applicable," so the suspect check in §3.2 correctly
never fires for this job).
**Spec:** extend or add a cross-tenant queue-drain spec proving a claimed job's
`completeJob`/`failJob` write actually persists (i.e., is not silently filtered to zero rows by
RLS) — this is the exact failure mode §1.5 describes, and today's test suite (constructing
`QueueProcessor` directly with mocked repos, per `CLAUDE.md` §8.2's own caution about what unit
tests can't see) would not catch it without an explicit assertion on the bound tenant.
Implemented as `src/queue/queue.processor.spec.ts`.

### 9.14b `src/queue/queue.service.ts` — the ninth job (§2.5, Anton's secops review point 1)
`processScheduledJobs()` (around `:517-558` at the time of review) — rewrite using
`runTenantBoundSweep` with `enumerate` = today's `scheduledRepo.find({ where: { isActive: true,
nextRun: LessThan(new Date()) } })` unchanged, `fn` = today's per-item body (`createJob` +
`nextRun`/`runCount`/`maxRuns`/`endDate` bookkeeping + `scheduledRepo.save`). Import
`runTenantBoundSweep`, `JobScopeEvidence`. No structural exception here (unlike `queue-drain`,
§2.3) — this job enumerates by due time, not by cross-tenant priority claim.
**Spec:** `src/queue/queue.service.spec.ts` — enumeration under system bypass; `createJob` +
`scheduledRepo.save` bound to each due item's own tenant; one item's mid-processing failure
(after its `createJob`, before its `save`) isolated into `scope.failures` without stopping the
rest.

### 9.15 `src/ai/engines/regulatory-radar.engine.ts` — IMPLEMENTED 2026-09-17

**Was deliberately not done in this ADR's own pass**, for the reason §2.4's implementation
note gives: `src/ai/` was under concurrent edit by another backend agent, and the workspace
convention when two agents share a working tree is not to touch a path someone else is
actively editing. It has since landed, in the follow-up commit that note asked for — this is
no longer the one item in §9 left undone; every job in §9.1–§9.16 is now implemented and
specced. No tenancy change, as originally specified (§2.4): only `scheduledScan()` now
`return`s `this.runScan()` instead of discarding it, so `JobDispatchService`'s `handlerFor`
case for `'regulatory-radar'` receives the already-good `RadarScanResult` rather than
`undefined`. No `scope` key, as designed — `JobResult.scope` stays `undefined` for this job,
which is correct per `JobScopeEvidence`'s `eligible: number | null` contract (nothing to
report, not zero). Spec: `src/ai/engines/regulatory-radar-scheduled-scan.spec.ts`.

### 9.16 Cross-cutting spec
`src/jobs/job-dispatch-suspect.spec.ts` (new) — asserts: a handler returning `{ scope: {
eligible: 3, scanned: 0 } }` causes `jobRunService.record` to be called with `status:
'suspect'`; a handler returning `{ scope: { eligible: 3, scanned: 3 } }` records `'ok'`; a
handler returning no `scope` at all (e.g. `regulatory-radar`) records `'ok'` and never evaluates
the suspect check (`eligible === null` short-circuits — actually `undefined`, since no `scope`
key at all; confirm the guard handles `result.scope === undefined` the same as `eligible ===
null`, not as a crash).

### 9.17 Delete `WorkflowEngineService.checkSLAViolations` (Anton's secops review, point 5)

**Not the job that runs.** `src/workflow/workflow.service.ts` carries a *second*, unrelated
`checkSLAViolations()` (around `:679-739` at the time of review, under a `// ==== SLA
MONITORING ====` banner) — a full second implementation of the same sweep
`SlaWatchdogService.checkSLAViolations` (`services/sla-watchdog.service.ts`, §9.8) actually
performs. Confirmed dead before deletion, not assumed: `grep -rn checkSLAViolations src` finds
exactly two definitions (this one, and `SlaWatchdogService`'s) and every caller —
`agent-registry.service.ts:57`, `job-dispatch.service.ts:131`, and both specs that reference the
name — resolves to `SlaWatchdogService`'s, confirmed by reading the injected type at each call
site (`private readonly slaWatchdog: SlaWatchdogService` in `agent-registry.service.ts`).
`WorkflowEngineService`'s copy has zero callers.

Beyond being unreachable, it could not have worked if called: its query filters
`slaDeadline: now` — **exact equality** against a freshly-constructed `Date`, not
`LessThan(now)` the way the real implementation and every other due-item query in this ADR do —
a comparison that cannot match any row, ever, independent of the tenancy defect this ADR fixes.
Delete the method entirely rather than fix and keep it: a second, subtly different,
permanently-broken implementation of the same sweep sitting one file over from the real one is
a hazard on its own, independent of whether it currently runs.

---

## 10. `[UNVERIFIED:]` items carried from this ADR

- Whether `meru-core-fe` (or any consumer outside this repo) listens for the
  `notification.created` event over a channel this repo doesn't show (§1.3).
- Whether `RegulatoryRadarEngine.writeChangeProposal`'s filesystem write fails silently or
  visibly on Vercel's read-only filesystem outside `/tmp` (§1.1) — unrelated to this ADR,
  flagged for Jonas.
- Row counts per tenant for `RecurringJob`/`Notification` at production scale, needed to confirm
  per-item `AsyncLocalStorage.run()` overhead stays negligible under `TICK_BUDGET_MS` for the
  1-minute-cadence jobs (§5).
- Whether `AuditSeverity.CRITICAL` (used for every automated-transition audit entry, §4.2b —
  there is no `HIGH` member) is the right long-term severity once real automated-transition
  volume exists, or whether it needs its own level between `ERROR` and `CRITICAL` so it doesn't
  compete for attention with a genuine god-mode cross-tenant access. Flag for Owen/Anton.
- ~~`src/ai/engines/regulatory-radar.engine.ts`'s one-line fix (§2.4, §9.15) is NOT
  implemented~~ — **struck 2026-09-17, closed.** It landed in the follow-up commit this bullet
  asked for, once `src/ai/` was free; see §2.4's implementation note and §9.15. No longer an
  open item.
