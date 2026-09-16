# 0026 — VAC card authority, PAN guard, and the client self-report route

**Status:** Proposed — 2026-09-17, not merged. **Extends ADR 0008, does not replace it.**

**Owner:** Kyle (architect). Implementation: Luke (backend-dev), Mira (frontend-dev). Review/gate:
Owen (quality). Tenancy/PII review: Anton (secops) — mandatory, this ADR adds the platform's first
generic card-data detector and a new client-writable route on a money-integrity record.

**Scope:** ImmiStack PRD §10 (FR-7.13 — no card number anywhere), `immistack/CLAUDE.md` §4.2–4.4
(the four `vacSettlementMode` values, `vacStatus`, the card-authority record, PAN redaction, the
reconciliation alert). This ADR is **ADR 0008's D3 (card authority), D4 (PAN guard), and its two
open implementer items — resolved, not re-litigated where 0008 already decided correctly.**

**Verified against:** `meru-core/src/` on disk, 2026-09-17. ADR 0008's own §1.1 zero-match grep
(`vacStatus`, `cardAuthority`, `duty_floor`, etc.) was re-run for this ADR:
`grep -rn "vacCardAuthority\|cardDataGuard\|documentReview" meru-core/src meru-core/packages`
returns zero matches. **D3 and D4 are still unbuilt.** `vacStatus`/`vacSettlementMode`/`lockedWhen`
are confirmed built (`src/crm/crm.service.ts:142-192`, `packages/config-packs/verticals/
immigration.json:2597-2606`) and are **not** re-decided here.

> **Amended 2026-09-17 after Anton's (secops) review, in two passes: approved with required
> changes, then confirmed with one further required fix.** The first pass closed five gaps (§4's
> attachment-point coverage, the self-report ownership predicate, evidence-document validation on
> both `self-report` and `verify`, the `verify` either/or's enforcement layer, and the false
> `comment.entity.ts` citation), plus a MARS decision restricting `self-report` to
> `PlatformRole.CLIENT`. The second, same-day pass fixed a line-citation error and replaced the
> first pass's "no task, logged" no-assignee fallback with a deterministic oldest-active-
> `firm_admin` fallback, auditable and reflected in the route's response (`staffNotified`). No code
> was written in either pass — text only. Full changelog at the end of this document, §15.

---

## 1. Context — what ADR 0008 already settled, restated so this document stands alone

| ADR 0008 decision | Status, re-verified this session |
|---|---|
| D1 — `vacStatus` on `verticalAttributes`, required-with-default | **Shipped.** `BackfillVacStatus1756600000000` (`src/migrations/1756600000000-BackfillVacStatus.ts`) is registered in `ALL_MIGRATIONS`. It sets `unpaid` only where the key is absent, and its `down()` removes only rows still carrying that exact seed — read in full for this ADR, matches ADR 0008 §5's spec exactly. |
| D2 — the BLOCKING reconciliation alert as a pack `rules[]` entry | **Shipped.** `packages/config-packs/countries/au-immigration.json:3188-3214` carries the rule keyed on the kanban `stage` field (not `matter.stage` — a deliberate scoping choice recorded in the pack's own `description`, because a rule naming both would be `skipped` on any record missing either, per `missingVariables`' "any absent variable" behaviour). **Not re-decided here.** |
| D6 — `vacSettlementMode` field-level immutability via pack `lockedWhen` | **Shipped.** `src/crm/crm.service.ts:142-192` (`assertNoLockedFieldChanged`), pack declaration at `immigration.json:2597-2606`. **Not re-decided here.** |
| D3 — card authority (terms/assent/reference split) | **Not built.** This ADR builds it, §3. |
| D4 — PAN detector, pack-gated | **Not built.** This ADR builds it, §4. |
| D5 — duty floor / `commercial_hold` | **Out of scope**, per ADR 0008 §9: "the hold is a larger design... putting it in the same document would have let the floor be negotiated down alongside it." Still out of scope here — this ADR does not touch `arrearsBlocking` or author `compliance.dutyFloor`. |
| Open item 1 — can a `client` token `PATCH /crm/entities/:id`'s `verticalAttributes`? | **Answered, and the answer closes the open item.** `CrmAccessService` (`src/crm/crm-access.service.ts:44-56`, shipped on `harden/authz-golive`, 2026-09-02 — one day *before* ADR 0008 was drafted but evidently not cross-checked against it) states as a standing rule: **`own` scope is read-only, everywhere.** A `client` actor cannot reach `CrmService.update` with tenant-wide or even own-record write access via the generic PATCH path at all for a record they do not administer — write requires `tenant`/`god` scope. **So: no, a client cannot PATCH `verticalAttributes` today, full stop**, not merely "should not". ADR 0008's proposed fallback ("the client self-report must not be a direct PATCH... goes through an ImmiStack route handler") is therefore not optional caution, it is the **only** way a client can write anything to `vacStatus` — this ADR builds that route as a first-class backend endpoint rather than a frontend-only workaround, §2. |
| Open item 2 — does `CommentService` write an audit entry, for D2's dismissal? | **Answered: no.** `grep -n "AuditService\|audit" src/crm/comment.service.ts` returns zero matches beyond a doc-comment reference. **This ADR does not route the dismissal, verification, or self-report writes through `CommentService` at all** — see §2, §5. Each gets its own explicit `AuditService` call, removing the dependency on an unaudited side channel entirely. |

**What this ADR adds beyond ADR 0008's scope:** three new dedicated routes
(`/crm/entities/:id/vac/*`) that replace generic-PATCH as the write path for the fields that
matter most (`vacStatus` verification, the alert dismissal), because §1's open items show the
generic-PATCH path was never actually the right mechanism for either — it was either
unreachable (client) or unaudited (comment-based dismissal). D3 and D4 are unchanged from ADR
0008's design and are implemented here as specified there.

---

## 2. Decision — three dedicated `/crm/entities/:id/vac/*` routes replace the generic-PATCH paths ADR 0008 proposed for staff writes on this data

**Decision:** `vacStatus` verification, the alert dismissal, and the client self-report each get
their own route, DTO-validated, explicitly audited. The pack `lockedWhen` mechanism (D6, already
shipped) continues to protect `vacSettlementMode` on the generic PATCH path — that field is set
once by staff before lodgement and does not need a dedicated route; it is a single write, not a
decision with evidentiary requirements the way `verified` is.

### D1 — `POST /crm/entities/:id/vac/self-report` (`PlatformRole.CLIENT` only)

Writes `vacStatus: 'evidence_pending'` **only if the current status is not already `verified`**
(never downgrade a staff-verified charge back to pending on a client's say-so — a client cannot
un-verify), records a `vacEvidenceSubmission` object, and opens a staff task. Never writes
`verified`. Never writes anything else on the record.

```jsonc
// verticalAttributes, on successful self-report
{
  "vacStatus": "evidence_pending",
  "vacEvidenceSubmission": {
    "submittedBy": "<users.id>",     // the client's own user id
    "submittedAt": "<ISO-8601>",
    "evidenceDocumentId": "<documents.id> | null",
    "note": "<string, max 500> | null"
  }
}
```

