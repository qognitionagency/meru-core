# 0022 — Minimal appointments on the record timeline, and auto-case-provisioning on lead conversion

**Status:** Proposed — 2026-09-17. Not merged. Requires `quality` (Owen) and `secops` (Anton)
review — a new RLS-carrying table and a change to an existing client-facing write path, per
`definition-of-done.md`. Luke and Mira implement against this contract; this document specifies
no feature code.

**Scope:** Two independent decisions, documented together because both are small, both touch the
lead/client/case lifecycle, and both were scoped down by the same operator instruction: build the
minimal thing now, not the full-featured version already designed elsewhere.

- **§2.1–2.4 (E10/E12 in the task brief's numbering — this ADR's own numbering is D1–D2):**
  PRD §13 / BC-9, **the minimal subset of** FR-10.1, FR-10.7, FR-10.8 only — a staff-booked
  appointment recorded on the lead/client timeline. **Operator decision, not reopened here:** no
  Cal.com, no public booking page, no calendar sync, in this ADR.
- **§2.5–2.6:** PRD FR-4.6 — "on conversion the system automatically creates a case workspace,"
  with visa subclass captured, case number assigned (ADR 0010).

Each has its own rollback row (§8) because each can be reverted independently.

---

## 1. Context

### 1.1 Appointments — ADR 0015 already exists, is much larger, and is not being replaced

ADR 0015 (`docs/adr/0015-appointments-and-calendar-integration.md`, Proposed, not merged) already
specifies the **full** appointments capability: a three-table schema (`appointments`,
`appointment_availability`, `appointment_blocks`, plus `user_calendar_links`), public booking
routes, availability computation with buffers and working hours, a double-booking exclusion
constraint, and poll-based Google Calendar sync. It is FR-10.1–10.8 in full and is scoped to
**Release R2** (PRD §22).

**This ADR does not re-decide any of that.** The operator instruction for E10 is explicit:
"minimal in-app appointment on the lead/client timeline, no Cal.com." That is a strict subset of
ADR 0015's own D2/D3 (§1.2 below), and the right move is to **adopt ADR 0015's schema for the one
table this subset needs, unchanged**, and build a **much smaller route surface** against it —
never a second, incompatible `appointments` table that would need a painful migration the day
ADR 0015's remaining phases (availability, public booking, calendar sync) actually ship.

### 1.2 What this ADR adopts from ADR 0015 verbatim, and what it does not build yet

Adopted, unchanged (ADR 0015 §2.2–2.3): the `appointments` table schema in full, including columns
this minimal subset will not populate yet (`reminderPlan`, `providerRef`, `syncState`) — they
default sensibly (`'[]'`, `NULL`, `'unsynced'`) and cost nothing to leave unused. The core
architectural reasoning ADR 0015 §2.2 gives for **why appointments need a dedicated table and not
a `/crm/entities` `type`** — an interval is not a `dueDate`, double-booking needs a database
constraint, availability is a range scan — applies identically whether the booking was made by
staff typing a time in or by a public page computing free slots, so there is nothing about "staff
books directly" that argues for a different data shape.

