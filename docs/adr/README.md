# Architecture Decision Records

There was no ADR directory in this repo before 2026-09-03. This proposes the convention.

## Naming

`NNNN-kebab-case-title.md`, zero-padded to four digits, allocated in order. Never renumber
a merged ADR — a stale link to `0007` must not resolve to a different decision.

> **0008 is the one exception, and the reason for this rule.** `0008-vac-payment-integrity.md`
> was drafted as `0001` on a since-superseded branch (`fix/crm-entity-actor-scoping`) that never
> reached `main`, in parallel with an unrelated `0001-practice-role-tags.md` that did. It was
> rescued and renumbered to `0008` on merge into `main` rather than left to collide — see its
> own rescue note. It was never published under `0001` anywhere a link could have formed, which
> is why this was safe to do once and must not be repeated.

## Required sections

1. **Status** — Proposed | Accepted | Implemented | Superseded by NNNN. Dated.
2. **Context** — what forced the decision, with `file:line` or an `/api-json` path for
   every load-bearing claim. Anything unverified is marked `[UNVERIFIED: <thing>]` inline.
3. **Decision** — one sentence per decision, then the detail.
4. **Options rejected** — and why. The rejected option is the part future readers need.
5. **Consequences** — including the unpleasant ones.
6. **What would make this wrong later** — the trigger to revisit. Without this it is a
   record, not a decision.
7. **Rollback** — in this document, not a separate one.

## Scope

An ADR belongs here when the decision is expensive to reverse: schema, tenancy, auth,
anything on a public API, anything touching the pack contract. Decisions that span
`meru-core`, `packages/config-packs` and a frontend app live here because the pack and the
core both live in this repo; the frontend app docs link to the ADR rather than restating it.

## Index

Verified against `docs/adr/` on disk, 2026-09-10.

