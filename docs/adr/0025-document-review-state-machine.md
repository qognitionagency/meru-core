# 0025 — Document review state machine (E19)

**Status:** Proposed — 2026-09-17, not merged.

**Owner:** Kyle (architect). Implementation: Luke (backend-dev), Mira (frontend-dev). Review/gate:
Owen (quality). Tenancy review: Anton (secops) — this ADR adds a new staff-only write surface and
extends what a `client` token may read on an existing one.

**Scope:** ImmiStack PRD FR-6.6 (`Requested → Uploaded → Under Review → Approved | Rejected`, pack
rejection-reason enum, "request re-upload" action), FR-6.9 (version history), FR-6.10 (staff
review, reviewer + timestamp), tied to FR-6.5's three-valued checklist rendering.

**Verified against:** `meru-core/src/documents/` on disk, 2026-09-17; live `/api-json` not
re-queried for this ADR — every route named below is checked against the controller source at
the cited line, not against a fetched spec. `[UNVERIFIED: /api-json path count at merge time]`.

---

## 1. Context

### 1.1 What exists today, and what does not

`DocumentStatus` (`src/documents/entities/document.entity.ts:16-20`) is `active | archived |
deleted` — **storage lifecycle only**. It answers "does this object still exist", never "has
anyone looked at it". There is no review field on `Document` at all: no reviewer, no review
timestamp, no rejection reason. `grep -rn "reviewStatus\|reviewedBy\|rejectionReason" src/`
returns zero matches outside this ADR.

Three things already ship and this ADR builds on them rather than around them:

| Capability | Evidence |
|---|---|
| Re-upload without destroying the prior version | `POST /documents/:id/versions` (`documents.controller.ts:143`) → `DocumentsService.createNewVersion` (`documents.service.ts:439`) inserts a new `DocumentVersion` row and bumps `document.versionNumber`; nothing deletes the prior row. **FR-6.9 is already satisfied structurally** — this ADR only has to reset the review sub-state on a fresh upload, not build versioning. |
| The three-valued checklist | `DocumentChecklistService.forEntity` (`src/documents/document-checklist.service.ts:62`) returns `{items[]}` where each item carries `uploaded: boolean \| null` and `applies: boolean \| null`, matched to `Document` rows by `metadata.documentTypeKey` or `tags`. This is the shape `GET /documents/checklist` already contracts (`ChecklistResponseDto`, `documents.controller.ts:174-213`) and this ADR extends it — it does not replace it. |
| "Requested" as a distinct fact | **Already built, uncommitted as of this session** (`src/documents/document-request.service.ts`, `POST /documents/checklist/request`, `documents.controller.ts:215-264`): `DocumentRequestService.recordRequest` stamps `verticalAttributes.documentsRequestedAt` on the **entity** (the case/matter), not on any `Document` row — because a requested document has no file yet, so there is no row to carry a status. This is why FR-6.6's `Requested` state is **not** a value of the new `Document.reviewStatus` enum below: it already exists one level up, on the record the checklist is evaluated against. |

**Who may review, per `immistack/CLAUDE.md` §2:** `firm_admin`, `manager`, `agent` and
`paralegal` may "verify / reject an uploaded document" — i.e. every practice role except
`client`. In `PlatformRole` terms (§2's own footnote: `manager` is a practice-role tag, not a
`PlatformRole` a guard can match) this collapses to **`firm_admin` and `staff`** — the same pair
already gating every other staff-only document route in this controller.

### 1.2 Tenancy model, derived from the code

- `documents` is a tenant-scoped table (`tenantId` column, `document.entity.ts:45-46`), part of
  the **68 of 68** ENABLE+FORCE RLS tables (`meru-core/CLAUDE.md` §5.1). RLS confines every query
  to the caller's tenant at the connection level.
- **RLS does not confine a `client` token to their own documents inside the tenant.**
  `DocumentAccessService` (`src/documents/document-access.service.ts:70-192`) is the service-layer
  check that does: `hasTenantWideReach(actor)` is true for `firm_admin`/`staff`/god-context and
  false for everyone else; a `client` actor's reach is `ownedEntityIds` — records they are the
  CRM-record SUBJECT of (`subjectEmail`) or assignee of, joined to documents by
  `uploadedById = actor.id OR linkedEntityId IN (ownedEntityIds)`.
- The new review-decision route is staff-only by `@Roles`, so it never reaches the `own`-scope
  branch — but per the standing rule this workspace has had to learn five times
  (`meru-core/CLAUDE.md` §8), **the route also calls `DocumentAccessService.assert(document, actor,
  'write')` before mutating**, so a staff member from tenant A cannot reach tenant B's document by
  guessing a UUID even though `@Roles` alone would let the request past the controller. This is
  belt-and-braces, not decorative: `assert` derives its answer from the **loaded row's**
  `tenantId`, and the row is loaded by `{id, tenantId}` from the caller's own JWT tenant first —
  two independent narrowings, matching every other mutation in this controller.
