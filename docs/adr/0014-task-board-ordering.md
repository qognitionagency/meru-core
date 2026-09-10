# 0014 — Task board ordering: fractional positions, server-resolved moves, and compare-and-set

**Status:** Proposed — 2026-09-10. Not merged. Requires `quality` (Owen) review — the whole
decision is a concurrency argument, and a green unit suite will not exercise two simultaneous
drags — and `secops` (Anton) review of the new write route's role gate (§2.3). Luke and Mira
implement against this contract; this document specifies no feature code.

**Scope:** PRD FR-8.2 / PL-20 — "rebuild the task board as true drag-and-drop, free movement
between columns and reordering within a column, optimistic update with rollback on failure."
Release R2.

**Relationship to ADR 0007 D3.** 0007 D3 specified `PATCH /tasks/:id/status`, `Task.internal`
and a `TaskAccessService`. The cross-tenant and user-scoping halves of D3 **shipped**
(`task.service.ts:84-96`, `:113-117`, `:169-171`; `task-authz.spec.ts` exists). The status route
and `Task.internal` **did not** — they survive only in `~/dev/meru/_salvage/_recovered-from-e8/`.
This ADR **supersedes D3's status route** with a single move route (§2.3, §3) and **declines
`Task.internal`** (§2.6).

---

## 1. Context

### 1.1 There is no ordering column, and no route that can express a column change

`Task` (`src/tasks/entities/task.entity.ts:41-137`) has `status`, `priority`, `assignedTo`,
`dueDate`, `createdAt` — and **no `position`, `sortOrder`, `rank` or `boardPosition`**. Confirmed
by reading the entity in full. `TaskService.listTasks` orders by `{ createdAt: 'DESC' }`
(`task.service.ts:179`), which is the only order the API has ever offered.

