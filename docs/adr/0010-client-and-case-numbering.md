# 0010 — Client and case numbering

**Status:** Proposed — 2026-09-09. Not merged. Requires `quality` (Owen) review (concurrency
correctness under the serverless pool constraint is exactly the class of thing a green unit
suite will not catch — see §4.3) and `secops` (Anton) review for the new RLS-carrying table,
per `definition-of-done.md`. Luke implements against this contract; this document specifies no
feature code.

**Scope:** PRD FR-4.10 and FR-5.4 — an auto-generated client number and case number, unique per
tenant, shown on the client, every case, every invoice and every document. Companion to ADR
0011 (record-identity/"unnamed client" contract), which this document does not duplicate.

---

## 1. Context

### 1.1 Nothing generates a number today; the frontend fakes one

`meru-core-fe/immistack/app/(workspace)/payments/page.tsx:90` reads `c.case_number ?? c.id.slice(0, 8)`
— an eight-character slice of a UUID, presented as if it were a case reference, on the one screen
(government-fee tracking) where a caseworker cross-checks against a paper file. `case_number` is
not a promoted column on `UniversalEntity`
(`src/crm/entities/universal-entity.entity.ts:124-214` — no such column exists); it is whatever a
caller happened to write into `verticalAttributes.case.case_number`
(`meru-core-fe/immistack/lib/api/services/cases.service.ts:53-59`, `toEntityDto`), and nothing on
either side of the wire ever sets it. Ten other frontend call sites read the same absent field
(`meru-core-fe/immistack/app/(workspace)/cases/page.tsx`, `clients/[id]/page.tsx:373`,
`cases/[id]/page.tsx:227`, `client/home/page.tsx:168,372`, `client/application/page.tsx:112`,
`components/kanban/kanban-card.tsx:108`, `components/layout/command-palette.tsx:107`,
`lib/utils/kanban.ts:18,41` — confirmed by grep, 2026-09-09). There is no `client_number` anywhere
in the frontend today; FR-4.10 is entirely unbuilt, not partially built.

### 1.2 A live example of the exact anti-pattern this ADR must not repeat

`BillingService.generateInvoiceNumber` (`src/billing/billing.service.ts:626-630`):

```ts
private async generateInvoiceNumber(tenantId: string): Promise<string> {
  const count = await this.invoiceRepo.count({ where: { tenantId } });
  const date = new Date();
  return `INV-${tenantId.substring(0, 8)}-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}-${String(count + 1).padStart(6, '0')}`;
}
```

`count()` then `+1` is a read-then-write with no lock between the two steps. Two concurrent
invocations for the same tenant — routine under Vercel, where every request is a separate
function instance drawing from a **DB pool of `max: 1`** (`meru-core/CLAUDE.md` §9) — can both
read the same count and mint the same `invoiceNumber`, which collides against
`Invoice.invoiceNumber`'s `@Column({ unique: true })`
(`src/billing/entities/invoice.entity.ts:41`) and 500s the second caller, or — if the count moved
between the two reads for an unrelated reason — silently skips a number. This is exactly the race
FR-4.10/5.4 must not have, and this ADR's mechanism (§2.2) is deliberately not this shape. Fixing
`generateInvoiceNumber` itself is **out of scope** here — invoices are not part of this ADR's
deliverable — but it is flagged as a related, unfixed gap for Jonas/Luke to backport this ADR's
counter mechanism onto, since it is the same defect class.

### 1.3 The serverless constraints this must survive

Per `meru-core/CLAUDE.md` §9: DB pool `max: 1` per invocation, `maxDuration: 60s`, and — because
`meru-core/vercel.json` routes every path to one function — **genuinely concurrent invocations**,
each with its own single-connection pool, all capable of writing to the same tenant's rows at the
same moment. A counter that lives in application memory (a module-level variable, a cache) is
worthless: each invocation is a fresh process. The only place a counter can safely live is the
database, and the only safe way to advance it is a single atomic statement — not a
read-then-write pair, however short.

