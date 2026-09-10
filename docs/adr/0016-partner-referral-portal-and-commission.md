# 0016 — Partner/referral portal: a fifth role, a separate resource, and a disclosure gate that is not a checkbox

**Status:** Proposed — 2026-09-10. Not merged. **Requires `secops` (Anton) review as a blocking
gate, not a courtesy** — this adds a fifth `PlatformRole` to a system where five isolation defects
of one shape have already been found and fixed, and §1.3 documents a sixth that adding the role
*creates* unless it is closed in the same commit. `quality` (Owen) gates before merge. Luke and
Mira implement against this contract; this document specifies no feature code.

**Scope:** PRD §17 / BC-13, FR-14.1–14.5; BRD BR-4 and D-5. Release R3.

**FR-14.4 is a launch gate, not a feature.** "Per-referral disclosure attestation that the client
was given written notice of the arrangement. **Without it the programme does not launch.**"
Everything else in this ADR is subordinate to §2.5.

---

## 1. Context

### 1.1 Nothing exists, and one thing was deliberately un-shipped

`grep -rl "partner"` and `grep -rl "commission"` over `--include='*.ts' src/` return **nothing**.
`PlatformRole` has exactly four members (`src/iam/enums/platform-role.enum.ts:20-29`).

`meru-core-fe/immistack-marketing/App.tsx:121-125` records why the marketing site's Affiliate page
is unregistered:

> "The Affiliate Program link is gone while `/affiliate` is unregistered … The page made a
> revenue-share offer to registered migration agents with no s.34 conflict artifact and nothing
> built behind it."

The page itself sits in `~/dev/meru/_salvage/_recovered-from-mira/` (`pages/Affiliate.tsx`,
`components/AffiliateForm.tsx`). Its `_salvage/README.md` is explicit: *"ported only as part of
the R3 partner portal, behind the disclosure attestation — never as 'cleanup'."* It also notes
that the marketing build's own claims gate (`scripts/check-claims.mjs`) independently bans
affiliate/commission-payout copy, so a naive restore fails the build — **that is the gate
working**.

### 1.2 The legal constraint is stricter than "disclose in writing", and it changes the data model

`meru-core-fe/immistack/BUSINESS.md:415-440`, read directly from the Code of Conduct on
2026-08-26, corrects an earlier, weaker reading:

- **s.34 is two-sided.** The agent must give **written notice** of the interest **and** the client
  must give the agent a **written statement** that they have been given notice and still wish the
  agent to act. Both, not either.
- **s.34(4): an *actual* conflict is not waivable.** Where an actual conflict exists and
  objectivity or confidentiality could be compromised, the agent must not give immigration
  assistance **even with the client's consent**.
- s.34(5) extends conflicts to those of a **relative** of the agent or the client.

BUSINESS.md draws the three product consequences itself, and this ADR adopts them verbatim as
requirements: consent is a two-sided artifact not a tick; a potential conflict is waivable and an
actual one is not; and the rate must stay where the conflict remains *potential* — "do not exceed
~25%", with the OSHC 12% statutory cap cited as the adjacent precedent (the defined-term wording
naming migration agents is marked `[UNVERIFIED]` there and stays so here).

**A single `disclosureAccepted: boolean` cannot represent any of that.** §2.5 is built from these
facts, not from a generic "consent" idea.

### 1.3 The defect that adding `PlatformRole.PARTNER` *creates*, if nothing else changes

This is the most important paragraph in this document.

`CrmController.clientScoped` (`src/crm/crm.controller.ts:73-102`) narrows the list and export
queries **only** when the caller's roles include `PlatformRole.CLIENT` and no staff role:

```ts
return roles.includes(PlatformRole.CLIENT) && !isStaff
  ? { ...query, subjectEmail: user.email }
  : query;
```

`GET /crm/entities` (`:233-259`) and `GET /crm/entities/export` (`:261-…`) carry
`@UseGuards(AuthGuard('jwt'), PolicyGuard)` and **no `@Roles()`**. `PolicyGuard` only checks roles
when `@Roles()` is present (`src/iam/guards/policy.guard.ts:39-48`).

Therefore: **a token holding `partner` and neither `client` nor a staff role falls through
`clientScoped` unnarrowed and receives the tenant's entire caseload — list and CSV export.** That
is the sixth instance of the shape that has already been found on `/crm/entities`, `/payments`,
`/communications/threads`, `/tasks` and `/documents`, and it would be introduced by a one-line
enum addition.

The general form of the hazard: **`clientScoped` and every check like it is written as an
allow-list of "who gets narrowed", not a deny-list of "who gets everything".** Adding a role to
the enum silently adds it to the "gets everything" side.

### 1.4 `scopeOf` is a three-valued function and every isolation fix in this codebase routes through it

`src/common/access.ts:82-86`:

```ts
export function scopeOf(actor: Actor): AccessScope {
  if (isGodContext()) return 'god';
  if (isTenantStaff(actor.roles)) return 'tenant';
  return 'own';
}
```

`AccessScope = 'god' | 'tenant' | 'own'` (`:80`). Call sites, all of the form
`if (scopeOf(actor) === 'own') { narrow }` or `if (scope === 'god' || scope === 'tenant') return
true`:

