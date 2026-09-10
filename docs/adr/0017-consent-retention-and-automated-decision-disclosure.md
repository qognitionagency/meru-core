# 0017 — Consent, retention, and the automated-decision disclosure

**Status:** Proposed — 2026-09-10. Not merged. **Requires `secops` (Anton) review as a blocking
gate** — this decides what PII enters the sealed audit chain, and it corrects a statement in ADR
0009 §5 that is not implementable against the WORM trigger as written (§1.4). `quality` (Owen)
gates before merge. Luke and Mira implement against this contract; this document specifies no
feature code.

**Scope:** PRD NFR-7 (retention controls per tenant, consent records per purpose with expiry,
"never one global tick at signup"), FR-13.5, BRD BR-6 and D-7. Release R3.

**BR-6 carries a hard date: every AI feature must appear in a per-tenant automated-decision
disclosure before 10 December 2026.** §2.5 is the only part of this ADR with a deadline attached,
and it is the part most likely to be quietly deferred.

---

## 1. Context

### 1.1 There is no consent model at all

`grep -rl "consent"` and `grep -rl "Consent"` over `--include='*.ts' src/` return **nothing**
(verified 2026-09-10, and verified without wrapping the command in `timeout`, which exits 127
silently on this host — workspace `CLAUDE.md` §14). The pack schema has no consent section:
`ComplianceRulesSchema` (`packages/config-packs/_schema/pack.schema.ts:296-308`) carries
`dataResidency`, `retentionYears`, `encryptionRequired`, `auditRequired`,
`regulatoryFrameworks` and `reportingObligations`, and nothing else.

So NFR-7's consent half is not partially built. It is absent, which is at least honest: nothing
in the product currently claims a consent has been obtained.

### 1.2 Retention exists, is real, and cannot do what NFR-7 asks — by construction

`RetentionService.sweep` (`src/audit/retention.service.ts:55-116`) is genuinely implemented and
its reasoning is right as far as it goes. Its own doc comment (`:27-42`) states the correct
principle: *"Archives, never deletes… a retention sweep that tried to DELETE would be refused by
Postgres, and one that could delete would have punched a hole in the tamper-evidence."* And when
a pack declares no period it does nothing, with an explicit comment that an omission is "not
'keep nothing' — it is 'the pack has not said'" (`:70-83`). Both are the right instincts.

Three facts make it unable to satisfy "retention controls **per tenant**":

1. **It reads one number per vertical.** `this.packs.section(tenant.vertical, 'compliance')`
   (`:64-67`). Measured on disk 2026-09-10: `verticals/immigration.json` declares
   `retentionYears: 7`, `verticals/grc.json` declares `5`. Every tenant of a vertical gets that
   vertical's number.
2. **Country overlays cannot change it, because they declare no `compliance` block at all.**
   `countries/au-immigration.json` and `countries/ae-grc.json` — and all six of their siblings —
   have `compliance: null`. Verified by parsing every pack file.
3. **Even if an overlay did declare one, the sweep would not see it.** The sweep runs inside
   `TenantContext.runAsSystem` (`:56`), so there is **no ambient tenant**, so
   `VerticalPackService.forVertical` skips its `tenant_config_pins` lookup
   (`src/tenant/services/vertical-pack.service.ts:99-103`) and returns the base pack. A tenant
   pinned to `au-immigration` gets `immigration`'s retention, always, and no code path exists by
   which it could get anything else.

**And it only touches `audit_logs`.** `this.auditLogs.update(...)` (`:88-95`) is the whole of the
sweep. Documents, CRM records, communications and payments have no retention treatment anywhere.
"Retention controls per tenant" today means "one archive flag on one table, per vertical."

### 1.3 The `audit-archive` job is daily, and it is the only thing that runs this

`JOB_CADENCE_MINUTES['audit-archive'] = 1440` (`src/jobs/job-catalogue.ts:54`), which puts it in
`TICK_SCOPES.daily` (`:81`) — the scope the live Vercel cron actually drives. So unlike the `fast`
work in ADR 0015, retention does run. That is worth stating because it means changes here take
effect, rather than sitting behind the missing external scheduler.

### 1.4 The tension is real and one half of the previously-stated answer is not implementable

`audit_logs` is sealed by a database trigger, not a policy, *because* a `BYPASSRLS` owner would
evade a policy (`src/migrations/1755200000000-AddAuditWormEnforcement.ts:13-18`). The guard is:

```sql
IF (to_jsonb(NEW) - 'archived') IS DISTINCT FROM (to_jsonb(OLD) - 'archived') THEN
  RAISE EXCEPTION 'audit_logs is append-only (WORM): only the "archived" flag may change…'
```

(`:52-60`), plus a `BEFORE TRUNCATE` statement trigger (`:76-95`). The migration's own comment
explains the whole-row comparison: enumerating columns "would mean a new one is writable until
somebody remembers to add it, which is the wrong default for an audit log." That is correct and
this ADR does not touch it.

**The consequence, stated plainly: no column of `audit_logs` except `archived` can ever be
updated. ADR 0009 §5's suggested future — "anonymise the actor/subject references in place, never
delete the row" — is not implementable against this trigger.** It would require
`ALTER TABLE … DISABLE TRIGGER`, i.e. deliberately defeating the control that exists to stop
exactly that. This ADR corrects that row of 0009 rather than leaving it to be discovered by
whoever tries to build it.

**A second fact, which cuts the other way and is worth having on record.** The hashes do not
cover the whole row:

- `checksum` = SHA-256 over `{tenantId, timestamp, userId, action, entityId, beforeState,
  afterState}` (`src/audit/audit.service.ts:61-68`).