### 1.4 Tenancy: how the counter must be scoped, and what tenant deletion does to it

Every tenant-scoped table carries `"tenantId"` and RLS, `ENABLE` and `FORCE`
(`meru-core/CLAUDE.md` §8; `1754700000000-AddTenantConnectors.ts` and
`1756700000000-AddTenantFeeOverrides.ts` are the direct precedents for a new small tenant-scoped
table, both `ENABLE`/`FORCE` at creation with a `tenant_isolation` policy using
`app.rls_bypassed()` / `app.current_tenant_id()`). RLS binding happens by patching
`obtainMasterConnection` on the shared `DataSource` (`src/core/tenancy/rls.datasource.ts:38-83`)
— **every** connection checkout, including one obtained via a manually-opened `QueryRunner`
inside a service method, is bound to `TenantContext.get()`'s tenant before it is handed out. This
is why `BillingService` can safely open its own `QueryRunner`/transaction
(`billing.service.ts:383-385`) mid-request and still have it scoped correctly — the same
guarantee this ADR's transaction (§2.2) relies on.

`Tenant.slug` is not stable across a tenant's lifetime: ADR 0009 §2.1 soft-deletes a tenant by
rewriting `slug` to `${slug}--deleted--${id.slice(0,8)}` to release the name for reuse, while the
`Tenant` row (and therefore `tenantId`) is never deleted or reused — hard purge was rejected
outright in that ADR because the ~63 RLS tables would orphan, and because `audit_logs` structurally
refuses `DELETE`/`UPDATE` via a WORM trigger. This matters directly here: **whatever this ADR
scopes the counter by must survive a tenant rename/soft-delete unchanged.** `tenantId` (immutable)
satisfies that; `slug` (mutable, and deliberately overwritten on deletion) does not. §2.1 decides
accordingly.

---

## 2. Decisions

### 2.1 D1 — Format (PD-1): `{PREFIX}-{zero-padded sequence}`, no year, no tenant slug, one generic column

**Decision.** Two series, sharing one mechanism:

- **Client number:** `CL-000001`, `CL-000002`, … — assigned to `EntityType.PERSON` and
  `EntityType.ORGANIZATION` (the existing `SUBJECT_TYPES` set, `src/crm/crm.service.ts:91-94`).
- **Case number:** `CS-000001`, `CS-000002`, … — assigned to `EntityType.CASE`.

Padding is a **minimum**, not a cap: `String(value).padStart(6, '0')` renders `1234567` as
`CL-1234567`, not a truncated or wrapped value — there is no tenant realistically reaching seven
digits of clients, but the format does not silently misbehave if one somehow did, and no future
code change is needed at that boundary.