`src/tasks/task.service.ts:114`, `:169`, `:578` · `src/forms/form.controller.ts:66` ·
`src/forms/form-builder.service.ts:413` · `src/storage/storage.service.ts:771` ·
`src/crm/crm-access.service.ts:71`, `:108`, `:171`, `:203` · `src/crm/comment.service.ts:100`,
`:187` · `src/documents/document-access.service.ts:160`.

**What `own` currently means for CRM** (`crm-access.service.ts:82-100`): the caller is the
record's `assignedTo`, **or** the caller's email equals the record's `subjectEmail`. And a
successful `own` read returns the **whole `UniversalEntity`, `verticalAttributes` included** —
which on ImmiStack is where passport and visa data lives (the class comment says so at `:19`).
`EntityRelationService.traverse` (`entity-relation.service.ts:163-215`) returns whole entity rows
too, and its own comment (`:185-196`) records that filtering only the parent "turned a relation
into a lateral-movement primitive."

So: **`own` is not a partner-shaped scope.** It is "this record is about me," and its payload is
the full record.

### 1.5 The primitives this decision reuses rather than reinvents

- **`EntityRelation`** (`src/crm/entities/entity-relation.entity.ts:27-67`): a typed edge, unique
  on `("tenantId","relationKey","fromId","toId")`, with a `metadata jsonb` column (`:62-63`) and
  a `createdBy`. `EntityRelationService.link` (`entity-relation.service.ts:80-125`) validates the
  edge against the **resolved config pack's `relationships[]`** and refuses a
  `fromType`/`toType` mismatch — so a referral edge is pack-declared, satisfying `CLAUDE.md` §7.6.
- **`AcceptanceService`** (`src/crm/acceptance.service.ts`): an audited record of assent —
  subject, user, email, timestamp, IP, user-agent, SHA-256 of the exact bytes shown — appended to
  `verticalAttributes.acceptances[]` so a later acceptance never erases an earlier one (`:70-79`),
  and carrying `isSignature: false` **in the payload** with a comment stating that a UI must say
  so where it collects it (`:31-43`). This is the only two-sided-attestation primitive Meru has,
  and building a second one would be exactly the "approximation everyone downstream treats as the
  real thing" that `CLAUDE.md` §7.4 forbids.
- **`payments.direction`** is `inbound | outbound` in one table and the two are **never summed**
  (`CLAUDE.md` §7.8). `GET /payments/summary` reports `receivableMinor` and `payableMinor`
  separately, and a `client`-role caller sees `inbound` only. A commission payable to a partner is
  an **outbound** payment. The ledger already has the right shape.
- **`ModuleEntitlementGuard`** (`src/iam/entitlements/module-entitlement.guard.ts:66-101`) → HTTP
  **402** `MER-TENANT-0006`. Its legacy-grant escape hatch is scoped precisely: it only forgives
  a missing module when **every** missing module is in `GRC_MODULE_CODES` (`:88-99`).
- **`MeruErrorCode`** families (`src/common/types.ts:54-129`): `MER-TENANT-0009` is the current
  end of the tenant family.
- Highest migration timestamp on disk: `1756920000000-AddUserPractitionerCredential.ts`.

---

## 2. Decisions

### 2.1 D1 — `partner` is a fifth `PlatformRole`, ranked last, and it is *not* a practice-role tag

**Decision.** `PlatformRole.PARTNER = 'partner'`, appended to `ROLE_PRECEDENCE`
(`platform-role.enum.ts:36-41`) **after `CLIENT`** — i.e. least privileged.

**Why a `PlatformRole` and not an ADR 0001 practice-role tag.** ADR 0001's `verticalRoles` are
*additive tags on top of* a `PlatformRole`, validated against the tenant's pack `roles[]`, and
they are for vertical vocabulary — `migration_agent`, `mlro`, `paralegal`. A partner is not a
finer-grained staff member; it is a **different kind of principal** with a different portal, a
different data projection and a different lawful basis for holding the data they see. It is also
vertical-neutral: a GovernanceX bank with introducers has the same shape. ADR 0001's own §6 rules
that the docs' `partner` row is a practice-role tag; **this ADR overrides that specific row**, and
says why: a practice-role tag rides on top of a `PlatformRole`, and there is no existing
`PlatformRole` a partner can safely ride on. Riding on `client` would give them `own` CRM scope
(§1.4); riding on `staff` would give them `tenant` scope, which is the whole caseload.

**Ranked last matters mechanically.** `canGrantRole` (`platform-role.enum.ts:64-77`) lets a caller
grant only at or below their own rank, and `IamService.resolvePrimaryRole` walks
`ROLE_PRECEDENCE` to pick the portal. Ranking `partner` last means a `firm_admin` may create one
and a partner may create nobody. Placing it anywhere else in that array changes both behaviours
silently.

**A user holds `partner` or a tenant role, never both.** `isClientOnly`
(`access.ts:61-63`) already encodes the principle that the wider role wins; a partner who is also
staff at the same firm is a conflict of interest, not a permissions puzzle, and the invite route
must refuse the combination outright with a 400 rather than resolving it.

### 2.2 D2 — `AccessScope` keeps three values. `scopeOf(partner)` is `'own'`. The partner never touches `/crm/entities`.

**Decision.** `src/common/access.ts` is **not** given a fourth `AccessScope` value.