- `chainHash` = SHA-256 over `previousChainHash : tenantId : timestamp : action : entityId :
  userId : checksum` (`:553-565`).

So `userEmail`, `userRole`, `description`, `context` and `changes` are **outside both hashes** —
redacting them would not break `verifyChain` (`:326-351`). `beforeState`/`afterState` **are**
inside the checksum, so redacting those would break single-row verification. The cryptography
would therefore permit a narrow redaction that the trigger forbids. §2.4 decides deliberately not
to take that opening.

### 1.5 What is actually in the audit log, and it is not only actor metadata

`AuditLog` carries `userEmail` (`src/audit/entities/audit-log.entity.ts:64-65`), `beforeState`
and `afterState` (`:90-94`), `changes` — computed per-field before/after values
(`audit.service.ts:57`, `:515`) — and a `context` jsonb including `ipAddress` (`:103-105`).

A concrete instance: `AcceptanceService.record` writes `afterState: { ...record }`
(`src/crm/acceptance.service.ts:158`), and `AcceptanceRecord` is
`{subject, userId, email, acceptedAt, ip, userAgent, documentSha256, isSignature}` (`:16-43`).
**The applicant's email address and IP are inside the checksummed portion of a sealed row.**

That is the honest shape of the problem: it is not "the audit log names who acted," it is "the
audit log contains subject PII in a field that is hashed and cannot be changed."

### 1.6 The AI surface, enumerated, because the disclosure has to be built from something

Routes that can carry generated output today:

| Controller | Routes |
|---|---|
| `AiController` (`src/ai/ai.controller.ts`) | `POST /ai/execute` `:49` · `POST /ai/analyze-entity/:id` `:70` · `POST /ai/embeddings` `:86` · `GET /ai/search` `:104` · `GET /ai/prompts` `:126` · `POST /ai/prompts` `:142` |
| `EnginesController` (`src/ai/engines/engines.controller.ts`) | `POST /engines/screening` `:87` · `GET /engines/screening/watchlist-status` `:131` · `POST /engines/doc-intel` `:163` · `POST /engines/vessel/risk` `:189` · `GET /engines/vessel/lookup` `:204` · `POST /engines/radar/scan` `:221` · `GET /engines/scoring` `:242` · `POST /engines/scoring/:modelKey` `:255` |
| `OrchestrationController` (`src/orchestration/orchestration.controller.ts`) | `GET /orchestration/agents` `:54` · `GET /orchestration/agents/:id/logs` `:69` · `POST /orchestration/agents/:id/run` `:90` · `GET /orchestration/events` `:115` · `GET /orchestration/health` `:162` · `GET /orchestration/search/intelligent` `:182` · `GET /orchestration/entity/:id/insights` `:208` |
| `DocumentsController` | `POST /documents/:id/analyze` |

`CitationEnforcementInterceptor` is applied on all four controllers and its own comment records
why (`src/ai/interceptors/citation-enforcement.interceptor.ts:15-27`): it used to sit on `/ai`
alone, "which meant a route elsewhere that returned the same `AiResponse` shape reached the wire
unenforced." It replaces an unsourced result with a fallback and sets `citationEnforced: false`
rather than deleting the field — the honest failure direction.

**And a code inventory alone would go stale immediately.** Both shipped verticals declare **9
`prompts[]` entries each** (`verticals/immigration.json`, `verticals/grc.json`; all eight country
overlays declare 0), and each pack declares **1 messaging sequence** plus 16–17 templates.
`PromptSchema`'s own rationale (`pack.schema.ts:312-321`) is that a pack ships the prompt library
so a new tenant inherits a working one. **A pack author can therefore add an AI surface with no
code change**, and any disclosure derived only from `src/` is wrong the moment they do.

### 1.7 Precedents this decision is bound by

- **`CapabilityStatus = 'live' | 'degraded' | 'unconfigured' | 'unknown'`**
  (`src/health/capabilities.service.ts:35`), with `unknown` explicitly never folded into `live`:
  "an unprobed dependency reported as working is the lie this report exists to stop" (`:30-34`).
- **`capabilities-regulators.spec.ts`** parses the adapter source files and fails when the report
  and the adapters disagree — because, as the comment says (`capabilities.service.ts:57-70`),
  "writing the discipline down was not enough," and the list drifted in **seven of eight rows**
  even with that instruction in its own comment.
- **The three-part pack commit** (`CLAUDE.md` §6 rule 1): extend the Zod schema, regenerate with
  `npm run packs:schema`, **and** add the key to `upsertPack`'s list
  (`src/tenant/services/config-pack-loader.service.ts:497-537`). Miss the third and the section
  "validates cleanly, loads without error, and then does not exist at runtime" — the loader's own
  comment (`:507-514`).
- **`AcceptanceService`** (`src/crm/acceptance.service.ts`) — audited assent with subject, user,
  email, timestamp, IP, user-agent and a SHA-256 of the exact bytes shown, appended to
  `verticalAttributes.acceptances[]` so a later acceptance never erases an earlier one (`:70-79`).
- **`MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID = 'MER-TENANT-0009'`** is the current end of the
  tenant family (`src/common/types.ts:97`).
- Highest migration timestamp on disk: `1756920000000-AddUserPractitionerCredential.ts`.

---

## 2. Decisions

### 2.1 D1 — Consent is an append-only ledger of `(subject, purpose, scope)` states, and absence is a third value

**Decision.** New table `consent_records`. **One row per state change, never an update.** The
current state of a `(subjectEmail, purposeKey, scopeKey)` triple is its latest row.

