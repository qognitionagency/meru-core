# 0020 — Send-for-signature is an assent workflow wrapped around the existing acceptance record, not a new signature primitive

**Status:** Proposed — 2026-09-17. Not merged. Requires `quality` (Owen) and `secops` (Anton)
review — a new client-reachable state machine and a new RLS-carrying table, per
`definition-of-done.md`. Luke and Mira implement against this contract; this document specifies
no feature code.

**Amended 2026-09-17, following Anton's (secops) review — approved with changes, text only, no
code:** (1) §5's `decline` row now carries `ip`/`userAgent`, sourced identically to
`AcceptanceService.record`; (2) §5 states explicitly that every row-level audit write in this ADR
populates `userId`/`userEmail` from the acting caller; (3) §1.3's module-cycle `[UNVERIFIED]` is
resolved — confirmed no cycle exists; (4) §3/§4 now specify the exact guard stack, matching
`PaymentsController`'s precedent, and §2.3's `sendFromTemplate` `[UNVERIFIED]` is resolved against
an existing one-off call site in this same module.

**Scope:** PRD §9 / BC-5, FR-6.19–6.21, E13/E14. Builds on ADR 0019 (templates) for *what* gets
sent and adopts **operator decision PD-3** verbatim: the cost agreement ships on the existing
acceptance/assent record (`POST /crm/entities/:id/acceptance`, `isSignature: false`) with explicit
labelling; a real signature provider is an interface only, not built here. This ADR does not
reopen PD-3.

---

## 1. Context

### 1.1 What exists today, verified

`POST /crm/entities/:id/acceptance` (`crm.controller.ts:417-...`, `AcceptanceService.record`,
`acceptance.service.ts:85-166`) appends an `AcceptanceRecord` to
`entity.verticalAttributes.acceptances[]` — `subject`, `userId`, `email`, `acceptedAt`, `ip`,
`userAgent`, `documentSha256`, `isSignature: false` (always). It is **stateless across calls**:
there is no "this document was sent," no "the client viewed it," no "the client declined it," and
no expiry. A firm calling this route today has to build the whole draft→sent→viewed→responded
workflow FR-6.19 asks for entirely in the frontend, against a primitive that only knows "someone
accepted something, once."

`POST /documents/generate/:templateKey?entityId=…&store=true` (ADR 0019 §2.3–2.5, unchanged by
this ADR except that the template resolved may now be a tenant override) produces and files the
PDF. Nothing today connects "the PDF that was generated" to "the acceptance that was recorded" —
a caller must independently compute `documentSha256` from bytes it already has and pass it to
`/acceptance` by hand; there is no single call that does both and no stored link from an
acceptance record back to which `documentId`/version it was shown against.

### 1.2 What PD-3 decides, and what it leaves open

PD-3 (operator decision, not reopened here): the cost agreement — and, by the same reasoning,
every other FR-6.16 document type — ships on `isSignature: false` assent, explicitly labelled.
**What PD-3 does not decide** is the workflow state machine FR-6.19 asks for
(`draft → sent → viewed → signed | declined | expired`) or where "viewed"/"declined"/"expired"
are recorded, since none of those exist on `AcceptanceRecord` today. That is this ADR's job.

FR-6.19's own state name is `signed`; this ADR renames the terminal success state `accepted` in
the schema and API (§2.1) while keeping the **UI label** "Sign" where the product copy already
uses it — the interface says what it is (`isSignature: false`, per ADR 0009-adjacent §5.2b of the
workspace `CLAUDE.md`) even where the button a client clicks says "Sign this document," because a
client asked to "accept" a cost agreement reads as weaker than what they are actually being asked
to do, and the honesty obligation is about what the **record** claims, not about avoiding the word
"sign" in a call-to-action.

### 1.3 Who the recipient is, and the resolution problem this reuses rather than re-solves