**Why adding `'referral'` would be the most dangerous change in this ADR.** Every call site in
§1.4 is written as `if (scopeOf(actor) === 'own') { narrow }`. Introducing a fourth value makes
that comparison **false** for a partner at all thirteen of them — so a partner would fall into the
*unnarrowed* branch of every one of the five isolation fixes this codebase has already had to
make. It is a fail-**open** change disguised as a modelling improvement, and it would have to be
caught by inspecting thirteen call sites correctly, once, forever.

Leaving `scopeOf(partner) === 'own'` fails **closed** everywhere instead, and does so by
arithmetic rather than by vigilance:

- `CrmAccessService.ownsEntity` (`crm-access.service.ts:82-100`) compares `assignedTo` (a staff
  user id — never a partner) and `subjectEmail` (the applicant's address — never the partner's).
  A partner matches **nothing**, so `canAccess` is false for every record, and `assert` throws
  **404** (`:129-143`). `traverse` drops every neighbour (`entity-relation.service.ts:197-201`).
- `TaskService` narrows to `assignedTo = actor.id` (`task.service.ts:169-171`) — no task is
  assigned to a partner, so the list is empty rather than the firm's.
- `StorageService`, `FormBuilderService`, `DocumentAccessService`: same shape, same result.
- `CrmAccessService.mayReadInternalNotes` (`:202-204`) returns false.

**The one thing this does not cover is §1.3, and it must be fixed in the same commit.**
`clientScoped` is an allow-list keyed on `PlatformRole.CLIENT`, not a call to `scopeOf`. The fix
is to **invert it**: narrow whenever the caller is not staff.

```ts
// The narrowing must key on "is this caller staff?", never on "is this caller
// a client?". Keyed the second way, every role added to PlatformRole after
// this line was written defaults to seeing the tenant's whole caseload.
return isStaff ? query : { ...query, subjectEmail: user.email };
```