```sql
CREATE TABLE "consent_records" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         uuid NOT NULL,
  "subjectEntityId"  uuid,                    -- universal_entities.id, when one exists
  "subjectEmail"     varchar NOT NULL,        -- normalised trim/lower, as CrmService does
  "purposeKey"       varchar(100) NOT NULL,   -- pack-declared vocabulary (§2.2)
  "scopeKey"         varchar(100) NOT NULL,   -- what data/processing it covers
  "state"            varchar(16) NOT NULL,    -- granted | refused | withdrawn
  "lawfulBasis"      varchar(32) NOT NULL,    -- consent | contract | legal_obligation |
                                              -- legitimate_interest | vital_interest
  "grantedAt"        timestamptz NOT NULL,
  "expiresAt"        timestamptz,             -- NULL = no expiry declared, NOT "never expires"
  "disclosureVersion" varchar(32) NOT NULL,   -- which text they were shown
  "documentSha256"   char(64),                -- SHA-256 of the exact bytes shown
  "capturedVia"      varchar(24) NOT NULL,    -- portal | staff | public_form | import | migration
  "capturedByUserId" uuid,
  "ipAddress"        varchar(64),
  "userAgent"        text,
  "reason"           text,                    -- required for 'withdrawn' and 'refused'
  "supersedesId"     uuid,                    -- the row this replaces
  "createdAt"        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON "consent_records" ("tenantId", "subjectEmail", "purposeKey", "createdAt" DESC);
CREATE INDEX ON "consent_records" ("tenantId", "subjectEntityId");
CREATE INDEX ON "consent_records" ("tenantId", "expiresAt") WHERE "state" = 'granted';
```

`ENABLE` + `FORCE` RLS with a `tenant_isolation` policy at creation, structurally identical to
`src/migrations/1756700000000-AddTenantFeeOverrides.ts:46-59`.

**Why append-only rather than a mutable row with a `withdrawnAt`.** "Was this person's consent
valid on 4 March?" is the only question that matters in a dispute, and a mutable row cannot
answer it. This is the same instinct `AcceptanceService` already applies by appending to
`verticalAttributes.acceptances[]` rather than replacing (`acceptance.service.ts:70-79`): "a
client who accepts revised terms does not erase the version they agreed to first."

**It is a service invariant, not a trigger.** There is no UPDATE path and no update route.
A WORM trigger here would be a second sealed table to reason about, and the failure mode it guards
(someone rewriting a consent row) is not the failure mode the audit log's trigger guards (someone
covering their tracks). If a regulator asks for tamper-resistance on consent specifically, that is
a small, separate migration — noted in §5, not built speculatively.

**Four states, and the fourth is the point of NFR-7.** A resolver returns, for any
`(subject, purpose, scope)`:

| Condition | Resolved | Renders as |
|---|---|---|
| latest row `granted`, `expiresAt` null or future | `granted` | granted, with the date and the disclosure version |
| latest row `granted`, `expiresAt` past | **`expired`** | expired — **never** `granted`, and never `refused` |
| latest row `withdrawn` / `refused` | `withdrawn` / `refused` | with the recorded reason |
| **no row at all** | **`not_asked`** | "not asked" — **never** `refused`, never `granted`, never a blank |

`not_asked` ≠ `refused` is the same three-valued distinction the document checklist already draws
between `uploaded: null` ("not asked") and "missing" (`CLAUDE.md` §7.3). A consent UI that renders
an unasked purpose as an unticked box is asserting a refusal that never happened.