`vacEvidenceSubmission` is a **new key, distinct from D1's `vacVerification`** (ADR 0008 §2 D1) —
`vacVerification` is written only by staff on the `verified` path and requires `verifiedBy`/
`verifiedAt`/an evidence artefact, per ADR 0008's contract, unchanged here. Conflating the two
would let a client-authored field masquerade as a staff attestation the moment anything read
`vacVerification` without checking who wrote it.

**MARS decision (2026-09-17): `@Roles(PlatformRole.CLIENT)`, not "any authenticated tenant
member."** The earlier draft of this ADR left `self-report` open to any authenticated actor,
narrowed only by the service-layer ownership check. That is wrong for a reason distinct from
tenancy: **a staff attestation must not be recorded as a client one.** `vacEvidenceSubmission` is
read downstream (the evidence pack, `immistack/CLAUDE.md` §4.7; the reconciliation alert's
dismissal reasoning) as "the applicant said they paid" — a `firm_admin` or `staff` actor calling
this same route would produce a record that reads identically, and nobody reading it later could
tell the difference. Staff who have genuinely seen evidence use `verify` (D2), which is the
correctly-attributed, correctly-audited path for a staff observation. The route is therefore
gated `@Roles(PlatformRole.CLIENT)` at the controller — a `firm_admin`/`staff` token gets a
**403** before the handler runs at all, not merely a service-layer no-op.

**Ownership predicate, decided (not left open for implementation to pick).** The service:

```ts
const entity = await this.entities.findOne({ where: { id: entityId, tenantId } });
if (!entity) throw new NotFoundException('Record not found');
this.crmAccess.assert(entity, actor, 'read');
```

`CrmAccessService.assert` (`src/crm/crm-access.service.ts:146-160`) is the exact predicate
already used by `CommentService.add` (`src/crm/comment.service.ts:93`, `this.access.assert(parent,
actor, 'read')`) and by `AcceptanceService` for the same shape of check — **this route follows
that established pattern rather than inventing a third one**, resolving the earlier draft's
"`CrmAccessService` exposes an equivalent — confirm which of the two this route should call" into
a concrete answer: `CrmAccessService.assert`, not `DocumentAccessService.assertOwnsEntity` (that
one is for documents, and `self-report` never loads a `Document` row for the case entity itself —
only, optionally, for the evidence document, §D1b below). `assert` throws `NotFoundException` on
a foreign-but-real `entityId` (404, not 403), matching every other client-scoped route in this
file.

### D1a — validating a client-supplied `evidenceDocumentId`

A client may optionally name a document they already uploaded as evidence. **That reference must
be validated, not merely stored** — an unvalidated `documents.id` written into
`vacEvidenceSubmission` would let a client point staff at a document belonging to someone else's
case, or one that does not exist, and have it sit in the audit trail as if it were checked.

```ts
if (dto.evidenceDocumentId) {
  const document = await this.documents.findOne({
    where: { id: dto.evidenceDocumentId, tenantId },
  });
  if (!document) throw new NotFoundException('Evidence document not found');

  await this.documentAccess.assert(document, actor, 'read');   // the caller must be able to read it

  if (document.linkedEntityId !== entityId) {
    throw new NotFoundException('Evidence document not found');   // same 404, not "wrong case" — see below
  }
}
```

Three checks, in order: **exists in this tenant** (plain `{id, tenantId}` load); **the caller can
read it** (`DocumentAccessService.assert(document, actor, 'read')`,
`src/documents/document-access.service.ts:205-219` — the same predicate ADR 0025 relies on
throughout); **it is linked to the case being self-reported against**
(`document.linkedEntityId === entityId`). All three failures return the **same 404** — a client
probing whether a document id belongs to a different case must not be able to distinguish "does
not exist" from "exists but is not yours" from "exists, is yours, but is on a different case" —
each is a smaller disclosure than the last and none of the three needs to be told apart by the
caller.

**Task creation, named — amended 2026-09-17, no silent miss.** `TaskService.createTask(tenantId,
dto)` (`src/tasks/task.service.ts:68`) — the same method every other task-creating call site in
this codebase uses; no new task-creation path. `CreateTaskDto.assignedTo` is a **required** field
(`@IsUUID()`, not optional — `src/tasks/dto/create-task.dto.ts:49-51`), so an assignee must always
be resolved before the call, by two rules tried in order:

1. **`entity.assignedTo` is set** (the case has a staff assignee) → the task is created with
   `assignedTo: entity.assignedTo`.