`UpdateTaskDto` (`src/tasks/dto/create-task.dto.ts:91-123`) carries `title`, `description`,
`priority`, `assignedTo`, `dueDate`, `metadata` — **no `status`**. The global `ValidationPipe`
runs `forbidNonWhitelisted` (per ADR 0010 §2.4's citation of `src/main.ts:119-121`), so a body
containing `status` is a 400, not a silent drop.

The only status writes reachable over HTTP are `POST /tasks/:id/start` → `IN_PROGRESS`,
`/complete` → `DONE`, `/cancel` → `CANCELLED` (`task.controller.ts:171-222`). `TaskStatus` has
six members (`task.entity.ts:14-21`). **Three of the six — `TODO`, `UNDER_REVIEW`, `BLOCKED` — are
not reachable by any request.** `TODO` is only ever set as the create default
(`task.service.ts:70`); `UNDER_REVIEW` and `BLOCKED` appear in `src/` only as *read* filters
(`task.service.ts:278-281`, `:666-668`) — grep found no writer for either.

### 1.2 The frontend already knows this and says so, honestly

`meru-core-fe/immistack/components/tasks/task-board.tsx` is already `@dnd-kit`-based and already
renders six columns. Its own doc comment (`:26-37`) states the constraint precisely:

> "only three of them are reachable over the API … there is no request that can put a task back
> into `todo` or move it to `under_review` / `blocked`. Those two columns exist because the
> workflow engine puts tasks there and they must be visible — they are rendered as drop-disabled
> rather than as targets that would silently do nothing. A board that accepts a drag and then
> snaps the card back is worse than one that says why."

`resolveMove` (`:55-79`) returns a *reason string* for every impossible move. **That is correct
behaviour against today's API and must not be deleted as "cleanup" — it becomes wrong only once
this ADR's route exists.** The comment about the workflow engine setting `under_review`/`blocked`
is, on the evidence above, **not currently true of `src/`** — nothing writes them. Recorded here
because a reader will otherwise trust it.

### 1.3 The serverless envelope is what rules out the obvious design

`meru-core/vercel.json` routes every path to one function: DB pool `max: 1` per invocation,
`maxDuration: 60`, genuinely concurrent invocations each holding its own single connection
(workspace `CLAUDE.md` §10, and ADR 0010 §1.3 states the same constraint for the same reason).

Integer positions with sibling rewriting therefore cost, per drag, an `UPDATE … WHERE position
>= n` touching every card at or below the insertion point in the target column — N rows written
inside one request, on a one-connection pool, while every other request for that tenant contends
for the same rows. Two users dragging in the same column serialise on that range. It is not that
this is slow; it is that the write amplification is unbounded in the number of cards and the
lock footprint is the whole column.

### 1.4 The precedents this decision is bound by

- **ADR 0010 §2.2** established the house answer to "two concurrent writers must not collide":
  **one atomic SQL statement, never a read-then-write pair**, with the database — not application
  code — doing the serialising. `tenant_record_counters`' `INSERT … ON CONFLICT … RETURNING`
  is the shape.
- **`MeruErrorCode.RESOURCE_VERSION_CONFLICT = 'MER-RES-0005'`** already exists
  (`src/common/types.ts:112` region — the `MER-RES` family). No new error code is needed for the
  concurrent-drag case, and inventing one would be worse than reusing the one that already means
  exactly this.
- **`AddTenantFeeOverrides1756700000000`** (`src/migrations/1756700000000-AddTenantFeeOverrides.ts`)
  is the current template for a tenant-scoped migration. `tasks` already carries `"tenantId"` and
  was covered by the generated RLS pass in `1753500000000-AddTenantRowLevelSecurity.ts`, so a new
  **column** on it needs no RLS work — unlike a new table.
- Highest migration timestamp on disk is `1756920000000-AddUserPractitionerCredential.ts`.

### 1.5 The salvaged branch, and a timestamp collision that will bite whoever copies it

`~/dev/meru/_salvage/_recovered-from-e8/` holds `task-access.service.ts`,
`dto/update-task-status.dto.ts`, `crm/owned-entities.ts` and
`migrations/1756500000000-AddInternalToTasks.ts` — ADR 0007 D3's implementation, never merged.

**`1756500000000` is already taken.** `src/migrations/1756500000000-AddSubjectEmailToEntities.ts`
is on disk and registered in `ALL_MIGRATIONS` (`src/config/migrations.ts`). Two migration classes
sharing one timestamp make TypeORM's ordering depend on list position rather than on the
timestamp, which is precisely the property the timestamp exists to remove. **Anyone reviving that
file must renumber it first.** The `_salvage/README.md` flags the ordering hazard but not the
collision itself.

---

## 2. Decisions

### 2.1 D1 — Ordering representation: a `numeric` fractional position, one per tenant, not per column

**Decision.** New column `Task.position: numeric NOT NULL`, unbounded precision, with a **unique
partial index on `("tenantId", position)` where `"deletedAt" IS NULL`**. Boards render
`ORDER BY position ASC`. A move writes **exactly one row**.

**Why `numeric` and not a lexicographic string rank (LexoRank / base-62 fractional indexing).**
This is the one that would have looked more sophisticated and would have been wrong here:

- A string rank sorts by the **column's collation**, not by byte order. `ORDER BY position` on a
  `varchar` under a linguistic collation does not reproduce ASCII order — case and digits are
  weighted, not compared bytewise. Making a string rank correct requires `COLLATE "C"` on the
  column *and* on every `ORDER BY` that ever touches it, and forgetting it once produces a board
  that renders in a subtly wrong order **with no error anywhere** — the exact shape of failure
  this workspace keeps naming (`CLAUDE.md` §7.3). `[UNVERIFIED: the collation of the Neon
  control-plane database — this session cannot connect. The argument does not depend on the
  answer: the hazard is that it is not `C`, and confirming it is `C` today would not stop a
  future database from differing.]`
- A string rank needs midpoint arithmetic in application code. `numeric` needs `(lo + hi) / 2`
  in SQL, evaluated by Postgres at arbitrary precision.
- Postgres `numeric` with no declared precision is arbitrary-precision. There is no exhaustion
  point of the kind IEEE-754 `double precision` has (~50 consecutive midpoints between one pair
  before the mantissa runs out) — which is why `double precision` is rejected too.

**Why one order per tenant, not one per column (`(tenantId, status, position)`).** The workflow
engine and `POST /tasks/:id/{start,complete,cancel}` change `status` **without** any knowledge of
board position. If uniqueness were scoped by `status`, every one of those writes could move a
card into a column where its position already belongs to another card, and a unique-index
violation would turn `POST /tasks/:id/complete` into a 500. A tenant-wide linear order has no
such coupling: a status change alone is always legal, the card simply appears in its new column
at whatever place the global order gives it. Column membership is `status`; order within the
column is the projection of the global order onto that filter.

**Ordering is a total order, stated explicitly.** `ORDER BY position ASC` — no secondary key is
needed, because the unique index makes ties impossible. Consumers must not add
`, "createdAt" DESC` and quietly reintroduce a second opinion about order.

### 2.2 D2 — The client never sends a position. It sends neighbours, and the server resolves.

**Decision.** The move request carries **intent** — the target column and the two cards the
dropped card landed between — never a computed number:

```jsonc
// PATCH /tasks/:id/move
{
  "status": "in_progress",        // optional; absent = stay in the current column
  "afterId": "uuid | null",       // the card immediately ABOVE the drop point; null = top
  "beforeId": "uuid | null",      // the card immediately BELOW the drop point; null = bottom
  "expectedVersion": 7            // §2.4
}
```

**Why this and not `{ position: 1536.5 }`.** A client-computed position is computed against the
board the user was *looking at*, which is by definition stale by the width of the round trip. Two
users dragging into the same gap would compute the same number from the same stale neighbours and
the second write would land on top of the first. Sending neighbours lets the server recompute the
midpoint from **current** rows inside the same statement, so the second drag resolves against a
board that already contains the first. This is the same principle ADR 0010 §2.2 applies to
counters: the authoritative value is derived where the lock is, not where the user is.

**Resolution rules**, all inside one statement (§2.3):

| `afterId` | `beforeId` | New position |
|---|---|---|
| a card | a card | `(after.position + before.position) / 2` |
| `null` | a card | `before.position - 1000` |
| a card | `null` | `after.position + 1000` |
| `null` | `null` | `1000` if the tenant has no tasks; otherwise `MAX(position) + 1000` |

`afterId`/`beforeId` that do not resolve to a live task **in the same tenant** are a 400
(`MER-VAL-0001`) naming which one, never a silent fallback to the end of the column — a card that
lands somewhere other than where it was dropped is the "unknown rendered as settled" failure in
its smallest form.

### 2.3 D3 — One route, one statement, compare-and-set

**Decision.** `PATCH /tasks/:id/move`, `@Roles(PlatformRole.STAFF, PlatformRole.FIRM_ADMIN)`.
**Not reachable by `client` and not by `partner`** (ADR 0016) — an applicant does not reorder the
firm's board, and `POST /tasks/:id/{start,complete}` remain their two actions on their own
checklist task (`task.controller.ts:171-205`, unchanged by this ADR).

**This route supersedes ADR 0007 D3's `PATCH /tasks/:id/status`.** Two routes that both write
`Task.status` is the "one implementation, two front doors" drift ADR 0009 §2.3 refused for
`JobDispatchService`; here it would be worse, because the second door would also have to know
about `position` to avoid leaving a card in an undefined place. A pure column change is
`{ status, afterId: null, beforeId: null }` — expressible, and it means "bottom of that column".

**The statement.** One `UPDATE`, no prior `SELECT`, with the expected version in the `WHERE`:

```sql
WITH bounds AS (
  SELECT
    (SELECT position FROM tasks
      WHERE id = $afterId  AND "tenantId" = $tenantId AND "deletedAt" IS NULL) AS lo,
    (SELECT position FROM tasks
      WHERE id = $beforeId AND "tenantId" = $tenantId AND "deletedAt" IS NULL) AS hi,
    (SELECT COALESCE(MAX(position), 0) FROM tasks
      WHERE "tenantId" = $tenantId AND "deletedAt" IS NULL) AS top
)
UPDATE tasks t
SET position = CASE
      WHEN b.lo IS NOT NULL AND b.hi IS NOT NULL THEN (b.lo + b.hi) / 2
      WHEN b.hi IS NOT NULL                      THEN b.hi - 1000
      WHEN b.lo IS NOT NULL                      THEN b.lo + 1000
      ELSE b.top + 1000
    END,
    status    = COALESCE($newStatus, t.status),
    version   = t.version + 1,
    "updatedAt" = now()
FROM bounds b
WHERE t.id = $id
  AND t."tenantId" = $tenantId
  AND t."deletedAt" IS NULL
  AND t.version = $expectedVersion
RETURNING t.*;
```

- **Zero rows returned** means either the task is not this tenant's / not live, or the version
  did not match. The service distinguishes them with one follow-up read **only to choose the
  status code** — 404 if the row is not readable at all, 409 if it is (§2.4). It never retries
  the write off that read.
- **A unique-index violation on `("tenantId", position)`** means another invocation claimed the
  same midpoint between the same pair between statement start and commit. **Retry the whole
  statement, bounded at 3 attempts**, then 409. The retry recomputes against neighbours that now
  include the other card, so the second attempt cannot collide the same way. This is the same
  posture ADR 0010 §2.2 takes: let the database detect it, do not try to prevent it in
  application code.
- `RETURNING t.*` is what the optimistic UI reconciles against — no second read on the happy path.

**Side-effects stay in one place.** Moving to `DONE` must set `completedAt`/`completedBy`, and
moving to `IN_PROGRESS` must set `startedAt`, exactly as `completeTask`/`startTask` already do
(`task.service.ts:212-232`). `/move` and the three action routes therefore call **one** internal
transition helper for the timestamp side-effects. If they do not, a card completed by drag and a
card completed by button produce different rows, and the difference surfaces months later in a
report nobody can reconcile.

**Search reindex.** `TaskService.indexTask` (`task.service.ts:~620`) already carries `status` into
the index. `/move` must call it on the same path `updateTask` does, or a dragged card's status
goes stale in search. Fire-and-forget, outside the statement, matching `CrmService`'s existing
posture (ADR 0010 §2.2's note on `indexEntityData`).

### 2.4 D4 — Two users, one card: 409 with the truth attached, never a silent last-write-wins

**Decision.** New column `Task.version: integer NOT NULL DEFAULT 0`, incremented by **every**
write to a task (`/move`, `PUT /tasks/:id`, `/start`, `/complete`, `/cancel`, and any workflow-
engine write). `PATCH /tasks/:id/move` requires `expectedVersion`. A mismatch is:

```
HTTP 409
error: { code: "MER-RES-0005", message: "This task moved while you were dragging it.",
         details: { task: { id, status, position, version, updatedAt } } }
```

**Why an explicit integer and not `updatedAt`.** `updatedAt` is a `@UpdateDateColumn` on a
`timestamp` column; Postgres keeps microseconds and a JSON round trip through `Date` keeps
milliseconds, so an `expectedUpdatedAt` comparison is a truncation bug waiting to be written by
whoever implements it. An integer has no representation to lose. It also gives the frontend a
value it can compare without parsing a date.

**Why `details.task` carries the current row.** FR-8.2 asks for "optimistic update with rollback
on failure." A rollback that only knows *that* it failed has to refetch the whole board; a
rollback handed the authoritative row for that card can reconcile immediately and show the user
where the card actually is. Returning the current state on conflict is the difference between
"something went wrong" and "Priya moved this to Submitted."

**The three concurrent cases, stated so nobody has to infer them:**

| Case | Outcome |
|---|---|
| Two users drag **different** cards into the same gap | Both succeed. Either they compute distinct midpoints (statement ordering), or the second hits the unique index and its retry resolves against the first. Bounded retry, then 409. |
| Two users drag **the same** card | First wins; second gets **409 `MER-RES-0005`** with the current row. Never a silent overwrite. |
| A user drags a card that a **workflow transition or another user's `/complete`** just moved | Same 409, same payload — because every task write bumps `version`, not just `/move`. This is why the version bump cannot be confined to the move route. |

### 2.5 D5 — Rebalance: bounded, per tenant, triggered by measured depth — not scheduled

**Decision.** After a successful move, the service reads `scale(newPosition)` from the
`RETURNING` row. If it exceeds **30**, it enqueues nothing and schedules nothing — it performs a
**renormalisation of that tenant's tasks in a second, separate transaction**, immediately:

```sql
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY position, "createdAt", id) AS rn
  FROM tasks WHERE "tenantId" = $tenantId AND "deletedAt" IS NULL
)
UPDATE tasks t SET position = ordered.rn * 1000, version = t.version + 1
FROM ordered WHERE t.id = ordered.id;
```

**The arithmetic, so the threshold is not a guess.** Positions start 1000 apart. Halving an
integer gap consumes roughly one decimal place per drag *into the same gap*. Reaching scale 30
requires ~30 consecutive drops between the same adjacent pair with no intervening rebalance. That
is reachable by a determined user and essentially unreachable by ordinary use, which is exactly
where a threshold belongs.

**Why not a `/jobs` entry.** Adding `board-rebalance` to `JOB_CADENCE_MINUTES`
(`src/jobs/job-catalogue.ts:30-63`) would place it in `TICK_SCOPES.fast` or `daily`. The `fast`
scope requires an external scheduler at `/api/v1/jobs/tick?scope=fast` that **is not
provisioned** (workspace `CLAUDE.md` §12), and the `daily` scope would let a board sit unusable
for up to 24 hours. A condition that is cheap to detect at the moment it arises should not be
deferred to a sweep that may not run.

**Why the rebalance bumps `version`.** It moves cards. A client holding stale versions must get
409s and refetch rather than write against positions that no longer exist. Renormalisation is
therefore *visible* to optimistic clients — deliberately.

**Consequence, named rather than hidden:** a rebalance writes one row per live task in that
tenant. At a firm's realistic volume (hundreds) this is a sub-second statement. **Trigger to
revisit** is in §5.

### 2.6 D6 — `Task.internal` (ADR 0007 D3) is declined, not deferred

**Decision.** Do not add `Task.internal`.

`internal` was designed as the fence around a **widening**: ADR 0007 D3's `TaskAccessService`
would have let a `client` see a task whose `entityId` is one of their own records, so a
default-`true` "internal" flag was needed to stop that widening exposing every existing task on
deploy. **That widening did not ship.** What shipped is narrower and already correct: `own` scope
is `where.assignedTo = actor.id` (`task.service.ts:169-171`) and
`assertOwnedByOrTenant` (`:113-117`), so a client sees only tasks explicitly assigned to their
user id. That fails closed without any flag.

Adding the column now would add a `NOT NULL DEFAULT true` boolean that **nothing reads** — and a
default-hidden flag on a table where visibility is already decided elsewhere is worse than no
flag, because the next reader will assume it is load-bearing and reason from it.

**If the `entityId`-based widening is ever built**, `internal` comes back with it, in that ADR,
in the same commit — and with a renumbered migration (§1.5).

### 2.7 D7 — Migration

**`1757000000000-AddTaskBoardPosition`.** One migration, one transaction, additive throughout.
`tasks` already carries RLS from `1753500000000-AddTenantRowLevelSecurity.ts`; a new column
inherits it, so **no policy work** — unlike a new table.

```sql
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "position" numeric;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 0;

-- Backfill: one spaced position per tenant, in the order the board renders today.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
           PARTITION BY "tenantId" ORDER BY "createdAt", id
         ) AS rn
  FROM "tasks" WHERE "position" IS NULL
)
UPDATE "tasks" t SET "position" = ordered.rn * 1000
FROM ordered WHERE t.id = ordered.id;

ALTER TABLE "tasks" ALTER COLUMN "position" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tasks_tenant_position"
  ON "tasks" ("tenantId", "position") WHERE "deletedAt" IS NULL;
```

**Soft-deleted rows are numbered too** (`"position" IS NULL` is the only filter), for the same
reason ADR 0010 §2.5 numbers them: a restored task must not arrive without a position. They are
excluded from the *unique index* only, so a deleted card cannot block a live one's slot.

**Backfill order is `createdAt` ascending**, which is the reverse of today's list order
(`{ createdAt: 'DESC' }`, `task.service.ts:179`). That is deliberate: a board reads top-to-bottom
oldest-first once positions exist. Mira must expect the board to reverse on the deploy that
lands this, and that is a visible change worth a line in the frontend changelog — the same
caution ADR 0009 §4 item 4 gives for fee overrides.

Registration in `ALL_MIGRATIONS` (`src/config/migrations.ts:55`) is **part of this migration's
commit**, not a follow-up. Workspace `CLAUDE.md` §16 records this exact omission recurring four
times.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| Integer `position` with sibling rewriting on every move | N-row write and a whole-column lock footprint per drag, on a `max: 1` pool where every invocation is a separate connection (§1.3). The cost grows with board size, which is the wrong direction for the one interaction a user performs dozens of times an hour |
| Sparse integers (steps of 1024) with periodic rebalance | Strictly worse than `numeric`: it has the same rebalance obligation *and* a hard exhaustion point after ~10 midpoints in one gap, at which the "one row per move" property silently degrades to a sibling rewrite |
| `double precision` midpoint | IEEE-754 gives ~50 consecutive midpoints between one pair before the mantissa is exhausted; after that two cards compare equal and the order becomes arbitrary. `numeric` has no such point |
| LexoRank / base-62 lexicographic string rank | Correctness depends on the column collation being byte-order. Under any linguistic collation the board renders wrong with no error (§2.1). Also needs midpoint arithmetic in application code where `numeric` needs one SQL expression |
| Unique index scoped `("tenantId", status, position)` | Couples `status` writes to position uniqueness, so a workflow transition or `POST /tasks/:id/complete` could 500 on a unique violation for reasons the caller has no way to understand or avoid (§2.1) |
| Client sends the computed `position` | Computed against a board that is stale by one round trip; two users in the same gap silently overwrite. The server must derive it where the lock is (§2.2) |
| `updatedAt` as the optimistic-concurrency token | Microsecond-vs-millisecond truncation across the JSON boundary; also changes on unrelated edits, producing conflicts the user cannot explain (§2.4) |
| Last-write-wins on `position`, no version token | Explicitly refused by the requirement, and rightly: a drag that silently discards a colleague's drag is indistinguishable from a drag that worked |
| Keep ADR 0007 D3's separate `PATCH /tasks/:id/status` alongside `/move` | Two front doors writing the same column, one of which knows nothing about `position` — a card whose status changed through the other door ends up ordered by a value nobody set deliberately |
| Add `Task.internal` now, "since it is already written" | The widening it fences never shipped; the column would be read by nothing and reasoned from by everyone (§2.6). Its migration also collides with a live timestamp (§1.5) |
| A `board-rebalance` entry in `JOB_CADENCE_MINUTES` | `fast` scope needs an external scheduler that is not provisioned; `daily` leaves a board degraded for up to 24h (§2.5) |
| Board columns authored in the config pack (PRD PD-6) | Out of scope here and genuinely undecided. This ADR fixes the *ordering* mechanism; whether the six `TaskStatus` values remain the columns, or a pack authors them, changes nothing about `position` and should be decided separately with the pack contract in view |

---

## 4. Consequences

1. **Two new columns on `tasks`, one new unique index, and a version bump obligation on every
   existing task write path.** The last is the part most likely to be missed: `PUT /tasks/:id`,
   `/start`, `/complete`, `/cancel`, `RecurringJob` materialisation and any workflow-engine write
   must all `version = version + 1`, or a stale client's `/move` succeeds against a task that
   changed underneath it. Owen's review should include a test asserting every write path bumps it.
2. **`POST /tasks` must claim a position.** A card created while the board is open needs a place;
   the same `MAX(position) + 1000` expression as the empty-neighbour case (§2.2), inside the
   insert. This is a second write path touching the unique index, and it can collide with a
   concurrent move — same bounded retry.
3. **The board reverses on deploy** (§2.7). Visible, intended, and worth announcing.
4. **The frontend's `resolveMove` reason strings (`task-board.tsx:55-79`) become false the moment
   this ships** — every column becomes a legal target. Mira replaces the reason table with the
   move call plus 409 handling; the drop-disabled styling on `under_review`/`blocked` goes with
   it. **Landing the backend without the frontend change leaves a board that refuses drops the
   API would now accept** — an honest-but-stale UI, which is the safe direction, but it should
   not sit that way for long.
5. **Three previously unreachable statuses become writable** (`TODO`, `UNDER_REVIEW`, `BLOCKED`).
   Anything that assumed a task never returns to `todo` — reports, SLA watchdog, alert rules
   counting "completed" — should be checked. `SlaWatchdogService` and `AlertRuleService` are in
   `JobDispatchService`'s dependency list (ADR 0009 §1.3); `[UNVERIFIED: whether either derives a
   monotonic assumption from `status`; not read in this session]`.
6. **`numeric` arrives in the API as a string.** TypeORM maps `numeric` to `string` in JS to
   avoid float truncation, so `task.position` is `"1500"`, not `1500`. Clients must not do
   arithmetic on it — and under §2.2 they have no reason to, because they send neighbours.
   Swagger must type it `string`, not `number`, or every generated client is wrong.
7. **This ADR does not make the board pack-driven.** PRD PD-6 stays open.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A tenant's live task count reaches the point where the §2.5 renormalisation is no longer a sub-second statement (order 10⁵ rows) | D5's inline, whole-tenant rebalance | Move to a per-status-column rebalance (renormalise only the column the deep position landed in), which bounds the write to one column; only if that is still too large, revisit the `/jobs` route once an external scheduler exists |
| Board columns become pack-authored (PRD PD-6) | Nothing in D1 — `position` is independent of what the columns are — but D3's `status` parameter would need to accept a pack-declared column key rather than a `TaskStatus` member | Keep `position`; add a promoted `boardColumn` column alongside `status` rather than overloading `status` with pack vocabulary, which would be an 80/20 violation |
| Users report 409s often enough to be an irritant rather than a safety net | D4's strict compare-and-set | Do **not** relax to last-write-wins. Narrow the version bump so that writes which cannot affect ordering (a title edit, a description edit) do not invalidate an in-flight drag — a second, ordering-only counter, or excluding those fields from the bump |
| Per-user or per-filter board ordering is required ("my board, ordered my way") | D1's single tenant-wide order | That is a different data model — an ordering *per (user, board)* — and is a new table, not a wider column. New ADR |
| The `entityId`-based client task widening from ADR 0007 D3 is built | D6's declining of `Task.internal` | Reinstate `internal` in that ADR, in the same commit as the widening, with a renumbered migration (§1.5) |
| Postgres `numeric` scale growth turns out to be faster than §2.5's arithmetic predicts in real use | D5's threshold of 30 | Lower the threshold; the mechanism does not change. Measure `scale(position)` distribution before changing the number |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `tasks.position` + `IDX_tasks_tenant_position` (`AddTaskBoardPosition`) | `DROP INDEX "IDX_tasks_tenant_position"; ALTER TABLE "tasks" DROP COLUMN "position"` | Every hand-arranged board order is lost and is not recoverable — `createdAt` order is the only fallback. **Confirm with affected firms before rolling this back once any board has been arranged**, the same caution ADR 0009 §6 gives for `tenant_fee_overrides` |
| `tasks.version` | `ALTER TABLE "tasks" DROP COLUMN "version"` | None of consequence — it is a counter with no historical meaning. **Roll it back only together with the `/move` route**, never alone: the route's `WHERE … version = $expected` would then match nothing and every move would 409 |
| Backfill (inside the same migration) | Reverted by dropping the column above | Same caveat as the column |
| `PATCH /tasks/:id/move` + the transition helper + version bumps on existing write paths | Revert the commit | Tasks moved while it was live keep their positions and statuses; nothing is retroactively reset. Reverting the version bumps alone, while leaving the route, breaks the route — revert them together |
| Frontend `resolveMove` replacement | Revert to the reason table | Display only. **This is the safe half to leave in place**: the old reason strings simply become over-cautious against a route that would accept the drop, which is the correct failure direction |

**Rollback verification.** Before dropping `position`, confirm nothing in `meru-core-fe` reads it
unconditionally and that `SearchService`'s task index does not carry it — the same
"confirm before reverting" discipline ADR 0010 §6 uses.

---

## 7. Open items for implementers

| # | Item | Owner |
|---|---|---|
| 1 | Concurrency test: N parallel `/move` calls into the same gap, same tenant — assert all succeed, all positions distinct, retry count bounded | Owen |
| 2 | Conflict test: two `/move` calls on the same task with the same `expectedVersion` — assert exactly one 200 and one 409 `MER-RES-0005` carrying the current row | Owen |
| 3 | Assert every task write path bumps `version` (§4 item 1) — a spec over the service, not the route | Owen |
| 4 | Register `AddTaskBoardPosition1757000000000` in `ALL_MIGRATIONS` **in the same commit** (`src/config/migrations.ts:55`) | Luke |
| 5 | Swagger: `position` typed `string`, not `number` (§4 item 6) | Luke |
| 6 | Confirm `SlaWatchdogService` / `AlertRuleService` carry no monotonic `status` assumption (§4 item 5) | Luke |
| 7 | Replace `resolveMove` (`task-board.tsx:55-79`) with the move call, optimistic apply, and 409 reconciliation from `error.details.task` | Mira |
| 8 | Frontend changelog line for the board's initial order reversing on deploy (§2.7) | Mira |
| 9 | Renumber `_salvage/_recovered-from-e8/src/migrations/1756500000000-AddInternalToTasks.ts` **if it is ever revived** — the timestamp is taken (§1.5) | whoever revives it |