**`expiresAt: null` means "no expiry was declared", not "consent is perpetual."** The resolver
returns the null explicitly so a caller can tell them apart, exactly as `recordNumber: null` must
be read as "no number" and not as zero (`universal-entity.entity.ts`'s own comment on that field).

**"Never one global tick at signup" is enforced structurally**, not by policy: the primary key of
meaning is `(purposeKey, scopeKey)`, so there is no row shape that can express "agreed to
everything." A caller who wants to record five purposes writes five rows and each carries its own
disclosure version and hash.

### 2.2 D2 — Purposes are pack-authored, and adding the section is a three-part commit

**Decision.** A new optional top-level pack key, `consentPurposes[]`:

```ts
const ConsentPurposeSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  description: z.string(),          // shown to the subject; this IS the disclosure text
  lawfulBasis: z.enum(['consent','contract','legal_obligation',
                       'legitimate_interest','vital_interest']),
  scopes: z.array(z.object({ key: z.string(), label: z.string() })).default([]),
  defaultExpiryMonths: z.number().int().positive().optional(),
  /** Refuse the named action when this purpose is not `granted`. §2.6. */
  gates: z.array(z.enum(['marketing_messaging','ai_processing','third_party_disclosure']))
          .default([]),
  required: z.boolean().default(false),   // service cannot be provided without it
});
```

**Why the pack and not core.** "Marketing communications", "AI-assisted document review",
"disclosure to an education agent" are the vocabulary of what a firm does with data — Layer 4, in
the same category as `documentTypes[]` and `fees[]`. Core learns "a purpose that a subject may
have consented to," and nothing about what any purpose means. §7.1, applied.

**The three-part commit is the whole risk of this decision.** Per `CLAUDE.md` §6 rule 1 and the
loader's own comment at `config-pack-loader.service.ts:507-514`:

1. Add `ConsentPurposeSchema` and `consentPurposes` to `pack.schema.ts`.
2. `npm run packs:schema` to regenerate the JSON Schema.
3. **Add `consentPurposes: def.consentPurposes ?? []` to `upsertPack`'s `schema` object**
   (`config-pack-loader.service.ts:497-537`).

Miss (3) and the section validates, loads with no error, persists nowhere and is read by nobody —
and the symptom is a consent UI that renders zero purposes, which looks exactly like a firm that
has not configured any. `config-pack-loader.service.spec.ts` asserts every optional section
round-trips and is the guard; the new case goes in the same commit.

**Bump the pack `version`.** Packs only upgrade on a strictly greater version; otherwise the
loader reports `up-to-date` and writes nothing (`CLAUDE.md` §6 rule 4).

**No purposes are authored by this ADR.** Which purposes an Australian immigration practice must
obtain, and on what basis, is a legal question. `[NEEDS DECISION: the initial `consentPurposes[]`
for `verticals/immigration.json` — Legal/Operator. Until authored, the consent surface correctly
shows nothing, which is honest.]`

### 2.3 D3 — Retention: resolve per tenant, per data class, with tenant override

**Decision, in three parts.**

**(a) A new tenant override table.**

```sql
CREATE TABLE "tenant_retention_policies" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"       uuid NOT NULL,
  "dataClass"      varchar(24) NOT NULL,   -- audit | records | documents | communications
  "retentionYears" integer NOT NULL,
  "basis"          text NOT NULL,          -- WHY. Free text, required, audited.
  "setBy"          uuid NOT NULL,
  "effectiveFrom"  timestamptz NOT NULL DEFAULT now(),
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_tenant_retention" UNIQUE ("tenantId", "dataClass"),
  CONSTRAINT "CHK_retention_positive" CHECK ("retentionYears" > 0)
);
```

`ENABLE` + `FORCE` RLS at creation. `PUT /compliance/retention`, `@Roles(PlatformRole.FIRM_ADMIN)`
— complete desired state per `dataClass`, not a delta, for the same reason
`UpdateEntitlementsDto` and ADR 0009 §2.4 give: removing an override must be expressible.

**`basis` is required and is not decoration.** It is the answer to "why does this firm keep client
files for 7 years and that one for 10," and it is the thing a reviewer reads two years later. The
same argument ADR 0009 §2.2 makes for `reason` on an operator entitlement write.

**(b) Resolution order, and the honest floor:**

```
tenant_retention_policies[tenantId, dataClass]        ← the firm's own decision
  ↓ (absent)
pinned country pack   compliance.retentionYears       ← currently null in all 8 overlays (§1.2)
  ↓ (absent)
base vertical pack    compliance.retentionYears       ← immigration 7, grc 5
  ↓ (absent)
NOTHING IS DONE, and the report says "no declared period"
```

The floor is already implemented correctly (`retention.service.ts:70-83`) and this ADR keeps it
verbatim. A sweep that guessed a period would destroy history on the strength of an omission.

**(c) The sweep resolves inside each tenant's context.** The current loop is
`runAsSystem → for each tenant → packs.section(tenant.vertical, …)` (`:56-67`), which is why the
pin is never consulted (§1.2 item 3). The fix is to bind the tenant for the per-tenant portion so
`VerticalPackService.forVertical`'s `tenant_config_pins` lookup
(`vertical-pack.service.ts:99-103`) can fire. Tenant **enumeration** stays under `runAsSystem` —
crossing tenants is the job, and that is the documented use (`SequenceRunnerService.run`'s comment
at `sequence-runner.service.ts:82-84` makes the identical split).

**The sweep still only archives `audit_logs`.** Extending retention to documents, records and
communications is not built here, and saying otherwise would be worse than the gap: those are
*deletions* of primary data, and there is no decided period to delete against (§2.7). The
`dataClass` column exists so the decision has somewhere to land; three of its four values are
declared and enforced by nothing today, and `GET /compliance/retention` must report them as
`unenforced`, never as configured. `CapabilityStatus`'s discipline (`capabilities.service.ts:30-34`)
applied to a policy rather than a credential.

### 2.4 D4 — Erasure and the immutable audit trail: the operational record is erased; the audit log is retained under a different basis, and that is disclosed

**Decision, in four parts. This is the load-bearing section.**

**(a) `audit_logs` is never edited, never anonymised, never deleted.** The WORM trigger stands
unchanged. Erasure does not touch it. **ADR 0009 §5's row suggesting in-place anonymisation of
actor/subject references is superseded by this decision** — it cannot be implemented without
`ALTER TABLE … DISABLE TRIGGER` (§1.4), and the cryptographic opening that exists for
`userEmail`/`description`/`context` (also §1.4) is deliberately not taken: a schema where *some*
audit columns are mutable is a schema whose next reader has to know which, and the trigger's own
comment explains why enumerating columns is the wrong default.

**(b) Erasure means erasing the operational record.** `POST /compliance/erasure` (`firm_admin`,
reason required, audited at `CRITICAL`) overwrites, for a named subject:

- `universal_entities`: `firstName`, `lastName`, `email`, `phoneNumber`, `subjectEmail`,
  `verticalAttributes` → a redaction marker. **`id`, `recordNumber`, `type`, `status`, dates,
  `assignedTo` and every relation are kept**, so the firm's own workflow and financial history
  stay reconcilable and no invoice loses the case number it names (ADR 0010 §6 makes the same
  point in the other direction).
- `documents` / storage objects: content deleted through `StorageService`; the row and its
  metadata kept with a redaction marker.
- `notifications` / threads: body redacted, envelope kept.
- `consent_records`: **kept**. A record that this person consented, and later that they withdrew,
  is the evidence the erasure was lawful. Erasing it destroys the defence for the erasure.

The enumeration of exactly which columns count as PII across the ~64 RLS tables **is not made
here**, and ADR 0009 §3 refused it for the right reason: "no enumerated PII-column list exists,
and no jurisdiction-specific retention requirement is in hand to design against." What this ADR
adds is the *shape* and the requirement that the list be explicit and reviewed —
`[NEEDS DECISION: the PII column inventory, table by table. Anton to produce; Legal to confirm
sufficiency. This is a prerequisite for shipping `POST /compliance/erasure`, not a follow-up.]`

**(c) Forward-only minimisation, so the problem stops growing.** `AuditService.logEvent` gains a
redaction pass over `beforeState`/`afterState` before the checksum is computed
(`audit.service.ts:57-68`), replacing values of a declared PII field set with `'[redacted]'` while
keeping the field **names** and the fact that they changed. What the audit log needs to prove is
*that a field was changed, by whom, when* — not what the value was. `changes` is derived from the
same inputs (`:57`, `:515`) and inherits the redaction.

Two consequences, both stated rather than hidden:

- **It is forward-only.** Rows already written keep their PII, in a sealed table, forever. There
  is no migration that fixes them and this ADR does not pretend there is.
- **It changes what future checksums cover**, so a chain verified across the boundary is still
  valid (each row is hashed with what it stored), but a reader comparing an old row to a new one
  will see different fidelity. That is a documentation obligation, not a defect.

**(d) The reconciliation, in one sentence, because this is what has to be defensible to a
regulator and to a client:**

> The operational record is erased on request. The audit log is **not** erased: it is retained
> under a **legal-obligation** basis for a declared period, it is append-only by database
> enforcement, it records only that a field changed and by whom (§2.4c), and **the subject is told
> this at the point of collection** — it is a `consentPurposes[]` entry with
> `lawfulBasis: 'legal_obligation'` and `required: true`, so it appears in the disclosure and
> cannot be presented as an optional tick.

**And the residual, named rather than glossed:** the WORM trigger forbids DELETE, so **no audit
row is ever destroyed by any code path**. "Retention" for `audit_logs` means *archived after N
years*, not *deleted after N years* (`retention.service.ts:88-95` sets `archived: true` and
nothing more). Any disclosure, DPA or privacy policy that says otherwise is wrong. The
`1755200000000` migration's own comment already records the deeper residual — a superuser can
disable the trigger, and genuine WORM needs storage the database cannot reach (S3 Object Lock in
compliance mode). That export remains unbuilt.

### 2.5 D5 — The automated-decision disclosure is generated from a registry, a spec, and the resolved pack — never written by hand

**Decision.** `GET /compliance/automated-decisions` returns a per-tenant disclosure assembled from
three sources at request time. There is no prose file anyone edits.

**Source 1 — a code registry, guarded by a spec that fails when it drifts.** A new
`AI_SURFACES` registry in `src/ai/`:

```ts
{ key: 'doc_intel',
  routes: ['POST /engines/doc-intel', 'POST /documents/:id/analyze'],
  purposeKey: 'ai_document_review',        // must exist in the tenant's pack (§2.2)
  inputs: ['uploaded document contents', 'document type'],
  output: 'a flag for human review',
  producesLegalEffect: false,
  humanInTheLoop: 'a staff reviewer approves or rejects; the system never approves',
  citationEnforced: true }
```

The registry is worthless without the guard, and the guard is the reason to believe the
disclosure. **A spec parses the controllers named in §1.6 and fails if any route on
`AiController`, `EnginesController`, `OrchestrationController` or `POST /documents/:id/analyze` is
absent from `AI_SURFACES`.** This is `capabilities-regulators.spec.ts`'s technique, chosen for
its track record: that list "was authored with that instruction in its own comment and still
drifted in SEVEN of eight rows" (`capabilities.service.ts:57-70`). A registry with a prose
instruction and no test will drift the same way, and this one has a legal deadline attached.

**Source 2 — the tenant's resolved pack.** Every `prompts[]` entry (9 in each shipped vertical,
0 in every country overlay — §1.6) and every `messaging.sequences[]` entry is enumerated with its
`key`, its declared purpose and where it is used. **This is the source most likely to be
forgotten**, and omitting it means a pack author adds an AI surface and the disclosure silently
stops being complete — with no code change to notice.