The recipient of a sent document is a **client** — a `users.id` holding the `client` role, not a
CRM person-entity id, for the identical reason `Payment.clientId` has to be resolved
(`payments.service.ts:77-187`, `resolveClientUserId`, already `public` specifically so a second
writer could reuse it — see its own doc comment: "Public because `FeeScheduleService.expand`
writes `Payment` rows on a second path and must resolve the same way"). This ADR is the third
writer that needs the identical resolution (staff hand the UI a CRM entity id; the record must
store a real `users.id` to be readable by the client's own login) and reuses
`PaymentsService.resolveClientUserId` rather than writing a fourth copy of the email-comparison
logic — `BillingModule` already exports `PaymentsService` (`billing.module.ts:51`), so
`DocumentsModule` (or wherever this ADR's new service lives) imports `BillingModule` for it.

**Resolved, not `[UNVERIFIED]`: no cycle.** `BillingModule`'s own imports are `VerticalPackModule`,
`AuditModule` and `SearchModule` (`billing.module.ts:23-28`) — none of the three import
`DocumentsModule`, `AiModule`, or anything that does (`VerticalPackModule` imports nothing beyond
`TypeOrmModule`; `AuditModule` imports only `VerticalPackModule`; `SearchModule` imports
`CoreModule` and `ElasticsearchCoreModule`, neither of which imports `DocumentsModule` either).
`DocumentsModule` may therefore add `BillingModule` to its own `imports` array as a **plain**
import — no `forwardRef` needed, unlike the existing `forwardRef(() => AiModule)` on the same file
(`documents.module.ts`), which exists for a different, already-resolved reason (`AiModule` itself
imports both `DocumentsModule` and `BillingModule` directly, `ai.module.ts:21-22` — that cycle is
already handled on `DocumentsModule`'s side and this ADR does not touch it). **The gate that
matters is not reading the import graph by eye, though — it is booting the compiled app.** Luke
must run `SKIP_CONFIG_PACK_LOADER=true JWT_SECRET=x node dist/src/main.js` (or `npm start`) after
wiring `BillingModule` into `DocumentsModule` and grep for **`Nest application successfully
started`**, per `CLAUDE.md` §8.2/§8.6 — a DI fault of this shape prints a full route table and
*then* dies, and no unit test constructs the module graph, only individual services with mocked
constructor arguments.

### 1.4 The 404-not-403 and own-scope precedents this must match

`DocumentGenerationService.buildContext` already checks `DocumentAccessService.assertOwnsEntity`
before touching an entity for a `client` actor (ADR 0019 §1.3, `:277-279`), and `PaymentsService`
already gives a `client` caller a 404, not a 403, for a payment that is not theirs
(`payments.service.ts:309-323`, "a real-but-foreign entityId is itself a disclosure"). Every
client-facing route this ADR adds follows the identical rule.

---

## 2. Decisions

### 2.1 D1 — New table `document_send_requests`: the state machine. `AcceptanceService` stays the system of record for the assent itself.

**Decision.** A send request is a **first-class row**, not folded into `verticalAttributes` —
unlike `AcceptanceRecord`, which is intentionally a lightweight jsonb append, a send request has
an indexed lifecycle a client and staff both query (`GET .../mine`, `GET ?entityId=`), a
compare-and-set need (two staff members must not both "send" the same draft), and an expiry that
has to be computed without deserialising every entity's `verticalAttributes` in the tenant. Those
are exactly the reasons ADR 0015 §2.2 gave for appointments needing a real table instead of
`verticalAttributes`, and they apply here unchanged.

```sql
CREATE TABLE "document_send_requests" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"           uuid NOT NULL,
  "entityId"           uuid NOT NULL,             -- the case/client this concerns
  "templateKey"        character varying(100) NOT NULL,
  "templateSource"     character varying(10) NOT NULL,   -- 'pack' | 'tenant' (ADR 0019 §2.3)
  "templateVersion"    character varying(40) NOT NULL,   -- pack version string, or tenant int as text
  "documentId"         uuid,                       -- set once generated+stored (documents.id)
  "documentSha256"     character varying(64),       -- set once generated
  "recipientUserId"    uuid,                        -- resolved users.id (§1.3); NULL while draft
  "recipientEmail"     character varying(255) NOT NULL,  -- AS GIVEN AT SEND, never re-read later
  "recipientName"      character varying(255),
  "status"             character varying(16) NOT NULL DEFAULT 'draft',
                       -- draft | sent | viewed | accepted | declined | cancelled
  "sentBy"             uuid,
  "sentAt"             timestamptz,
  "viewedAt"           timestamptz,
  "respondedAt"        timestamptz,
  "declineReason"      text,
  "acceptanceSubject"  character varying(200),      -- the `subject` string handed to AcceptanceService
  "expiresAt"          timestamptz,
  "cancelReason"       text,
  "version"            integer NOT NULL DEFAULT 0,  -- compare-and-set, same contract as ADR 0014 D4 / ADR 0015 D3
  "createdBy"          uuid NOT NULL,
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  "updatedAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_document_send_requests_status"
    CHECK ("status" IN ('draft','sent','viewed','accepted','declined','cancelled'))
);
CREATE INDEX ON "document_send_requests" ("tenantId", "entityId");
CREATE INDEX ON "document_send_requests" ("tenantId", "recipientUserId");
CREATE INDEX ON "document_send_requests" ("tenantId", "status");
```

`ENABLE`+`FORCE` RLS at creation, `tenant_isolation` policy, identical shape to the precedent
migrations named throughout ADR 0019/0009/0015.

**`AcceptanceService` is not replaced.** When a send request transitions to `accepted` (§2.3), the
service calls `AcceptanceService.record(tenantId, entityId, { subject: acceptanceSubject, userId,
email, ip, userAgent, documentSha256 }, actor)` exactly as any other caller would — the assent
itself, with its hash-anchoring and its hash-chained audit entry, is recorded by the **one**
existing mechanism this product has for "someone agreed to something," per PD-3 and per
`CLAUDE.md` §5.2b ("Two places now return a field whose only job is to deny a stronger claim" —
this ADR does not add a third place; it wraps the existing one). `document_send_requests` records
the *workflow* (was it sent, was it seen, when, by what deadline); `verticalAttributes.acceptances[]`
records the *assent itself*, unchanged in shape.

**Why `expired` is never a stored status.** `status` only ever holds the six values that are
genuinely written by an action. "Expired" is **computed at read time** — `now() > expiresAt AND
status IN ('sent','viewed')` renders as `effectiveStatus: 'expired'` in every response — because
writing a stored `expired` status would mean either a background job flips it (another job, on
serverless, cadence-limited, `CLAUDE.md` §8.4) or every read has to reason about staleness anyway;
computing it at read time is simpler, always current, and — critically — **reversible**: extending
`expiresAt` on a request that has not yet been responded to un-expires it with no status write to
undo, matching `CLAUDE.md` §5.2's "unknown is never clear" instinct applied to time instead of data
completeness (an expired-but-not-yet-marked request must never render as "still live" either, and
computing it fresh on every read is what guarantees that).

### 2.2 D2 — Generation happens at `draft` creation, not at `send`; the hash and version are frozen the moment the document exists

**Decision.** `POST /documents/send-requests` (§3) does three things atomically, in one request:
resolves the template (ADR 0019 §2.3), calls `DocumentGenerationService.generate(...)` then
`.store(...)` exactly as the existing manual flow would, and writes the `document_send_requests`
row with `status: 'draft'`, `documentId`, `documentSha256` and `templateVersion` all populated
from that generation. **Sending (§2.3) never regenerates the document.** This is what makes
FR-6.22 ("a sent agreement always renders the version that was sent") true by construction rather
than by a query joining backwards through time: the PDF bytes, their hash, and the template
version that produced them are fixed the instant the draft exists, and every later action —
send, view, accept, decline — operates on that same, already-immutable, already-versioned
document. A firm that wants to send a different version creates a new send request; there is no
"edit and resend" on an existing one, matching `Payment.invoiceNumber`'s own "immutable once
issued, corrections are a new row" pattern this codebase already uses for exactly this reason.

**Why not generate at send-time instead.** Two reasons. First, staff need to review the actual
rendered PDF before it reaches a client (this is what "draft" is *for* — ADR 0019 §2.5 already
makes generation-without-store a preview; §3 below makes the *stored, hash-anchored* draft
reviewable before send the same way). Second, generating at send-time would mean the document a
client is asked to accept could differ from the one staff reviewed if anything about the record
changed between review and send (a payment settled, an address updated) — the `buildContext` this
draws from is live data at generation time, and freezing it at draft creation is what stops that
class of drift.

### 2.3 D3 — The state machine, and who may drive each transition

```
draft ──(staff: send)──▶ sent ──(client: view)──▶ viewed ──(client: accept)──▶ accepted
  │                        │                          │
  │                        └──(client: decline)───────┴──(client: decline)──▶ declined
  │
  └──(staff: cancel)──▶ cancelled          sent/viewed ──(staff: cancel)──▶ cancelled
```

- **`draft → sent`**: staff only. Sets `sentBy`, `sentAt`; dispatches a notification to
  `recipientEmail` via `NotificationsService.sendFromTemplate` against a pack `messaging.templates[]`
  key (§6) — `CLAUDE.md` §4.1's evaluator table already names `SequenceRunnerService` as the
  reader of that array; this is a one-off send, not a sequence, so it calls
  `NotificationsService.sendFromTemplate` directly. **Resolved, not `[UNVERIFIED]`: a one-off,
  non-sequence call site for exactly this shape already exists in this same module** —
  `DocumentRequestService` (`src/documents/document-request.service.ts:490-503`) calls
  `this.notifications.sendFromTemplate(tenantId, templateKey, entity.id, variables, vertical, {
  recipientEmail, metadata })` to chase a client for a missing document, addressing the recipient
  by **CRM entity id**, not a `users.id` — because the recipient "is a CRM record, not a platform
  user, so the address travels with the message — same contract the sequence runner uses" (that
  file's own comment, `:493-494`). This ADR's `send` transition follows the identical shape:
  `recipientId` is the `entityId` this send request is about, `options.recipientEmail` is the
  row's own `recipientEmail` column (§2.1 — captured at draft creation, never re-read from the
  entity at send time), and `options.metadata` carries `{ sendRequestId, templateKey, reason:
  'document-send-request' }`. `renderTemplate`'s `unrendered` check (the same one
  `DocumentRequestService` already runs before calling `sendFromTemplate`, `:479-487`) applies
  unchanged — a template declaring a variable this route cannot supply fails the transition with a
  400 naming it, rather than sending a document with an unresolved placeholder in the notification
  body.
  `recipientUserId` is resolved separately, via `PaymentsService.resolveClientUserId` (§1.3), not
  at draft creation — a draft may exist before the client has been invited (matching
  `PaymentsService.resolveClientUserId`'s refusal-not-null-write behaviour), and `send` is refused
  (400) if resolution fails for the same reason raising a charge against an uninvited client is
  refused today. **These are two independent resolutions or two independent reasons to refuse**:
  the notification dispatch needs only an email address (`recipientEmail`, always present per the
  DTO, §3); the `client`-role read/response routes (`/view`, `/accept`, `/decline`, §4) need
  `recipientUserId`, because that is what the own-scope check compares against an authenticated
  caller's `actor.id`. A `send` that dispatches successfully but fails to resolve `recipientUserId`
  is refused as a whole (both must succeed, since a client who received an email with no way to log
  in and act on it is a support incident, not a partial success) — implemented as: resolve
  `recipientUserId` **first**, before calling `sendFromTemplate`, so a resolution failure never
  results in an email already sent that the client cannot then respond to.
- **`sent → viewed`**: client only, own scope. Idempotent — a second view call when already
  `viewed` or later is a no-op (200, unchanged), not an error; `viewedAt` is set only the first
  time. This is a deliberate, honest signal to staff ("the client has at least opened this"), not
  a read-receipt guarantee (a client viewing via a screen reader, or a preview pane, still counts —
  this product does not attempt pixel-tracking or any stronger claim than "the endpoint was
  called").
- **`sent | viewed → accepted`**: client only, own scope. Calls `AcceptanceService.record` (§2.1)
  with `documentSha256` from the frozen draft (§2.2) — **never recomputed at accept-time**, so
  what is hashed is provably what was generated, not whatever the record looks like now. Sets
  `respondedAt`. This is the one transition PD-3 governs: the response the client sees must say,
  in the same screen where they click "Sign," **"This records that you agreed to this document —
  it is not an electronic signature"** (verbatim requirement carried from `CLAUDE.md` §5.2b/§9),
  and the API response embeds `isSignature: false` from the underlying `AcceptanceRecord` so no
  frontend can accidentally omit it.
- **`sent | viewed → declined`**: client only, own scope. Requires `declineReason` (free text,
  `MaxLength(2000)`) — a decline with no reason gives staff nothing to act on, and FR-6.19 names
  `declined` as a real outcome staff must be able to follow up on, not a dead end.
- **`draft | sent | viewed → cancelled`**: staff only. Withdraws an offer before it is acted on —
  the "send the wrong template" recovery path. `cancelReason` optional. **`accepted` and
  `declined` are terminal**; cancelling an already-accepted request would contradict a recorded
  assent, which this system never retroactively unwrites (the same "audit_logs is append-only"
  instinct, `CLAUDE.md` §5.4, applied one level up).
- Every transition carries `expectedVersion` and is refused with **409 `MER-RES-0005`** on
  mismatch — the identical compare-and-set contract ADR 0014 D4 and ADR 0015 D4 already establish,
  so two staff members racing to send, or a staff cancel racing a client accept, resolve the same
  way task-board drag races already do in this codebase.
- A transition attempted against an `effectiveStatus: 'expired'` request (§2.1) is refused
  (400 `MER-VAL-0001`, "this request expired on {date}") **except** `cancel`, which staff may
  always do to formally close out an expired offer.

### 2.4 D4 — Expiry default, and who sets it

**Decision.** `expiresAt` defaults to **30 days from `sentAt`** if not specified at draft
creation, matching the card-authority default already established in `CLAUDE.md` §4.3
("expires... on lodgement or 30 days, whichever is first") as the product's existing convention
for a time-bounded consent artefact. Staff may set a shorter or longer `expiresAt` explicitly per
document type (a cost agreement urgency might warrant 7 days; a general correspondence
acknowledgement might warrant 90). `expiresAt` is measured from `draft` creation if the draft is
never sent (an unsent draft that sits for months is stale data, not a live offer) — set at draft
creation, not recomputed at send, so a firm cannot indefinitely extend an offer's shelf life by
delaying `send`.

---

## 3. API contract

Base path `/documents/send-requests`.

| Route | Method | Who | Notes |
|---|---|---|---|
| `/documents/send-requests` | POST | `firm_admin`, `staff` | Create + generate + store, `status: draft` (§2.2). Body: `{ entityId, templateKey, recipientEmail?, recipientName?, expiresInDays? }`. `recipientEmail`/`Name` default to the entity's own `email`/name if omitted |
| `/documents/send-requests` | GET | `firm_admin`, `staff` (tenant scope, `?entityId=` filter); `client` (forced own scope) | List. A `client` caller is forced to `recipientUserId = caller.id` regardless of query params — same forcing pattern as `PaymentsService.list` |
| `/documents/send-requests/:id` | GET | as above | 404, not 403, for a foreign id (§1.4) |
| `/documents/send-requests/:id/send` | POST | `firm_admin`, `staff` | `draft → sent`. Body: `{ expectedVersion }` |
| `/documents/send-requests/:id/view` | POST | `client`, own only | `sent|viewed → viewed`. No body needed (idempotent, §2.3) |
| `/documents/send-requests/:id/accept` | POST | `client`, own only | `sent|viewed → accepted`. Body: `{ expectedVersion }`. Response embeds the resulting `AcceptanceRecord` (`isSignature: false`) |
| `/documents/send-requests/:id/decline` | POST | `client`, own only | `sent|viewed → declined`. Body: `{ expectedVersion, reason }` |
| `/documents/send-requests/:id/cancel` | POST | `firm_admin`, `staff` | `draft|sent|viewed → cancelled`. Body: `{ expectedVersion, reason? }` |

**Guard stack — specified, matching `PaymentsController`'s precedent exactly** (`payments.controller.ts:47-48`,
confirmed: `@Controller('payments')` `@UseGuards(AuthGuard('jwt'), PolicyGuard)` at class level,
`@Roles(...)` per route). `DocumentSendRequestsController` (or wherever these routes live, §11) 
carries `@UseGuards(AuthGuard('jwt'), PolicyGuard)` **at the class level**, and every route in the
table above carries its own `@Roles(...)` decorator naming exactly the roles in the "Who" column —
`@Roles(PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)` for the staff-only routes,
`@Roles(PlatformRole.CLIENT)` for `/view`, `/accept`, `/decline`. This is not a new pattern this
ADR invents; it is the one every other controller in `src/billing/`, `src/documents/` and
`src/crm/` already uses, and deviating from it (e.g. a route-level-only `@UseGuards` with no class
guard) is exactly the shape that has previously left a route reachable with no authentication at
all (`CLAUDE.md` §16's `POST /auth/register`/`POST /tenants/signup` history). `PolicyGuard` runs
`@Roles` against the authenticated actor's `PlatformRole`; it does **not** perform the own-scope
check (§4) — that remains a service-layer check, per every other ADR in this set.

### Responses

`GET .../:id` (and every transition's 200):

```jsonc
{
  "id": "...", "entityId": "...", "templateKey": "cost_agreement",
  "templateSource": "tenant", "templateVersion": "3",
  "documentId": "...", "status": "sent", "effectiveStatus": "sent",  // "expired" overrides status when past expiresAt
  "recipientEmail": "mei-ling@example.com", "recipientName": "Mei-Ling Chen",
  "sentAt": "...", "viewedAt": null, "respondedAt": null, "expiresAt": "...",
  "version": 1,
  // present only once accepted:
  "acceptance": { "subject": "cost_agreement:sent:<id>", "userId": "...", "email": "...",
                  "acceptedAt": "...", "documentSha256": "...", "isSignature": false }
}
```

### MER-* errors

| Code | HTTP | When |
|---|---|---|
| `MER-VAL-0001` | 400 | Illegal transition (not in §2.3's diagram from the current status); missing `declineReason`; transition attempted on an `effectiveStatus: 'expired'` request; `recipientEmail` cannot be resolved to a `client`-role `users.id` at send-time (§2.3) |
| `MER-RES-0001` | 404 | `:id` not found for this caller's scope — own-scope enforced 404, not 403 (§1.4) |
| `MER-RES-0005` | 409 | `expectedVersion` mismatch on any transition (§2.3) |
| `MER-AUTH-0009` | 403 | Wrong role attempting a route (e.g. staff calling `/accept`) |

No new error family — reuses `VAL`/`RES`/`AUTH`, matching ADR 0019's own choice not to invent one
for a workflow that is not billing.

---

## 4. Tenancy enforcement per route

| Route | RLS | Service-layer check |
|---|---|---|
| `POST /documents/send-requests` | `document_send_requests` `ENABLE`+`FORCE` RLS at creation | `DocumentAccessService.assertOwnsEntity(tenantId, entityId, actor)` before generation — staff acting on behalf of a client still needs the entity to be a real, readable record in this tenant; this is the same check ADR 0019's `generate` call already performs, reused, not reinvented |
| `GET /documents/send-requests`, `GET .../:id` | RLS as above | Staff: tenant-scope only, no further restriction. `client`: **forced** `recipientUserId = actor.id` in the query itself (not merely filtered after fetch) — the same "forced, not defaulted" pattern `PaymentsService.list` uses so a client cannot widen their view by manipulating query params |
| `POST .../:id/send`, `.../:id/cancel` | RLS as above | `firm_admin`/`staff` only via `@Roles`; no additional own-scope needed (staff act tenant-wide by design) |
| `POST .../:id/view`, `.../:id/accept`, `.../:id/decline` | RLS as above | **Explicit service-layer check**, not RLS: `if (row.recipientUserId !== actor.id) throw NotFoundException(...)` — RLS isolates tenants, not users inside one (`CLAUDE.md` §5.1, the exact defect class named there for `/crm/entities`, `/payments`, `/communications/threads` and, most recently, `POST /documents/generate/:templateKey` itself). This is the single highest-stakes check in this ADR: a `client` token reaching another client's `/accept` route would let one applicant record assent to another applicant's cost agreement. **Every implementation of these three routes must be tested with a second `client` token against the first client's request id before this ships** (matching the NFR-2 acceptance step E29 in the PRD) |

---

## 5. Audit events

**Every row in this table populates `userId`/`userEmail` from the acting caller, never from the
row being modified — the same rule `AcceptanceService.record` already follows and
`AuditService.logEvent`'s DTO already requires (`audit.service.ts:55-68`, `userId` is a mandatory
field on every write).** Concretely: `crm.controller.ts:417-434`'s own precedent is the pattern
every write below copies — `userId: actor.id, userEmail: actor.email` sourced from
`req.user`/the resolved `Actor`, **taken from the request/session, never accepted as a body
field** (a caller-supplied "this happened as user X" is an assertion, not evidence, exactly the
reasoning `RecordAcceptanceDto`'s own doc comment gives for omitting `userId`/`email` from that
DTO, `record-acceptance.dto.ts:10-16`). For the two staff-driven rows (draft create, send, cancel)
this is the authenticated staff member; for the two client-driven rows (accept — via
`AcceptanceService`'s own write — and decline) this is the authenticated client, i.e.
`recipientUserId`/`recipientEmail` as confirmed by the own-scope check (§4) that already ran
before the write, not re-derived a second time.

| Event | Action | Severity | Context |
|---|---|---|---|
| `POST /documents/send-requests` (draft created) | `CREATE` | `INFO` | `{ entityId, templateKey, templateVersion }` |
| `.../send` | `UPDATE` | `WARNING` | `{ recipientEmail }` — a legal document is now in a client's hands |
| `.../view` | not separately audited — recorded on the row itself (`viewedAt`); an audit entry for every client page-view is disproportionate volume for a signal this ADR already treats as weak evidence (§2.3) |
| `.../accept` | handled by `AcceptanceService.record`'s own audit write (`WARNING`, unchanged — ADR 0020 does not duplicate it) — this ADR's service additionally logs `UPDATE`/`INFO` on `document_send_requests` itself for the status-row transition, so the workflow state change and the assent event are both independently reconstructable |
| `.../decline` | `UPDATE` | `WARNING` | `{ declineReason, ip, userAgent }` — **`ip`/`userAgent` added on review, sourced identically to `AcceptanceService.record`**: `req.ip ?? null` and `req.headers['user-agent'] ?? null` (`crm.controller.ts:429-432`'s own comment: "From the request, never the body: a client-supplied 'I accepted from this address' is not evidence of anything" — the identical reasoning applies to a decline, which is just as much a legally-relevant client action as an accept and should carry the same weak-but-real provenance evidence) |
| `.../cancel` | `UPDATE` | `INFO` | `{ cancelReason, statusAtCancel }` |

---

## 6. Pack keys touched

- `messaging.templates[]` — a new template key, e.g. `document_send_request` (exact key name is
  Luke's/a pack author's call at implementation; not fixed by this ADR), rendered with the
  document label and a link into the client portal's document-send list. **No schema change** —
  `messaging.templates[]` already exists and is read by `SequenceRunnerService`
  (`CLAUDE.md` §4.1); this ADR only asks a pack author to author one more entry into an
  already-declared array, the same "additive, no code change" posture ADR 0019 keeps for
  `documentTemplates[]`.
- No new pack schema fields. This ADR's state machine lives entirely in `document_send_requests`,
  not in pack configuration.

---

## 7. Options rejected

| Option | Why rejected |
|---|---|
| Extend `AcceptanceRecord` itself with `status`/`sentAt`/`viewedAt` fields | `verticalAttributes.acceptances[]` is an append-only jsonb array recording completed assents; retrofitting a mutable in-progress workflow state onto it means editing array elements in place, which is exactly the "audit trail that can be silently edited" shape `CLAUDE.md` §5.4/§5.4b's WORM discipline exists to avoid elsewhere |
| Generate the document at `send` time rather than `draft` creation | Lets the document a client sees drift from what staff reviewed, and reopens exactly the version-ambiguity problem FR-6.22 exists to close (§2.2) |
| A public, unauthenticated magic-link for viewing/accepting (matching how some e-signature providers work) | The client is already invited and authenticated in the portal per FR-9.11/E15; adding a second, unauthenticated access path for the same document is new attack surface for no requirement that asks for it — PRD §21 E13–E14 describe an already-signed-in client, not an anonymous one |
| A stored `expired` status flipped by a scheduled job | Requires a job that runs frequently enough to be meaningful, which is exactly the `scope=fast` scheduler gap `CLAUDE.md` §8.4/§12 already names as unprovisioned; computing `effectiveStatus` at read time needs no scheduler and is always current (§2.1) |
| Allow `platform_admin` to send/cancel on a tenant's behalf | Not requested by any FR; matches ADR 0019's identical exclusion for template edits — a platform operator acting on a tenant's client-facing document is a separate, unreviewed capability |

---

## 8. Consequences

1. One new RLS-carrying table — run `npm run rls:verify` after the migration.
2. `AcceptanceService` gains no new public method and no schema change — this ADR is additive on
   top of it, matching the "extend, don't replace" instinct `CLAUDE.md` §5.5b states for core
   changes generally.
3. `DocumentsModule` (or wherever this lives) takes a new dependency on `BillingModule` for
   `PaymentsService.resolveClientUserId` (§1.3) — confirm no cycle before merging.
4. **The own-scope check on `/view`, `/accept`, `/decline` (§4) is the single highest-risk piece
   of this ADR** and must be the first thing Owen's review and Anton's cross-tenant/cross-user
   test target, given this product's history: this is the same class of gap that has already
   shipped five times (`CLAUDE.md` §8, most recently on `POST /documents/generate/:templateKey`
   itself, the very route ADR 0019/0020 both build on).
5. A firm now has a real "who has an unsigned cost agreement outstanding" query
   (`status IN ('sent','viewed')`) — feeds the PRD §7 statistics catalogue's "cost agreement
   sent→signed and the drop-off" metric, which today has nothing to compute from.

---

## 9. What would make this wrong later

| Trigger | Invalidates | What to do |
|---|---|---|
| A real e-signature provider is contracted (FR-6.20, PD-3's deferred half) | This whole ADR's `accepted` transition | Add a `signatureProviderId` seam beside `acceptanceSubject` on the row (this ADR's own docstring already predicts this in §1.2/§2.3) — `accepted` becomes two paths, assent (this ADR, unchanged) or provider-signed (new), both terminal, both distinguishable in the response by `isSignature: true`/`false`. Do not remove the assent path when this lands — some document types (draft approval, VEVO consent) are PD-3-listed as staying assent-only permanently |
| A firm needs to resend a *reminder* for an outstanding `sent`/`viewed` request without creating a new one | D2's "no edit-and-resend" | Add a `POST .../:id/remind` that re-dispatches the same notification without touching `documentId`/`documentSha256`/`expiresAt` — additive, does not violate the frozen-document principle |
| Multiple recipients need to accept the same document (e.g. both spouses on a family application) | D1's single `recipientUserId` per row | This is a materially different shape (one document, many assent records) — treat as a new ADR, do not stretch this one's one-row-one-recipient model |
| The `fast` job scheduler (Upstash QStash, ADR 0004) ships | D1's read-time `effectiveStatus` computation | No change required — it remains correct and cheaper than a job-driven flip; only revisit if a *stored* `expired` status is needed for some other reason (e.g. a reporting query that cannot afford to compute it per-row) |

---

## 10. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `document_send_requests` (migration `AddDocumentSendRequests`) | `DROP TABLE document_send_requests` | Every send-request row is lost. **The underlying `AcceptanceRecord`s in `verticalAttributes.acceptances[]` are NOT touched by this rollback** — an already-recorded assent survives exactly as it did before this feature existed, because this ADR never modified `AcceptanceService`'s storage, only wrapped it. Confirm no active `sent`/`viewed` request exists that a client is currently expected to act on before dropping — those offers simply vanish with no record they were ever sent |
| New routes (§3) | Remove them; `AcceptanceService`/`DocumentGenerationService` are unmodified by this ADR and need no reversion |
| `messaging.templates[]` pack entry (§6) | Remove the entry from the pack, bump version | None — additive-only pack change |

**Rollback verification:** confirm the count of `status IN ('sent','viewed')` rows before
dropping the table — each one represents a document a real client may be mid-review of, and
losing the row does not un-send the email already in their inbox, so staff should be told to
follow up manually on any that were live.

---

## 11. Implementation briefs

### For Luke (backend)

- **Migration** `1757410000000-AddDocumentSendRequests.ts` per §2.1. `down()` drops the table.
- **Entity** `DocumentSendRequest` in `src/documents/entities/`, registered in
  `src/config/entities.ts` (`CLAUDE.md` §10 rule 3, §16's recurring defect class).
- **New `DocumentSendRequestService`**, in `src/documents/`, importing `BillingModule` (a plain
  import — §1.3 confirms no cycle) to inject `PaymentsService` (for `resolveClientUserId`), plus
  `DocumentGenerationService`, `DocumentAccessService`, `AcceptanceService` and
  `NotificationsService`. One method per transition in §2.3, each opening a `QueryRunner`
  transaction only where a counter or a cross-table write is involved (draft creation, which also
  writes to `documents`/`document_versions` via the existing `DocumentGenerationService.store`
  path) — the pure status transitions (`send`/`view`/`accept`/`decline`/`cancel`) are single-row
  updates and do not need one, matching how `ADR 0014`'s own compare-and-set transitions are
  implemented without a transaction wrapper.
- **Boot gate, mandatory before this is considered wired:** after adding `BillingModule` to
  `DocumentsModule`'s `imports`, run `SKIP_CONFIG_PACK_LOADER=true JWT_SECRET=x node dist/src/main.js`
  (build first) and grep the output for **`Nest application successfully started`** — do not trust
  a green unit suite or a clean `tsc` for this; neither exercises the module graph (§1.3, `CLAUDE.md`
  §8.2/§8.6).
- **`documents.controller.ts`** (or a new `DocumentSendRequestsController` — Luke's call): seven
  routes per §3, with the guard stack specified in §3 (`@UseGuards(AuthGuard('jwt'), PolicyGuard)`
  at the class level, `@Roles(...)` per route, matching `PaymentsController`). **The three
  client-reachable routes (`/view`, `/accept`, `/decline`) must each independently re-check
  `recipientUserId === actor.id` inside the service method itself, not only via a controller-level
  guard** — this is the exact "controller authenticated, service trusted the id" pattern
  `CLAUDE.md` §8 names as the root cause of all five prior instances of this defect class. Write
  the cross-user test (a second `client` token against the first client's request id, expecting
  404) **before** wiring the route, not after.
- Reuse `AcceptanceService.record` for the `accept` transition verbatim — do not write a second
  acceptance-writing code path.
- For `send`: follow `DocumentRequestService.sendFromTemplate`'s exact call shape
  (`document-request.service.ts:490-503`) — read it before writing this, do not re-derive the
  argument order. Resolve `recipientUserId` (via `PaymentsService.resolveClientUserId`) **before**
  calling `sendFromTemplate`, per §2.3's amended reasoning — a resolution failure must never leave
  an email sent with no way for the client to act on it.
- Every audit write (`AuditService.logEvent`) sets `userId`/`userEmail` from the acting `Actor`,
  never from the row (§5). The `decline` write additionally carries `ip`/`userAgent`, sourced
  exactly as `crm.controller.ts:429-432` sources them for `recordAcceptance` — from `req.ip` and
  `req.headers['user-agent']`, never the request body.
- Concurrency/compare-and-set test: two concurrent `send` calls on the same draft with the same
  `expectedVersion`, assert exactly one succeeds and the other gets 409.

### For Mira (frontend)

- Staff side: on a case/client detail page, "Send for signature" action picks a template (from
  ADR 0019's resolved list), previews it (reusing the existing generate-without-store call), then
  `POST /documents/send-requests` creates the draft. A distinct "Send" action (separate from
  "Create draft") calls `.../send` — **do not collapse these into one button**; FR-6.19's `draft`
  state exists specifically so staff can review before a client sees anything.
- Client portal: a new list/section showing outstanding `sent`/`viewed` requests
  (`GET /documents/send-requests`, forced own-scope server-side, no client-side filter needed).
  Opening one calls `.../view` on mount (idempotent, safe to call every time the page loads). The
  accept screen **must show, in the same view as the accept action**, the literal sentence "This
  records that you agreed to this document. It is not an electronic signature." — sourced from
  the response's `isSignature: false`, not hardcoded copy that could drift from the actual field
  (render the label conditionally on the field, so a future `isSignature: true` path — §9's
  trigger — automatically stops showing this sentence rather than requiring someone to remember to
  remove it).
- Decline flow: require the reason field client-side too (defence in depth; the backend already
  requires it), and surface it to staff prominently — FR-6.19/BR-R5's whole point is that a
  decline is information staff must act on, not a dead click.
- `effectiveStatus: 'expired'` renders distinctly from `sent`/`viewed` in both staff and client
  views — an expired offer is not the same as one still awaiting a response, and PRD §3's
  three-valued-rendering discipline applies here as much as it does to documents and checklists.
- Five states per definition-of-done: empty (no send requests yet), loading, error (a 400 on
  accept because the request expired mid-review — show *why*, not a generic failure), populated,
  overflowing (a client with several outstanding requests, or staff viewing a firm-wide list —
  paginate).