**Not built by this ADR** (left for ADR 0015's later phases, unchanged from its own scope):
`appointment_availability`, `appointment_blocks`, `user_calendar_links`; the public `?host=`
routes; `GET /appointments/availability`; `POST /appointments/calendar/connect/:provider`; the
`calendar-sync` job; reminder dispatch. **Booking a slot in this ADR is staff typing a start/end
time directly** — there is no availability computation, no conflict-free-slot suggestion, and no
double-booking *prevention* beyond ADR 0015's own database-level exclusion constraint, which this
ADR inherits for free by using the same table (§2.1).

### 1.3 Lead-to-client conversion — confirmed, in the current source, to do nothing about a case

`CrmService.convertEntity` (`crm.service.ts:782-894`) rewrites `type`, claims a `recordNumber` when
one is due (ADR 0010 §2.4), and writes `verticalAttributes.conversion` — and stops there. It does
**not** create a case. `grep -n "EntityType.CASE" crm.service.ts` inside `convertEntity` returns
nothing. This matches `immistack/CLAUDE.md` §5.0b's own confirmation that no live backend path
populates a case for a newly converted client, and PRD FR-4.6's requirement — "On conversion the
system automatically creates a case workspace" — is, today, entirely unbuilt, not partially built.

### 1.4 How a case already links to its client, on the one path that creates one manually

`matters.service.ts`'s `createMatter` (`meru-core-fe/immistack/lib/api/services/matters.service.ts:179-...`)
writes `verticalAttributes.matter.clientId` on the new `case` entity — a plain jsonb field, the
same vertical-attribute convention `CLAUDE.md` §5.5/§7.5 already establishes for every
vertical-specific piece of data. **There is no core-level relation, FK, or `relationships[]` pack
entry linking a case to its primary client today** — the pack's own `relationships[]`
(`verticals/immigration.json`) has `dependent_of` (person→case, for **dependants**, not the
primary applicant), `sponsored_by` (case→organization), and `supporting_note` — none of them the
primary-applicant link. This ADR follows the existing convention (`verticalAttributes.matter.clientId`)
rather than inventing a second, competing linkage mechanism the day after the first one was
established by the only code that currently writes it.

### 1.5 The 80/20 boundary this decision has to respect

"Visa subclass" is immigration vocabulary and must not become a named field or DTO property in
`src/crm/` (`CLAUDE.md` §5.5, restated in `immistack/CLAUDE.md` §1: "if you are about to write
immigration vocabulary inside `meru-core/src/` — stop"). `EntityType.CASE` is already confirmed
core-neutral (ADR 0010 §2.3 — GRC's own base pack uses `type: "case"` too). What is **not**
core-neutral is any *field on* a case, which is why §2.5 passes visa-subclass-and-friends through
as an opaque, caller-supplied jsonb blob, never a named parameter core inspects or validates.

---

## 2. Decisions

### 2.1 D1 — Adopt ADR 0015's `appointments` table now; this ADR's migration is the same schema, not a redesign

**Decision.** The migration in this ADR creates the **identical** `appointments` table ADR 0015
§2.3 specifies — same columns, same indexes, same `EXCL_appointments_host_overlap` exclusion
constraint (subject to the same `btree_gist` availability caveat ADR 0015 already flags as
`[UNVERIFIED]` and must be re-confirmed before this migration is written, not re-guessed here).
**If ADR 0015 merges first** with its own migration for this table, this ADR's migration becomes a
no-op and should be dropped from the implementation branch rather than run twice — this is stated
explicitly because two architects are working in this ADR directory concurrently (per this
document's own commissioning instruction) and a duplicate `CREATE TABLE "appointments"` is a
foreseeable collision this note exists to prevent. **If this ADR merges first**, ADR 0015's later
migrations for `appointment_availability`/`appointment_blocks`/`user_calendar_links` are additive
and do not touch this table.

**Why adopt rather than design a smaller, purpose-built table.** A reduced table (no
`reminderPlan`, no `providerRef`, no `syncState`) would need a schema migration the day ADR 0015's
calendar-sync phase lands — adding columns to a table already holding live booking data is a real
migration with a real (if small) risk, for no saving beyond a handful of unused nullable columns
today. Adopting the full schema now costs nothing at this volume and removes an entire class of
future migration.

### 2.2 D2 — Route surface: staff books directly, both roles read, no public routes, no availability, no calendar sync

**Decision.**

| Route | Who | Notes |
|---|---|---|
| `POST /appointments` | `firm_admin`, `staff` | Books a specific `hostUserId`/`startsAt`/`endsAt` directly — no availability check beyond the database exclusion constraint (§1.2/§2.1) rejecting a literal overlap. `source: 'staff'` always (ADR 0015's `source` enum already includes it) |
| `GET /appointments` | `firm_admin`, `staff` (tenant scope, `?entityId=` filter for a lead/client's own timeline); `client` (forced own scope, matching every other client-facing list in this product) | `client` scope = `subjectEmail` matches the caller's email — **identical rule to ADR 0015 §2.4**, adopted unchanged, not redesigned |
| `GET /appointments/:id` | as above | 404, not 403, for one the caller may not read — the same rule this entire set of four ADRs applies everywhere a client token can reach a record |
| `PATCH /appointments/:id` | `firm_admin`, `staff` only, in this ADR — **`client` reschedule/cancel (ADR 0015's own FR-10.5 grant) is deferred**, because self-service reschedule needs availability data this ADR does not build (§1.2); a client asking to move a consultation goes through staff for now | Status transitions only: `booked → rescheduled \| cancelled \| completed \| no_show`. Carries `expectedVersion`, same compare-and-set contract as ADR 0015 §2.4/ADR 0014 D4 |

**No `GET /appointments/availability`, no `POST /appointments/public`, no
`/appointments/calendar/*` routes in this ADR.** Staff pick a time by looking at the existing
`GET /tasks/calendar/events`-style view of their own day (out of scope for this ADR to change) and
type it in; the exclusion constraint is the only thing stopping two staff from double-booking one
host, which is exactly the level of automation "minimal" was asked for.

**Notification on booking**: reuses `NotificationsService.sendFromTemplate` against a pack
`messaging.templates[]` entry (§6), the identical mechanism ADR 0020 §2.3 uses for a document-send
notification — no new dispatch mechanism invented for a second feature in this same set of four
ADRs.

### 2.3 D3 — `entityId`/`entityType` links the appointment to the lead/client it is about, exactly as ADR 0015 already specified

**Decision.** `POST /appointments` accepts `entityId` (required for this ADR's use case — FR-10.7/
FR-10.8's "lands on the lead or client timeline" is the entire point of building this now, ahead
of the rest of ADR 0015) and no `entityType` guess-work: the service reads the named entity's own
`type` and stores it, matching the unenforced-reference pattern `Task.entityId`/`entityType`
already establish (ADR 0015 §2.2's own citation, `task.entity.ts:74-80`) — no FK, so a record's
appointment history survives even if the entity itself is later converted (lead → person) or
soft-deleted. `DocumentAccessService`-style `assertOwnsEntity` runs before the booking is created,
for the identical reason it runs before a document is generated against an entity (ADR 0019 §1.3)
— a staff member booking an appointment against an entity they cannot read is the same class of
bug as generating a document against one.

### 2.4 D4 — Timeline rendering is a read concern, not a new API shape

**Decision.** "Shows on the lead timeline" (FR-10.7) is satisfied by the frontend calling
`GET /appointments?entityId=<leadId>` alongside whatever other timeline sources it already merges
(activity log, call notes, acceptance history) — **no new merged "timeline" endpoint is built by
this ADR.** PRD FR-3.13 already asks for "one chronological activity timeline per lead," which is
a frontend aggregation concern across several existing sources; adding appointments to that
aggregation is Mira's work (§9), not a new backend contract.

### 2.5 D5 — `convertEntity` creates the case in a second, sequential transaction — never nested inside the conversion transaction

**Decision.** `CrmService.convertEntity` gains one new step, run **after** its existing transaction
commits (`crm.service.ts:855-879`), not inside it: when `toType` is `PERSON` or `ORGANIZATION`
(i.e. the conversion is `LEAD → client`) and the request opts in (`autoCreateCase`, default
`true` — see DTO, §3), call `this.createEntity(tenantId, { type: EntityType.CASE, ... }, actor)` —
the **existing** `createEntity` method, unchanged, which already opens and manages its own
`QueryRunner` transaction for the `CS-` record-number claim (ADR 0010 §2.2).

**Why a second, sequential transaction and not one combined transaction.** `meru-core`'s database
pool is `max: 1` **per invocation** (`CLAUDE.md` §9). `createEntity` opens its own `QueryRunner`
internally via `this.dataSource.createQueryRunner()`, which acquires a **new** connection from
that pool. Calling it from *inside* `convertEntity`'s still-open transaction — which is already
holding the invocation's one available connection — would mean the second `createQueryRunner()`
call blocks waiting for a connection that can never free, because the only connection is held by
the very transaction waiting on this call to return. **This is a deadlock, not a slowdown, and it
is exactly the class of defect ADR 0010 §1.2 exists to name for a different reason (a race, not a
deadlock) — both come from underestimating what `max: 1` does to nested transactional calls.**
Running the case creation *after* `convertEntity`'s own transaction commits avoids this entirely:
by the time `createEntity` opens its transaction, the conversion's connection has already been
released back to the pool.

**What this means for failure handling, stated plainly rather than engineered around.** If case
creation fails after the conversion has already committed, **the conversion is not rolled back** —
the client conversion, and any `recordNumber` it claimed, stand. This is the correct trade-off:
a client that was successfully converted must not disappear back into being a lead because an
unrelated write (case provisioning) failed a moment later, and ADR 0010 §2.2 already established
the precedent that a `recordNumber`, once claimed and committed, is never un-claimed. The response
DTO (§3) therefore carries an explicit `caseProvisioningError: string | null` field — **never
silently omitted** — so the caller (staff, or the frontend on their behalf) knows to create the
case manually via the existing `createMatter` path if this one failed, rather than believing FR-4.6
succeeded when it did not. This is the same "unknown must never render as a positive result"
discipline (`CLAUDE.md` §5.2) applied to a response field instead of a UI render.

### 2.6 D6 — Visa subclass and every other vertical-specific field pass through as an opaque `caseAttributes` blob; core never inspects them

**Decision.** `ConvertEntityDto` gains one new optional field: `caseAttributes?:
Record<string, unknown>`. When the auto-created case is written, `caseAttributes` is deep-merged
(the existing `deepMerge`, `crm.service.ts`, already used for `verticalAttributes.conversion`
elsewhere in this same method) into the new case's `verticalAttributes.matter` — **the same key
path `createMatter`'s manual flow already uses** (§1.4), so a case created by conversion and a
case created manually are structurally identical to every downstream reader (checklist resolution,
workflow materialisation, the client portal's `client-journey.ts` mapping). Core validates nothing
about the *contents* of `caseAttributes` — no `visaSubclass` field name appears anywhere in
`src/crm/`, satisfying §1.5. `verticalAttributes.matter.clientId` is set by this ADR's code to the
newly-converted entity's own id, **always**, regardless of what the caller passed in
`caseAttributes` — this is the one field core *does* own, because it is the linkage this ADR's
whole existence depends on, and a caller-supplied `caseAttributes.clientId` (if any) is silently
overwritten by the correct value rather than trusted, the same "server derives identity, never
trusts a caller's assertion of it" instinct `RecordAcceptanceDto`'s own doc comment states
(ADR 0020 §1.1) applied here.

**Case number.** The new case goes through the **existing, unmodified** `createEntity` → ADR 0010
§2.2 counter-claim path — it gets a `CS-000042`-shaped `recordNumber` for free, because
`createEntity` already does this for every `EntityType.CASE` row regardless of how it was
triggered. This ADR adds no new numbering logic.

---

## 3. API contract

### Appointments (D2)

```ts
export class CreateAppointmentDto {
  @IsUUID() hostUserId: string;
  @IsUUID() entityId: string;
  @IsDateString() startsAt: string;
  @IsDateString() endsAt: string;
  @IsString() timezone: string;              // IANA, matches ADR 0015 §2.3 column
  @IsIn(['video','in_person','phone']) locationKind: string;
  @IsOptional() @IsString() locationText?: string;
  @IsOptional() @IsUrl() meetingUrl?: string;
  @IsOptional() @MaxLength(2000) notes?: string;
}

export class UpdateAppointmentStatusDto {
  @IsInt() expectedVersion: number;
  @IsIn(['rescheduled','cancelled','completed','no_show']) status: string;
  @IsOptional() @IsDateString() startsAt?: string;   // required when status === 'rescheduled'
  @IsOptional() @IsDateString() endsAt?: string;
  @IsOptional() @MaxLength(1000) cancelReason?: string;
}
```

Response shape: the `appointments` row as ADR 0015 §2.3 defines it, with `notes` **stripped** for
`own` (client) scope — identical rule to ADR 0015 §2.4, adopted unchanged, since `notes` is a
staff file note and this ADR did not change that distinction.

### Conversion (D5/D6)

`ConvertEntityDto` (`update-entity.dto.ts:173-184`) gains:

```ts
export class ConvertEntityDto {
  @IsEnum(EntityType) toType: EntityType;
  // New:
  @IsOptional() @IsBoolean() autoCreateCase?: boolean;         // default true, only meaningful for LEAD → PERSON/ORGANIZATION
  @IsOptional() @IsObject() caseAttributes?: Record<string, unknown>;
}
```

`POST /crm/entities/:id/convert` response gains one field:

```jsonc
{
  // ...existing UniversalEntity fields, unchanged...
  "caseWorkspace": { "id": "...", "recordNumber": "CS-000042" } | null,
  "caseProvisioningError": null | "string explaining what failed"
}
```

`caseWorkspace` is `null` when `autoCreateCase: false`, when `toType` was `ORGANIZATION ↔ PERSON`
(not a lead conversion), or when provisioning failed — **the caller must check
`caseProvisioningError`, not merely the presence of `caseWorkspace`, to distinguish "not
applicable" from "failed"** (both render `caseWorkspace: null`; only the latter also sets a
non-null `caseProvisioningError`).

### MER-* errors

| Code | HTTP | When |
|---|---|---|
| `MER-VAL-0001` | 400 | Appointment `endsAt <= startsAt`; illegal status transition |
| `MER-RES-0001` | 404 | Appointment/entity not found for caller's scope |
| `MER-RES-0005` | 409 | `expectedVersion` mismatch on `PATCH /appointments/:id` |
| `MER-RES-0002` | 409 (from the database exclusion constraint, mapped) | The host already has an overlapping `booked`/`rescheduled` appointment — `RESOURCE_ALREADY_EXISTS`, reused rather than a new code, since this is structurally "you tried to create a thing that conflicts with an existing one," the same shape that code already names |

No new error family. `convertEntity`'s existing 400/404 behaviour (`crm.service.ts:798-812`) is
unchanged — case-provisioning failure is reported in the 200 response body (§3 above), never as a
second error on an otherwise-successful conversion, per §2.5's stated failure-handling decision.

---

## 4. Tenancy enforcement per route

| Route | RLS | Service-layer check |
|---|---|---|
| `POST /appointments`, `GET /appointments`, `GET /appointments/:id`, `PATCH /appointments/:id` | `appointments` table `ENABLE`+`FORCE` RLS at creation (adopted from ADR 0015 §2.3 verbatim) | `assertOwnsEntity(tenantId, entityId, actor)` on create (§2.3). `client` scope on read: **explicit service-layer check** — `subjectEmail` (or, since this ADR's bookings are always staff-created against a real entity, resolved via the entity's own email at read time) compared to `actor.email`, not RLS — RLS isolates tenants, not users inside one (`CLAUDE.md` §5.1), the same instinct every other ADR in this set restates because it is the single most repeated defect class in this codebase's history (five prior instances, `CLAUDE.md` §8) |
| `POST /crm/entities/:id/convert` (existing route, extended) | `universal_entities` RLS, unchanged | `this.access.assert(entity, actor, 'write')` — **unchanged**, already present at `crm.service.ts:796`. The new case-creation step calls `this.createEntity`, which performs its **own** independent access/validation as it already does for every caller — no bypass, no shortcut through the conversion's own already-checked permission |

---

## 5. Audit events

| Event | Action | Severity | Context |
|---|---|---|---|
| `POST /appointments` | `CREATE` | `INFO` | `{ entityId, hostUserId, startsAt }` |
| `PATCH /appointments/:id` (any transition) | `UPDATE` | `INFO` (`WARNING` for `cancelled` with `source: 'staff'` cancelling on short notice — **not enforced by this ADR**, left as a UI nicety, not a backend rule, since "short notice" needs a threshold nobody has specified) |
| `convertEntity`'s new case-provisioning step | `CREATE`, on the **new case entity** | `INFO` | matches `createEntity`'s own existing audit write — no new audit call added by this ADR beyond what `createEntity` already performs; case-provisioning failure is logged via `Logger.error` (matching the existing `searchService.indexEntityData` fire-and-forget failure logging pattern already in `convertEntity`, `crm.service.ts:888-890`), not a separate audit entry, since the conversion's own audit trail already covers the conversion itself |

---

## 6. Pack keys touched

- `messaging.templates[]` — one new entry for appointment-booked notification (D2), same
  already-declared array ADR 0020 §6 uses for its own notification, no schema change.
- No change to `relationships[]` (§1.4 — this ADR deliberately does not add a
  case-to-primary-client relation key; it continues the existing `verticalAttributes.matter.clientId`
  convention instead, per §2.6).

---

## 7. Options rejected

| Option | Why rejected |
|---|---|
| Design a smaller, bespoke appointments table instead of adopting ADR 0015's schema | Costs a real migration the day ADR 0015's later phases land, for a saving of a handful of unused nullable columns today (§2.1) |
| Build `GET /appointments/availability` now, scoped to "no calendar sync, just Meru's own existing bookings" | Explicitly out of scope per the operator instruction ("minimal... no Cal.com"); availability computation is non-trivial (buffers, working hours) and is exactly the piece ADR 0015 already designed properly — building a lesser version now risks a second, inconsistent implementation |
| Allow `client` self-service reschedule/cancel in this ADR, matching ADR 0015's eventual FR-10.5 grant | Self-service reschedule needs to show the client *available* alternative slots, which needs availability data this ADR does not build; a client "rescheduling" into an already-booked slot with no availability check is worse than routing the request through staff |
| Nest case-creation inside `convertEntity`'s own transaction | Deadlocks the `max: 1` connection pool (§2.5) — not a style preference, a correctness requirement |
| Roll conversion back if case-provisioning fails | Makes an unrelated write (case creation) able to undo a successful, already-committed client conversion and its claimed `recordNumber` — worse than reporting the failure and letting staff create the case manually (§2.5) |
| Add a `visaSubclass` field to `CreateEntityDto`/`ConvertEntityDto` directly, since PRD FR-4.6 names it | Direct 80/20 violation (`CLAUDE.md` §5.5) — immigration vocabulary has no business as a named parameter in `src/crm/`; `caseAttributes` (opaque, pass-through) is the correct shape (§2.6) |
| A new `primary_applicant_of` pack `relationships[]` entry, replacing `verticalAttributes.matter.clientId` | Would create two competing linkage mechanisms (the new relation, and the existing field every other read path already uses) the day after the first one was established — a real improvement, possibly, but a separate decision requiring its own migration of every existing case, not something to fold into this ADR incidentally |

---

## 8. Consequences

1. One new RLS-carrying table (or zero, if ADR 0015 merges first — §2.1's collision note) — run
   `npm run rls:verify` after whichever migration actually lands.
2. `ConvertEntityDto` and `convertEntity`'s response shape both change (additive fields only,
   §3) — every existing caller that does not send `caseAttributes`/`autoCreateCase` keeps working
   exactly as today, with `autoCreateCase` defaulting to `true` meaning **existing frontend
   callers will start getting a case auto-created on lead conversion the moment this ships**,
   unless the frontend is updated in the same release to either pass `autoCreateCase: false` or
   handle the new `caseWorkspace`/`caseProvisioningError` fields. **This is a behaviour change on
   an existing route, not purely additive, and must be called out in the frontend changelog**, the
   same caution ADR 0007 gives its own `internal` task default.
3. `convertEntity` now performs a second database round-trip (the sequential `createEntity` call,
   §2.5) for every `LEAD → PERSON/ORGANIZATION` conversion with `autoCreateCase` left at its
   default — negligible against the `maxDuration: 60s` budget, worth naming for the same reason
   ADR 0010 §4 names its own extra write.
4. Appointments booked by this ADR are immediately compatible with ADR 0015's later phases with no
   backfill — `source: 'staff'`, `syncState: 'unsynced'`, both already correct defaults for a
   booking that was never calendar-synced.

---

## 9. What would make these decisions wrong later

| Trigger | Invalidates | What to do |
|---|---|---|
| ADR 0015's availability/public-booking/calendar-sync phases are actually built | D2's reduced route surface | Add the routes ADR 0015 already specifies; no schema change needed (§2.1) — this is the expected, planned trigger, not a surprise |
| A firm asks for self-service client reschedule before availability computation exists | D2's staff-only `PATCH` | Requires building at least a minimal "here are this host's existing bookings, pick a non-overlapping time" check before opening `PATCH` to `client` scope — do not open it without that, or a client could reschedule into a literal double-booking that only the database-level exclusion constraint would catch, as a 409 with no good UI recovery |
| Case-provisioning failures on conversion turn out to be frequent in practice | D5's "report and move on" stance | Add a background retry job (`/jobs/case-provisioning-retry` or similar, `CronSecretGuard`-gated, matching every other scheduled job in this codebase) that scans for `LEAD`-derived clients with no linked case and no explicit `autoCreateCase: false` marker — a real fix, not a redesign of D5's core trade-off |
| A second vertical needs a *different* default location for the client-case link than `verticalAttributes.matter.clientId` | D6's hardcoded key path | This is vertical-specific and belongs in the pack, not core — a pack-declared `caseClientAttributePath` config key would be the additive extension; do not hardcode a second path in core for a second vertical |
| GRC needs an equivalent "auto-open an obligation/case on onboarding conversion" | D5/D6's `LEAD → PERSON/ORGANIZATION` trigger | `EntityType.CASE` is already core-neutral (§1.5) and `caseAttributes` is already opaque — verify this works for GRC's own conversion flow before assuming a redesign is needed; likely just works |

---

## 10. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `appointments` table (migration, contingent on §2.1's collision note) | `DROP TABLE appointments` (only if this ADR's own migration created it, not ADR 0015's) | Every booked appointment is lost. Confirm no `booked`/`rescheduled` row exists for a future date before dropping |
| New appointment routes (§3) | Remove them | None |
| `ConvertEntityDto.autoCreateCase`/`caseAttributes`, the new response fields, and the sequential `createEntity` call in `convertEntity` | Revert `convertEntity` to its pre-ADR body; revert the DTO | **Cases already auto-created remain** — rolling back does not retroactively delete a client's case workspace, matching every other rollback table in this set of ADRs (data created while a feature was live outlives the feature's reversion) |

**Rollback verification:** for the `convertEntity` rollback specifically, confirm the frontend has
been reverted (or was never updated to rely on `caseWorkspace`) **first** — reverting the backend
while a live frontend still reads `caseWorkspace`/`caseProvisioningError` from the response would
silently stop rendering a field the UI depends on, the exact "a merged commit is not a shipped one,
check both sides" caution `CLAUDE.md` §8.1/§9 gives generally.

---

## 11. Implementation briefs

### For Luke (backend)

- **Migration** `1757430000000-AddAppointmentsMinimal.ts` — the full `appointments` table per ADR
  0015 §2.3, **check the ADR 0015 directory/migrations folder immediately before writing this** for
  whether it has already landed; if so, skip this migration entirely and reference ADR 0015's
  instead. `down()` drops the table. **Confirm the `btree_gist` extension availability on the Neon
  control-plane database before relying on the exclusion constraint** — ADR 0015 §2.3 already flags
  this as unconfirmed; if unavailable, fall back to the unique-index alternative it names, and state
  that limitation in this migration's own comment.
- **Entity** `Appointment` in `src/crm/entities/` (or a new `src/appointments/` module — Luke's
  call; ADR 0015 does not mandate a location, since it specifies no feature code either).
  Register in `src/config/entities.ts`.
- **New `AppointmentsService`/`AppointmentsController`**: `create` calls
  `DocumentAccessService.assertOwnsEntity` (or the equivalent generic entity-ownership check —
  confirm the exact shared method name before wiring, do not assume it is exported from
  `DocumentsModule` without checking) before inserting; `update` enforces the status-transition
  table (§2.3/§3) and `expectedVersion` compare-and-set identically to how `TaskService`'s own
  drag-reorder compare-and-set already works (ADR 0014 D4) — read that implementation first rather
  than inventing a new compare-and-set idiom for a third feature.
- **`CrmService.convertEntity`**: add the sequential (never nested) `createEntity` call **after**
  the existing transaction's `commitTransaction()`/`release()` (§2.5) — this ordering is the one
  load-bearing detail in this whole ADR; get it wrong and the deadlock only appears under real
  concurrent load, not in a sequential test run, which is exactly the kind of defect a green unit
  suite will not catch (`CLAUDE.md` §8.2's own caution about DI/concurrency faults applies here).
  Write a concurrency test: N parallel conversions for different leads in the same tenant, assert
  no deadlock and every resulting case gets a distinct `CS-` number.
- **`ConvertEntityDto`**: add the two new optional fields (§3). **Do not add `caseAttributes` to
  the global `ValidationPipe`'s whitelist as a `class-validator`-typed nested DTO** — it is
  deliberately `Record<string, unknown>`/`@IsObject()`, opaque, per §2.6; over-typing it would be
  the 80/20 violation this ADR's whole design exists to avoid.

### For Mira (frontend)

- Lead/client detail page: an "Book appointment" action opens a simple form (host — defaulting to
  the assigned counsellor, date/time, timezone, location kind, notes) and calls `POST /appointments`
  directly — no availability picker (out of scope, §1.2). Appointments render on the existing
  activity timeline (FR-3.13, §2.4) alongside call notes and stage changes, chronologically, with a
  distinct icon/badge — not a separate tab, matching "one chronological activity timeline" as
  written.
- `NewMatterDialog`/`createMatter`'s manual flow is **unchanged and stays available** — this ADR
  adds automatic case creation on conversion; it does not remove the manual path, which is still
  needed for `caseProvisioningError` recovery (§2.5) and for cases opened without a preceding lead
  conversion.
- On the lead→client conversion action, read `caseProvisioningError` from the response and, if
  non-null, surface it clearly ("Client created. Case workspace could not be created automatically:
  {error}. Create it manually.") rather than treating a 200 response as unconditionally successful
  on every count — this is the direct UI consequence of §2.5's stated failure-handling decision,
  and skipping it silently reintroduces the exact "unknown rendered as a positive result" defect
  class this whole product exists to avoid.
- Client portal: no changes required by this ADR's appointments half (client-visible appointment
  read access already covered by `GET /appointments`'s own-scope rule, §2.2) — confirm an
  appointment shows on the client's own case/home view per FR-10.7's spirit, reusing whatever
  existing timeline component already renders acceptance/document history there.
- Five states per definition-of-done: empty (no appointments booked yet for this record), loading,
  error (an overlap conflict on submit — surface it as "that time is no longer available," not a
  raw 409), populated, overflowing (a long-running case with many appointments — the timeline
  already needs to handle this for other event types; confirm appointments do not break that).