**Source 3 — what is actually configured.** Whether an AI provider is connected for this tenant
(`AI_PROVIDER_ADAPTERS` / `tenant_connectors`), and whether citation enforcement is on. Reported
in the existing four-valued vocabulary (`live | degraded | unconfigured | unknown`,
`capabilities.service.ts:35`). A surface that **cannot run** is disclosed as *present and not in
use*, never omitted and never claimed. Omitting it would understate; claiming it would overstate;
both are the same failure in opposite directions.

**Three things the disclosure must never do.** It must never say "we do not use automated
decision-making" — it enumerates. It must never describe an assistive surface as a decision:
FR-13.1 forbids stating or implying a likelihood of approval, FR-13.2 makes the output "a flag for
human review, never an approval," and the disclosure has to use those words rather than softer
ones. And it must never render a surface whose `citationEnforced` is false as a normal answer —
`CLAUDE.md` §7.3 lists `citationEnforced: false` as "unsourced", and the interceptor already sets
that flag rather than hiding it (`citation-enforcement.interceptor.ts:18-26`).

**Where it is published.** Tenant-scoped (`firm_admin`/`staff` read the full report), and the
subject-facing rendering is reachable in the client portal at `own` scope — a disclosure the
subject cannot read is not a disclosure. FR-13.5's other half — "every AI surface is labelled
AI-assisted at the point of use" — is Mira's, and this ADR gives her the registry to drive the
label from so the label and the disclosure cannot disagree.