- The two read surfaces this ADR extends (`GET /documents/checklist`, `GET /documents/:id`)
  already run through `DocumentAccessService.assert(..., 'read')` / `applyScope`, so a client
  reading their own rejection reason needs **no new tenancy code** — the fields are additive to an
  already-scoped response.

---

## 2. Decision

### D1 — a review sub-state machine on `Document`, orthogonal to `DocumentStatus`

**Decision:** add `reviewStatus`, `reviewedById`, `reviewedAt`, `rejectionReasonKey`,
`rejectionReasonNote` and an append-only `reviewHistory` jsonb array to `Document`.
`DocumentStatus` (storage lifecycle) is untouched — a `rejected` document is still `status:
active`; it exists, it is simply not accepted.

```
reviewStatus: 'uploaded' | 'under_review' | 'approved' | 'rejected'   -- NOT NULL, default 'uploaded'
reviewedById: uuid | null
reviewedAt: timestamptz | null
rejectionReasonKey: varchar(64) | null      -- a key from the pack's rejection-reason list
rejectionReasonNote: text | null            -- free text, always alongside a key, never instead of one
reviewHistory: jsonb, default '[]'          -- append-only, see D3
```

**Why a `varchar` + `CHECK`, not a Postgres `ENUM` type.** The precedent this repo has already
set twice — `DocumentEncryption`/`DocumentStatus` are TypeORM `enum` columns declared at initial
table creation, but a Postgres `ALTER TYPE ... ADD VALUE` cannot run inside a transaction and
cannot be removed at all, which makes a later addition (a fifth review state, if one is ever
needed) a migration that cannot be part of the same deploy discipline this repo uses everywhere
else. `AddUserPractitionerCredential1756920000000` chose `varchar` + `CHECK` for exactly this
reason. Following it here keeps the two most recent additive-column migrations in this table
family consistent.

**Why `reviewStatus` starts at `uploaded`, not `requested`.** Per §1.1, "requested" already
exists as `verticalAttributes.documentsRequestedAt` on the CRM record, before any `Document` row
exists. A `Document` row is created by an upload (`documents.service.ts` `upload`/`create`); by
definition it cannot be created in a "requested, not yet uploaded" state. `reviewStatus` therefore
only ever describes a file that exists.

**Why `rejectionReasonKey` is a pack key, not a free string, and why `rejectionReasonNote` exists
alongside it — not instead of it.** Per the 80/20 rule (`meru-core/CLAUDE.md` §5.5) core does not
know what "expired" or "illegible" means as immigration vocabulary; the vertical does. But an
enum alone loses the specific thing wrong with *this* document — "expired 3 days before this
matter's lodgement window closes" is not expressible as `expired`. Both fields are required
together whenever `reviewStatus = 'rejected'` (enforced by a `CHECK`, matching the
`practitionerCredential`/`practitionerCredentialType` pairing precedent):

```sql
CHECK (
  "reviewStatus" <> 'rejected'
  OR ("rejectionReasonKey" IS NOT NULL)
)
```

`rejectionReasonNote` is never required at the database level — a firm that authors reasons
specific enough to need no elaboration should not be forced to pad a note. The frontend may make
it required for the pack's `other` key; that is a product decision, not a schema one.

**Why the reason vocabulary is one shared list, not per-document-type.** Considered and rejected:
authoring `rejectionReasons[]` on every one of ~15 `documentTypes[]` entries (§6.4 of the ImmiStack
doc names 12+ standard types) multiplies the authoring burden for what is mostly generic vocabulary
— illegible, wrong document, expired, name mismatch, incomplete, other. A pack that later finds it
needs a type-specific reason authors it as a more specific *key* in the shared list
(`bank_statement_wrong_period`) rather than a parallel per-type mechanism. If a real product need
for genuinely type-scoped reason sets emerges, that is the trigger to add an optional per-type
override — not decided here, see §7.

### D2 — where the vocabulary lives in the pack

