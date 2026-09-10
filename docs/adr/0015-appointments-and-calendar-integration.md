# 0015 — Appointments: Meru owns the booking record; a provider owns only the mirror

**Status:** Proposed — 2026-09-10. Not merged. Requires `secops` (Anton) review — this adds a
`@Public()` write route and a per-**user** encrypted credential store, two of
`definition-of-done.md`'s review triggers — and `quality` (Owen) before anything merges. Luke and
Mira implement against this contract; this document specifies no feature code.

**Scope:** PRD §13 / BC-9, FR-10.1–10.8. Release R2.

---

## 1. Context

### 1.1 There is no appointments surface anywhere in `meru-core`

`grep -ril "appointment" --include='*.ts' src/` returns **zero files** (exit 1, verified
2026-09-10 — and verified *without* wrapping the command in `timeout`, which exits 127 silently
on this host and has already produced two confidently-wrong conclusions in this workspace,
workspace `CLAUDE.md` §14). The only occurrence in `packages/` is
`verticals/immigration.json:102`, a document-type label — "Form 956 — appointment of a
registered migration agent" — which is a different sense of the word.

So this is a green field, not a repair. Nothing has to be kept working.

### 1.2 What exists that looks like appointments, and is not

`GET /tasks/calendar/events` (`src/tasks/task.controller.ts:120-143`) projects **tasks with a
`dueDate` inside a window** as `{id, title, start, end, type: 'task', status, priority}` —
`start` and `end` are the same instant (`task.service.ts:588-597`, with its own comment: "Tasks
are typically all-day or have same start/end"). It is a due-date list rendered on a grid. It is
not a calendar of intervals and cannot become one: `Task` has one timestamp, not two.

`POST /tasks/calendar/sync/:provider` (`task.controller.ts:297-314`) exists and **always 501s**,
with a message that already states this ADR's central credential fact
(`task.service.ts:601-616`):

> "Calendar sync with {provider} is not implemented. Tasks with a dueDate are projected by GET
> /tasks/calendar/events; two-way sync needs a Google/Microsoft OAuth app that has not been
> provisioned."

That route is a **model of the right behaviour** — an honest 501 kept on the surface so the gap
is visible in `/api-json` rather than absent from it — and this ADR keeps it, unchanged, for
task sync (§2.7).

### 1.3 Cal.com on the marketing site is lead-gen, and conflating it would be a category error

`cal.com/immistack-tech/30min` is booked from `www.immistack.com` (Vercel project
`immistack-marketing`). That is a prospective **firm** booking a demo of Meru. FR-10.1 is a
prospective **applicant** booking a consultation with a counsellor at a firm that is already a
customer. Different tenant, different subject, different calendar, different retention basis,
different consent purpose. Workspace `CLAUDE.md` §4 already draws this line for the apps
themselves — "Marketing and product are never the same app" — and it holds here for the same
reason: the marketing site must build and deploy when the API is down, and a booking that creates
tenant data cannot be one of its dependencies.

**Nothing in this ADR touches the marketing site's Cal.com link, and no product surface reads
from it.**

### 1.4 No Google OAuth exists in this repo

- `src/iam/strategies/` contains `jwt.strategy.ts` and `local.strategy.ts`. There is no Google
  strategy.
- `package.json` dependencies contain no `googleapis`, no `google-auth-library`, no
  `passport-google-*`. `AuthProvider.GOOGLE` exists as an enum member on `User`
  (`src/iam/entities/user.entity.ts:17`) with nothing behind it in `src/`.
- PRD OBS-2/OBS-6 record that the live login page offers "Continue with Google". `[UNVERIFIED:
  where that button is served from — it is not implemented in `meru-core`. It is either a
  frontend-only affordance with no backend, or it belongs to the identity work in ADR 0002/0012.
  Confirm before treating Google identity as already available.]`

### 1.5 The serverless envelope, and what it does to "two-way sync" and "1-hour reminder"

One function, `maxDuration: 60`, pool `max: 1`, no held-open connections (workspace `CLAUDE.md`
§10). Every scheduled job is an HTTP route under `/jobs` behind `CronSecretGuard`.

`src/jobs/job-catalogue.ts:30-63` is the cadence table. `TICK_SCOPES` (`:79-83`) splits it: jobs
at ≤ 60 minutes are `fast`, the rest are `daily`. **`CRON_SECRET` is set and the two Vercel crons
are live, but both are scheduled daily** (`0 2 * * *` and `0 3 * * *`), so the `fast` scope has no
driver. Workspace `CLAUDE.md` §12 names the missing piece: an external pinger (Upstash QStash) at
`/api/v1/jobs/tick?scope=fast`.

Consequences that this ADR must state rather than design around:

- **A 1-hour reminder (FR-10.6) is undeliverable until that scheduler exists.** So is a 24-hour
  reminder with any precision better than "some time in the daily window". `scheduled-notifications`
  and `notification-dispatch` are both cadence `1` (`job-catalogue.ts:34-37`) — i.e. `fast` scope
  — so they are in the same position today.
- **Google Calendar push notifications are the wrong mechanism here.** A watch channel is a
  registered HTTPS callback with an expiry (days, not months) that must be renewed by something
  running on a schedule — which is the same missing scheduler, plus a public endpoint, plus
  channel bookkeeping. `POST /webhooks/inbound/:endpointId` is `@Public()` and exists
  (`src/webhooks/webhooks.controller.ts:43-48`), so the seam is there; the renewal is the part
  that has no home.

### 1.6 The precedents this decision is bound by

- **Per-tenant encrypted credentials already have a shape.** `TenantConnector`
  (`src/integrations/entities/tenant-connector.entity.ts:24-51`) stores an AES-256-GCM envelope
  (`{iv, tag, data}`) via `core/crypto/credential-cipher`, unique on `(tenantId, adapterCode)`,
  and never returns the secret — only `hasCredentials`. `ConnectorsService`'s own comment
  (`src/integrations/services/connectors.service.ts:26-45`) explains why AI provider keys reuse
  that table rather than getting their own: "a second table would have duplicated all of it and
  given the platform two places to leak a key from."
- **Honest degradation has a vocabulary.** `CapabilityStatus = 'live' | 'degraded' |
  'unconfigured' | 'unknown'` (`src/health/capabilities.service.ts:35`), and its doc comment is
  explicit that `unconfigured` "is never evidence of a fault, and it must never be reported as
  `live`."
- **`GET /tenants/resolve?host=` already exists** (workspace `CLAUDE.md` §16), returning
  `{slug, name, vertical, logoUrl, branding.colors, matchedBy}` to an anonymous caller and
  nothing else. That is the tenant-resolution primitive a public booking page needs.
- Highest migration timestamp on disk is `1756920000000-AddUserPractitionerCredential.ts`.

---

## 2. Decisions

### 2.1 D1 — Meru models appointments itself. A provider is a mirror, never the system of record.

**Decision.** Appointments are a first-class Meru resource, stored in Meru's own tables, owned by
Meru's own tenancy and audit. Google Calendar (and any later provider) receives a **mirror** of
what Meru decided, and reports back changes that Meru then applies to its own record. If the
provider is unconfigured, disconnected, or down, **booking still works** — with the meeting-link
field honestly empty and the appointment marked `syncState: 'unsynced'`, never silently absent.

**Why not "integrate a provider and hold no record of our own."** Three reasons, in order of how
much they cost to discover late:

1. **FR-10.8 makes a booking a CRM event.** "A booking creates or matches a lead and records the
   source" — that is a write into `universal_entities` under this tenant's RLS, with an audit
   entry. A provider that owns the booking cannot own that; the record has to exist here for the
   lead to attach to.
2. **Regulatory retention and isolation.** A consultation booking carries an applicant's name,
   email, phone and stated visa interest. `CLAUDE.md` §8's north star is "tenant data-isolation
   incidents: 0, ever," and ADR 0017 has to be able to answer "what do we hold about this person
   and under what basis." Data whose system of record is a third-party SaaS account owned by the
   firm is outside both.
3. **Availability is a query over Meru's data.** Counsellor working hours, buffers, and existing
   appointments are the inputs. Asking a provider for them on every availability page load means
   an external round trip inside a 60-second function, per render, with no fallback when the
   provider is unreachable — and an availability page that silently shows *no* slots because an
   API call failed is the "unknown rendered as settled" failure (`CLAUDE.md` §7.3) applied to a
   calendar.

**Why not "build our own calendar sync from scratch either."** We are not writing a CalDAV
client. FR-10.3's two-way sync is a provider integration; §2.5 scopes it narrowly.

### 2.2 D2 — A new core table, **not** a new `EntityType` on `/crm/entities`

**Decision.** New table `appointments`. `EntityType` gains **no** `APPOINTMENT` member.

This is the one decision in this ADR that runs against a rule, so the reasoning has to be
explicit. `CLAUDE.md` §7.5 says there is one generic record resource and that `obligations`,
`breaches` and `cases` are structurally identical — "a record with `status` + `dueDate` +
`assignee` + `stage`". PRD §19 lists Appointment as its own concept but does not say where it
lives.

**An appointment is not that shape. It is an interval, and the load-bearing query is overlap.**

- `UniversalEntity` has exactly one temporal column, `dueDate timestamptz`
  (`src/crm/entities/universal-entity.entity.ts:~167`). There is no `endsAt` and adding one to a
  table where 20 of 20 `EntityType` members do not need it is a worse trade than a purpose-built
  table.
- Putting `start`/`end` in `verticalAttributes` puts them in jsonb — and the entity's own comment
  block (`:157-165`) states the rule this would break: "a jsonb predicate cannot use an index the
  way a column can," which is precisely why `status`/`dueDate`/`assignedTo` were promoted in the
  first place. Availability is a range scan; it is the single hottest read this feature has.
- **Double-booking can only be prevented at the database level**, with a Postgres exclusion
  constraint over a `tstzrange` (§2.3). There is no way to express that against a jsonb key.
  Enforcing it in application code means read-then-write on a `max: 1` pool with concurrent
  invocations — the exact defect ADR 0010 §1.2 exists to name.

**And it is not an 80/20 violation.** §7.1 forbids *vertical vocabulary* in core — visa
subclasses, checklists, stage names. "A scheduled interval between a host and a subject, with a
location or a link" is vertical-neutral: a GovernanceX bank books a compliance review with the
same shape. The label ("Consultation", "Counsellor") comes from the pack, as §7.6 requires. What
this ADR adds to core is a *shape both verticals have*, which is the same justification ADR 0010
§2.3 gives for `EntityType.CASE` being core-neutral.

**The appointment still links into the generic record model**, by the same unenforced-reference
pattern `Task` already uses (`task.entity.ts:74-80`: `entityId` + `entityType`, no FK, so a
record's history survives a deprovisioned reference).

### 2.3 D3 — Schema

Three tables. All `ENABLE` **and** `FORCE` RLS with a `tenant_isolation` policy **at creation**,
following `1756700000000-AddTenantFeeOverrides.ts:46-59` exactly — never retrofitted.

**`appointments`** — the booking record.

```sql
CREATE TABLE "appointments" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      uuid NOT NULL,
  "hostUserId"    uuid NOT NULL,            -- the counsellor. users.id, no FK (see Task.entityId)
  "entityId"      uuid,                     -- the lead/person this is about (FR-10.7, FR-10.8)
  "entityType"    varchar(50),
  "subjectEmail"  varchar,                  -- normalised lower/trim, as CrmService does
  "subjectName"   varchar,                  -- as GIVEN AT BOOKING; never re-read from the record
  "subjectPhone"  varchar,
  "startsAt"      timestamptz NOT NULL,
  "endsAt"        timestamptz NOT NULL,
  "timezone"      varchar(64) NOT NULL,     -- IANA, the zone the booking was MADE in (display)
  "status"        varchar(24) NOT NULL DEFAULT 'booked',
                  -- booked | rescheduled | cancelled | completed | no_show
  "locationKind"  varchar(16) NOT NULL,     -- video | in_person | phone
  "locationText"  text,                     -- office address, for in_person
  "meetingUrl"    text,                     -- NULL is "no link", never rendered as "join here"
  "source"        varchar(32) NOT NULL,     -- portal | public | staff | import   (FR-10.8)
  "notes"         text,                     -- staff notes. NOT visible to the subject
  "cancelReason"  text,
  "reminderPlan"  jsonb NOT NULL DEFAULT '[]',   -- [{offsetMinutes, channel}] (FR-10.6)
  "remindersSent" jsonb NOT NULL DEFAULT '[]',   -- [{offsetMinutes, sentAt, notificationId}]
  "providerRef"   jsonb,                    -- {provider, calendarId, eventId, etag}
  "syncState"     varchar(16) NOT NULL DEFAULT 'unsynced',
                  -- unsynced | pending | synced | failed   (never silently "synced")
  "syncError"     text,
  "version"       integer NOT NULL DEFAULT 0,     -- same compare-and-set token as ADR 0014 D4
  "createdBy"     uuid,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_appointments_interval" CHECK ("endsAt" > "startsAt")
);

CREATE INDEX ON "appointments" ("tenantId", "hostUserId", "startsAt");
CREATE INDEX ON "appointments" ("tenantId", "startsAt");
CREATE INDEX ON "appointments" ("tenantId", "entityId");
CREATE INDEX ON "appointments" ("tenantId", "subjectEmail");

-- Double-booking is refused by the database, not by a service.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "appointments" ADD CONSTRAINT "EXCL_appointments_host_overlap"
  EXCLUDE USING gist (
    "tenantId"   WITH =,
    "hostUserId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  ) WHERE ("status" IN ('booked', 'rescheduled'));
```

> `[UNVERIFIED: that `btree_gist` can be created on the Neon control-plane database from the
> migration/owner connection. It is a standard contrib extension and `MigrateService` already
> installs `uuid-ossp` and `pgcrypto` the same way (`src/jobs/migrate.service.ts:76-77`), so the
> mechanism is proven; only this specific extension is unconfirmed from this session. **Confirm
> before writing the migration.** If it is unavailable, the fallback is a unique index on
> `("tenantId","hostUserId","startsAt")` — which prevents identical starts but not overlaps, and
> that difference must then be stated in the API docs rather than glossed.]`

**`appointment_availability`** — a counsellor's working hours, per weekday, in their office's zone.

```sql
CREATE TABLE "appointment_availability" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"      uuid NOT NULL,
  "userId"        uuid NOT NULL,
  "weekday"       smallint NOT NULL,        -- 0=Sunday .. 6, in "timezone" below
  "startMinute"   smallint NOT NULL,        -- minutes from local midnight
  "endMinute"     smallint NOT NULL,
  "timezone"      varchar(64) NOT NULL,     -- IANA. THE OFFICE's zone, not the browser's
  "slotMinutes"   smallint NOT NULL DEFAULT 30,
  "bufferBeforeMinutes" smallint NOT NULL DEFAULT 0,
  "bufferAfterMinutes"  smallint NOT NULL DEFAULT 0,
  "effectiveFrom" date, "effectiveTo" date,
  "active"        boolean NOT NULL DEFAULT true,
  CONSTRAINT "CHK_availability_window" CHECK ("endMinute" > "startMinute")
);
CREATE INDEX ON "appointment_availability" ("tenantId", "userId", "weekday");
```

**Why local minutes plus an IANA zone, and not a `timestamptz` range.** "Priya works 9–5 Sydney
time" is a wall-clock rule; the UTC instants it maps to move twice a year. Storing the rule as
instants means DST silently shifts a counsellor's working day by an hour, in the direction that
makes an out-of-hours booking look legal. Storing local minutes + IANA zone and expanding to
instants at query time is the only representation that survives a DST boundary. `User.timezone`
already exists (`src/iam/entities/user.entity.ts:61`) and is the sensible default when a rule is
created, but it is **not** authoritative here — FR-10.2 says "per office timezone," and a
counsellor can work a different office's hours. There is no `offices` concept in core and this
ADR does not invent one; the zone lives on the rule.

**`appointment_blocks`** — one-off unavailability (leave, a blocked morning). Same shape as
`availability` but an absolute `tstzrange` and no weekday. Kept separate rather than folded in,
because a recurring rule and a one-off exception are queried differently and merging them
produces a table where half the columns are always null.

**`user_calendar_links`** — a per-user provider connection (§2.5). Separate from
`tenant_connectors` for one reason: that table is unique on `(tenantId, adapterCode)` and its
credential belongs to the **tenant**. A calendar refresh token belongs to a **user**, and putting
a user's token under a tenant key would make one counsellor's grant serve everyone's calendar.
It **reuses `core/crypto/credential-cipher`** — the same AES-256-GCM envelope, the same
never-return-the-secret rule, the same `hasCredentials` flag — because the argument in
`connectors.service.ts:26-45` against a second leak surface is about the *cipher*, not the table.

```sql
CREATE TABLE "user_calendar_links" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"     uuid NOT NULL,
  "userId"       uuid NOT NULL,
  "provider"     varchar(32) NOT NULL,          -- 'google' today
  "calendarId"   varchar(255),
  "credentials"  jsonb,                         -- {iv, tag, data} — never returned by the API
  "syncToken"    text,                          -- Google incremental sync cursor
  "lastSyncedAt" timestamptz,
  "status"       varchar(16) NOT NULL DEFAULT 'unconfigured',
                 -- unconfigured | connected | revoked | error   (never silently "connected")
  "statusReason" text,
  "createdAt"    timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_user_calendar_links" UNIQUE ("tenantId", "userId", "provider")
);
```

### 2.4 D4 — Routes, and who may reach them

| Route | Who | Notes |
|---|---|---|
| `GET /appointments` | staff/`firm_admin` (tenant scope); `client` (own scope) | `own` scope = `subjectEmail` matches the caller's email, mirroring `CrmAccessService.ownsEntity` (`crm-access.service.ts:82-100`). **`notes` is stripped for `own` scope** — it is the staff file note, the same distinction `CrmAccessService.mayReadInternalNotes` (`:202-204`) already draws |
| `GET /appointments/:id` | as above | 404, not 403, for an appointment the caller may not read — matching the `/payments`, `/documents` and `/crm/entities` precedent |
| `GET /appointments/availability` | staff; `client`; **and `@Public()` with `?host=`** | Returns free slots only. See below |
| `POST /appointments` | staff | Books on a subject's behalf |
| `POST /appointments/public` | `@Public()` | The website booking (FR-10.1). See below |
| `PATCH /appointments/:id` | staff; `client` for their own **reschedule/cancel only** (FR-10.5) | Carries `expectedVersion`; a mismatch is **409 `MER-RES-0005`**, the same compare-and-set contract ADR 0014 D4 establishes for tasks. Two people rescheduling one consultation is the same problem as two people dragging one card |
| `PUT /appointments/availability` | `firm_admin`, and a `staff` user for **their own** rules | Complete desired state per `(userId)`, not a delta — the same reasoning `UpdateEntitlementsDto` and ADR 0009 §2.4 give: "remove this rule" must be expressible |
| `POST /appointments/calendar/connect/:provider` | staff, self only | Starts OAuth. 503 `unconfigured` when the platform credentials are unset (§2.6) |
| `DELETE /appointments/calendar/:provider` | staff, self only | Revokes and clears the envelope |

**The two public routes are the sharpest edge in this ADR.**

- They resolve the tenant from `?host=` via the existing `GET /tenants/resolve` logic — **never
  from a `tenantId` in the body**, which would be a cross-tenant write primitive handed to the
  internet.
- `GET /appointments/availability` public form returns **only** `[{startsAt, endsAt}]` for a
  named `hostUserId` or for "any counsellor". It must never return who is busy, why, or with
  whom. Free/busy is already a disclosure; the reason for busy is a much larger one.
- `POST /appointments/public` needs rate limiting and abuse controls, and **this is the same
  unresolved dependency DEF-1 has**: `express-rate-limit` is in `package.json` and `api/index.js`
  gained a limiter for `/auth/*` (workspace `CLAUDE.md` §16), but a durable, distributed limiter
  is ADR 0004's Upstash work, unprovisioned. **Ship the public booking route only with a limiter
  in `api/index.js` covering it** — the Vercel entrypoint, not `src/main.ts`, because
  `api/index.js` is what Vercel actually serves and that exact gap has already shipped once.
- The public route creates or matches a `lead` (§2.8) and therefore writes tenant data from an
  unauthenticated request. Anton's review is required specifically on this route.

### 2.5 D5 — Google Calendar sync: one-way-out immediately, poll-based two-way, `syncState` never lies

**Decision.** Sync is **poll-based via Google's incremental `syncToken`**, driven by a new job
`calendar-sync` at cadence **15 minutes** in `JOB_CADENCE_MINUTES` (`src/jobs/job-catalogue.ts:30`),
which places it in `TICK_SCOPES.fast`. Push channels are rejected (§3).

Direction of authority, stated once so it is never ambiguous:

- **Meru → Google, on every write.** Booking, reschedule and cancellation push to the host's
  connected calendar synchronously, best-effort, inside the request. A failure sets
  `syncState: 'failed'` + `syncError` and **does not fail the booking** — the appointment is
  real, the mirror is stale, and the record says so.
- **Google → Meru, on the sweep.** A change to a Meru-created event (time moved, event deleted)
  is applied to the Meru row and raises a notification to the host, because a counsellor who
  drags a consultation in Google Calendar reasonably expects it to have moved.
- **Events Google owns that Meru did not create** are read into the **busy set** for availability
  and nothing else. They never become `appointments` rows. A counsellor's dentist appointment is
  not a Meru record, must not be stored as one, and must not have its title read into the
  tenant's database.

`syncState` starts `unsynced` and only ever becomes `synced` on a confirmed provider response
carrying an event id. There is no path from "we tried" to `synced`. This is the
`CapabilityStatus` discipline (`capabilities.service.ts:23-35`) applied to a row instead of a
deployment.

**A new dependency is required and it is gated.** A Google API client (`googleapis` or a hand-
rolled REST client) enters the require graph. `npm run check:cjs` is a deploy gate and **one
ESM-only package in that graph is `FUNCTION_INVOCATION_FAILED` on every route** (workspace
`CLAUDE.md` §9). Whichever client is chosen must pass `check:cjs` **before** any other work
starts — this is a five-minute check that, skipped, costs a production outage.

### 2.6 D6 — What this needs that does not exist, stated plainly

| Missing | Consequence if it stays missing | Owner |
|---|---|---|
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (a Google Cloud project with the Calendar API enabled and a verified OAuth consent screen) | `POST /appointments/calendar/connect/google` answers **503 naming the missing vars**, exactly as `StorageService` does (`storage.service.ts:120-143`). Every appointment stays `syncState: 'unsynced'`. **Booking, availability, reschedule, cancel and notes all still work.** FR-10.3 is the only requirement blocked | Operator |
| An external scheduler at `/api/v1/jobs/tick?scope=fast` (Upstash QStash, per ADR 0004) | `calendar-sync` runs at most once a day, so Google→Meru changes are up to 24h stale. **FR-10.6's 1-hour reminder cannot be delivered at all**, and the 24-hour reminder degrades to "some time in the daily window." This is not specific to appointments — `scheduled-notifications` and `notification-dispatch` are already in this position (`job-catalogue.ts:34-37`) | Operator / Jonas |
| `RESEND_API_KEY` + a verified sender | Confirmations, reminders, reschedule and cancellation notices **record and never arrive** (workspace `CLAUDE.md` §12). A booking confirmation that does not arrive is worse than no booking flow, because the applicant believes they have an appointment | Operator |
| A durable rate limiter for `POST /appointments/public` | Ship the route behind an in-process limiter in `api/index.js` and accept that it is per-instance; **or do not ship the public route in R2** and start with portal-only booking (FR-10.1's second half). Both are defensible; shipping an unlimited public write is not | Operator decides |
| Zoom OAuth app | Zoom links are not generated. `locationKind: 'video'` with no `meetingUrl` renders as "link to follow", never as a join button. §3 rejects building Zoom in R2 | deferred |

**Google Meet costs nothing extra.** A Meet link is produced by the same Calendar `events.insert`
call (`conferenceData`), so FR-10.4's video half is satisfied by the Google integration alone.
That is the reason to do Google first and Zoom not at all in R2.

### 2.7 D7 — `POST /tasks/calendar/sync/:provider` stays a 501, and stays where it is

**Decision.** No change to `task.controller.ts:297-314` / `task.service.ts:601-616`. Task-to-
calendar sync is a different feature (projecting due dates into a calendar) from appointment sync
(mirroring intervals), and the 501 is doing its job: it is visible in `/api-json`, it names the
missing OAuth app, and it does not pretend.

Once `user_calendar_links` exists it becomes *possible* to also push due-dated tasks into the
same calendar. That is a follow-up decision with its own trade-off (a firm may not want fifty
task deadlines in a counsellor's calendar), and it is not made here.

### 2.8 D8 — FR-10.8: a booking creates or matches a lead, by `subjectEmail`, and never overwrites

**Decision.** On `POST /appointments` and `POST /appointments/public`, the service:

1. Normalises the subject email (`trim().toLowerCase()` — the same normalisation
   `CrmService` applies at `crm.service.ts:249-250`).
2. Looks for a live `universal_entities` row in this tenant with a matching `email` **or**
   `subjectEmail`, of type `LEAD`, `PERSON` or `ORGANIZATION`.
3. **Match found:** links the appointment (`entityId`, `entityType`) and writes **nothing** to the
   matched record. Not the name, not the phone, not the source. A booking form is a weaker source
   of truth than a caseworker's own data entry, and a "helpful" overwrite of a client's phone
   number from a form a stranger filled in is a data-integrity incident waiting to happen.
4. **No match:** creates an `EntityType.LEAD` with `firstName`/`lastName`/`email`/`phoneNumber`
   populated **on the promoted columns** — this is ADR 0011 D1's producer contract, and a booking
   is a new producer, so it is bound by it. `verticalAttributes.lead.source` records the booking
   source. A lead draws no `recordNumber` (ADR 0010 §2.1); one is claimed on conversion.
5. Records the appointment on the record's timeline (FR-10.7) as a comment/timeline event, with
   `internal: false` for the fact of the appointment and `internal: true` for staff notes —
   `CrmCommentService`'s existing distinction (`comment.service.ts:100`), not a new one.

**Name handling.** `appointments.subjectName` holds the name **as given at booking**, and the UI
renders that on the appointment. It is never re-read from the linked record and never written
back to it. The two can therefore disagree, visibly, which is the honest outcome: "the person who
booked said X; the record says Y" is information, and silently picking one is not.

### 2.9 D9 — Migration

`1757100000000-AddAppointments`. One migration: `btree_gist`, three tables (plus
`appointment_blocks`), indexes, the exclusion constraint, and **`ENABLE` + `FORCE` RLS with a
`tenant_isolation` policy on each**, copied structurally from
`1756700000000-AddTenantFeeOverrides.ts:46-59`. Registered in `ALL_MIGRATIONS`
(`src/config/migrations.ts:55`) **in the same commit**.

`npm run rls:verify` must be run against this migration specifically — four new tenant-scoped
tables is the largest single addition since `AddPayments`, and workspace `CLAUDE.md` §8 is
explicit that "RLS is on" is never trusted without it.

`user_calendar_links` carries a credential envelope. Anton should confirm it appears in whatever
inventory tracks secret-bearing tables alongside `tenant_connectors`.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| Cal.com (or Calendly) as the system of record for consultations | FR-10.8 requires the booking to create tenant CRM data under this tenant's RLS and audit; a booking owned by a firm's own SaaS account is outside Meru's isolation model and outside ADR 0017's ability to answer "what do we hold about this person." Also conflates the marketing demo funnel with the product (§1.3) |
| Cal.com self-hosted, embedded | Solves the data-residency half and none of the others, and adds a second application, a second database and a second auth model to operate — against a serverless deployment that runs one function |
| `EntityType.APPOINTMENT` on `/crm/entities` | An interval cannot be indexed or overlap-constrained through `verticalAttributes`, and `UniversalEntity` has one temporal column. Double-booking prevention would move from a database constraint to a read-then-write in application code on a `max: 1` pool (§2.2) |
| Add `endsAt` to `UniversalEntity` so appointments fit the generic model | Adds a column that 20 of 20 existing entity types do not use, to avoid a table that four tables' worth of appointment machinery needs anyway. The generic-record rule exists to stop *vertical* tables (`/cases`, `/leads`), not to forbid a second vertical-neutral primitive |
| Google Calendar **push** notifications (watch channels) | Channels expire in days and must be renewed on a schedule — the same missing `fast` scheduler (§1.5) — plus channel bookkeeping and a public callback. Polling with `syncToken` has one moving part and degrades to "stale" rather than to "silently stopped." Revisit when QStash exists (§5) |
| Provider as the source of availability (query Google free/busy per page load) | An external call inside a 60s function on every availability render, with no fallback; a failed call renders an empty calendar, which reads as "fully booked" (`CLAUDE.md` §7.3) |
| Store working hours as `timestamptz` ranges | DST silently shifts a counsellor's working day, in the direction that makes out-of-hours bookings look legal (§2.3) |
| Working hours in the config pack | They are per-user tenant data, not vertical vocabulary — the same distinction ADR 0009 §2.4 draws for `firm_professional_482`: a firm's own operating detail is tenant data that happens to be shaped like configuration |
| Reuse `tenant_connectors` for calendar credentials | Unique on `(tenantId, adapterCode)`; a calendar token is per-user, and keying it by tenant makes one counsellor's grant serve every counsellor's calendar (§2.3) |
| Zoom in R2 | A second OAuth app, a second consent screen, a second set of credentials, for a capability Google Meet already provides free with the calendar insert (§2.6) |
| Overwrite the matched lead's name/phone from the booking form | A stranger-completed form is a weaker source than a caseworker's entry; silent overwrite is a data-integrity incident with no audit reason attached (§2.8) |
| Ship `POST /appointments/public` with no rate limit "for now" | An unauthenticated tenant-data write with no limiter is DEF-1's shape. Either limit it or ship portal-only booking first (§2.6) |

---

## 4. Consequences

1. **Four new RLS-carrying tables and a new Postgres extension.** Run `npm run rls:verify` after
   this migration specifically. `btree_gist` is a `CREATE EXTENSION` on the owner connection and
   must be confirmed available on Neon before the migration is written (§2.3).
2. **A new `@Public()` write route exists** if the public booking half ships. That is a genuinely
   larger attack surface than anything this ADR's other routes add, and it is why Anton's review
   is a gate rather than a courtesy. `POST /auth/register` was **removed** rather than repaired
   for a related reason (workspace `CLAUDE.md` §16) — a public route that provisions tenant data
   is exactly the shape that went wrong there, and the mitigation here is that the tenant comes
   from host resolution and the created record is a lead, not a user.
3. **A new job (`calendar-sync`) lands in `TICK_SCOPES.fast`, which has no driver.** It will
   report clean daily runs and be up to 24 hours stale. `GET /jobs/status` will say it ran. That
   is the same shape as the 34 hours of dead notification dispatch workspace `CLAUDE.md` §9
   records — so `calendar-sync` must report `lastSyncedAt` per link, and the UI must render a
   stale link as stale, not as connected.
4. **Every appointment surface must render `syncState` and `meetingUrl: null` honestly.** "No
   link yet" is not "join here", and `unsynced` is not "in your Google Calendar." This is
   §7.3 applied to a feature whose whole value proposition is that the appointment is really
   in the counsellor's calendar.
5. **A new npm dependency enters the serverless bundle** and must pass `check:cjs` (§2.5).
6. **Reminders inherit an existing gap rather than creating one.** FR-10.6 is not deliverable at
   1-hour precision today and will not be until the external scheduler exists. Do not build
   reminder UI that offers a 1-hour option while it cannot fire — offer what the platform can
   actually do, and say why the rest is greyed out.
7. **`appointments.notes` is staff-only and must be stripped in `own` scope** at the service, not
   the controller. This is the sixth resource to which that rule applies; the five before it were
   each found as a defect after shipping (workspace `CLAUDE.md` §8).

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| The external `fast` scheduler (QStash) is provisioned | Nothing here is invalidated — but D5's 15-minute poll becomes real rather than nominal, and FR-10.6's 1-hour reminder becomes deliverable | Re-evaluate push channels at that point: the renewal job now has a home, and push would cut sync latency from 15 minutes to seconds |
| A firm needs true multi-office scheduling — several physical offices, each with its own zone, hours and rooms | D3's "timezone lives on the availability rule; there is no `offices` concept" | An `offices` table with a zone and an address, referenced by `availability` and by `appointments.locationText`. Additive; does not change the interval model |
| Room or resource booking is needed (a meeting room, not just a person) | D3's exclusion constraint, which keys on `hostUserId` | Generalise the constraint's second column to a `resourceKind`/`resourceId` pair rather than adding a second overlapping constraint |
| Two-way sync with Microsoft 365 is required | D5's Google-specific `syncToken` and `providerRef` | `user_calendar_links.provider` already anticipates this; the sync cursor is provider-shaped, so the service needs a per-provider adapter behind one interface — the same shape `StorageDriverRegistry` already uses for S3/Supabase |
| A regulator or a firm requires that consultation content (not just the booking) be retained or recorded | Nothing in this ADR — but it becomes an ADR 0017 question about basis, retention and consent, not a scheduling one | New ADR, and note that recording a consultation is a separate consent purpose under ADR 0017 D1 |
| Booking volume makes the synchronous Meru→Google push a latency problem in the request | D5's "push on every write, best-effort, inside the request" | Move the push to the `calendar-sync` sweep by marking rows `pending` — the `syncState` vocabulary already has the value, deliberately |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `AddAppointments` migration (4 tables + `btree_gist` + exclusion constraint) | `DROP TABLE "appointment_blocks","appointment_availability","user_calendar_links","appointments"` — in that order. **Leave `btree_gist`**: dropping an extension another migration may later depend on is a wider action than this rollback | **Every booked appointment is destroyed**, including future ones an applicant has been told about. Do not roll this back once any real booking exists; roll back the *routes* instead and leave the tables |
| `POST /appointments/public` + `GET /appointments/availability` public form | Remove the two routes | None. **This is the half to roll back first if anything goes wrong** — it is the only unauthenticated surface, and removing it leaves staff booking fully working |
| Google connect/disconnect routes + `calendar-sync` job | Remove the routes; remove `calendar-sync` from `JOB_CADENCE_MINUTES` | Stored refresh tokens remain encrypted in `user_calendar_links` and are then unreachable. **Revoke them at Google before rolling back**, or a token nobody can see stays valid |
| Lead creation on booking (D8) | Revert the commit | Leads created while it was live remain, correctly populated per ADR 0011 D1 — reverting does not blank them |
| `calendar-sync` entry in `job-catalogue.ts` | Remove the key | `job_runs` rows naming a job that no longer exists remain, harmlessly — the same stance ADR 0010 §2.6 takes for a soft-deleted tenant's counter rows |

**Rollback verification.** Before dropping `appointments`, export it — the booking record is the
only place a cancelled-and-rebooked history exists, and no audit row reconstructs a calendar.

---

## 7. Open items for implementers

| # | Item | Owner |
|---|---|---|
| 1 | Confirm `CREATE EXTENSION btree_gist` succeeds on the Neon control-plane database before writing the migration (§2.3) | Jonas |
| 2 | Confirm the chosen Google client passes `npm run check:cjs` **before** any other work (§2.5) | Luke |
| 3 | Decide: ship `POST /appointments/public` in R2 with an in-process limiter, or portal-only booking first (§2.6) | Operator |
| 4 | Resolve where "Continue with Google" on the live login page is served from — it is not in `meru-core` (§1.4) | Jonas |
| 5 | Review of the two `@Public()` routes: host-resolution only, free/busy only, no cross-tenant write primitive (§2.4) | Anton |
| 6 | `npm run rls:verify` against the four new tables specifically | Anton |
| 7 | Isolation spec: a second `client` token requesting another applicant's appointment id gets **404**, and `notes` never appears in an `own`-scope response (§4 item 7) | Owen |
| 8 | Register `AddAppointments1757100000000` in `ALL_MIGRATIONS` in the same commit | Luke |
| 9 | Appointment UI must render `syncState` and a null `meetingUrl` honestly; no 1-hour reminder option while the `fast` scheduler is absent (§4 items 4 and 6) | Mira |
| 10 | Pack: `navigation[]` entry for Appointments, per portal, so the surface is pack-driven and not hardcoded (`CLAUDE.md` §7.6) | Luke |