**The date.** BR-6: **before 10 December 2026**. R3. The registry, the spec and the route are the
minimum; the *content* of each `purposeKey`'s description is Legal's, and it is on the critical
path. `[NEEDS DECISION: the disclosure text per AI surface — Legal. The engineering can be
complete and the obligation still unmet if this is not written.]`

### 2.6 D6 — Consent reports; it blocks only where the act itself is the harm

**Decision.** `GET /crm/entities/:id/consent` and `GET /compliance/consent?subjectEmail=` report
the four-valued state (§2.1). **Consent does not silently block a generic write.**

This mirrors `PackRuleService`, which is read-only by design — "nothing blocks a write"
(`CLAUDE.md` §16) — and for the same reason: a system that refuses arbitrary operations on a
consent state a firm has not yet configured is a system that stops working the day it ships.

**Three named gates are hard refusals**, driven by `consentPurposes[].gates` (§2.2):

| Gate | Enforced at | Why hard |
|---|---|---|
| `marketing_messaging` | `SequenceRunnerService.run` — refuse to enrol a subject whose purpose is not `granted` (`src/notifications/sequence-runner.service.ts:86+`) | Sending is an irreversible act performed on a person. A report after the fact is not a remedy |
| `ai_processing` | `AiService`, before a prompt carrying the subject's record is executed | The processing is the thing consented to; doing it and reporting it is not consent |
| `third_party_disclosure` | ADR 0016's referral gate, and any export naming a third party | Disclosure cannot be un-disclosed |

Each refusal names the purpose and the state (`not_asked` vs `withdrawn` vs `expired`) — never a
bare 403. Error code: **`MER-TENANT-0010` `CONSENT_NOT_GRANTED`**, HTTP **409** — a configuration
and state conflict a retry cannot fix, the same reasoning `TENANT_CONNECTOR_NOT_ENABLED` uses for
its 409 (`src/common/types.ts:76-79`). `MER-TENANT-0009` is the current end of the family.

**A purpose with no `gates` entry blocks nothing**, which is why §2.2 makes `gates` explicit
rather than inferring it from `required`.

### 2.7 D7 — What must be decided, and what the platform does until then

BRD **D-7** ("Data retention periods per jurisdiction") is open, and this ADR does not close it —
it makes the shape decidable and states the behaviour in the meantime.

| Open decision | Owner | Behaviour until decided |
|---|---|---|
| Retention period per jurisdiction, per `dataClass` (D-7) | Legal | Audit: the vertical pack's number (7y / 5y). Records, documents, communications: **nothing is deleted and the report says `unenforced`** |
| The initial `consentPurposes[]` for `verticals/immigration.json` (§2.2) | Legal / Operator | The consent surface shows zero purposes, honestly |
| The PII column inventory across ~64 tables (§2.4b) | Anton to produce, Legal to confirm | **`POST /compliance/erasure` does not ship.** It is not shippable against a guessed list |
| Disclosure text per AI surface (§2.5) | Legal | The route returns the structural report with `description: null` per purpose, marked incomplete — never a placeholder sentence that reads like a disclosure |
| Whether `consent_records` needs its own WORM trigger | Anton | Service invariant only (§2.1) |

**None of these blocks the engineering.** All of them block the *claim*. A tenant-facing screen
that says "your retention policy is configured" while three of four data classes are unenforced is
the failure this whole product is positioned against, and the report must say `unenforced` in
those rows.

### 2.8 D8 — Migration

`1757300000000-AddConsentAndRetention`: `consent_records`, `tenant_retention_policies`, their
indexes, and `ENABLE` + `FORCE` RLS with `tenant_isolation` on both — structurally identical to
`1756700000000-AddTenantFeeOverrides.ts:46-59`, never retrofitted.

No change to `audit_logs`, its trigger, or its schema. `MER-TENANT-0010` is a TypeScript enum
addition with no migration.