**New pack surface**, nested under the existing top-level `compliance` key
(`config-pack-loader.service.ts:439` — already in the loader's persisted key list):

```jsonc
"compliance": {
  "documentReview": {
    "rejectionReasons": [
      { "key": "illegible", "label": "Illegible or low quality" },
      { "key": "expired", "label": "Document has expired" },
      { "key": "wrong_document", "label": "Wrong document type for this checklist item" },
      { "key": "name_mismatch", "label": "Name does not match the applicant's profile" },
      { "key": "incomplete", "label": "Incomplete — pages or fields missing" },
      { "key": "not_certified", "label": "Copy is not certified where certification is required" },
      { "key": "other", "label": "Other — see note" }
    ]
  }
}
```

**This is a two-part commit** (extend the Zod schema in
`packages/config-packs/_schema/pack.schema.ts`, then `npm run packs:schema`), **not** the
three-part rule `meru-core/CLAUDE.md` §4.2 warns about — `compliance` is already persisted
wholesale by `upsertPack` (`config-pack-loader.service.ts:439`), so nesting a new object under it
needs no change to the loader's key list. `config-pack-loader.service.spec.ts` stays green.

**Version bump required.** `packages/config-packs/verticals/immigration.json` — bump on the same
commit that adds this key, per `meru-core/CLAUDE.md` §4.2 rule 4 (the loader only upgrades on
strictly-greater version). The GRC pack is untouched — this is additive, optional, absent from
`grc.json`, and `GET /documents/checklist` for a GovX tenant is byte-identical whether or not this
key exists anywhere.

### D3 — the review actions are two dedicated routes, not a generic PATCH

**Decision:** `POST /documents/:id/review/start` and `POST /documents/:id/review/decision`.
**Not** folded into the existing `PATCH /documents/:id` (`documents.controller.ts:471`,
`UpdateDocumentDto`).

**Why not the generic PATCH.** Three reasons:

1. `UpdateDocumentDto` is a metadata-editing surface (`name`, `tags`, etc. — `[UNVERIFIED: exact
   field list, dto/update-document.dto.ts not read for this ADR; Luke to confirm before adding
   review fields to it, which is exactly what this decision avoids]`). Overloading it with review
   semantics would let a caller with plain "update a document" permission accidentally (or
   deliberately) flip `reviewStatus` to `approved` by sending an unrelated field alongside it,
   with no validation that `rejectionReasonKey` is a real pack key.
2. A dedicated `decision` route can validate `rejectionReasonKey` against the pack's
   `compliance.documentReview.rejectionReasons[]` **at the API boundary**, the same discipline
   ADR 0001 §4 uses for practice-role tags — a `class-validator` decorator cannot know the tenant's
   pack vocabulary at decoration time, so the check is service-layer, but it belongs to a route
   whose only job is this decision, not a general-purpose PATCH.
3. It matches this repo's own convention for a state-carrying action with its own meaning and its
   own audit trail — acceptance (`POST /crm/entities/:id/acceptance`), a workflow transition
   (`POST /workflows/instances/:id/transition`) — over a generic PATCH, per
   `src/crm/crm-access.service.ts`'s documented rule that a client's real state changes "go through
   purpose-built routes that carry their own meaning and their own audit trail, never a generic
   PATCH." This route is staff-only, not client-facing, but the same reasoning about **auditability
   of a decision** applies regardless of who is making it.

**Why two routes and not one.** `start` (uploaded → under_review) is optional and cheap — it lets
the client portal honestly render "we're looking at it" rather than only ever "uploaded" then
suddenly "approved". `decision` (uploaded or under_review → approved | rejected) is the one that
actually matters and carries the audit weight. Calling `decision` directly from `uploaded` is
valid — `start` is not a required gate, it is a courtesy state for the UI.

---

## 3. API contract

Base path `/api/v1/documents` (existing controller, `src/documents/documents.controller.ts`).

### `POST /documents/:id/review/start`

- **Roles:** `@Roles(PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)`.
- **Tenancy:** load `{id, tenantId}` from the caller's JWT tenant; `DocumentAccessService.assert(document,
  actor, 'write')` before mutating (§1.2).
- **Body:** none.
- **Behaviour:** if `reviewStatus === 'uploaded'`, set `reviewStatus = 'under_review'`. If already
  `under_review`, no-op, 200. If `approved` or `rejected`, **409 Conflict** — starting a review on
  an already-decided document is either a stale client or a mistake; the caller must call
  `decision` again if they genuinely want to reverse it (§3, `decision` allows re-deciding).
- **Response:** the updated `Document` row (existing shape, `reviewStatus`/`reviewedById`/
  `reviewedAt` now populated where applicable).
- **Errors:**
  - `404` — document not in this tenant (existing `NotFoundException` convention on this
    controller; no leak-minimisation concern here since only staff with tenant-wide reach call
    this route).
  - `409 MER-RES-0005` (`RESOURCE_VERSION_CONFLICT`) — already decided.

### `POST /documents/:id/review/decision`

- **Roles:** `@Roles(PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)`.
- **Tenancy:** identical to `start`.
- **Body** (`ReviewDecisionDto`, new):

```ts
export class ReviewDecisionDto {
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @IsOptional() @IsString() @MaxLength(64)
  rejectionReasonKey?: string;   // required when decision === 'reject'