2. **`entity.assignedTo` is `null`** (an unassigned case — possible per
   `immistack/CLAUDE.md` §3's route-structure notes) → **MARS decision: fall back to the tenant's
   oldest-active `firm_admin`**, not a silent miss. Load candidates deterministically:

   ```ts
   const admins = await this.usersRepo.find({
     where: { tenantId, status: UserStatus.ACTIVE },
     order: { createdAt: 'ASC' },
   });
   const fallback = admins.find((u) => u.roles.includes(PlatformRole.FIRM_ADMIN)) ?? null;
   ```

   Filtered in application code, not a SQL array-containment query, deliberately — `users.roles` is
   declared `simple-array` (`user.entity.ts:92-93`), but ADR 0001 §11 records this column has been
   migrated between `text` and `text[]` at least once in this project's history and instructs
   confirming the physical type with `\d+ users` before writing a containment query against it.
   Loading a tenant's (small) active-user set and filtering the already-TypeORM-parsed `.roles`
   array in JS is correct regardless of which physical type is live today, and a tenant's admin
   count is never large enough for this to be a real cost. `assignedTo: fallback.id` if found.
   **If `fallback` is also `null`** (a tenant with zero active `firm_admin` users — possible but
   degenerate), **no task is created**, logged at `warn`, and the self-report write still
   succeeds regardless. A missing task must never block a client's evidence submission from being
   recorded.

**Both outcomes are recorded, never silently.** The `vac.self_report.recorded` audit event's
context (§9) carries:

```jsonc
{
  "taskCreated": true,
  "taskAssignee": "case_assignee"          // | "firm_admin_fallback" | null
}
```

`taskAssignee: null` iff `taskCreated: false`. This closes the gap the earlier draft left open —
"no task, logged" was auditable only by grepping application logs; it is now a queryable fact on
the audit trail itself, which is where every other consequential fact in this ADR already lives.

**The route's response carries `staffNotified: boolean`** — `true` iff `taskCreated`, `false`
otherwise — so the client portal can render "your firm has been notified" only when it is true,
never inferred from the write having succeeded (the `vacStatus` write always succeeds regardless
of whether a task could be created; conflating the two would be exactly the §7.3 failure this
whole ADR family exists to avoid, applied to a notification claim instead of a payment status).

**Tenancy of the task itself.** `createTask` takes the case's own `tenantId` — the task lands in
the same tenant, visible to staff per the existing `/tasks` scoping (`task.controller.ts`,
`task-authz.spec.ts`, already closed per workspace `CLAUDE.md` §16's table). The fallback query is
likewise scoped by the same `tenantId` — no cross-tenant read is introduced. No new tenancy
surface: this is an ordinary internal call to an existing, already-scoped service plus one
additional tenant-scoped read.

### D2 — `POST /crm/entities/:id/vac/verify` (staff-only)

Sets `vacStatus: 'verified'` with the full `vacVerification` object ADR 0008 §2 D1 specifies —
`verifiedBy`, `verifiedAt`, `evidenceKind`, and **either** `evidenceDocumentId` **or** `trn`. This
either/or is exactly the kind of cross-field rule a generic `PATCH verticalAttributes` cannot
enforce (the pack's `lockedWhen` mechanism only *blocks* a write, it does not *validate the shape*
of an allowed one) — a dedicated route enforces it at the boundary.

**Enforcement layer, decided: service-layer only, not a DTO decorator.** `VacService.verify`
checks, before any write:

```ts
if (!dto.evidenceDocumentId && !dto.trn) {
  throw new BadRequestException(
    'A verification needs either evidenceDocumentId or trn — neither was supplied.',
  );
}
```

**Neither → 400. Exactly one → accepted. Both → accepted** (a staff member who has both the
receipt PDF and a typed TRN may record both; `vacVerification` stores whichever fields are
present, and ADR 0008 §2 D1's own contract — "either... or" — never says "not both"). This is
**one layer, deliberately not duplicated as a DTO-level cross-field decorator**
(`@ValidateIf`/custom validator): every other pack-independent, business-rule cross-field check in
this ADR family lives in the service (ADR 0025's `rejectionReasonKey`-against-pack-vocabulary
check is the direct precedent, same reasoning: "a pack vocabulary check cannot live in a static
decorator" — this either/or is not pack vocabulary, but it is still a business rule about *this*
record's evidentiary requirement, not a shape constraint on the field in isolation, which is what
`class-validator` is for). The individual field decorators (`@IsOptional() @IsUUID()` on
`evidenceDocumentId`, `@IsOptional() @IsString()` on `trn`) stay on the DTO; only the "at least
one of these two" rule is service-layer.

**`evidenceDocumentId` existence/tenant check, added — this route had none.** Before the write:

```ts
if (dto.evidenceDocumentId) {
  const document = await this.documents.findOne({
    where: { id: dto.evidenceDocumentId, tenantId },
  });
  if (!document) throw new NotFoundException('Evidence document not found');
}
```

**No `DocumentAccessService.assert` call here, unlike D1a — and that asymmetry is deliberate, not
an oversight.** A `firm_admin`/`staff` actor already has tenant-wide document reach
(`hasTenantWideReach`, `src/common/access.ts:125-127`), so the ownership/readability question
`DocumentAccessService.assert` exists to answer is already `true` for every staff caller; running
it here would be a no-op check that reads like a real one. What this route still needs, and did
not have, is the **existence-in-this-tenant** check — a staff member could otherwise reference a
document id from another tenant entirely (a copy-paste error from a different case open in another
tab) and have it silently accepted into `vacVerification`, since nothing was loading the row at
all. This check closes that, at the same "two independent narrowings" cost every other query in
this ADR family pays. **No `linkedEntityId === entityId` check is added here** — unlike D1a, a
staff member verifying a matter may legitimately cite a receipt filed against a related record
(e.g. a parent matter in a `derived_from` chain, `immistack/CLAUDE.md` §5.3); D1a's stricter
linkage requirement exists specifically because a *client* naming a document is the higher-risk
direction (pointing staff at someone else's evidence), which does not apply the same way to a
staff member with tenant-wide reach making a professional judgement call.

### D3 — `POST /crm/entities/:id/vac/alerts/dismiss` (staff-only)

Implements ADR 0008 D2's dismissal, unchanged in data shape (`vacAlertDismissals[]`, append-only,
reason ≥ 20 characters), but **writes the audit entry directly from this route** rather than via a
comment, closing open item 2.

### Why three routes and not one generic `/vac` endpoint

Each has a different actor, a different validation shape, and a different consequence on refusal.
Collapsing them into one endpoint with a `type` discriminator would recreate exactly the problem
D1's separation from `vacVerification` exists to prevent: one route's request shape drifting to
"basically match" another's until a client-reachable action can, by accident of a shared code
path, write a staff-only field. Three narrow routes make that structurally impossible rather than
merely disciplined.

---

## 3. D3 (from ADR 0008) — the card authority record, as specified, now with routes

ADR 0008 §2 D3's three-part split is **adopted unchanged**: pack terms
(`documentTemplates[].vac_card_authority`), acceptance (`POST /crm/entities/:id/acceptance`,
existing route, unchanged), reference data (`verticalAttributes.vacCardAuthority`, exact shape
per ADR 0008 §2 D3). This ADR adds the write routes ADR 0008 did not specify (it left the
mechanism as "not a core change" without naming how the reference data actually gets written).

### `POST /crm/entities/:id/vac/card-authority` (staff-only)

```ts
export class RecordCardAuthorityDto {
  @IsIn(['visa', 'mastercard', 'amex', 'other'])
  brand: string;

  @Matches(/^[0-9]{4}$/)   // exactly four digits — a pasted PAN is rejected by shape alone
  last4: string;

  @IsInt() @IsPositive()
  maxAmountMinor: number;

  @IsString() @Length(3, 3)
  currency: string;

  @IsString() @MaxLength(200)
  purpose: string;

  @IsUUID()
  authorisedUserId: string;

  @Matches(/^[a-f0-9]{64}$/)   // the SHA-256 from the acceptance record this authority rests on
  acceptanceSha256: string;

  @IsOptional() @IsISO8601()
  expiresAt?: string;   // default: min(lodgement, capturedAt + 30d) — computed server-side if omitted
}
```

**Precondition, enforced server-side before the write:** an acceptance record with `subject:
'vac_card_authority'` and `documentSha256 === dto.acceptanceSha256` must exist for this entity
(`AcceptanceService` — read, not written, by this route). **Refuse with 409** if no such
acceptance exists: a card authority reference with no matching assent record is exactly the "we
have the terms of an agreement nobody agreed to" gap this ADR must not create. This is the one
cross-service check this route performs and it is load-bearing — do not skip it to save a query.

**Every field is validated by shape before it ever reaches storage.** `last4` anchored to exactly
four digits is the first of two independent barriers against a pasted PAN landing here — the
second is D4's detector, applied to free-text fields this DTO deliberately has none of (`purpose`
is bounded at 200 chars and still passed through D4's scanner, §4, because a free-text field of
any length is a place a PAN can be typed).

### `POST /crm/entities/:id/vac/card-authority/revoke` (staff-only)

```ts
export class RevokeCardAuthorityDto {
  @IsString() @MinLength(10) @MaxLength(500)
  reason: string;
}
```

Sets `vacCardAuthority.revokedAt`/`revokedBy`/`revocationReason`. Refuses (409) if already revoked
or absent. The authority object is **not deleted** — a revoked authority is evidence a firm acted
correctly, per `immistack/CLAUDE.md` §4.3's own framing.

---

## 4. D4 (from ADR 0008) — the PAN detector, as specified, with implementation detail ADR 0008 left open

**Adopted from ADR 0008 §2 D4 unchanged**: pack-gated (`compliance.cardDataGuard.mode: off | warn
| block`, default `off`), Luhn-validated 13–19 digit candidates, CVV/expiry flagged only when
co-located with a Luhn-valid candidate, typed field vs. extracted text treated asymmetrically
(reject what a human typed, redact and flag what a machine read).

**Five attachment points, not three — amended after Anton's review.** ADR 0008's original three
(comment bodies, message bodies, document-analysis output) covered client- and staff-facing
*communication* surfaces but missed the two free-text fields **this ADR itself introduces**:
`RecordCardAuthorityDto.purpose` and `RevokeCardAuthorityDto.reason` (§3). Both are staff-typed
free text on a record that exists specifically because of card-data risk — missing them from the
guard's coverage while building the very feature that motivated the guard would have been the
gap this ADR exists to close, reopened by omission.

| # | Field | Row scanned lands on | `mode: 'block'` behaviour | `mode: 'warn'` behaviour |
|---|---|---|---|---|
| 1 | `Comment` body (`comment.service.ts:93` area) | the `UniversalEntity` (type `NOTE`) row itself | 422, write refused | save, flag |
| 2 | Thread message `content` (`thread.service.ts:294`, `send()`) | the `Notification` row itself | 422, write refused | save, flag |
| 3 | `POST /documents/:id/analyze` extracted text | the `Document.aiAnalysis` object | **never reject** — redact and flag (ADR 0008's asymmetric rule) | redact and flag (same as block — extraction has no "warn" distinction, per ADR 0008 §2 D4) |
| 4 | **`RecordCardAuthorityDto.purpose`** (§3, new in this ADR) | the case `UniversalEntity`'s `verticalAttributes.vacCardAuthority` write | **422, write refused** — the card-authority record is never created | write proceeds, flagged |
| 5 | **`RevokeCardAuthorityDto.reason`** (§3, new in this ADR) | same, on the revocation write | **422, write refused** — the revocation is never recorded | write proceeds, flagged |

**Scan-before-audit, stated explicitly.** In `VacService.recordCardAuthority` and
`.revokeCardAuthority`, the scan runs **before** the entity save and **before** the
`AuditService` call — a rejected write must never reach `AuditService.logUpdate`, because logging
a "rejected: PAN-shaped candidate detected" audit entry that itself echoes even a redacted
version of the field would be exactly the class of leak D4's constraint 1 (no logging of matched
text) exists to prevent, applied to the audit trail instead of the application log. Order,
precisely:

```
1. scanForCardData(dto.purpose)  →  hit === true && mode === 'block'  →  throw 422, nothing written, nothing audited
2. (scan passed, or mode !== 'block')  →  save the entity
3. AuditService.logUpdate(...)   →  only reached if step 2 succeeded
```

This ordering applies identically to attachment points 1 and 2 (comment/message) — a rejected
comment or message must never reach whatever audit call, if any, sits downstream of the save.

**One addition this ADR makes that ADR 0008 left as a stated constraint without a mechanism:**
constraint 2 in ADR 0008 §2 D4 ("every scan records that it ran, with the detector version") is
implemented as a `cardGuardScan: { version: string, ranAt: string, hit: boolean }` object. Where
it lands, per attachment point — resolved below, not `[UNVERIFIED]`:

- **Comments (point 1):** `verticalAttributes.cardGuardScan` on the `NOTE`-type `UniversalEntity`
  row, sibling to the existing `content`/`authorId`/`internal` keys `CommentService.add` already
  writes (`comment.service.ts:101-112`). No migration — `verticalAttributes` is the same jsonb
  column every other CRM attribute already lives in.
- **Thread messages (point 2):** `Notification.metadata.cardGuardScan`
  (`src/notifications/entities/notification.entity.ts:161-169` — the `metadata` jsonb column
  already declares `actionUrl`/`actionLabel`/`icon`/`imageUrl`/`tags`/`customData`; `cardGuardScan`
  is a sibling addition to that same TypeScript type, not a new column). No migration.
- **Document analysis (point 3):** `Document.aiAnalysis`, per ADR 0008's own original placement —
  unchanged.
- **Card-authority `purpose`/revocation `reason` (points 4, 5):** the scan result for these two is
  **not persisted as a standalone field** — it is folded into the same
  `AuditService.logUpdate`/`logEvent` call §9 already makes for `vac.card_authority.recorded`/
  `.revoked` (context: `{ cardGuardScan: { version, ranAt, hit: false } }` — `hit` is always
  `false` by the time this audit entry is written, because a `true` hit under `mode: 'block'`
  never reaches the audit call at all, per this section's ordering rule; under `mode: 'warn'` a
  `true` hit is recorded here alongside the accepted write). No new column, no new jsonb key on
  `UniversalEntity` beyond what §9's audit context already carries.

**Detector core is a new, generic, pack-neutral service** — `src/common/card-data-detector.ts` (or
`src/rules/` alongside the JsonLogic evaluator, since both are generic evaluators core exposes to
every vertical) — exporting one function:

```ts
export interface CardDataScanResult {
  hit: boolean;
  redacted: string;        // input with any Luhn-valid run replaced by a fixed-width mask
  detectorVersion: string; // bump whenever the regex/Luhn logic changes
}

export function scanForCardData(input: string): CardDataScanResult;
```

**No logging of the matched text, anywhere, ever** — ADR 0008's constraint 1. The function returns
a redacted string; callers log `{ hit, detectorVersion, length: input.length }`, never `input`
itself and never the matched substring. This must be enforced by code review, not by a runtime
check the function itself cannot provide (it cannot stop a caller from logging its own input
before calling it). **Required unit test, not optional:** assert that for every input containing a
Luhn-valid 13–19 digit run, `result.redacted` contains **no substring that itself Luhn-validates**
— i.e. re-run the Luhn check against `result.redacted` and assert it never passes. This is stronger
than "the exact original digits are absent" (a naive test) because a masking bug that leaves,
say, the last eight digits unmasked could still leave a *different* Luhn-valid run in the redacted
output by coincidence on adjacent digits; the re-validation test catches that class directly rather
than trusting the mask width was correct by inspection.

**No BIN/IIN heuristic — a deliberate simplification, not an oversight.** The detector does not
check the scanned candidate's leading digits against known card-issuer ranges (a "BIN/IIN check",
the technique real PCI tooling uses to distinguish "16 digits that Luhn-validate and start with a
real issuer prefix" from "16 digits that Luhn-validate by coincidence"). Luhn alone is
**necessary, not sufficient** — a meaningful fraction of random 13–19-digit sequences that Luhn-
validate are not card numbers at all, and without a BIN/IIN check this detector cannot tell them
apart. This is accepted for the initial ship because BIN/IIN range tables need maintaining (issuer
ranges are reassigned) and add a dependency this ADR does not want to take on for a `mode: 'off'`-
by-default feature. **This is the single largest lever on the false-positive rate named in §11
point 2**, and it is the first thing to add if that rate proves too high in practice — see §12.

---

## 5. API contract summary

| Route | Actor | Tenancy | New audit event |
|---|---|---|---|
| `POST /crm/entities/:id/vac/self-report` | `@Roles(PlatformRole.CLIENT)` — 403 for any other role before the handler runs | `{id, tenantId}` load + `CrmAccessService.assert(entity, actor, 'read')` (D1) — never `DocumentAccessService.assertOwnsEntity`, which answers a document-ownership question, not a CRM-record one | `vac.self_report.recorded`, INFO |
| `POST /crm/entities/:id/vac/verify` | `firm_admin`, `staff` | `{id, tenantId}` load, tenant-wide reach implied by role | `vac.status.verified`, INFO |
| `POST /crm/entities/:id/vac/alerts/dismiss` | `firm_admin`, `staff` | same | `vac.alert.dismissed`, INFO — **WARNING if `stage` is still `>= lodged` after dismissal**, because a dismissed-but-still-unpaid matter is exactly the state ADR 0008 §4.4 calls the most damaging in the product |
| `POST /crm/entities/:id/vac/card-authority` | `firm_admin`, `staff` | same, plus the acceptance-record precondition (§3) | `vac.card_authority.recorded`, INFO |
| `POST /crm/entities/:id/vac/card-authority/revoke` | `firm_admin`, `staff` | same | `vac.card_authority.revoked`, INFO |

**Error codes:**

- `404` — record not in this tenant, or (for `self-report`) not owned by the caller. Same
  404-not-403 convention as every other client-scoped route in this codebase — confirming a
  real-but-foreign record exists is itself a disclosure.
- `409 MER-RES-0005` — `verify` called with `vacStatus` already `verified` and no `force` flag
  `[decision: no force flag — re-verifying is a legitimate correction (a staff member fixing a
  wrong TRN), so `verify` is idempotent-overwrite, not refuse-on-already-verified. State this
  explicitly so Owen does not flag it as a missing guard: overwriting a verification is
  intentional, and it is itself audited with the before-state, so the correction is traceable]`;
  `card-authority` called with no matching acceptance record; `revoke` called on an
  already-revoked or non-existent authority.
- `400 MER-VAL-0001` — DTO shape validation (existing generic validation code, reused rather than
  minted new — these are ordinary field-shape failures, not pack-vocabulary lookups like ADR
  0025's `MER-VAL-0006`).
- `422` — a PAN-shaped candidate detected in `RecordCardAuthorityDto.purpose` or
  `RevokeCardAuthorityDto.reason` (§4, D4 attachment points 4 and 5), when
  `compliance.cardDataGuard.mode === 'block'`. These are the two places in this ADR the detector
  refuses a **staff**-typed field on a route this ADR itself defines, not just the client-facing
  message-body surfaces ADR 0008 originally scoped D4 to — `purpose` and `reason` are free text on
  a card-authority record, exactly the kind of field ADR 0008's "blocks what a human typed"
  reasoning applies to. **The scan runs, and the write is refused, before `AuditService` is ever
  called** — §4 states the ordering explicitly; a rejected write leaves no audit trail beyond
  whatever the application's own request logging captures (never the matched text, per D4
  constraint 1).

---

## 6. Tenancy enforcement, per route — explicit per the workspace's standing rule

Per `meru/CLAUDE.md` §8's rule that "anything touching a query, endpoint or cache key states how
tenancy is enforced there, derived from the code":

- All five routes sit under `/crm/entities/:id/...`, so they inherit `TenantAlsMiddleware` →
  `TenantBindingInterceptor` → RLS at the connection level (the tenant layer). This confines every
  query to the caller's own tenant regardless of role.
- **`self-report` is the only one of the five a `client` token can reach, and only a `client`
  token** — `@Roles(PlatformRole.CLIENT)` at the controller means a `firm_admin`/`staff` token gets
  a **403 before the handler runs**, distinct from the ownership check below. Two layers, doing two
  different jobs: the role guard says "only clients use this route at all" (§2 D1's MARS decision —
  a staff attestation must never be recorded as a client one); the service-layer check says "and
  only for their own record." Within that, `CrmAccessService.assert(entity, actor, 'read')`
  (`src/crm/crm-access.service.ts:146-160`) is the exact predicate this route uses — **not**
  `DocumentAccessService.assertOwnsEntity`, which is the wrong service for a CRM-entity ownership
  question (it answers "does this caller own this *document*"; this route needs "does this caller
  own this *case*"). D1's evidence-document sub-check (D1a) is the one place this route also
  touches `DocumentAccessService`, and only for the optional `evidenceDocumentId`, not for the case
  entity itself. 404, not 403, on a foreign `entityId`.
- The other four are `@Roles(PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)` — a `client` token never
  reaches the handler. No additional ownership check is needed for staff, matching every other
  staff-only mutation in this codebase (`hasTenantWideReach` is true for both roles). `verify` and
  `self-report` each independently validate a caller-supplied `evidenceDocumentId` against the
  tenant (D1a, D2) before it is written into `vacEvidenceSubmission`/`vacVerification` — neither
  route trusts a document id merely because it parses as a UUID.
- **No route in this ADR reads a `tenantId` from the request body.** Every one derives it from
  `req.user.tenantId` (the JWT claim), per the standing rule `CLAUDE.md` §5.1 states after the
  `search_index` body-trust incident.

---

## 7. Pack keys needed

| Key | Nests under | Status |
|---|---|---|
| `compliance.cardDataGuard.{mode, redactExtraction}` | `compliance` | Specified by ADR 0008 D4, unbuilt until this ADR ships the code that reads it |
| `documentTemplates[].vac_card_authority` | `documentTemplates` | Pack authoring, per ADR 0008 D3 — not performed in this ADR, tracked as an implementation-brief item below |

No new top-level key. No change to the loader's persisted key list — both nest under keys already
in `upsertPack` (`config-pack-loader.service.ts:439,466`).

---

## 8. Migration plan

**None required**, matching ADR 0008 §5's own finding: `vacEvidenceSubmission`,
`vacCardAuthority`, and the card-guard scan metadata are all `verticalAttributes`/jsonb-metadata
additions, not columns. **This is deliberate and worth restating given ADR 0025 in this same
batch does need one** — the difference is that ADR 0025 puts structured, frequently-filtered state
(`reviewStatus`) on a core entity with a `CHECK` constraint protecting its integrity, while this
ADR's new data is vertical vocabulary living in an already-jsonb bag, exactly per the 80/20 rule.

**§4's `cardGuardScan` provenance need no migration either**, resolved against the real entities
(not `[UNVERIFIED]` — see §4): comments are `UniversalEntity` rows of type `NOTE`
(`comment.service.ts:101-112`), so the scan record sits in the same already-jsonb
`verticalAttributes`; thread messages are `Notification` rows, whose `metadata` column
(`notification.entity.ts:161-169`) is already jsonb. Both attachment points reuse existing columns.

---

## 9. Audit events — full list

| Event | Severity | Entity type | Written by |
|---|---|---|---|
| `vac.self_report.recorded` — context includes `{ taskCreated: boolean, taskAssignee: 'case_assignee' \| 'firm_admin_fallback' \| null }` per §D1a | INFO | `case` | `VacService.selfReport` |
| `vac.status.verified` | INFO | `case` | `VacService.verify` |
| `vac.alert.dismissed` | INFO (WARNING if stage still `>= lodged`) | `case` | `VacService.dismissAlert` |
| `vac.card_authority.recorded` | INFO | `case` | `VacService.recordCardAuthority` |
| `vac.card_authority.revoked` | INFO | `case` | `VacService.revokeCardAuthority` |

All via `AuditService.logUpdate`/`logEvent` (`src/audit/audit.service.ts:55,135`), all `INFO` (not
`CRITICAL` — these are same-tenant, non-god-mode writes; `CRITICAL` stays reserved per
`common/access.ts:41-47`'s documented convention), each carrying `beforeState`/`afterState`
limited to the field that changed — never the full `verticalAttributes` blob, which would put
every other vertical attribute on the record into an audit row for an unrelated change.

**These five routes bypass `CrmService.updateEntity` entirely** — `VacService` reads and writes
the entity's `verticalAttributes` directly (via its own repository, per the implementation brief,
§14), not through the generic update path. That is deliberate for the reasons §2 already gives
(a dedicated route can validate a shape `PATCH` cannot), but it has a consequence worth recording
for whoever eventually picks up ADR 0008 §9's still-open "wide fix" item — *"whether
`CrmService.update` should audit unconditionally"*: **if that wide fix ever ships, it will not
automatically cover these five routes**, because they never call `updateEntity`. Each of the five
audit events above remains this ADR's own explicit responsibility, permanently, not a stopgap
that a future generic mechanism quietly absorbs. If the wide fix ships, the correct response is
to *keep* these five explicit calls (they carry event-specific `beforeState`/`afterState` framing
a generic mechanism would not reproduce) rather than to assume they have become redundant.

---

## 10. Options considered and rejected

- **Keep ADR 0008's original design: generic PATCH + `lockedWhen` + comment-based dismissal.**
  Rejected because §1's two open items resolve to "the client path is unreachable, not merely
  risky" and "the comment path is unaudited, not merely undocumented" — both were live gaps in
  ADR 0008's own design, not implementation details. A dedicated route per actor closes both
  structurally.
- **One `/crm/entities/:id/vac` endpoint with a `type` discriminator body.** Rejected in §2 — the
  actor-mixing risk of a shared endpoint outweighs the marginal routing simplicity.
- **A `force` flag refusing re-verification.** Rejected in §5 — re-verification is a legitimate
  correction and the audit trail is what makes it safe, not a refusal.
- **Storing the card-authority reference on the acceptance record itself (extending
  `RecordAcceptanceDto`).** Rejected — this is ADR 0008's own F5/D3 reasoning, restated: the
  acceptance shape's value is that it is closed and shared with GovernanceX; an open bag on it is
  where a PAN eventually gets written by exactly the well-meaning path D4 exists to prevent.

---

## 11. Consequences, including the unpleasant ones

1. **A client can now write to a money-integrity field for the first time.** `self-report` is
   narrowly scoped (§2 D1) but it is still new attack surface on a record firms already worry
   about — a client spamming `self-report` cannot escalate to `verified` (the route structurally
   cannot write it) but can create staff-task noise. No rate limit is specified here; if this
   proves to be abused, add one at the route (a per-entity cooldown, not a global one — a
   legitimate client correcting a mistaken self-report needs to be able to resubmit).
2. **The PAN detector will produce false positives** (ADR 0008's own §6 point 4, unchanged) — an
   IMO number, an invoice reference, a long case number can Luhn-validate by chance. `mode: 'off'`
   default means this risk is opt-in per tenant, but once an immigration tenant flips to `'block'`,
   expect a support ticket within the first week and have the pack-overlay escape hatch (ADR 0008
   §7 trigger table) ready to use, not to design from scratch under pressure.
3. **Five new routes is five new things to keep GovX byte-identical against.** Verify the sweep
   (GovX 27/28) after this ships even though nothing here touches a GRC pack — the routes live in
   `CrmController`'s module graph, shared code even though the data is immigration-only.

---

## 12. What would make this decision wrong later — the trigger to revisit

- **If GovernanceX develops its own money-integrity model needing the same client-attestation
  pattern**, `self-report`'s shape (`vacEvidenceSubmission`) is immigration-vocabulary-named. The
  generalisable part — "a non-privileged actor may write a bounded, task-generating attestation
  but never a privileged status" — should be extracted into a generic CRM primitive at that point,
  not duplicated as `breachEvidenceSubmission` or similar.
- **If the PAN detector's false-positive rate causes more than one tenant to request `mode:
  'off'`.** Per ADR 0008 §7: "If more than one tenant asks, the detector is wrong, not the
  config." **The first thing to add, not a redesign:** a BIN/IIN range check (§4) — deliberately
  left out of this ADR's initial scope, and the single largest known lever on the false-positive
  rate. Revisit the Luhn/co-location heuristic itself only if a BIN/IIN check does not resolve it.
- **If the duty floor (D5, still out of scope) is ever built**, it must be checked against these
  five routes explicitly: none of them may become subject to a `commercial_hold` without a
  deliberate decision, per ADR 0008 §2 D5's `neverGated[]` list and its own standing warning that
  `commercial_hold` must never reach `DocumentAccessService`, `StorageService.checkAccess` or
  `ThreadService` without a regression test proving it does not. Extend that same regression
  discipline to `VacService` when D5 is eventually built.

---

## 13. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| Five new routes + `VacService` | Revert the commit. No migration to reverse (§8) | `vacEvidenceSubmission`, `vacCardAuthority`, and any dismissal entries already written remain on affected records — harmless, `verticalAttributes` is an open bag, and per ADR 0008's own rule **do not "clean up" by PATCHing `null`**, which would delete the key and (for `vacStatus`-adjacent keys) reopen the F1 skipped-rule hole |
| PAN detector core (`scanForCardData`) | Revert the commit; all five call sites (comment, message, document-analyze, card-authority `purpose`, revocation `reason`) return to unguarded, matching ADR 0008's own D4a rollback entry | None |
| `compliance.cardDataGuard.mode: 'block'` flip | Set `mode: 'off'` and bump the pack version — faster than reverting code | Redacted extraction output already written is **not recoverable**, exactly as ADR 0008 §8 already states — re-run `/documents/:id/analyze` on affected documents |
| `documentTemplates[].vac_card_authority` | Remove the entry, bump. Existing acceptance records are append-only and must not be deleted — they are the audited evidence the authority was given | `vacCardAuthority` reference objects persist, now referring to a template that no longer generates — acceptable, they are historical |

**Rollback verification:** re-run ImmiStack (33/33) and GovX (27/28) sweeps, per every ADR in this
family.

---

## 14. Implementation briefs

### Luke (backend-dev)

1. **`src/crm/vac.service.ts`** (new) — `selfReport`, `verify`, `dismissAlert`,
   `recordCardAuthority`, `revokeCardAuthority`. **`selfReport` and `verify` do not go through
   `CrmService.updateEntity`** — inject `UniversalEntity`'s repository directly (same pattern
   `CommentService` uses for its own writes), load `{id, tenantId}`, run the actor check per §6
   (`CrmAccessService.assert` for `selfReport`'s D1 ownership check; role-only for the other four),
   validate `evidenceDocumentId` per D1a/D2 where applicable, deep-merge the relevant
   `verticalAttributes` key via the existing `deepMerge` utility (`src/common/deep-merge.ts`) —
   **do not hand-roll a merge**, the whole point of D1's separation from `vacVerification` is that
   these writes touch one key each and must not clobber siblings — save, then call `AuditService`
   per §9 (**after** the save succeeds, and for `recordCardAuthority`/`revokeCardAuthority`, only
   after the D4 scan on `purpose`/`reason` has already passed — §4's ordering rule; a rejected scan
   throws before the save is attempted at all, so the audit call is simply never reached, not
   skipped by a conditional).
   - `selfReport` additionally: inject `Repository<User>` (already available in this module graph
     elsewhere — see `documents.service.ts`'s own `userRepo` for the precedent) for the
     oldest-active-`firm_admin` fallback per D1a; resolve `taskCreated`/`taskAssignee` **before**
     building the audit context, so the context object is constructed once from a single source of
     truth rather than re-derived at the call site; return `staffNotified: taskCreated` on the
     response DTO.
2. **`src/crm/dto/self-report-vac.dto.ts`, `verify-vac.dto.ts`, `dismiss-vac-alert.dto.ts`,
   `record-card-authority.dto.ts`, `revoke-card-authority.dto.ts`** (new) — per §2/§3.
   Cross-field validation (`verify`'s either/or — service-layer only, per D2; `card-authority`'s
   acceptance precondition) is service-layer, not a DTO decorator.
3. **`src/crm/crm.controller.ts`** — five new handlers under `crm/entities/:id/vac/...`. The four
   staff-only ones get `@Roles(PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)`; **`self-report` gets
   `@Roles(PlatformRole.CLIENT)`** — a `firm_admin`/`staff` token must 403 at the guard, before
   `VacService.selfReport` is ever reached (§2 D1's MARS decision). The service-layer
   `CrmAccessService.assert` call is the *second* layer, narrowing a `client` token to their own
   record — it does not do the role-separation job the guard does, and neither check is redundant
   with the other.
4. **`src/common/card-data-detector.ts`** (new) — `scanForCardData` per §4. Unit tests:
   - the Luhn validator against known-valid and known-invalid test numbers (the standard published
     test PANs, never a real one), and against realistic false-positive candidates (an IMO number,
     a 16-digit invoice reference) to establish the baseline false-positive rate before shipping
     `mode: 'block'` anywhere;
   - **required:** for every input containing a Luhn-valid 13–19 digit run, assert
     `result.redacted` contains no substring that itself Luhn-validates — re-run the Luhn check
     against the *output*, not merely a string-inequality check against the input (§4's reasoning:
     a masking-width bug could leave a different Luhn-valid run in the redacted text by
     coincidence, which a naive "the original digits are gone" test would miss).
5. **Five call sites**, gated behind `compliance.cardDataGuard.mode` read via
   `VerticalPackService.section(vertical, 'compliance')`:
   - `src/crm/comment.service.ts:93` (`CommentService.add`) — scan `body` before save; `mode:
     'block'` → 422; `mode: 'warn'` → save, flag; `mode: 'off'` → no-op (the default, so GRC is
     byte-identical, confirmed by grep in the header of this ADR). Write the scan result to
     `verticalAttributes.cardGuardScan` on the same `NOTE` entity, sibling to `content`.
   - `src/notifications/thread.service.ts:294` (`ThreadService.send`) — scan `content` before
     save, same three-way behaviour. Write the scan result to `Notification.metadata.cardGuardScan`
     (extend the `metadata` TypeScript type at `notification.entity.ts:161-169`, no migration).
   - `POST /documents/:id/analyze` output path, before persistence — redact and flag per ADR 0008's
     asymmetric rule, never reject. Scan result to `Document.aiAnalysis`, per ADR 0008's original
     placement.
   - **`VacService.recordCardAuthority`** (new, this ADR) — scan `dto.purpose`; `mode: 'block'` →
     422, the card-authority record is never created; `mode: 'warn'` → write proceeds, the scan
     result folds into the `vac.card_authority.recorded` audit context (§4, §9), not a standalone
     field.
   - **`VacService.revokeCardAuthority`** (new, this ADR) — scan `dto.reason`, identical
     block/warn behaviour, folds into `vac.card_authority.revoked`'s audit context.
6. **`packages/config-packs/_schema/pack.schema.ts`** — add `compliance.cardDataGuard` per ADR
   0008 §2 D4's exact shape (this ADR does not change it). Two-part commit.
7. **`packages/config-packs/verticals/immigration.json`** — author `documentTemplates[].
   vac_card_authority` (pack-authoring, per ADR 0008 §2 D3 — a real `DocumentBlockSchema` template,
   see `packages/config-packs/_schema/pack.schema.ts`'s block types for the vocabulary), and set
   `compliance.cardDataGuard.mode: 'off'` explicitly (stating the default rather than relying on
   the schema default, so a pack reader sees the decision was made, not omitted). Bump version.
8. Specs: `vac-self-report-authz.spec.ts` (a `firm_admin`/`staff` token gets 403 from the `@Roles`
   guard before the service is reached; a `client` token cannot write `verified`, cannot reach
   another client's record — `CrmAccessService.assert` refusal, 404; cannot downgrade an
   already-`verified` status; a bogus or cross-case `evidenceDocumentId` is refused per D1a),
   `vac-self-report-task.spec.ts` (new, per this amendment — an assigned case creates the task on
   `entity.assignedTo` with `taskAssignee: 'case_assignee'`; an unassigned case with at least one
   active `firm_admin` falls back to the oldest by `createdAt`, `taskAssignee:
   'firm_admin_fallback'`; a tenant with zero active `firm_admin` users creates no task,
   `taskCreated: false`, `taskAssignee: null`, and the `vacStatus` write still succeeds; the
   response's `staffNotified` matches `taskCreated` in all three cases; the fallback query never
   returns a user from a different tenant),
   `vac-verify.spec.ts` (either/or: neither field → 400, one → accepted, both → accepted; a
   cross-tenant `evidenceDocumentId` is refused per D2's existence check), `vac-card-authority.spec.ts`
   (refuses without matching acceptance record; `last4` shape rejection; `purpose` containing a
   Luhn-valid candidate under `mode: 'block'` is refused with 422 and writes no audit entry —
   assert `AuditService.logUpdate` was never called, not merely that the record was not saved),
   `card-data-detector.spec.ts` (Luhn correctness, the required no-unmasked-run test, false-positive
   baseline), `vac-audit.spec.ts` (every one of the five routes writes exactly one audit entry with
   the correct `beforeState`/`afterState` scoping, and a 422-refused `card-authority`/`revoke`
   write produces **zero** audit entries).

### Mira (frontend-dev)

1. **Client self-report UI** — a single "I've paid this" action on the client portal's payments
   view, calling `POST /crm/entities/:id/vac/self-report`. Render the result as
   `immistack/CLAUDE.md` §3 already specifies: `vacStatus: 'evidence_pending'` → **"not verified"**,
   never "paid". The action must be idempotent-feeling to the client (resubmitting does not error
   unless the record is already `verified`, in which case show "already confirmed by [firm]" —
   pulling `vacVerification.verifiedAt` if present, never inventing a message from `evidence_pending`
   state).
2. **Staff verify UI** — `POST /crm/entities/:id/vac/verify`, collecting `evidenceKind` and either
   an `evidenceDocumentId` (picked from the case's documents) or a typed `trn`. The either/or must
   be enforced in the form before submit, not left to the 400 to explain.
3. **The reconciliation alert banner** — per ADR 0008 §2 D2's rendering contract table (unchanged):
   `violations` → BLOCKING, un-dismissable without a ≥20-character reason via the new
   `POST /crm/entities/:id/vac/alerts/dismiss`; `skipped` → "Cannot determine — payment status
   missing", never clean; `invalid` → "Alert misconfigured", shown to `firm_admin`. **This table has
   three outcomes and only one renders clean — do not add a fourth default branch that falls
   through to clean.**
4. **Card authority capture UI** — generate the `vac_card_authority` document
   (`POST /documents/generate/vac_card_authority`), collect the client's acceptance
   (`POST /crm/entities/:id/acceptance`, existing route, `subject: 'vac_card_authority'`), **then**
   call `POST /crm/entities/:id/vac/card-authority` with the resulting `documentSha256`. The three
   steps are sequential and the third will 409 if the second was skipped or the hash does not
   match — surface that 409 as "record the client's acceptance first", not a generic error.
5. **Never render a card number, anywhere.** The UI's own form for `last4` must be a four-digit
   input, not a full card-number field with client-side truncation — truncating client-side still
   means the full number transited the browser's memory and, if any analytics/error-reporting SDK
   is attached to form state, potentially a third party. This is the one place in this ADR where a
   frontend implementation choice, not just a backend contract, is load-bearing for FR-7.13.

---

## 15. Changelog — Anton (secops) review, 2026-09-17

Amendment only. No code was written for this pass; every change below is to this document. Owen's
gate and Anton's re-review both still apply before Luke implements.

| # | Anton's finding | Resolution |
|---|---|---|
| 1 | D4's three attachment points missed the two free-text fields this ADR itself introduces (`RecordCardAuthorityDto.purpose`, `RevokeCardAuthorityDto.reason`) | §4 now names five attachment points in a table, with explicit `mode: 'block'` → 422 semantics for the two new ones, and states the scan-before-audit ordering explicitly (a rejected write never reaches `AuditService`) |
| 2a | Self-report's ownership predicate was left as "confirm which of the two services to call" rather than decided | §2 D1 decides it: `{id, tenantId}` load + `CrmAccessService.assert(entity, actor, 'read')`, the same pattern `CommentService.add` already uses — not `DocumentAccessService.assertOwnsEntity`, which answers a document question, not a CRM-record one |
| 2b | MARS decision: self-report must be role-restricted to `PlatformRole.CLIENT`, not open to any authenticated actor | §2 D1 and §6 updated: `@Roles(PlatformRole.CLIENT)` at the controller, so a staff token 403s before the handler runs — a staff attestation must never be recorded as a client one; staff use `verify` |
| 2c | The task-creation mechanism and its tenancy were unnamed | §D1a (new subsection) names `TaskService.createTask(tenantId, dto)`, states `CreateTaskDto.assignedTo`'s required-field constraint, and states the task's tenancy (same tenant, existing `/tasks` scoping). **The no-assignee fallback given in this pass ("no task created, logged") was superseded the same day — see the second pass below; do not implement from this row.** |
| 3 | A client-supplied `evidenceDocumentId` on self-report was stored unvalidated | §D1a (new subsection): must exist in the tenant, be readable by the caller (`DocumentAccessService.assert`), and be linked to the case being self-reported against — all three failure modes return the same 404 |
| 4a | `verify`'s either/or validation layer was unstated | §D2: service-layer only, not a DTO decorator, with the specific reasoning (a business rule about the record's evidentiary requirement, not a field-shape constraint) |
| 4b | Neither/both cases for `verify`'s either/or were unstated | §D2: neither → 400; both → accepted (both fields stored) |
| 4c | `verify` had no existence/tenant check on `evidenceDocumentId` | §D2: added, with the deliberate asymmetry against D1a explained (staff already have tenant-wide document reach, so only existence-in-tenant is checked, not `DocumentAccessService.assert`; no `linkedEntityId` match required, unlike the client-facing D1a check) |
| 5 | The `comment.entity.ts` citation does not exist; comments and thread messages needed their actual homes stated | §4 and §8: comments are `UniversalEntity` rows of type `NOTE` (`comment.service.ts:93-112`), body in `verticalAttributes.content`; thread messages are `Notification` rows (`notification.entity.ts:161-169`), `metadata` jsonb. `cardGuardScan` provenance placement stated for both — no migration needed either way. `[UNVERIFIED]` removed |
| — | Required: a unit test that the detector's output never contains an unmasked Luhn-valid run | Added to §4 and Luke's brief item 4 — re-validate Luhn against `result.redacted`, not a naive input/output string comparison |
| — | Note: no BIN/IIN heuristic is used | Added to §4 as a stated, deliberate simplification and the largest lever on the false-positive rate; promoted to the first-line response in §12's revisit trigger |
| — | Note: these routes bypass `updateEntity`, so a future generic update-audit mechanism won't cover them | Added to §9 — the five audit calls remain this ADR's own permanent responsibility, not a stopgap a later mechanism absorbs |
| — | Re-grep `crm.service.ts`'s `lockedWhen` line references | `assertNoLockedFieldChanged` is now at `src/crm/crm.service.ts:142-192` (was cited as `122-177`); both references in this document corrected |

Also corrected in this pass, not separately requested but load-bearing once the above changed:
§5's route/tenancy table, §6's tenancy narrative, §13's rollback table ("three call sites" → all
five), and stale cross-references to the resolved `[UNVERIFIED]` in §12's trigger list.

### Second pass — Anton confirms, same day, one required fix before Luke builds

Text only, no code, no commit. This pass **supersedes row 2c above** — "no task created, logged"
was the first pass's answer and is no longer current; read D1a, not this row, for the live
behaviour.

| # | Anton's finding | Resolution |
|---|---|---|
| 1 | `comment.service.ts` line citation was off by six lines (`:99`, actual `:93`) | Every occurrence in this document corrected to `:93` (the `assert` call) and `:93-112` / `:101-112` (the surrounding block), matched against a fresh grep of the file, not carried forward from the first pass |
| 2 | No silent miss on self-report when the case has no assignee — MARS decision: fall back to the tenant's oldest-active `firm_admin` (deterministic order, `createdAt` ascending); if the tenant has none, no task. Either way, audit the outcome and tell the client | §D1a rewritten: the fallback query (filtered in application code against `users.roles`, deliberately avoiding the SQL array-containment landmine ADR 0001 §11 already flagged for this exact column); `vac.self_report.recorded`'s audit context now carries `{ taskCreated, taskAssignee: 'case_assignee' \| 'firm_admin_fallback' \| null }` (§9); the route's response carries `staffNotified: boolean` so the client portal renders "your firm has been notified" only when true. Luke's brief item 1 and a new spec item 8 (`vac-self-report-task.spec.ts`) updated to match |