For a `client` this is behaviour-preserving. For a bare `platform_admin` outside `runAsGod` it is
a **narrowing**, which matches what `scopeOf` already says about that caller
(`access.ts:76-78`: "their own records only… a platform operator who needs more takes the god
path"). For a partner it produces an empty list, which is correct.

**And a `@Roles` deny-list is added as defence in depth, not as the primary control.** Every
tenant-data controller — `CrmController`, `DocumentsController`, `PaymentsController`,
`TaskController`, `CommunicationsController`, `FormController`, `StorageController` — gains an
explicit `@Roles(...)` listing the four non-partner roles. Two independent mechanisms, because
this exact class of gap has shipped five times.

**Enforced by a spec, not by discipline.** A new test asserts that
`PlatformRole.PARTNER` appears in **no** `@Roles(...)` decorator outside `src/partners/`, by
matching over the controllers' own source — the same regex-over-own-source technique
`config-pack-loader.service.spec.ts` and `capabilities-regulators.spec.ts` already use, and for
the same reason: writing the discipline down was not enough.

### 2.3 D3 — A referral is a typed relation between two generic records. Commission is a ledger of its own.

**Decision, in three parts.**

**(a) A partner is `EntityType.PARTNER` on `universal_entities`** — one new enum member, additive,
via `ALTER TYPE … ADD VALUE IF NOT EXISTS 'partner'`, the exact shape of
`1756200000000-AddSarEntityType.ts` (which is deliberately a migration that does nothing else,
because `ADD VALUE` is not transactional on older Postgres).

This is `CLAUDE.md` §7.5 applied honestly: a partner is a party with a name, an email, a status
and an owner — structurally the `person`/`organization` shape the CRM already models. It is
vertical-neutral (a bank's introducer is the same record). PRD §19 says the same: "Partner |
entity, type `partner`; referrals as typed relations."

`seriesFor` (`src/crm/record-identity.ts:49-53`) is **not** extended — a partner draws no `CL-`
number. It is not a client, and giving it one would put a partner into the client-number series a
firm reconciles against its caseload.

**(b) A referral is an `EntityRelation`** with `relationKey: 'referred_by'`, `fromId` = the
lead/client record, `toId` = the partner record. It is declared in the config pack's
`relationships[]` — `{key: 'referred_by', fromType: 'lead', toType: 'partner', cardinality:
'many_to_many', blocksCompletion: false}` — so `EntityRelationService.link`'s type check
(`entity-relation.service.ts:115-120`) validates it and the label is pack-owned per §7.6.

**Why not its own `referrals` table.** The edge is exactly what `entity_relations` was built for
— its own comment names "document relationships, task and milestone dependencies, and
counterparty links" as one shape (`entity-relation.entity.ts:24-25`) — it is already unique per
`(tenant, key, from, to)`, already indexed both directions, and already RLS-carrying. A second
edge table would be the drift this one exists to prevent.

**(c) The commercial terms are frozen onto the edge at creation, in `EntityRelation.metadata`:**

```jsonc
{ "planKey": "tier-gold", "rateBps": 1500, "clawbackDays": 90,
  "conflictKind": "potential",            // 'potential' | 'actual'  — §2.5
  "referredName": "Mei-Ling Chen",        // AS SUPPLIED BY THE PARTNER, never re-read
  "registeredAt": "2026-09-10T..." }
```

**Why frozen rather than looked up at accrual time.** A firm that changes its commission plan must
not silently reprice referrals already made — the partner agreed to a rate. This is the same
principle `CLAUDE.md` §7.2 states for entitlements ("frozen into `tenants.settings.modules` at
provisioning… so a tenant's grant does not move when a plan definition changes") applied to the
other side of the ledger. `metadata` is jsonb and therefore loose; that is acceptable **because
it is a snapshot, not the ledger** — the authoritative integers live in `commission_entries`
(§2.4), which is typed.

**Why `referredName` is stored on the edge and not read from the client record.** FR-14.2 says the
partner sees "stage-level only — never the client's documents, notes or personal detail." The
partner already knows the name of the person they introduced, because they supplied it. Storing
their own submission and rendering that means a later correction to the client record — a name
change, a new email, a linked dependant — **does not flow back to the partner**. The alternative
(project the name off `UniversalEntity`) turns the referral list into a live feed of the firm's
data about that client, which is precisely what FR-14.2 forbids.

### 2.4 D4 — Commission: an accrual ledger, and payment through the existing outbound ledger

**Decision.** New table `commission_entries`. Payment of a commission is an existing `Payment`
with `direction: 'outbound'` — **never a new money table**, and never summed with client fees
(`CLAUDE.md` §7.8).

```sql
CREATE TABLE "commission_entries" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"          uuid NOT NULL,
  "partnerEntityId"   uuid NOT NULL,      -- universal_entities.id, type='partner'
  "relationId"        uuid NOT NULL,      -- entity_relations.id — the referral
  "referredEntityId"  uuid NOT NULL,      -- the lead/client. NOT exposed to the partner
  "triggerKind"       varchar(32) NOT NULL,   -- 'fee_settled' today
  "triggerRef"        uuid,                   -- the payments.id that caused the accrual
  "basisAmountMinor"  bigint NOT NULL,        -- what the commission is a percentage OF
  "rateBps"           integer NOT NULL,       -- frozen from the relation's metadata
  "amountMinor"       bigint NOT NULL,
  "currency"          char(3) NOT NULL,
  "status"            varchar(16) NOT NULL,
      -- accrued | payable | paid | clawed_back | void
  "accruedAt"         timestamptz NOT NULL DEFAULT now(),
  "payableAt"         timestamptz NOT NULL,   -- accruedAt + clawbackDays
  "paidPaymentId"     uuid,                   -- payments.id, direction='outbound'
  "clawbackReason"    text,                   -- FR-14.5: "a visible reason on any clawback"
  "clawedBackAt"      timestamptz,
  "clawedBackBy"      uuid,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "updatedAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_commission_amount_nonneg" CHECK ("amountMinor" >= 0),
  CONSTRAINT "UQ_commission_trigger" UNIQUE ("tenantId", "relationId", "triggerKind", "triggerRef")
);
```

`ENABLE` + `FORCE` RLS with a `tenant_isolation` policy at creation, structurally identical to
`1756700000000-AddTenantFeeOverrides.ts:46-59`.

- **Minor units, `bigint`, explicit currency** — the house money representation.
- **`UQ_commission_trigger` is the idempotency guarantee.** A settlement webhook delivered twice
  must not accrue twice. The constraint, not a service check, is what makes that true — the same
  reasoning ADR 0010 §2.2 gives for letting the database do the serialising.
- **`status` is a lifecycle, not a boolean.** `accrued` → `payable` (once `payableAt` passes with
  no clawback) → `paid`. `clawed_back` is terminal and requires `clawbackReason`; `void` is for an
  accrual raised in error, and also requires a reason. FR-14.3's admin funnel reads
  "accrued / payable / paid" straight off this column, so those three words must mean exactly one
  thing each.
- **The clawback window is time, not judgement.** `payableAt = accruedAt + clawbackDays`, frozen
  from the relation (§2.3c). A `daily-billing`-adjacent sweep promotes `accrued` → `payable`;
  until then, an accrual is **not** payable and must not be rendered as owed.

**Tiers (FR-14.5) live in a small tenant table, not in the config pack.** New
`commission_plans` (`tenantId`, `key`, `label`, `rateBps`, `basis`, `clawbackDays`, `active`,
`updatedBy`). A commission rate is **the firm's own commercial term**, exactly like
`firm_professional_482` — and ADR 0009 §2.4 already ruled that a firm's own price is tenant data
that happens to be shaped like configuration, not vertical vocabulary. Putting rates in the pack
would quote every ImmiStack tenant the same commission, which is the live 80/20 violation that
ADR settled.

**What triggers an accrual is deliberately narrow at launch:** a **settled inbound `firm`-kind
fee** on a case linked to a referred client. Not "a case opened" (no money yet), not "an invoice
raised" (unverified, and `CLAUDE.md` §7.3 forbids rendering unverified as paid), and never a
government charge or a disbursement — a firm does not pay commission on money that was never its
revenue. `FeeDefinition.kind === 'firm'` (`src/billing/fee-schedule.service.ts:12`) is the
existing discriminator and is reused rather than re-derived.

### 2.5 D5 — The disclosure gate: two-sided, typed by conflict kind, and enforced at accrual

**Decision.** A referral relation may be *created* without a disclosure — a partner registering a
lead is not yet giving immigration assistance. **Nothing else may happen without one.**

**The artefact is two `AcceptanceService` records plus a document, not a boolean.**

| s.34 limb | Artefact | Where |
|---|---|---|
| (a) written **notice given** to the client | A generated document from the pack's `documentTemplates[]` (`referral_disclosure_notice`), filed against the client record, with a `sentAt` and the SHA-256 of the exact bytes | `documents` + `document_versions` |
| (b) client's **written statement back** | `AcceptanceService.record(tenantId, clientEntityId, { subject: 'referral-disclosure:<relationId>', documentSha256: <the same hash> }, actor)` — **recorded by the client, on their own record**, per `acceptance.service.ts:76-82`'s "own scope must keep working" rule | `verticalAttributes.acceptances[]` + an audit entry |

**The two hashes must match.** An acceptance whose `documentSha256` does not equal the hash of the
notice actually filed is not evidence that the client agreed to *this* arrangement — that is the
whole reason `AcceptanceService` records the hash at all (`acceptance.service.ts:26-31`). The gate
compares them; a mismatch is a failed gate, not a warning.

**s.34(4): `conflictKind: 'actual'` is not waivable and no acceptance cures it.** The gate refuses
outright, with a message that says why, and the UI must not offer a "proceed anyway" affordance.
This is the one place in this ADR where a correct implementation must refuse a thing the user
wants to do.

**Where the gate is enforced.** In the service, at three points, and reported honestly at a
fourth:

1. **Commission accrual** — `commission_entries` may not be inserted for a relation whose gate is
   not `satisfied`. This is the hard one, because it is the money.
2. **Advice/lodgement sign-off** — a workflow transition through a step the pack marks as advice
   (the same credentialed sign-off gate FR-1.2/BR-3 already require) is refused for a client with
   an unsatisfied referral gate. This is the limb that actually implements s.34: the prohibition
   is on *giving immigration assistance*, not on being paid.
3. **The partner's own view** — a referral with an unsatisfied gate shows `disclosure:
   'not_obtained'`, never a green tick and never an omission.
4. **`GET /referrals/:id/gate`** returns the three-valued truth for each limb:
   `{ noticeSent: 'yes'|'no', clientStatement: 'yes'|'no', hashMatch: 'yes'|'no'|'not_applicable',
   conflictKind, gate: 'satisfied'|'not_obtained'|'refused_actual_conflict' }`. **"Not obtained"
   is not "denied" and is not "compliant"** — the same three-valued discipline the checklist uses
   for `uploaded: null` (`CLAUDE.md` §7.3).

**Why the gate is a service check and not a pack `rules[]` entry.** `PackRuleService` is
read-only by design — "nothing blocks a write" (`CLAUDE.md` §16). A launch gate that reports and
does not block is not a gate. The pack still owns the *notice wording* (`documentTemplates[]`) and
the *rate ceiling* is a `commission_plans` validation, but the refusal lives in code.

**The rate ceiling.** `commission_plans.rateBps` is validated at write against a platform maximum.
BUSINESS.md §6.1 says "do not exceed ~25%" — a commercial and legal judgement, not an
architectural one. **`[NEEDS DECISION: the maximum `rateBps` the platform will accept, and whether
it is a hard refusal or a warning requiring a recorded reason. Legal/Operator — this is BRD D-5.]`**
Until it is decided, the field is validated only as `0 < rateBps <= 10000` and the ceiling is
**not** silently assumed at 2500.

### 2.6 D6 — What the partner can actually reach: one resource, one projection, nothing else

**Decision.** `src/partners/` owns every route a `partner` token may reach. No partner route
returns a `UniversalEntity`, a `Document`, a `Payment`, a `Task` or a `CrmComment`, ever.

| Route | Returns |
|---|---|
| `GET /referrals` | `ReferralView[]` (below) |
| `GET /referrals/:id` | one `ReferralView` |
| `POST /referrals` | registers a lead + creates the `referred_by` edge (FR-14.2 "register leads") |
| `GET /referrals/:id/gate` | §2.5 item 4 |
| `GET /partners/me/commission` | `CommissionSummaryView` — accrued / payable / paid totals and the per-entry list, **their own only** |
| `GET /partners/me/materials` | pack-declared marketing collateral (`documentTemplates[]` filtered to a `partner` audience). Signed, short-TTL URLs, as `CLAUDE.md` §12's storage model requires |
| `/communications/threads` | **the one pre-existing resource a partner may reach** — see below |

**`ReferralView` is an allow-list, written as a hand-built object, never a `delete` on an entity.**

```jsonc
{ "referralId": "...",                 // entity_relations.id — NOT the client's record id
  "registeredAt": "...",
  "referredName": "Mei-Ling Chen",     // from the edge metadata (§2.3c), not the record
  "stageKey": "documents_collected",
  "stageLabel": "Documents collected", // resolved from the PACK; never invented
  "status": "in_progress",             // EntityStatus — the generic lifecycle, not the visa stage
  "lastChangedAt": "...",
  "disclosure": "not_obtained",        // §2.5
  "commission": { "status": "accrued", "amountMinor": 52500, "currency": "AUD",
                  "payableAt": "..." } }
```

Explicitly **absent, and enumerated so a reviewer can check**: `id` of the client record,
`email`, `phoneNumber`, `subjectEmail`, `recordNumber`, `verticalAttributes`, `assignedTo`,
`dueDate`, documents, comments, payments, tasks, the case's own record number, and the *identity
of the counsellor*.

**`stageLabel` comes from the pack or is not rendered as a label.** Where the resolved pack
declares no label for a stage key, the API returns `stageLabel: null` and the UI shows the raw key
with an honest marker — never a prettified guess. A partner reading an invented stage name would
be reading a fabricated status on a regulated matter.

**Messaging (FR-14.2 "message the team") reuses `/communications/threads`.** Per ADR 0005 the
thread service already scopes an `own`-scope caller to their own thread, and a partner is `own`
scope, so a partner's thread is keyed on their own email and no widening is needed. **This is the
only exception to "partner routes live in `src/partners/`" and it needs its own isolation spec**
— a second partner requesting the first partner's thread id must get 404. ADR 0005's own note
records that client-thread cross-client isolation is *untested, not unsound*, blocked on
`RESEND_API_KEY`; the partner case inherits that blocker exactly.

### 2.7 D7 — Entitlement: `ModuleCode.PARTNERS`, and why it fails closed for free

**Decision.** `ModuleCode.PARTNERS = 'partners'` (`src/iam/entitlements/module-code.ts:11-33`),
added to neither `CORE_MODULE_CODES` nor `GRC_MODULE_CODES`. Every route in §2.6 carries
`@RequiresModule(ModuleCode.PARTNERS)`.

**This fails closed by arithmetic, and it is worth spelling out.** `ModuleEntitlementGuard`'s
legacy escape hatch only fires when **every** missing module is in `GRC_MODULE_CODES`
(`module-entitlement.guard.ts:88-99`). `partners` is not, so `missingGrcOnly` is `false` and every
tenant without an explicit grant gets **402 `MER-TENANT-0006`** with `missingModules:
['partners']`. That is the correct answer for a programme a firm has not signed up to, and it
requires no new guard logic.

**`partners` is the first non-GRC code added since that guard shipped**, so it is the first to
exercise the non-forgiven path. Owen's review should include a case asserting a legacy
immigration grant gets 402 on a partner route and 200 on everything else — because if the escape
hatch were ever widened to "any module the grant predates", this decision silently inverts.

**Stacking (`CLAUDE.md` §7.2):** nothing here is retrofitted onto a route ImmiStack or GovernanceX
already calls. Every `@RequiresModule` is on a route that does not exist yet. Existing grants are
untouched. Re-run the frontend sweep against both baselines (immistack 33/33, governancex 27/28)
after the `PlatformRole` and `EntityType` additions — those two are the only changes that touch
shared surface.

### 2.8 D8 — Migration

Two migrations, because `ALTER TYPE … ADD VALUE` must stand alone (§2.3a):

- **`1757200000000-AddPartnerEntityType`** — `ALTER TYPE "universal_entities_type_enum" ADD VALUE
  IF NOT EXISTS 'partner'`, and nothing else. `down()` is a comment explaining that Postgres
  cannot drop an enum value and that an unused one costs nothing — copied from
  `1756200000000-AddSarEntityType.ts:26-31`.
- **`1757210000000-AddCommission`** — `commission_plans` and `commission_entries`, indexes, the
  unique trigger constraint, and `ENABLE` + `FORCE` RLS with `tenant_isolation` on both.

`PlatformRole.PARTNER` and `ModuleCode.PARTNERS` are **TypeScript enum additions with no
migration** — neither is a Postgres enum. `User.roles` is `simple-array` (a `text` column, per
ADR 0001 §2), so a new role string needs no schema change.

Both registered in `ALL_MIGRATIONS` (`src/config/migrations.ts:55`) **in the same commit**;
`npm run rls:verify` run against the two new tables specifically.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| A fourth `AccessScope` value, `'referral'` | Turns `scopeOf(actor) === 'own'` false at thirteen call sites, dropping a partner into the *unnarrowed* branch of all five previously-fixed isolation defects. Fail-open, disguised as better modelling (§2.2) |
| `partner` as an ADR 0001 practice-role tag | A tag rides on top of a `PlatformRole`, and there is no existing one a partner can safely ride on: `client` grants `own` CRM scope on real records, `staff` grants tenant-wide (§2.1) |
| Reuse `PlatformRole.CLIENT` for partners and distinguish by a flag | The flag would have to be consulted at every one of the thirteen `scopeOf` call sites — i.e. exactly the fourth-scope problem, with the additional property that a missed site grants a partner an *applicant's* view of a real client record |
| A separate `partner_users` table and a separate auth path | A second identity model in a product where identity resolution is already load-bearing before tenancy binding (ADR 0013 §1.4). Two token shapes is how "which principal is this" becomes unanswerable |
| A bespoke `referrals` table instead of `EntityRelation` | `entity_relations` is already the typed, pack-validated, bidirectionally-indexed, RLS-carrying edge table, built for exactly this (§2.3b). A second edge table is the drift it exists to prevent |
| Project the referred client's name live from `UniversalEntity` | Turns the partner's referral list into a live feed of the firm's data about that client — the thing FR-14.2 forbids. Storing the partner's own submission also means a later correction does not leak backwards (§2.3c) |
| Commission rates in the config pack | Quotes every tenant of the vertical the same rate — the live 80/20 violation ADR 0009 §2.4 settled for `firm_professional_482`. A firm's commercial terms are tenant data (§2.4) |
| Look the rate up at accrual time rather than freezing it on the referral | A plan change would silently reprice referrals a partner has already made, against a rate they agreed to (§2.3c) |
| A `commissions` money table with its own direction/summing | `payments.direction = 'outbound'` already exists and is already never summed with inbound (`CLAUDE.md` §7.8). A parallel money table is a second ledger to reconcile |
| Accrue on case creation or on invoice raised | No money has moved. Accruing on an unverified invoice renders an unpaid amount as owed, which is the "unverified shown as paid" failure the whole product is positioned against (§2.4) |
| `disclosureAccepted: boolean` on the referral | Cannot represent s.34's two limbs, cannot represent the hash binding the statement to the notice, and cannot represent the unwaivable actual-conflict case (§1.2, §2.5) |
| Build a second attestation primitive rather than using `AcceptanceService` | `CLAUDE.md` §7.4: an approximation of a signature is worse than none because everyone downstream treats it as real. `AcceptanceService` is honest about being assent and carries `isSignature: false` in the payload — that honesty is exactly what a s.34 statement needs |
| Enforce the gate as a pack `rules[]` entry | `PackRuleService` is read-only by design; nothing blocks a write. A launch gate that only reports is not a gate (§2.5) |
| Enforce the gate only on payment of commission | s.34 prohibits *giving immigration assistance* under an undisclosed conflict, not being paid for it. Gating only the money leaves the actual prohibition unenforced (§2.5 item 2) |
| Assume the 25% ceiling from BUSINESS.md and hard-code it | It is a commercial/legal judgement (BRD D-5) with an `[UNVERIFIED]` statutory citation attached. Hard-coding a number nobody has decided is how a guess becomes a policy (§2.5) |
| Restore `_salvage/_recovered-from-mira/pages/Affiliate.tsx` as part of this work | Its `README.md` and the marketing `App.tsx:121-125` both say it ships only behind the disclosure gate. The marketing build's `check-claims.mjs` independently fails on affiliate/commission copy — a naive restore breaks the build, correctly (§1.1) |

---

## 4. Consequences

1. **`PlatformRole` gains a member, and every allow-list keyed on a role string is now a
   liability.** §1.3 found one (`clientScoped`). There may be others: `[UNVERIFIED: no exhaustive
   audit of role-string allow-lists across `src/` was performed in this session. Anton should run
   one — `grep -rn "PlatformRole.CLIENT" --include='*.ts' src/` is the starting point, and every
   hit that is a *positive* test for "narrow this caller" is a candidate for the same inversion.]`
2. **`EntityType` grows from 20 to 21 members**, in the single enum both verticals draw from
   (`CLAUDE.md` §7.2 item 3). Additive; existing values keep resolving; GovernanceX is unaffected
   because nothing filters `type NOT IN (...)`. `[UNVERIFIED: that no GovX frontend switch over
   `EntityType` is exhaustive and would break on an unknown value — Mira/Owen to confirm against
   `governancex/`.]`
3. **A partner is a real user in `users` with a real session**, and therefore appears in the user
   directory, the audit log, login history and MFA policy. That is correct and it is also a
   surface a firm admin must be able to see and disable — `PATCH /iam/users/:id` already covers
   it, and `canGrantRole` (§2.1) already refuses a partner granting anyone anything.
4. **Two new RLS-carrying tables.** `npm run rls:verify` against them specifically.
5. **The commission ledger creates an obligation to reconcile.** Once `commission_entries` exists,
   `GET /payments/summary`'s `payableMinor` and the commission ledger's `paid` total are two views
   of the same money and **will** be compared. They must agree, which means every commission
   payment must carry `paidPaymentId` and nothing may mark an entry `paid` without one.
6. **The disclosure gate will block real work**, visibly, at the advice/lodgement transition. That
   is the point, and the UI must explain which limb is missing rather than saying "blocked."
7. **The programme cannot launch on the strength of this ADR alone.** BRD D-5 (rate model and
   clawback window) and the §2.5 rate ceiling are commercial decisions that are still open. The
   code can ship gated at 402 with no tenant granted `partners`; the *programme* launches when
   those are decided and the gate is proven.
8. **This is the first ADR to override a specific row of an accepted ADR.** ADR 0001 §6 rules
   `partner` a practice-role tag; §2.1 here overrides that row and only that row. ADR 0001's
   mechanism, carrier and validation are untouched.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A partner legitimately needs to see a document — e.g. an education agent must confirm a CoE was issued | D6's "no partner route returns a `Document`" | A **specific, named artefact type** exposed as its own projection with its own consent basis, never a relaxation of the referral view. The moment "the partner can see documents" is expressible in general, FR-14.2 is gone |
| A second role of this kind appears (an external assessor, an onshore agent, a translator) | D2's "leave `scopeOf` at three values and give the new principal its own resource" | Confirms the pattern; repeat it. Do **not** at that point conclude that a generic fourth scope has become worthwhile — two bespoke resources are safer than one generic scope that thirteen call sites must interpret correctly |
| A firm wants per-referral, negotiated rates rather than plan tiers | D4's `commission_plans` + frozen `rateBps` | Already expressible: the rate is frozen on the *relation*, not looked up from the plan, so a per-referral override is a value on the edge. Only a *retroactive* repricing would need a new decision, and it should need one |
| Commission on something other than a settled firm fee (a flat bounty per qualified lead) | D4's single `triggerKind: 'fee_settled'` | Add a `triggerKind`; the unique constraint already keys on it. But re-read §2.4's reasoning first — a bounty on a lead is a payment for an unverified thing, and the clawback window has to carry more weight |
| Legal decides the s.34 statement requires a provider e-signature, not an assent record | D5's use of `AcceptanceService` | That is the e-signature decision (PRD PD-3), not a partner decision. `AcceptanceService` already labels itself `isSignature: false`, so the gate's shape does not change — only which artefact satisfies limb (b) |
| A jurisdiction outside AU is onboarded with a different referral-disclosure rule | D5's s.34-shaped two-limb model | The limbs are the *shape*; which limbs apply is jurisdictional. Move the limb definition into the country overlay's `compliance` block rather than adding a second gate — and note that country overlays currently declare no `compliance` at all (ADR 0017 §1.2) |
| `ModuleEntitlementGuard`'s legacy escape hatch is ever widened beyond `GRC_MODULE_CODES` | D7's fail-closed-for-free property | `partners` would become ungated for every legacy grant, silently. Any change to that guard must have a test asserting `partners` is still refused |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `PlatformRole.PARTNER` + `ROLE_PRECEDENCE` entry | Revert the commit | **Any user already holding `partner` keeps the string in `users.roles` and becomes a principal with a role nothing ranks** — `resolvePrimaryRole` would return nothing and their portal routing is undefined. **Disable those users before reverting**, or revert the enum only after confirming none exist |
| `clientScoped` inversion (§2.2) | **Do not roll this back.** It is a strict narrowing that is correct independently of the partner role | None. Reverting it restores the §1.3 defect for any future role |
| `@Roles` deny-lists + the partner-absence spec | Revert the commit | None — pure authorisation surface |
| `ModuleCode.PARTNERS` + `@RequiresModule` | Remove the code and the decorators | A tenant already granted `partners` keeps the string in `settings.modules`, harmlessly — the same stance ADR 0009 §6 takes for an over-plan module grant |
| `AddPartnerEntityType` | **Not reversible.** Postgres cannot drop an enum value; `down()` is a no-op by design | The value remains, unused, at no cost — the precedent set by `AddSarEntityType`, `AddGovxEntityTypes` and `AddWhatsappChannel` |
| `AddCommission` (`commission_plans`, `commission_entries`) | `DROP TABLE "commission_entries", "commission_plans"` | **Every accrual is destroyed, including amounts a firm owes a partner.** Export before dropping. Do not roll this back once any accrual exists; remove the routes instead |
| `referred_by` relations | `DELETE FROM entity_relations WHERE "relationKey" = 'referred_by'` | The audit entries for the links remain (WORM). The disclosure acceptances remain in `verticalAttributes.acceptances[]` — correctly: a client's statement that they were told about an arrangement does not stop being true because the arrangement was rolled back |
| Pack `relationships[]` entry for `referred_by` | Remove and bump the pack `version` | Existing edges keep their `relationKey` but `EntityRelationService.definition` will refuse new ones, and `traverse` will fall back to the raw key as the label (`entity-relation.service.ts:211`) |

**Rollback verification.** Before removing `PlatformRole.PARTNER`, run
`SELECT id, email FROM users WHERE 'partner' = ANY(string_to_array(roles, ','))` and confirm it is
empty. A user holding a role the enum no longer knows is not a cosmetic problem.

---

## 7. Open items for implementers

| # | Item | Owner |
|---|---|---|
| 1 | **Fix `clientScoped` (`crm.controller.ts:73-102`) in the same commit as the enum addition.** Nothing else in this ADR ships before it | Luke |
| 2 | Audit every role-string allow-list in `src/` for the §1.3 shape (§4 item 1) | Anton |
| 3 | Spec: `PlatformRole.PARTNER` appears in no `@Roles(...)` outside `src/partners/`, matched over controller source (§2.2) | Owen |
| 4 | Spec: a `partner` token gets an empty list from `GET /crm/entities`, 404 from `GET /crm/entities/:id`, empty from `GET /tasks`, 402 from every `/referrals` route when the tenant lacks the grant | Owen |
| 5 | Spec: a legacy immigration grant gets **402** on a partner route (the non-forgiven guard path, §2.7) | Owen |
| 6 | Isolation spec: partner A cannot read partner B's `/communications/threads` — inherits ADR 0005's `RESEND_API_KEY` blocker (§2.6) | Owen |
| 7 | **Decide the maximum `rateBps`** and whether it is a refusal or a recorded-reason warning (BRD D-5, §2.5) | Operator / Legal |
| 8 | Decide the default `clawbackDays` (BRD D-5) | Operator |
| 9 | Author `relationships[]` `referred_by` and `documentTemplates[]` `referral_disclosure_notice` in `verticals/immigration.json`; bump the pack `version` (packs only upgrade on a strictly greater version) | Luke |
| 10 | Register both migrations in `ALL_MIGRATIONS` in the same commit; `npm run rls:verify` against the two new tables | Luke / Anton |
| 11 | Re-run the frontend sweep against **both** baselines after the `PlatformRole` and `EntityType` additions (§2.7) | Owen |
| 12 | Port `_salvage/_recovered-from-mira/` **only** once §2.5's gate is implemented, and expect `check-claims.mjs` to fail until the copy matches what the product actually does (§1.1) | Mira |
| 13 | Confirm no GovX frontend switch over `EntityType` is exhaustive (§4 item 2) | Mira / Owen |