  @IsOptional() @IsString() @MaxLength(2000)
  rejectionReasonNote?: string;
}
```

  Cross-field validation (`decision === 'reject'` requires `rejectionReasonKey`, and that key must
  be one of the tenant's resolved `compliance.documentReview.rejectionReasons[]`) is service-layer,
  same reasoning as ADR 0001 §4 — a pack vocabulary check cannot live in a static decorator.

- **Behaviour:** any `reviewStatus` except the target itself may transition to `approved` or
  `rejected` — including re-deciding an already-`approved`/`rejected` document (a staff member
  correcting their own mistake), and including deciding directly from `uploaded` (skipping
  `start`). Writes `reviewedById = actor.id`, `reviewedAt = now`, and for `reject` also
  `rejectionReasonKey`/`rejectionReasonNote`; for `approve`, both reason fields are cleared
  (`null`) even if a prior rejection had set them — an approved document must not carry a stale
  rejection reason. Appends to `reviewHistory` (D4) before returning.
- **Response:** the updated `Document` row.
- **Errors:**
  - `400 MER-VAL-0006` (`VALIDATION_INVALID_ENUM_VALUE`, **new code, next free slot in the
    `MER-VAL` family** — `src/common/types.ts:100-105` currently ends at `0005`) — `decision ===
    'reject'` with no `rejectionReasonKey`, or a key not in the resolved pack's list. Message names
    the valid keys and the pack code/version, matching the existing "name the pack and version"
    convention (`sectionWithPack`).
  - `404` — document not in this tenant.

### `POST /documents/:id/versions` — one behavioural change, no contract change

**Decision, additive to the existing route** (`documents.controller.ts:143`,
`DocumentsService.createNewVersion`, `documents.service.ts:439`): on a successful new version,
**reset `reviewStatus` to `'uploaded'`** and clear `reviewedById`/`reviewedAt`/
`rejectionReasonKey`/`rejectionReasonNote` on the `Document` row, after appending the prior
decision (if any) to `reviewHistory` with the version number it applied to. This is what makes
"request re-upload" (FR-6.6) mean something: a rejected document that gets replaced must go back
through review, not sit silently `rejected` forever with a newer file attached that nobody has
looked at. No new route, no new DTO field — this is a change inside the existing service method.

### `GET /documents/checklist` — additive response fields

`ChecklistItem.documents[]` (`document-checklist.service.ts:36`) gains three fields per document:

```ts
documents: Array<{
  id: string; name: string; status: string; uploadedAt: Date;
  reviewStatus: 'uploaded' | 'under_review' | 'approved' | 'rejected';   // NEW
  rejectionReasonKey: string | null;    // NEW
  rejectionReasonNote: string | null;   // NEW
}>
```

No new route, no tenancy change — this list is already scoped by the existing `entityId`
ownership check (`document-checklist.service.ts:109-111`, `assertOwnsEntity`) before any document
row is read.

### `GET /documents/:id` — additive response fields

Same three fields added to the existing single-document read (`documents.controller.ts:393`,
`DocumentsService.findOne` — `[UNVERIFIED: exact method name, not re-read for this ADR]`), already
gated by `DocumentAccessService.assert(..., 'read')`.

---

## 4. Data model

```sql
ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "reviewStatus" character varying(20) NOT NULL DEFAULT 'uploaded',
  ADD COLUMN IF NOT EXISTS "reviewedById" uuid NULL,
  ADD COLUMN IF NOT EXISTS "reviewedAt" timestamptz NULL,
  ADD COLUMN IF NOT EXISTS "rejectionReasonKey" character varying(64) NULL,
  ADD COLUMN IF NOT EXISTS "rejectionReasonNote" text NULL,
  ADD COLUMN IF NOT EXISTS "reviewHistory" jsonb NOT NULL DEFAULT '[]';

ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_review_status_valid";
ALTER TABLE "documents" ADD CONSTRAINT "CHK_documents_review_status_valid"
  CHECK ("reviewStatus" IN ('uploaded','under_review','approved','rejected'));

ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_rejection_reason_paired";
ALTER TABLE "documents" ADD CONSTRAINT "CHK_documents_rejection_reason_paired"
  CHECK ("reviewStatus" <> 'rejected' OR "rejectionReasonKey" IS NOT NULL);