Stored as **one** new column, `UniversalEntity.recordNumber: string | null` — not two differently
named columns (`clientNumber`, `caseNumber`) — because `type` already determines which series
applies (§2.3's `seriesFor`), and a single generic column matches the shape `status`/`dueDate`/
`assignedTo` already establish on this entity: "generic column, per-type meaning," never
vertical-specific naming baked into core (`universal-entity.entity.ts:146-154`'s own comment makes
this the house style). The word "client"/"case" appears only as the two-letter **prefix value**,
not as a schema concept — a future GRC "SAR number" or "obligation number" is a third prefix and a
one-line addition to `seriesFor` (§2.3), never a migration.

**Why not embed the tenant slug or the year (rejected alternatives, detailed in §3).** In short:
slug is mutable and deliberately rewritten on deletion (§1.4); a year-scoped reset adds a
composite-key/rollover mechanism no requirement asks for; and uniqueness is already enforced
per-tenant at the database level (§2.2), so a human-readable tenant marker in the number itself is
cosmetic, not load-bearing — and every consumer of the number (staff inside their own tenant, a
client inside their own portal) already knows which tenant they are in.

**No lead number.** `EntityType.LEAD` is **not** eligible for the `CL` series — a lead is
prospective, not yet a client, and FR-4.9/4.10 are about the client relationship. §2.4 covers what
happens at the moment a lead converts into one.

### 2.2 D2 — Counter storage and concurrency: a dedicated table, one atomic `INSERT … ON CONFLICT … RETURNING`, inside the same transaction as the entity write

**Decision.** New table `tenant_record_counters`:

```sql
CREATE TABLE "tenant_record_counters" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"    uuid NOT NULL,
  "series"      character varying(8) NOT NULL,   -- 'CL' | 'CS' today, additive
  "value"       bigint NOT NULL DEFAULT 0,
  "updatedAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_tenant_record_counters_tenant_series" UNIQUE ("tenantId", "series")
);
-- ENABLE/FORCE RLS, tenant_isolation policy — identical shape to
-- 1756700000000-AddTenantFeeOverrides.ts.
```

No pre-seeding is needed: the first request for a given `(tenantId, series)` creates the row via
the same statement that claims number 1.

**The atomic primitive — one statement, no separate lock:**

```sql
INSERT INTO "tenant_record_counters" ("tenantId", "series", "value", "updatedAt")
VALUES ($1, $2, 1, now())
ON CONFLICT ("tenantId", "series")
DO UPDATE SET "value" = "tenant_record_counters"."value" + 1, "updatedAt" = now()
RETURNING "value";
```

Postgres locks the conflicting row as part of evaluating `ON CONFLICT` — a second session's
`INSERT … ON CONFLICT` against the same `(tenantId, series)` key **blocks** until the first
session's transaction commits or rolls back, then proceeds against the now-current value. This is
the standard, documented-safe Postgres counter pattern: no `SELECT … FOR UPDATE` round trip, no
`pg_advisory_xact_lock`, and — critically for §1.4 — contention is scoped to one `(tenantId,
series)` row, so two different tenants' writers, or a tenant's client-numbering writer and its
case-numbering writer, never block each other. This is the property `generateInvoiceNumber`'s
`count()+1` (§1.2) does not have.

**Where this runs.** Inside `CrmService.createEntity` (`src/crm/crm.service.ts:187-278`), wrapped
in a `QueryRunner` transaction opened **after** the existing pre-checks (settings fetch, duplicate
email check, `:196-229`) and **around only** the number claim plus the entity `save` — the same
shape `BillingService.createInvoice` already uses in this codebase
(`billing.service.ts:383-425`: `createQueryRunner()` → `connect()` → `startTransaction()` →
work → `commitTransaction()`/`rollbackTransaction()` → `release()`). `CrmService` gains a plain
`DataSource` constructor parameter, matching `BillingService`'s (`billing.service.ts:68`) — no
`@InjectDataSource()` needed; `DataSource` is a global provider under `TypeOrmModule.forRoot()`,
already resolvable outside `BillingModule`.

```ts
const series = seriesFor(dto.type);              // §2.3 — null for anything not CL/CS-eligible
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction();
try {
  let recordNumber: string | null = null;
  if (series) {
    const [{ value }] = await queryRunner.query(
      `INSERT INTO "tenant_record_counters" ("tenantId", "series", "value", "updatedAt")
       VALUES ($1, $2, 1, now())
       ON CONFLICT ("tenantId", "series")
       DO UPDATE SET "value" = "tenant_record_counters"."value" + 1, "updatedAt" = now()
       RETURNING "value"`,
      [tenantId, series],
    );
    recordNumber = `${series}-${String(value).padStart(6, '0')}`;
  }
  const entity = queryRunner.manager.create(UniversalEntity, { /* …existing fields…, */ recordNumber });
  const saved = await queryRunner.manager.save(entity);
  await queryRunner.commitTransaction();
  return saved;
} catch (err) {
  await queryRunner.rollbackTransaction();
  throw /* existing error mapping, `:269-278` */;
} finally {
  await queryRunner.release();
}
```

**Why the same transaction as the entity insert, not a separate committed step.** If the entity
insert fails after the number is claimed, rolling back the whole transaction rolls back the
counter increment too — no number is burned on an entity that was never created. A number can
still be burned if the transaction **commits** and a later, non-transactional step fails (e.g.
`searchService.indexEntityData`, already fire-and-forget and outside the transaction,
`:264-266`) — that is an accepted gap (§2.2 rejects "numbers must have zero gaps ever" as a
requirement; only reuse is forbidden, and this never reuses one).

**Why not `dataSource.transaction()`'s callback form instead of an explicit `QueryRunner`.** Purely
consistency: `BillingService` already established the explicit-`QueryRunner` idiom in this
codebase for exactly this shape of work (claim-a-number-then-insert), and mismatched transaction
idioms across two services doing the same kind of thing is its own source of drift.

### 2.3 D3 — Eligibility is a pure function of `type`, colocated with the existing per-type helpers

**Decision.** A `seriesFor` function next to `defaultStatusFor` (`crm.service.ts:60-62`):

```ts
function seriesFor(type: EntityType): 'CL' | 'CS' | null {
  if (SUBJECT_TYPES.has(type)) return 'CL';
  if (type === EntityType.CASE) return 'CS';
  return null;
}
```

Reuses the existing `SUBJECT_TYPES` set (`:91-94`) rather than a new list — one definition of
"what counts as a client" for both the required-field check that already gates on it and this
numbering decision, so the two can never silently diverge. `EntityType.CASE` is confirmed
core-neutral, not immigration vocabulary: GRC's own base pack uses it
(`packages/config-packs/verticals/grc.json:145`, the `aml-customer-onboarding` workflow's
`entityType: "case"`), alongside every immigration country overlay
(`packages/config-packs/countries/au-immigration.json` and siblings). A GRC "case" gets a `CS-`
number under this design; that is a consequence of the type already being shared, not a new
vertical-vocabulary leak (§7.1 is about not letting core learn what a *visa* is, not about
refusing a generic feature to a type both verticals already use).

### 2.4 D4 — Immutability, and what happens at conversion

**Decision.** `recordNumber` is assigned **exactly once**, only inside `createEntity` (§2.2) or, as
the one addition below, inside `convertEntity` — and never accepted as caller input.

- **Never writable via the API.** `recordNumber` is added to neither `CreateEntityDto`
  (`src/crm/dto/create-entity.dto.ts`) nor `UpdateEntityDto`
  (`src/crm/dto/update-entity.dto.ts`). The global `ValidationPipe` runs with `whitelist: true,
  forbidNonWhitelisted: true` (`src/main.ts:119-121`, mirrored in `api/index.js:229-231`), so a
  caller who sends `recordNumber` in a request body gets a 400 for free — no new guard code
  needed, the same mechanism that already refuses a stray `type` on `PATCH`.
- **A number, once assigned, survives type conversion among eligible types.** `PERSON ↔
  ORGANIZATION` conversion (`CONVERTIBLE_TYPES`, `:73-83`) does not touch `recordNumber` at all —
  it is untouched by `convertEntity`'s existing field-by-field logic (`:663-687`), so it simply
  carries over, matching the same "the record keeps its id and its history" principle
  `convertEntity`'s own docstring states (`:610-619`) for exactly this reason.
- **`LEAD → PERSON`/`LEAD → ORGANIZATION` conversion is the one case that assigns a number where
  none existed.** A lead has no `recordNumber` (§2.1 — leads are not eligible). The moment a lead
  converts into a client, `convertEntity` must claim one, using the identical counter mechanism as
  `createEntity` (§2.2), inside the same transaction as the type-and-status rewrite it already
  performs. This is additive to `convertEntity`'s existing body, gated on `entity.recordNumber ==
  null && seriesFor(toType) != null`, so re-converting `PERSON → ORGANIZATION → PERSON` never
  claims a second number.
- **`convertEntity` does not, and must not, try to derive a name or number from
  `verticalAttributes`.** ADR 0011 covers why: core does not know where a vertical stashed a
  lead's name, and guessing would be an 80/20 violation. This ADR only says: assign a number if
  one is due; it says nothing about `firstName`/`lastName` (that is entirely ADR 0011's subject).

### 2.5 D5 — Backfill for existing records

**Decision.** One migration, run once, in one transaction: assign every existing eligible row
(`type IN ('case','person','organization')` and `"recordNumber" IS NULL`) a number in `("tenantId",
seriesFor(type))` order by `("createdAt", "id")`, via a window function, then seed
`tenant_record_counters` from the result — not a row-by-row loop through the application-level
counter mechanism.

```sql
WITH ranked AS (
  SELECT id, "tenantId",
         CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END AS series,
         ROW_NUMBER() OVER (
           PARTITION BY "tenantId", (CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END)
           ORDER BY "createdAt", id
         ) AS rn
  FROM universal_entities
  WHERE "recordNumber" IS NULL
    AND type IN ('case', 'person', 'organization')
)
UPDATE universal_entities e
SET "recordNumber" = ranked.series || '-' || LPAD(ranked.rn::text, 6, '0')
FROM ranked
WHERE e.id = ranked.id;

INSERT INTO tenant_record_counters ("tenantId", series, value, "updatedAt")
SELECT "tenantId",
       CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END,
       COUNT(*), now()
FROM universal_entities
WHERE "recordNumber" IS NOT NULL AND type IN ('case', 'person', 'organization')
GROUP BY "tenantId", CASE WHEN type = 'case' THEN 'CS' ELSE 'CL' END
ON CONFLICT ("tenantId", "series")
DO UPDATE SET "value" = GREATEST(tenant_record_counters."value", excluded."value");
```

**Soft-deleted rows are numbered too** — `"deletedAt" IS NOT NULL` is not excluded. A number that
already appears on a historical invoice or document does not stop being true because the record
was later archived, and this system does not delete history (§7.7/audit-everything is the same
instinct applied to money and identity rather than the audit log itself).

**The concurrency caveat, stated plainly rather than engineered around.** This single-transaction
bulk approach holds a row lock on every touched `(tenantId, series)` counter for the full duration
of the migration — a genuinely concurrent `createEntity`/`convertEntity` call for an affected
tenant during that window will **block**, not race, which is correct but is a real, if brief,
availability cost. This is accepted **because current data volume does not justify more
machinery**: the only tenants on this system today are pilot/test tenants
(`sweep-pilot-*`, `meru-core/CLAUDE.md` §16), so the backfill set is small and the migration is
expected to run in well under a second. **Trigger to revisit:** if this migration is ever run
against a live-traffic production tenant set with a backlog large enough that the transaction
would run for more than a few seconds, switch to a per-tenant-locked, batched version (lock and
number one tenant's rows per transaction, in a loop, so unrelated tenants' writers are never
blocked) rather than running this as written.

### 2.6 D6 — Tenant deletion and slug release: no special handling, by construction

**Decision.** Nothing about this feature needs to change when a tenant is soft-deleted (ADR 0009
§2.1). `tenant_record_counters` and `recordNumber` are both keyed by `tenantId` (a UUID that is
never reused — ADR 0009 rejected hard purge outright, and the soft-delete path never deletes the
`Tenant` row itself), never by `slug` (which ADR 0009 deliberately rewrites and releases for
reuse). A brand-new tenant that later signs up under a reused slug gets a brand-new `tenantId` and
therefore starts its own counters at zero — there is no path by which a released slug causes a
number collision or a number to be reused, because the format never carried the slug in the first
place (§2.1). The soft-deleted tenant's `tenant_record_counters` rows are simply left in place,
harmless and tiny — the same "data left behind, correctly" stance ADR 0009's own rollback table
takes for `audit_logs` and a deleted tenant's other rows.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| `MAX(recordNumber-suffix) + 1` (or `COUNT(*) + 1`, as `generateInvoiceNumber` already does) | The exact race this ADR exists to avoid (§1.2) — two concurrent invocations on separate pool-of-1 connections can read the same value before either writes |
| Native Postgres `SEQUENCE` per tenant (`CREATE SEQUENCE tenant_<id>_client_seq`) | Requires dynamic DDL per tenant at provisioning time and dynamic cleanup semantics on deletion that ADR 0009 deliberately keeps simple (soft-delete, nothing purged); does not fit the "one small table, RLS as usual" model every other tenant-scoped setting in this codebase uses; gains nothing over `INSERT … ON CONFLICT` for this volume |
| `pg_advisory_xact_lock` around a read-then-write pair | No benefit over the `UNIQUE` + `ON CONFLICT` row lock, which needs no explicit lock/unlock discipline and cannot be forgotten by a future caller; an advisory lock is a second, parallel serialization mechanism this system does not otherwise use |
| Embed `tenant.slug` in the number (`ACME-CL-000001`) | `slug` is mutable and deliberately rewritten on tenant deletion (§1.4); a stored, already-issued number must not depend on a value that can change out from under it, and uniqueness is already enforced per-tenant at the database level without it |
| Year-scoped reset (`CL-2026-000001`, resetting each January) | No FR asks for it; adds a composite counter key and a rollover edge case for no stated benefit — can be layered on later (§5) if finance ops actually needs year-grouped numbering |
| Store two integer columns directly on `tenants` (`clientCounter`, `caseCounter`) | Not extensible to a third series without a migration; concentrates every client/case creation's write onto the one row read by nearly every request (tenant settings/entitlements lookups), where a dedicated table concentrates it onto a much smaller, purpose-built row instead |
| Two separate columns on `UniversalEntity` (`clientNumber`, `caseNumber`) instead of one `recordNumber` | Bakes "client"/"case" naming into the core schema as two concepts instead of one generic promoted field with a per-type meaning — inconsistent with how `status`/`dueDate`/`assignedTo` are already modelled on this entity |

---

## 4. Consequences

1. **A new table (`tenant_record_counters`) and a new column (`UniversalEntity.recordNumber`)** —
   both additive, both RLS-carrying from creation. Run `npm run rls:verify` after this migration
   specifically, not just the unit suite.
2. **`CrmService.createEntity` and `CrmService.convertEntity` both gain a `DataSource` dependency
   and a `QueryRunner` transaction they did not have before.** This is the same shape
   `BillingService` already uses successfully under the identical pool-of-1 constraint
   (`billing.service.ts:383-425`), but it is new surface area in `CrmService` specifically, and
   Owen's review should include a concurrency test — N parallel `createEntity` calls for the same
   tenant and type, asserting the resulting `recordNumber`s are all distinct and contiguous — since
   this is exactly the class of defect a sequential unit suite does not exercise.
3. **Every `POST /crm/entities` and the `LEAD → PERSON`/`LEAD → ORGANIZATION` branch of `POST
   /crm/entities/:id/convert` now do one extra write (the counter upsert) inside the request.**
   Negligible latency (`meru-core/CLAUDE.md` §9's `maxDuration: 60s` gives ample headroom for one
   extra single-row upsert), but it is a second write where there was one, worth naming for anyone
   reasoning about write amplification later.
4. **Invoices and documents are not given their own new number scheme by this ADR.** "Shown on
   every invoice/document" means the client's/case's `recordNumber` is *rendered* on the invoice or
   document — a read, via the existing relationship from an invoice/document to the CRM entity it
   concerns — not a new counter for invoices themselves. `Invoice.invoiceNumber`
   (`billing.service.ts:626-630`) is a separate, pre-existing, differently-racy mechanism this ADR
   does not touch (§1.2); fixing it is flagged, not done, here.
5. **`GET /crm/entities` responses gain a `recordNumber` field with no extra work** — `CrmController`
   returns the `UniversalEntity` directly and nothing found in this codebase strips unknown columns
   from that response (`[UNVERIFIED: no class-transformer @Exclude() or explicit response DTO was
   found narrowing /crm/entities responses; Luke should confirm this holds before relying on it]`).

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| Finance/legal ops asks for year-grouped numbering (e.g., for annual filing reconciliation) | D1's flat, non-resetting format | Add a `year` component to the `series` key (`'CL:2027'`) rather than reformatting existing numbers — old numbers stay valid, new ones start a new sub-sequence |
| The backfill (§2.5) is ever run against a tenant set with real concurrent production traffic and a large unnumbered backlog | D5's single-transaction bulk approach | Switch to the per-tenant-locked, batched version named in §2.5's trigger note |
| A third series is needed (an "obligation number," a "SAR number") | D3's two-value `seriesFor` | Add one more prefix and one more branch — no migration, no new table, per D1's stated extensibility |
| `generateInvoiceNumber`'s race (§1.2) actually fires in production (two invoices with the same number, or a 500 on the unique constraint) | Nothing in *this* ADR, but confirms the analysis in §1.2 | Backport this ADR's `tenant_record_counters` mechanism onto `BillingService`, as a new, separate, small ADR or an amendment referencing this one |
| A tenant genuinely needs per-country or per-visa-subclass numbering (not just one flat client/case sequence) | D1's "one series per type, tenant-wide" | This is a materially different requirement (a compound key), not covered here — treat as a new ADR rather than stretching this one |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `tenant_record_counters` table (migration `AddRecordNumbering`) | `DROP TABLE tenant_record_counters` | None — purely a counter, no historical meaning outside driving the next number |
| `UniversalEntity.recordNumber` column + partial unique index | `ALTER TABLE universal_entities DROP COLUMN "recordNumber"` | Every already-issued number is lost from the row — **do not roll this back once any number has been shown on a real invoice or document**; if that has happened, roll back the *code path* that assigns new numbers instead, and leave the column and its data in place |
| Backfill migration (`BackfillRecordNumbers`) | Not meaningfully reversible on its own — it only writes into the column above, so rolling back the column (previous row) also reverts this | Same caution as the column row above |
| `CrmService.createEntity`/`convertEntity` transaction + counter-claim logic | Revert the commit; `createEntity`/`convertEntity` return to their pre-ADR bodies | Rows created while this was live keep their `recordNumber`; nothing is retroactively blanked |

**Rollback verification:** if the column is ever dropped, confirm no frontend code still reads
`recordNumber` unconditionally first — the same "confirm before reverting" discipline ADR 0009 uses
for its own schema rollback entries.

---

## 7. Open items for implementers

| # | Item | Owner |
|---|---|---|
| 1 | Confirm `/crm/entities` responses carry no response-DTO/serializer that would need `recordNumber` added explicitly (§4 item 5) | Luke |
| 2 | Add `recordNumber` to `CrmController`'s Swagger response schema / examples | Luke |
| 3 | Concurrency test: N parallel `createEntity` calls, same tenant and type, assert distinct contiguous `recordNumber`s | Owen |
| 4 | `npm run rls:verify` against the new `tenant_record_counters` table specifically | Anton |
| 5 | Backport the same counter mechanism onto `BillingService.generateInvoiceNumber` (§1.2, §5) — separate piece of work, not blocking this ADR | Luke / Jonas |
| 6 | Wire the invoice/document rendering paths to read the case's/client's `recordNumber` off the linked CRM entity, replacing the `c.id.slice(0,8)` fallback at `payments/page.tsx:90` and the ten other read sites named in §1.1 | Mira |
| 7 | Add `recordNumber` to `SearchService.indexEntityData`'s indexed fields, so staff can search `CS-000042` directly (`src/search/search.service.ts:96-112`) | Luke |