Registered in `ALL_MIGRATIONS` (`src/config/migrations.ts:55`) **in the same commit** — workspace
`CLAUDE.md` §16 records that omission recurring four times. `npm run rls:verify` against the two
new tables specifically.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| A single `consents jsonb` blob on `UniversalEntity` | Cannot be indexed for "which consents expire this month", cannot carry a per-row disclosure hash, and a blob is edited in place — which loses the "was it valid on 4 March" answer that is the only question that matters in a dispute (§2.1) |
| A mutable consent row with `withdrawnAt` | Same objection: the history *is* the record. Withdrawal is a new state, not an edit |
| A boolean `consentGiven` at signup | Exactly what NFR-7 forbids: "per purpose, with expiry, never one global tick at signup." There is no row shape here that can express "agreed to everything" (§2.1) |
| Treat "no consent row" as refused | Turns a gap into a decision the subject never made, and would silently disable features for every existing record on the day this deploys. `not_asked` ≠ `refused` is the same distinction the checklist already draws (§2.1) |
| Treat "no consent row" as granted | The inverse lie, and the more dangerous one |
| Consent purposes hardcoded in core | Layer 4 vocabulary in the horizontal engine — §7.1. A firm's purposes differ by jurisdiction and by practice |
| Anonymise `audit_logs` rows in place (ADR 0009 §5's suggestion) | **Not implementable.** The WORM trigger compares the whole row minus `archived` and raises on any other change (§1.4). It would require deliberately disabling the control |
| Redact only the columns outside the hashes (`userEmail`, `description`, `context`, `changes`) | Cryptographically possible (§1.4) and still rejected: it requires relaxing the trigger's whole-row rule, producing a schema where some audit columns are mutable and the next reader must know which. The trigger's own comment explains why enumerating columns is the wrong default (`1755200000000:46-51`) |
| Delete a subject's audit rows on erasure | Blocked by the database, and correctly: the record of what happened to a person's data is exactly what a dispute or an incident review needs to outlive the decision to delete (ADR 0009 §2.1's reasoning, applied to a subject instead of a tenant) |
| Retroactively redact PII from existing audit rows | Same trigger. §2.4c is forward-only and says so rather than implying a cleanup exists |
| Encrypt audit PII with a per-subject key and destroy the key on erasure (crypto-erasure) | Genuinely viable and genuinely larger: it needs a key store, a rotation story, a key-loss failure mode, and it makes `verifyChain` depend on key availability. Worth its own ADR if erasure of audit content is ever mandated. Not a paragraph in this one |
| Retention periods in the country overlay only | All eight overlays declare `compliance: null` today (§1.2), and — more decisively — the sweep runs with no ambient tenant and therefore cannot read a pin at all (§1.2 item 3). Fixing only the data without fixing the resolution changes nothing |
| Extend the retention sweep to delete documents/records now | There is no decided period to delete against (D-7 is open), and these are deletions of primary data rather than an archive flag. Building it against a guess is guessing at law (ADR 0009 §3's stated reason for refusing the same thing) |
| A hand-written per-tenant disclosure document | Stale the first time a route or a pack prompt is added, with nothing to detect it. The 7-of-8 drift in `capabilities.service.ts`'s regulator list is the measured precedent (§2.5) |
| Generate the disclosure from `src/` alone | A pack author can add an AI surface with no code change — 9 `prompts[]` per vertical today, and the schema exists precisely so a pack can ship more (§1.6) |
| Omit unconfigured AI surfaces from the disclosure | Understates. A surface that exists and is not in use is disclosed as exactly that — the `unconfigured` vocabulary already exists for this (§2.5) |
| Block every write on missing consent | The `PackRuleService` lesson: a system that refuses arbitrary operations against a consent vocabulary a firm has not configured stops working on day one (§2.6) |
| Report-only for marketing sends and AI processing too | Sending and processing are irreversible acts performed on a person. A report after the fact is not a remedy (§2.6) |

---

## 4. Consequences

1. **Two new RLS-carrying tables**, one new pack section, one new error code, one new route
   family, and a redaction pass inside `AuditService.logEvent` — the last being the only change to
   a hot path that every write in the system goes through. Owen's review should include a case
   asserting the chain still verifies across the redaction boundary.
2. **A new pack section is the highest-risk single item.** Miss the `upsertPack` key and the whole
   consent surface renders empty while every test passes (§2.2). The loader spec case goes in the
   same commit as the schema change, not after.
3. **The disclosure route will initially report incompletely and must say so.** `description:
   null` per purpose until Legal writes them, marked incomplete — never a placeholder sentence
   that reads like a disclosure.
4. **`POST /compliance/erasure` does not ship in the same release as the rest.** It is gated on
   the PII column inventory (§2.7), and that is a real dependency rather than a formality: an
   erasure that misses a column is an erasure the firm has told a client happened.
5. **Retention behaviour changes for pinned tenants.** Today every tenant gets the base pack's
   number; after §2.3c a pinned tenant gets its overlay's, if one is ever declared. No overlay
   declares one today, so **the observable behaviour does not change on deploy** — which makes
   this a safe change to land early, and a change whose effect arrives later, silently, when
   somebody authors a `compliance` block in an overlay. That is worth a line in the pack-authoring
   notes.
6. **Three of four `dataClass` values are declared and enforced by nothing.** The report must
   render them `unenforced`. A firm that sets a document retention policy and sees it accepted
   will believe it is running.
7. **`consent_records` holds `subjectEmail`, `ipAddress` and `userAgent` for people who may later
   request erasure** — and §2.4b keeps it deliberately. That is a defensible position (the record
   is the evidence the erasure was lawful) and it is exactly the kind of position that must be
   written down before someone "tidies it up."
8. **This ADR corrects an accepted-direction row of ADR 0009.** 0009 §5's erasure trigger row
   should be read together with §2.4a here; the export-then-anonymise design it anticipated is
   viable for *operational* tables and not for `audit_logs`.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A regulator requires provable erasure of audit *content*, not just operational data | D4's "audit is retained under a separate basis" | Crypto-erasure (rejected in §3 on scope, not on merit): per-subject key wrapping of the PII portion, key destroyed on erasure. It is its own ADR, and it makes `verifyChain` depend on key availability — decide that consequence deliberately |
| The S3 Object Lock export named in `1755200000000`'s comment is built | Nothing here — but it changes what "the audit log is immutable" is worth as a claim | Update the disclosure text: today the honest claim is "append-only by database enforcement, defeatable only by a superuser DDL," not "immutable" |
| A jurisdiction requires a retention period **shorter** than the audit archive currently keeps | D3's floor and D4's residual — the sweep archives, it never deletes | This is the case where "archived, not deleted" stops being sufficient. It needs a decided, audited, DBA-executed purge procedure with the trigger disabled and re-enabled under change control — a runbook, not a code path |
| Consent needs to be provable against tampering (a dispute where the firm is accused of fabricating a consent row) | D1's "service invariant, not a trigger" | Add a WORM trigger and a hash chain to `consent_records`, mirroring `audit_logs`. Small migration, and the append-only shape already assumed here means no data model change |
| A pack author adds an AI surface via `prompts[]` and it does not appear in the disclosure | D5's source 2 | That is the bug D5 exists to prevent; if it happens, the pack-derived half was not built. Do not patch the disclosure by hand |
| The `AI_SURFACES` spec starts failing on legitimate new routes often enough to be edited around | D5's guard | Do not relax it to a warning. The 7-of-8 drift is what a warning produces (§2.5) |
| A second vertical (GRC) needs materially different consent purposes | Nothing — `consentPurposes[]` is per pack, which is the point | Author them in `verticals/grc.json`. Confirm the `gates` vocabulary still covers what GRC needs before adding a fourth gate |
| 10 December 2026 approaches with Legal's disclosure text unwritten | Nothing architectural | Escalate. The engineering being complete does not satisfy BR-6; the disclosure is the deliverable, and this is the item most likely to be assumed done because the route exists |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `consent_records` table | `DROP TABLE "consent_records"` | **Every recorded consent and withdrawal is destroyed** — including the evidence that an erasure already performed was lawful. Export before dropping. Do not roll back once any real consent exists; remove the routes instead |
| `tenant_retention_policies` | `DROP TABLE "tenant_retention_policies"` | Any firm's own retention decision is lost and silently reverts to the vertical default — a **change in retention behaviour with no notice to the firm**. Confirm with affected tenants first, the same caution ADR 0009 §6 gives for `tenant_fee_overrides` |
| `consentPurposes[]` pack section | Remove from `pack.schema.ts`, `upsertPack` and the pack files; bump the pack `version` | Stored packs keep the key in `config_packs.schema` until the next load, harmlessly. `consent_records` rows keep `purposeKey` strings that resolve to nothing — the resolver must render an unknown purpose key as the raw key, never drop the row |
| `RetentionService` per-tenant resolution (§2.3c) | Revert to `runAsSystem` for the whole loop | None — no overlay declares a period today, so behaviour is identical either way (§4 item 5) |
| `AuditService.logEvent` redaction (§2.4c) | Revert the commit | **Rows written while it was live stay redacted, permanently** — the trigger forbids restoring them. This is a one-way door and should be treated as one: land it deliberately, not as part of a larger commit |
| `GET /compliance/automated-decisions` + `AI_SURFACES` + its spec | Remove the route, the registry and the spec | None — a pure read. **But BR-6's obligation does not roll back with it**, and removing it after 10 December 2026 puts the platform out of compliance rather than merely un-featured |
| `MER-TENANT-0010` + the three §2.6 gates | Remove the code and the gate checks | Marketing sends and AI processing resume for subjects who have not consented. **This is the rollback most likely to be requested under delivery pressure and least safe to grant** — the gates are the only place consent has effect |
| `POST /compliance/erasure` | Remove the route | Erasures already performed are **not reversible** — that is what erasure means. The audit entries recording them remain (WORM), which is correct: the record that data was erased is exactly what survives |

**Rollback verification.** Before dropping `consent_records`, confirm no erasure has been
performed in reliance on a withdrawal row it holds. Before reverting the redaction pass, confirm
the deploy window — rows on either side of it have different fidelity, and the boundary should be
a known timestamp, not a mystery.

---

## 7. Open items for implementers

| # | Item | Owner |
|---|---|---|
| 1 | **Author `consentPurposes[]` for `verticals/immigration.json`, with lawful basis per purpose** (§2.2, §2.7) | Legal / Operator |
| 2 | **Decide retention periods per jurisdiction per `dataClass`** — BRD D-7 (§2.7) | Legal |
| 3 | **Produce the PII column inventory across the ~64 RLS tables.** `POST /compliance/erasure` does not ship without it (§2.4b) | Anton → Legal |
| 4 | **Write the disclosure text per AI surface.** BR-6, before 10 Dec 2026 (§2.5) | Legal |
| 5 | Three-part pack commit for `consentPurposes` — schema, `npm run packs:schema`, **and the `upsertPack` key** (`config-pack-loader.service.ts:497-537`), with the loader-spec case in the same commit (§2.2) | Luke |
| 6 | `AI_SURFACES` registry **plus** the drift spec over the four controllers in §1.6. The spec is the deliverable, not the registry | Luke |
| 7 | Bind the tenant for the per-tenant portion of `RetentionService.sweep` so pins resolve (§2.3c) | Luke |
| 8 | Redaction pass in `AuditService.logEvent` before checksum computation; spec asserting `verifyChain` holds across the boundary (§2.4c) | Luke / Owen |
| 9 | The three hard gates in `SequenceRunnerService`, `AiService` and the ADR 0016 referral path, each naming the purpose and the state (§2.6) | Luke |
| 10 | Register `AddConsentAndRetention1757300000000` in `ALL_MIGRATIONS` in the same commit; `npm run rls:verify` against the two new tables | Luke / Anton |
| 11 | Review: `consent_records` holds `subjectEmail`/`ipAddress`/`userAgent` and is deliberately exempt from erasure (§4 item 7) | Anton |
| 12 | Consent UI renders four states — `granted` / `expired` / `withdrawn` / **`not_asked`** — and never an unticked box for a purpose never asked (§2.1). Retention UI renders three `dataClass` rows as **`unenforced`** (§4 item 6) | Mira |
| 13 | "AI-assisted" labels at the point of use, driven from `AI_SURFACES` so the label and the disclosure cannot disagree — FR-13.5 (§2.5) | Mira |
| 14 | Update `docs/adr/README.md`: 0009 §5's audit-anonymisation row is superseded by 0017 §2.4a (§4 item 8) | Kyle |