| # | Title | Status | Owner |
|---|---|---|---|
| [0001](0001-practice-role-tags.md) | Practice roles as additive vertical tags on `User` | **Accepted** — executable contract | Kyle (architect); implementation Luke; gate Owen |
| [0002](0002-neon-auth-federation.md) | Neon Auth federation (post-pilot) | Proposed — 2026-09-05, not merged | Requires `secops` (Anton) + `quality` (Owen) review |
| [0003](0003-ai-provider-abstraction.md) | Platform AI provider abstraction, and three agentic features | Proposed — 2026-09-05, not merged | Requires `quality` (Owen), and `secops` (Anton) for the audit/citation write path |
| [0004](0004-upstash-redis-qstash.md) | Upstash Redis (REST) for rate limiting, revocation and idempotency; QStash as the minute scheduler | Proposed — 2026-09-05, not merged | Requires `quality` (Owen); `secops` (Anton) for revocation/idempotency |
| [0005](0005-communications-thread-scoping.md) | Communications thread scoping: ratify what shipped, close what did not | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0006](0006-operator-invite-link.md) | Operator invite-link retrieval and regeneration | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0007](0007-operator-console-and-record-lifecycle-contracts.md) | Operator console and record-lifecycle contracts | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0008](0008-vac-payment-integrity.md) | VAC and payment integrity (ImmiStack Tier 1.1–1.4) | **Implemented** (core) — `vacStatus`, `vacSettlementMode`, field-level immutability, first `rules[]` entry and the `BackfillVacStatus` migration are on `main` and applied to production. Card-authority/PAN redaction (§4.3) and the duty floor (§4.5) not found in `src`/`packages` as of 2026-09-08 — still open | Rescued from a superseded branch; not formally re-gated by Owen against this document |
| [0009](0009-operator-console-and-tenant-lifecycle.md) | Operator console, tenant lifecycle, and fee-schedule contracts | Proposed — 2026-09-08, not merged | Adopts 0007 D2 (tenant deletion) and D7 (documents/job-run) rather than re-deciding them; adds operator entitlements and runtime fee overrides. Requires `quality` (Owen) + `secops` (Anton) |
| [0010](0010-client-and-case-numbering.md) | Client and case numbering (FR-4.10, FR-5.4) | **Backend implemented, uncommitted** — 2026-09-10. Not merged, not deployed | `recordNumber` + `tenant_record_counters` + the atomic claim, with a concurrency spec. **One extension beyond the ADR text:** `ImportService.commit` numbers its rows too (a third producer the ADR does not name) — Kyle to confirm. `generateInvoiceNumber`'s race untouched, per §1.2. Frontend read sites (§7 item 6) are Mira's, not done. Requires `quality` (Owen) + `secops` (Anton) |
| [0011](0011-record-identity-and-unnamed-client-contract.md) | Record-identity contract: producers, guarantees, and the "unnamed client" renderer (FR-4.9) | **Server half implemented, uncommitted** — 2026-09-10. Frontend half NOT started | D3 (pack-load rejection) and D4's search-index title chain are in. **D1's `leads.service.ts` lift and D4's ten render sites are Mira's and are the half that actually stops new unnamed records.** D5 produces no code by design. Requires `quality` (Owen) + `secops` (Anton) for the pack-loader rejection path |
| [0012](0012-better-auth-adoption.md) | Better Auth: decline replacement, defer partial adoption behind the ADR 0002 seam | Proposed — 2026-09-10, not merged | Corrects two of 0002's `[UNVERIFIED]` items; freezes the `scopeOf` contract as a written invariant. Requires `secops` (Anton) + `quality` (Owen) |
| [0013](0013-immistack-vertical-database.md) | ImmiStack's own database: what stays on the control plane, and what has to be true before `forVertical()` is activated | Proposed — 2026-09-10, not merged | Blocks activation on a Neon repoint; `audit_logs` never splits. Requires `secops` (Anton) + `quality` (Owen) |
| [0018](0018-scheduled-job-tenant-context-and-scope-evidence.md) | Scheduled jobs: system-context tenancy (`runTenantBoundSweep`), scope evidence in `job_runs`, automated-actor attribution | Proposed — 2026-09-16, not merged | Seven of the eight jobs named in `NEXT-SESSION.md` §2c actually need the fix — `regulatory-radar` touches no tenant data. Requires `quality` (Owen) + `secops` (Anton) |
| [0019](0019-firm-editable-document-templates.md) | Firm-editable document templates (FR-6.15–6.18, FR-6.22): tenant overrides on top of pack templates, `firmEditable`/`locked` pack fields protecting statutory content, never a replacement of the pack | Proposed — 2026-09-17, not merged | Two new RLS tables (`tenant_document_templates`, `tenant_document_template_versions`); no loader key-list change (`documentTemplates` already declared). Requires `quality` (Owen) + `secops` (Anton) |
| [0020](0020-document-send-for-assent.md) | Document send-for-assent (FR-6.19–6.21, E13/E14): `draft → sent → viewed → accepted \| declined \| cancelled` wrapped around the existing `AcceptanceService`/`isSignature: false` record, per operator decision PD-3 | Proposed — 2026-09-17, not merged | New RLS table `document_send_requests`; reuses `PaymentsService.resolveClientUserId` across module boundary — confirm no `BillingModule`↔`DocumentsModule` cycle before wiring. The own-scope check on `/view`/`/accept`/`/decline` is this set's highest-risk item (sixth instance of the recurring client-isolation defect class if missed). Requires `quality` (Owen) + `secops` (Anton) |
| [0021](0021-client-payments-stripe-connect.md) | Client payments via Stripe Connect Standard (FR-7.1–7.16, E4/E20/E21): direct charges into the firm's own connected account, zero platform fee pending BRD D-2, BECS listed first for AU tenants, `government`-`feeKind` payments always refused a checkout link | Proposed — 2026-09-17, not merged | New RLS table `tenant_merchant_accounts`; new `MER-BILL-*` error family (first use — none existed before this ADR); second Stripe webhook endpoint (`/billing/webhook/connect`, separate signing secret from the existing subscription webhook). Builds against unset `STRIPE_*` keys, fails closed with a 503 exactly as `/billing/checkout` already does. Requires `quality` (Owen) + `secops` (Anton) — mandatory, first ADR in this repo that triggers real money movement rather than recording it |
| [0022](0022-minimal-appointments-and-auto-case-on-convert.md) | Minimal appointments on the record timeline (E10) + auto-case-provisioning on lead conversion (E12, FR-4.6) | Proposed — 2026-09-17, not merged | **Adopts ADR 0015 §2.2–2.3's `appointments` schema verbatim** rather than redesigning it — if ADR 0015 merges first, this ADR's own migration is a no-op and should be dropped, not run twice (see its own §2.1 collision note). Case auto-creation runs in a **second, sequential** transaction after `convertEntity` commits — nesting it would deadlock the `max: 1` connection pool. Requires `quality` (Owen) + `secops` (Anton) |
| [0023](0023-neon-better-auth-federation-rollout-and-control-centre.md) | Neon-managed Better Auth by federation: rollout (`AUTH_NEON_MODE` `off`/`link`/`enforce`), linking by `users.authSubject` via a Meru-minted single-use token (never by email alone), single-use Neon JWT exchange, and the Control Centre operator routes (`GET /platform/users`, operator invite, unlink) | Proposed — 2026-11-17, amended the same day after review, not merged. **Owen: FIX** (D10 SAML text vs code) — applied. **Anton: APPROVE WITH CONDITIONS** (eleven) — applied as decisions; most still outstanding in code, see its §11. **Owen final gate: FIX** (stale against code) — applied in a second amendment, which adds **D13** (impersonation attribution on every audit entry via the tenancy context; Anton reviews), **D14** (invites move to the strict audit path) and **D8.4** (operator MFA reset, proposed, with an interim procedure). **Third amendment 2026-11-17:** **Owen: FIX** (consistency with code: fact-named rows written before the change in D14/D8.4, D8.4's 409 classified as `write_failed`, stale "this round" markers) — applied. **Anton: APPROVE WITH CONDITIONS** on D13, D14, D8.4 and the gate-zero scope (D13.C1–C7, D14.C1–C4, D8.4.C1–C7, G0.C1, AC.C1–C3), **REJECT** of best-effort outcome rows as an end state — applied; adds **D15** (request → change → outcome with `changeId`, a reconciler, a per-tenant chain lock, and the `verifyMfaSetup` tenant ruling). D13.C1 (nested impersonation), D13.C7 (sign-off under impersonation) and D15 item 1 (request/`not_applied` rows without before/after, per-call `changeId`) are in code on branch `wave0/back-online`, not deployed; the `ConflictException` classifier is outstanding. **D8.4 stays proposed — operator's decision** | Supersedes **0002 D6 only**. **Which Neon project hosts auth is an open operator decision** (D12): Outcome A (live control plane) vs Outcome B (fresh auth-only project; recommended, §12). **Gate zero: no code until the Neon account owning `ep-small-darkness-aeyx0p5j`, and who can access it, is named.** `cool-rice-41190255` is the old Singapore project, not the live one. SAML is an unconditional 501 with no flag. Reserves 0024. Re-review by Owen + Anton required |
| [0024](0024-platform-groundwork-apps-snap-on.md) | Platform groundwork — making "apps snap on" true: D1 a `verticals` registry table replaces `vertical_type_enum` (`tenants.vertical` → `varchar` + FK, seeded `immigration`/`grc`/`labour`, every hardcoded per-vertical map becomes a registry column); D2 vertical modules under `src/verticals/<code>/` (VAC moves, route paths unchanged, core may never import them); D3 one generic pack-rendered app `meru-apps` + a new `GET /config-packs/me/manifest`, proven by a third example app "Compliance Register" (`register`, no adapter, no new `EntityType`); D4 scoped deny-by-default API keys (`API_KEY_AUTH` kill switch) and one `OutboundUrlPolicy` for every tenant-influenced outbound URL; D5 deferrals with triggers; D6 GovX task board — operator's choice, recommends frontend-only redesign now, ADR 0014 later | Proposed — 2026-11-17, not merged | **Takes up 0023 D9's reservation:** decides the registry, defers `app_builder` and the partner tier (0023 D3 untouched). D1/D3 pack-schema and `src/config` edits wait for the Wave 0 commit. Flags a `staff`-reachable outbound webhook (§1.9) and `POST /workflows` with no `@Roles` to Anton. Requires `quality` (Owen) + `secops` (Anton) — mandatory on D1, D3, D4 |
| [0025](0025-document-review-state-machine.md) | Document review state machine (E19): `uploaded → under_review → approved \| rejected`, reviewer + reason, tied to the three-valued checklist | Proposed — 2026-09-17, not merged | New `documents` columns + `CHECK` constraints, two new staff-only routes, pack `compliance.documentReview.rejectionReasons[]`. **Numbered 0025, not the next free slot after 0018** — 0019–0021 were claimed by concurrent ADR work in the same session; see the numbering note below. Requires `quality` (Owen) + `secops` (Anton) |
| [0026](0026-vac-card-authority-and-self-report.md) | VAC card authority, PAN redaction guard, and the client self-report route (E22) | Proposed — 2026-09-17, not merged | **Extends ADR 0008, does not replace it** — implements 0008's D3/D4 (still unbuilt) and closes 0008's two open implementer items by replacing generic-PATCH/comment writes with five dedicated, audited `/crm/entities/:id/vac/*` routes. No migration required. Requires `quality` (Owen) + `secops` (Anton) — mandatory, first generic card-data detector and a new client-writable route on a money-integrity record |
| [0027](0027-workflow-signoff-enforcement.md) | Workflow sign-off enforcement (E23), gated on the practitioner-credential column | Proposed — 2026-09-17, not merged | **Narrows ADR 0001 §7** — adopts its pack schema / gate placement / `signedOffBy` history field, but gates on `practitionerCredential IS NOT NULL` (already shipped) via a live DB read, not on matching a pack `signOffRole` against the still-unbuilt `User.verticalRoles`. No migration required — `permissions`/`history` are already jsonb. Requires `quality` (Owen); `secops` (Anton) recommended, not mandatory |

> **Numbering note, 2026-09-17, updated.** Two ADR-writing passes ran concurrently in this
> session: one on templates/payments/appointments/case-conversion
> (`0019-firm-editable-document-templates.md`, `0020-document-send-for-assent.md`,
> `0021-client-payments-stripe-connect.md`, `0022-minimal-appointments-and-auto-case-on-convert.md`
> — this pass, now complete), and a second, on document review / VAC card authority / sign-off
> enforcement. The second pass discovered the collision after already drafting under `0019`–`0021`
> and renumbered to `0025`–`0027` before merge, per this file's own rule to never renumber a
> **merged** ADR — neither pass's ADRs were merged at the time, so renumbering once was safe.
> **`0019`–`0022` are now fully claimed by this pass, as listed above.** *(Updated 2026-11-17.)*
> **`0023` is claimed** by `0023-neon-better-auth-federation-rollout-and-control-centre.md`.
> **`0024` is written** (2026-11-17) as `0024-platform-groundwork-apps-snap-on.md`, taking up the
> reservation 0023 D9 made: it decides the verticals registry and defers the `app_builder` role and
> the partner tier with explicit triggers. The next free number is `0028` — check this directory
> immediately before taking any number, the same discipline that produced this note in the first
> place. Whoever merges both passes should confirm no further
> collision exists and remove this note once it is no longer live information.
>
> **Index gap, noted 2026-11-17, not fixed here:** `0014`–`0017` exist on disk
> (`0014-task-board-ordering.md`, `0015-appointments-and-calendar-integration.md`,
> `0016-partner-referral-portal-and-commission.md`,
> `0017-consent-retention-and-automated-decision-disclosure.md`) and have no row in the table above.

**Reading `main`'s money model:** the ADR to cite for `vacStatus`, `vacSettlementMode`,
card-authority/PAN redaction and the duty floor is **0008**, not 0001. `0001` is the practice-role
tagging decision and has nothing to do with payments.

**0009 depends on 0007.** Both are Proposed, not merged. 0009's Contracts 1 and 3 restate 0007's
D2 and D7 with current line numbers and one correction (the job-dispatch extraction 0007 did not
specify); implement 0007 and 0009 together, not 0009 alone against a codebase where D2/D7 never
landed.

**0012 does not supersede 0002.** 0002 decided the *shape* of federation (Neon Auth authenticates,
Meru issues the session); 0012 answers the separate question of adopting Better Auth **directly**,
declines replacement, and corrects 0002 §1.1's two `[UNVERIFIED]` capability gaps — custom claims
and SAML are properties of Neon's *managed* wrapper, not of Better Auth itself. Read 0002 first;
0012 assumes it.

**0012 and 0013 are independent decisions sharing one constraint:** identity and the tenant's
vertical must be resolvable before anything else runs. That is why 0012 D3 freezes the token's
claim set and why 0013 D1 keeps `tenants`, `users` and `sessions` on the control plane
permanently — the same mechanical fact stated from two directions.

**0026 does not supersede 0008.** 0008 decided `vacStatus`/`vacSettlementMode`/the reconciliation
alert (all shipped) and specified, but did not build, the card authority and PAN guard (D3/D4).
0026 builds D3/D4 as specified and additionally replaces 0008's proposed generic-PATCH/comment
write path with five dedicated routes, after establishing that the generic path was either
unreachable (a `client` token cannot write via `PATCH /crm/entities/:id` at all, per
`crm-access.service.ts`'s `own`-scope-is-read-only rule) or unaudited (`CommentService` writes no
`audit_logs` entry). Read 0008 first for the money model; read 0026 for how a client or staff
member actually writes to it.

**0027 narrows 0001 §7, the same relationship 0012 has to 0002.** 0001 is the accepted, general
practice-role-tagging design (`User.verticalRoles`, pack `roles[]`, a grant route, a staged
census-gated rollout) and its own §7 specifies a `signOffRole`-matching sign-off gate built on top
of that carrier. 0027 ships sign-off enforcement now, gated on the already-shipped
`practitionerCredential` column instead of the still-unbuilt `verticalRoles` carrier — narrower,
but sufficient for ImmiStack's one sign-off-capable role today, with no JWT change and no rollout
gate needed. 0027 does not touch 0001 §§1-6,8-15 (practice-role tagging itself remains 0001's
design, unbuilt, and un-superseded).