```

`reviewedById` deliberately carries **no** `FOREIGN KEY` constraint, matching every other
actor-id field stored inside a jsonb history array elsewhere in this codebase
(`WorkflowInstance.history[].triggeredBy`, `AlertFiring`) rather than the relational
`uploadedById`/`ManyToOne` pattern on this same table. Reasoning: `reviewedById` is written from
`actor.id` at decision time and is never joined against in a hot path — it is read back for
display, resolved client-side against the directory the same way `triggeredBy` already is. Adding
a `ManyToOne` here would be the only FK on this table pointing at a jsonb-history-adjacent field
and inconsistent with the pattern the rest of the review data (`reviewHistory`) already uses.

**`reviewHistory` shape** (jsonb, append-only, same discipline as `WorkflowInstance.history[]`):

```ts
Array<{
  status: 'under_review' | 'approved' | 'rejected';
  byId: string;
  at: string;              // ISO-8601
  versionNumber: number;   // which DocumentVersion this decision applied to
  rejectionReasonKey?: string;
  rejectionReasonNote?: string;
}>
```

### Migration

**`1757300000000-AddDocumentReviewStatus.ts`**, additive, registered in `ALL_MIGRATIONS` in the
same commit as the migration file (`src/config/migrations.ts` — the array's own comment records
four prior production incidents from missing this step).

```ts
export class AddDocumentReviewStatus1757300000000 implements MigrationInterface {
  name = 'AddDocumentReviewStatus1757300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
        ADD COLUMN IF NOT EXISTS "reviewStatus" character varying(20) NOT NULL DEFAULT 'uploaded',
        ADD COLUMN IF NOT EXISTS "reviewedById" uuid NULL,
        ADD COLUMN IF NOT EXISTS "reviewedAt" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "rejectionReasonKey" character varying(64) NULL,
        ADD COLUMN IF NOT EXISTS "rejectionReasonNote" text NULL,
        ADD COLUMN IF NOT EXISTS "reviewHistory" jsonb NOT NULL DEFAULT '[]'
    `);
    await queryRunner.query(`
      ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_review_status_valid";
      ALTER TABLE "documents" ADD CONSTRAINT "CHK_documents_review_status_valid"
        CHECK ("reviewStatus" IN ('uploaded','under_review','approved','rejected'));
    `);
    await queryRunner.query(`
      ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_rejection_reason_paired";
      ALTER TABLE "documents" ADD CONSTRAINT "CHK_documents_rejection_reason_paired"
        CHECK ("reviewStatus" <> 'rejected' OR "rejectionReasonKey" IS NOT NULL);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_rejection_reason_paired"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "CHK_documents_review_status_valid"`,
    );
    await queryRunner.query(`
      ALTER TABLE "documents"
        DROP COLUMN IF EXISTS "reviewHistory",
        DROP COLUMN IF EXISTS "rejectionReasonNote",
        DROP COLUMN IF EXISTS "rejectionReasonKey",
        DROP COLUMN IF EXISTS "reviewedAt",
        DROP COLUMN IF EXISTS "reviewedById",
        DROP COLUMN IF EXISTS "reviewStatus"
    `);
  }
}
```

**Rollback data loss:** every document's review decision (who reviewed it, when, why it was
rejected) is destroyed. This is the honest cost of dropping a column — there is no "downgrade
path" that preserves review history in a schema that no longer has anywhere to put it. Before
running `down()` on a database with any real review decisions recorded, export `reviewHistory`
for every document first if the decisions need to survive the rollback for compliance reasons
(FR-6.10, and the evidence pack in `immistack/CLAUDE.md` §4.7 which reads a document's "verified"
history as part of the dispute record).

No existing row is affected beyond gaining the new columns at their defaults — every document
uploaded before this migration reads `reviewStatus: 'uploaded'`, which is honest: nobody has
reviewed it yet, and rendering it as `approved` by default would be exactly the §7.3 failure
(unknown rendered as a clean result).

---

## 5. Tenancy enforcement, per route

| Route | Guard | Service-layer check | Scope for `client` |
|---|---|---|---|
| `POST /documents/:id/review/start` | `@Roles(FIRM_ADMIN, STAFF)` | `{id, tenantId}` load + `DocumentAccessService.assert(doc, actor, 'write')` | Never reachable — no `client` role in the guard |
| `POST /documents/:id/review/decision` | `@Roles(FIRM_ADMIN, STAFF)` | Same as above | Never reachable |
| `GET /documents/checklist` (extended) | existing | existing `assertOwnsEntity` on `entityId` | Own records only, unchanged |
| `GET /documents/:id` (extended) | existing | existing `DocumentAccessService.assert(..., 'read')` | Own/uploaded documents only, unchanged |
| `POST /documents/:id/versions` (behaviour change only) | existing | existing `checkAccess(document, actor, 'write')` | Uploader may re-upload their own document; review reset is a side effect of the same write, no new check |

No route in this ADR widens what a `client` token can reach. The two new routes are staff-only at
the controller; the two extended reads add fields to a response a `client` could already retrieve
for their own documents, which is the correct direction — a client seeing their own rejection
reason is FR-6.6's entire point ("client sees state + reason").

---

## 6. Audit events

`AuditService.logUpdate` (`src/audit/audit.service.ts:135`) called from the `decision` route
handler, **not** relied upon as an implicit side effect of a generic PATCH (per D3's reasoning —
`CrmService.update` writes no audit entry today, confirmed by grep, `F4` in ADR 0008 §1.3):

```ts
await this.auditService.logUpdate(
  tenantId,
  actor.id,
  'document',
  document.id,
  { reviewStatus: before.reviewStatus },
  { reviewStatus: after.reviewStatus, rejectionReasonKey: after.rejectionReasonKey ?? null },
  { linkedEntityId: document.linkedEntityId, versionNumber: document.versionNumber },
);
```

`AuditSeverity.INFO` — a same-tenant staff action, not cross-tenant, matching the convention
`CRITICAL` is reserved for god-mode (`common/access.ts:41-47`).

`review/start` is **not** separately audited — it changes nothing a dispute would turn on (FR-6.10
cares about the decision and who made it, not that someone opened the file). If Owen judges this
too thin during review, the fallback is a `logEvent` with `AuditAction.UPDATE` and
`description: 'Document review started'` — cheap to add, deliberately deferred here because an
audited "someone looked at this" event with no decision attached has not been asked for by any
requirement this ADR traces to.

---

## 7. Pack keys needed

| Key | Nests under | Loader list change needed |
|---|---|---|
| `compliance.documentReview.rejectionReasons[]` | `compliance` (already persisted) | No — two-part commit only |

No `EntityType` change, no new top-level pack array, no change to `documentTypes[]`'s existing
shape.

---

## 8. Options considered and rejected

- **A `DocumentReview` entity, separate table, one row per decision.** Rejected: `reviewHistory`
  jsonb on `Document` already gives the same append-only record at zero migration cost beyond a
  single column, matching the precedent every other "history of decisions on this row" field in
  this codebase uses (`WorkflowInstance.history[]`, `AlertFiring`). A separate table would be
  justified if review decisions needed to be queried independently of their document (a firm-wide
  "all rejections this week" report) — no requirement traced to this ADR asks for that; if one
  does later, that is the trigger in §9 to promote `reviewHistory` into a table.
- **Folding `reviewStatus` into `DocumentStatus`.** Rejected in §1.1 — conflates storage lifecycle
  with a human decision. A `rejected` document that gets archived (the case closes, the file is
  retained per policy) needs to express both facts independently; one enum cannot.
- **Per-`documentTypes[]` rejection-reason lists.** Rejected in D1 — authoring burden without a
  demonstrated need; see the trigger to revisit below.
- **Reusing the generic `PATCH /documents/:id`.** Rejected in D3.

---

## 9. Consequences, including the unpleasant ones

1. **Every document uploaded before this migration reads `reviewStatus: 'uploaded'`**, even ones a
   staff member has, in practice, already looked at by opening the file and moving the case
   forward without ever using a "reviewed" button that did not exist. There is no way to backfill
   an honest answer for those — the system genuinely does not know. This is the correct default
   (§4) and it will make a firm's existing caseload look "unreviewed" on day one. Communicate this
   before shipping, the same lesson ADR 0008 §6 records for the VAC backfill.
2. **A rejected-then-replaced document silently re-enters `uploaded`.** A staff member who
   rejected a document and is waiting on a re-upload will not be notified when it arrives beyond
   whatever the existing `documents_outstanding` chase already does — this ADR does not add a new
   notification. If that gap matters in practice, it is a `messaging.templates[]` addition, not a
   schema change.
3. **`reviewHistory` grows unbounded** on a document that is rejected and re-reviewed many times.
   No cap is applied here, unlike `WorkflowInstance`'s `STAGE_HISTORY_LIMIT` pattern
   (`src/crm/aging/case-aging.service.ts`) — a document is reviewed at most a handful of times in
   practice, so this is accepted rather than engineered around. Revisit if abuse or a bulk-reject
   workflow makes this untrue.

---

## 10. What would make this decision wrong later — the trigger to revisit

- **If a firm needs to query "all rejections across all documents this month" without walking every
  document's `reviewHistory`.** Promote `reviewHistory` to its own table at that point; the jsonb
  shape above is the row shape to migrate into it, so the migration is a straightforward unnest.
- **If document types genuinely need different rejection-reason vocabularies** (a police-check
  rejection reason that makes no sense for a bank statement) and the shared list becomes a long,
  irrelevant dropdown for most types. Add an optional per-`documentTypes[]` override that, when
  present, replaces rather than merges with the shared list — do not merge the two, or a type
  author cannot narrow the list, only widen it.
- **If `review/start` needs its own audit trail** — see §6's stated fallback.
- **If a client-facing "resubmit" flow needs to distinguish "rejected, please re-upload" from
  "rejected, this document is not needed" (checklist item removed after rejection).** Not modelled
  here — a rejected document stays linked to its checklist item regardless of whether that item is
  still `required` in the pack at read time; the checklist's own `appliesWhen` re-evaluation
  already handles the second case independently.

---

## 11. Rollback

Per change, in the order they would be undone:

| Change | Rollback | Data left behind |
|---|---|---|
| Migration `1757300000000` | `down()` above — drops both `CHECK` constraints then all six columns | **Every review decision is destroyed.** Export `reviewHistory` first if compliance requires keeping it (§4) |
| `POST /documents/:id/review/start`, `POST /documents/:id/review/decision` | Revert the controller/service commit. With the migration still applied, the columns simply stop being written — no data corruption, the routes 404 | Existing `reviewStatus` values on documents already decided persist, frozen at whatever they were |
| `createNewVersion` reset behaviour | Revert that one code change; re-upload stops resetting `reviewStatus` | A re-uploaded document keeps its old (now stale) `reviewStatus` — the pre-this-ADR behaviour, restored |
| Pack `compliance.documentReview.rejectionReasons[]` | Remove the key, bump the pack version, reload. A lower version writes nothing (`meru-core/CLAUDE.md` §4.2 rule 4) | None — the key was never required by anything outside this ADR's own routes |

**Rollback verification:** re-run the ImmiStack sweep (baseline 33/33 per `meru-core-fe/CLAUDE.md`
§10) and the GovX sweep (27/28) — this ADR touches no GovX-facing code and no GRC pack, so GovX
must be byte-identical before and after.

---

## 12. Implementation briefs

### Luke (backend-dev)

1. **Migration** `src/migrations/1757300000000-AddDocumentReviewStatus.ts` exactly as §4. Register
   in `ALL_MIGRATIONS` (`src/config/migrations.ts`) **in the same commit**.
2. **`src/documents/entities/document.entity.ts`** — add the five scalar columns plus
   `reviewHistory` (typed as the array shape in §4) to the `Document` class, with a new
   `DocumentReviewStatus` string-literal type (not a TypeORM `enum` column — see D1's reasoning).
3. **`src/documents/dto/review-decision.dto.ts`** (new) — `ReviewDecisionDto` per §3. Cross-field
   validation (`rejectionReasonKey` required when `decision === 'reject'`, and must be a member of
   the resolved pack's `compliance.documentReview.rejectionReasons[]`) goes in the service, not the
   DTO — mirror `IamService.grantPracticeRoles`'s validation shape (ADR 0001 §8 step 4) for the
   "name the invalid key and the pack code/version" error message.
4. **`src/documents/documents.service.ts`**:
   - New methods `startReview(id, tenantId, actor)` and `decideReview(id, tenantId, actor, dto)`,
     both loading `{id, tenantId}` then calling `DocumentAccessService.assert(document, actor,
     'write')` before any mutation, matching `createNewVersion`'s existing shape
     (`documents.service.ts:449-456`).
   - `decideReview` reads `compliance.documentReview.rejectionReasons[]` via
     `VerticalPackService.section(vertical, 'compliance')` (need the tenant's `vertical`, same as
     `upload()` already receives from the controller's `req.tenantVertical`).
   - Append to `reviewHistory` **before** save, not after — the history entry describes the
     transition being committed, so it must be constructed from the pre-update values captured at
     the top of the method (`before = {...document}`), the same pattern `assertNoLockedFieldChanged`
     in `crm.service.ts` uses for its own before/after comparison.
   - Call `AuditService.logUpdate` per §6 after the save succeeds, not before — matching
     `WorkflowEngineService`'s ordering for its own audited writes (`workflow.service.ts:573-601`
     is the one exception, and its own comment explains why: an *automated* transition audits
     before executing because nothing else records the decision was made. A staff decision here is
     already the human record; auditing after is consistent with every other human-triggered write
     in this codebase not needing the "write the audit or the action doesn't happen" discipline
     `runAsGod` uses).
   - **Reset on new version:** inside `createNewVersion` (`documents.service.ts:439`), after the
     new `DocumentVersion` row is created and before the transaction commits, if
     `document.reviewStatus !== 'uploaded'`, push the current `{status, byId: reviewedById, at:
     reviewedAt, versionNumber: document.versionNumber, rejectionReasonKey, rejectionReasonNote}`
     onto `reviewHistory`, then set `reviewStatus = 'uploaded'` and clear the four other review
     fields, in the **same transaction** as the version insert — a partial write here would leave a
     document showing a stale `approved`/`rejected` status against a file nobody has actually seen.
5. **`src/documents/documents.controller.ts`** — two new handlers, `@Roles(PlatformRole.FIRM_ADMIN,
   PlatformRole.STAFF)`, positioned near the existing `checklist/request` handler (same "staff acts
   on a client's record" shape). `ApiOperation`/`ApiResponse` docs should state the 409 and 400
   error shapes explicitly, matching this controller's existing documentation density.
6. **`src/documents/document-checklist.service.ts`** — extend the `documents.map(...)` projection
   at the end of `forEntity` (around line 200-210) to include `reviewStatus`,
   `rejectionReasonKey`, `rejectionReasonNote` from each matched `Document` row. Update
   `ChecklistItem`'s TypeScript interface and `ChecklistResponseDto`
   (`src/documents/dto/checklist-response.dto.ts`) to match.
7. **`packages/config-packs/_schema/pack.schema.ts`** — add the `documentReview` object under the
   existing `compliance` schema (find where `compliance` is currently defined — it already accepts
   at least `cardDataGuard`/`dutyFloor` per ADR 0008 D4/D5, all optional siblings). Run `npm run
   packs:schema` in the same commit.
8. **`packages/config-packs/verticals/immigration.json`** — author the seven-entry
   `compliance.documentReview.rejectionReasons[]` from §2, bump `version`. Not GRC — leave
   `grc.json` untouched, confirming D2's "byte-identical for GovX" claim.
9. **`src/common/types.ts`** — add `VALIDATION_INVALID_ENUM_VALUE = 'MER-VAL-0006'` to
   `MeruErrorCode`, next free slot in the family (§3).
10. Specs: `document-review-authz.spec.ts` (new, mirroring
    `document-generation-authz.spec.ts`'s shape) — a `client` token gets a 403/404 from both new
    routes (route-level `@Roles` should already 403 before the service is reached; assert that,
    then also assert the service-layer `assert` call independently in case the guard is ever
    relaxed); a `staff` token from tenant B cannot decide on tenant A's document; re-upload after
    rejection resets `reviewStatus`.

### Mira (frontend-dev)

1. **Checklist rendering** (`immistack/lib/api/services/documents.service.ts` or equivalent) —
   read the three new fields per checklist item's `documents[]`. Render per
   `immistack/CLAUDE.md` §3's table conventions:
   - `reviewStatus: 'uploaded'` → "Uploaded, awaiting review" (neutral, not "pending" alone —
     pending reads as blocked-on-the-client, which it is not).
   - `reviewStatus: 'under_review'` → "Under review".
   - `reviewStatus: 'approved'` → clear positive state.
   - `reviewStatus: 'rejected'` → **the rejection reason label (resolved from the pack's
     `compliance.documentReview.rejectionReasons[]`, matched client-side or server-resolved — do
     not hardcode the seven labels in the frontend) plus `rejectionReasonNote` if present**, and a
     visible "re-upload" action wired to the existing `POST /documents/:id/versions`.
2. **Staff review UI** — on a document detail view, an "Approve" / "Reject" control calling
   `POST /documents/:id/review/decision`. Reject must collect `rejectionReasonKey` from a select
   populated from `GET /config-packs/me/navigation`-adjacent pack data
   `[UNVERIFIED: the exact route the frontend already uses to read pack `compliance` — check
   whether the pack is already fetched client-side anywhere, or whether this needs a new
   lightweight read; do not invent one without checking `lib/api/services/` first]`, plus an
   optional free-text note.
3. **Never render `reviewStatus` absent as `'uploaded'`-and-clean without checking the checklist's
   own `uploaded` field first** — a checklist item with `uploaded: null` (not asked) has no
   `Document` row at all, so `reviewStatus` will not be present in the response; that must render
   as "not asked", never fall through to a default review-status string. This is the same §3.1
   "a default is a claim" trap `immistack/CLAUDE.md` already documents for `current_stage` —
   do not repeat it here with `reviewStatus`.
4. Update the "three-valued checklist" fallback logic (`uploaded === null` → "not asked") to remain
   the outermost check; `reviewStatus` is a second-order field that only exists once `uploaded ===
   true`.
