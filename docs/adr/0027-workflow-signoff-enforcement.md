# 0027 — Workflow sign-off enforcement, gated on the practitioner-credential column

**Status:** Proposed — 2026-09-17, not merged. **Narrows ADR 0001 §7, does not supersede ADR
0001's other sections.**

**Owner:** Kyle (architect). Implementation: Luke (backend-dev), Mira (frontend-dev). Review/gate:
Owen (quality). This ADR does not touch a tenancy boundary beyond what
`POST /workflows/instances/:id/transition` already enforces, so Anton's review is recommended but
not mandatory in the way ADR 0026's is.

**Scope:** ImmiStack PRD FR-1.2's second sentence ("only a credentialed user may sign off advice,
lodgement or review advice"), `immistack/CLAUDE.md` §2 row "Sign off advice, lodgement, ART
advice — `agent` **only**", and §2's consequence 1: "Store `signedOffBy` on the transition, not
just `updatedBy`."

**Verified against:** `meru-core/src/workflow/` and `docs/adr/0001-practice-role-tags.md` on disk,
2026-09-17.

---

## 1. Context

### 1.1 What is already built

- **The practitioner credential itself.** `users.practitionerCredential` +
  `practitionerCredentialType`, a CHECK-paired nullable varchar pair, migration
  `1756920000000-AddUserPractitionerCredential.ts`, registered in `ALL_MIGRATIONS`. Admin-only
  write via `PATCH /iam/users/:id`. `DirectoryUser.practitionerCredentialVerified` is always sent
  as `false` — nothing checks the number against a real registry (`meru-core/CLAUDE.md` §13, every
  regulator adapter is sandbox). **This ADR treats "has a non-null `practitionerCredential`" as the
  gate**, and inherits that same honesty constraint: it proves a firm *recorded* a registration
  number, never that the registration is real or current.
- **The workflow transition plumbing `signedOffBy` needs.** `WorkflowTransition.permissions`
  (`src/workflow/entities/workflow-transition.entity.ts:71-76`) is an untyped jsonb column already
  carrying `roles`/`users`/`requireApproval`/`approvers` — extending it needs no migration.
  `WorkflowInstance.history[]` (`src/workflow/entities/workflow-instance.entity.ts:69-86`) is
  already an append-only jsonb array carrying `automated`/`automatedBy` as an ADR 0018 precedent
  for "add an optional field to a history entry, genuinely absent rather than `false`, so old and
  new entries stay distinguishable" — this ADR follows that exact pattern for `signedOffBy`.
- **`checkPermissions`** (`src/workflow/workflow.service.ts:782`) and its call site
  (`workflow.service.ts:526-534`) — the existing role gate this ADR's new check sits immediately
  after, same as ADR 0001 §7 specifies.
- **The AU pack's real step ids**, `wf_visa_matter`
  (`packages/config-packs/countries/au-immigration.json:30-243`): `intake, cost_agreement,
  signup_payment, portal_access, document_request, health_insurance, drafting, client_approval,
  apf, lodgement_fee, lodged, decision, art_review, closed`. **There is no step literally named
  `advice_given`** — ADR 0001 §7's example names were illustrative, not verified against the pack.
  This ADR does not author pack changes (§8, out of scope, matching ADR 0001's own discipline of
  leaving pack authoring to a separate commit) but corrects the record: the steps a pack author
  should consider for `requiresSignOff: true` are `lodged` (lodgement) and `art_review` (ART
  advice) at minimum, per `immistack/CLAUDE.md` §2's three named actions — "advice" itself is
  currently folded into the `decision` step's written-advice sequence
  (`immistack/CLAUDE.md` §5.1 step 5), so `decision` is the third candidate. Which steps get the
  flag is a pack-authoring decision, made with product input, not architecture.

### 1.2 What ADR 0001 §7 already specified, and what this ADR narrows

ADR 0001 is **Accepted** and its own header calls it "an executable contract for implementation —
Luke implements against this without a second design decision." §7 fully specifies the
`requiresSignOff`/`signOffRole` pack fields, the materialisation change, the `executeTransition`
gate, and the `signedOffBy` history field. **This ADR does not redo that design.** It changes
exactly one thing: **who counts as eligible to satisfy the gate.**

ADR 0001 §7's `signOffRole` mechanism requires matching a pack-declared role string against
`User.verticalRoles ∪ PlatformRole`, where `verticalRoles` is a **new column that does not exist**
(ADR 0001 §3) and requires its own rollout before it can gate anything safely: a pack-vocabulary
validator, a grant route with its own DTO and audit write (§8), a JWT payload change threaded
through four call sites (§5), and — the part with real production risk — a **census query that
must return zero rows for every tenant with a materialised gated transition before enforcement can
ship** (§9), because flipping the gate before every currently-working staff member has been tagged
"locks out every actor on every gated transition in every tenant that has materialised a pack
workflow."

That machinery is the right long-term answer to "which of several named practice roles may sign
off *this specific kind* of step" — GRC's hypothetical `mlro`-only SAR filing is exactly the case
it was built for. **It is not required to answer FR-1.2's actual question for ImmiStack today**,
which is narrower: ImmiStack has exactly one sign-off-capable practice role (`agent`/RMA), and the
practitioner-credential column already distinguishes "a credentialed practitioner" from "not one"
without needing a second vocabulary, a JWT change, or a tenant-by-tenant rollout gate.

---

## 2. Decision

**The sign-off gate is "does the acting user hold a non-null `practitionerCredential`", checked by
a live database read at transition time — not by matching a pack-declared role string against
`User.verticalRoles`.** ADR 0001 §7's pack schema field, materialisation change, gate placement,
and `signedOffBy` history field are **adopted verbatim** with one rename
(`signOffRole: string` → `requiresSignOff: boolean`, since there is now only one thing to require,
not a role to name) and one implementation change (a fresh DB read, not a JWT claim).

### D1 — pack schema: `requiresSignOff: boolean`, not `requiresSignOff` + `signOffRole`

```ts
// packages/config-packs/_schema/pack.schema.ts, WorkflowStepSchema — pack-schema change,
// NOT performed in this ADR, out of write scope (matching ADR 0001's own discipline)
const WorkflowStepSchema = z.object({
  // ...existing fields...
  requiresSignOff: z.boolean().default(false),
  // NOTE: no `signOffRole` field. See §7 for when to add it back.
});
```

Two-part commit (Zod + `npm run packs:schema`) — `workflows[]` is already a persisted top-level
array, so no loader key-list change.

### D2 — materialisation: `PackWorkflowService.materialise` (`src/workflow/services/
pack-workflow.service.ts:202`)

```ts
permissions: {
  roles: step.assignedRole ? [step.assignedRole] : [],
  requiresSignOff: step.requiresSignOff ?? false,   // was: signOffRole: string | null
},
```

### D3 — the gate: `WorkflowEngineService.transition` (`src/workflow/workflow.service.ts`),
immediately after the existing `checkPermissions` call (currently lines 526-534), before the
payment-arrears check (currently line 548)

```ts
if (transition.permissions.requiresSignOff) {
  const actor = await this.usersRepo.findOne({
    where: { id: request.userId, tenantId: instance.tenantId },
    select: ['id', 'practitionerCredential', 'practitionerCredentialType'],
  });
  if (!actor?.practitionerCredential) {
    throw new BadRequestException(
      `Transition to '${transition.toState.name}' requires sign-off by a registered ` +
        `practitioner. This actor has no recorded practitioner credential.`,
    );
  }
}
```

**Why a live read, not a JWT claim — the deliberate departure from ADR 0001 §5's pattern.** ADR
0001 needed a JWT claim because `verticalRoles` is checked on **every** gated transition, a
potentially hot path, and a per-request DB read for that was judged worse than a bounded
(≤1-hour) staleness window (ADR 0001 §13, "Unpleasant, accepted"). This gate has the opposite risk
profile: `requiresSignOff` fires only on the handful of steps a pack author deliberately flags
(lodgement, ART advice, the decision/advice step — three or four transitions per matter, not
every transition), so the extra query is cheap in aggregate; and the thing being gated is a
professional registration that can be **revoked**, where a staleness window of up to an hour means
a practitioner whose credential a `firm_admin` just cleared (a compliance action, presumably
urgent) could still sign off a lodgement for up to an hour after. For a Code-of-Conduct gate, that
window is the wrong trade to accept for a query cost this small. **This is the one place this
ADR's design is more conservative than ADR 0001's own precedent, and it is a deliberate choice, not
an oversight.**

### D4 — history entry: `WorkflowInstance.history[]` (`workflow-instance.entity.ts:69-86`), push
site `workflow.service.ts:623-633`

```ts
history: Array<{
  // ...existing fields, unchanged...
  automated?: boolean;
  automatedBy?: string;
  /**
   * The signing practitioner's userId — present, and only present, when this
   * transition's `requiresSignOff` gate was satisfied. Never `triggeredBy`:
   * a record of WHOSE sign-off satisfied the Code of Conduct requirement,
   * distinct from who triggered the state change (normally the same person,
   * but the automated-transition path in ADR 0018 makes `triggeredBy` the
   * system actor while a sign-off, by construction, can never be automated —
   * `requiresSignOff` and `request.automated` are mutually exclusive in
   * practice and this field makes that verifiable after the fact).
   */
  signedOffBy?: string;
  /** Snapshot of the credential AT THE TIME of sign-off — see D5. */
  signedOffCredential?: { type: string; number: string };
}>
```

Populate at the push site:

```ts
...(transition.permissions.requiresSignOff
  ? { signedOffBy: request.userId, signedOffCredential: {
        type: actor.practitionerCredentialType!, number: actor.practitionerCredential! } }
  : {}),
```

(`actor` is the row already loaded by D3's check — no second query.)

### D5 — the credential snapshot, a small addition beyond ADR 0001 §7's original spec

ADR 0001 §7 records only the actor's userId on the history entry. **This ADR adds a snapshot of
the credential itself** (`signedOffCredential: {type, number}`), because a credential is not
append-only reference data the way a user record mostly is — `PATCH /iam/users/:id` can change or
clear `practitionerCredential` at any time (it is admin-editable, per FR-1.2's migration comment,
with no history of its own). Without the snapshot, a dispute six months later asking "who was
registered to sign this off, and under what number" would have to trust that the user row's
*current* credential matches what it was at sign-off time — which is exactly the kind of "a record
of what was agreed, not what somebody last typed" distinction ADR 0008 D6 makes for
`vacSettlementMode`, applied here to a regulatory attestation instead of a payment field. The
evidence pack (`immistack/CLAUDE.md` §4.7) explicitly reads `signedOffBy` from the stage-by-stage
work log — it needs the credential number that was true at the time, not today's.

---

## 3. API contract

**No new route.** This ADR changes the behaviour of `POST /workflows/instances/:id/transition`
(existing, `workflow.controller.ts:257` per ADR 0001 §5 — `[UNVERIFIED: exact current line number,
not re-read for this ADR; the route itself is not moving]`) and adds fields to
`WorkflowInstance.history[]`, already returned by every route that reads an instance
(`GET /workflows/instances/:id`, `[UNVERIFIED: exact route name — not re-read for this ADR, but no
new route is being proposed regardless of its exact spelling]`).

**New error shape on the existing route:** `400`, same `BadRequestException` family the adjacent
`checkPermissions` failure already uses on this exact code path (line 533) — **not** a new `MER-*`
code. Consistency with the immediately-preceding check matters more than a dedicated code here:
both are "you may not make this transition" refusals on the same route, and splitting them into
different error families would make client-side handling worse, not better, for no benefit.

---

## 4. Data model

**No migration.** `permissions` and `history` are both already-schemaless jsonb columns
(`workflow-transition.entity.ts:71`, `workflow-instance.entity.ts:69`) — this is two TypeScript
type extensions plus a pack-schema change, exactly as ADR 0001 §7 states for its own version of
this mechanism.

**One module-wiring change:** `WorkflowModule` (`src/workflow/workflow.module.ts:25-34`) does not
currently import the `User` entity. Add it to the existing `TypeOrmModule.forFeature([...])` array
— read-only, matching the pattern already used there for `UniversalEntity` ("Read-only here —
instance-ownership scoping... same pattern as `documents.module.ts`'s `DocumentAccessService`").
No new module import, no circular-dependency risk (`User` imports nothing from `workflow/`).

---

## 5. Tenancy enforcement

The gate is evaluated **inside** `WorkflowEngineService.transition`, which already runs on a
request scoped to `instance.tenantId` (the instance itself was loaded via `findInstanceOrThrow`
with tenant scoping — this is pre-existing and not changed by this ADR). D3's new query adds
`tenantId: instance.tenantId` to its own `where` clause explicitly, rather than relying solely on
RLS, matching the "two independent narrowings" discipline `meru-core/CLAUDE.md` §8 now requires
everywhere a query touches actor-identifying data: **RLS confines the connection to the tenant;
the explicit `tenantId` in the query is the second layer**, cheap to add and consistent with every
other query in this file.

No new client-reachable surface. A `client` token cannot call `POST /workflows/instances/:id/
transition` in the first place on any transition carrying `permissions.roles` — this is unchanged,
pre-existing behaviour this ADR does not touch.

---

## 6. Audit events

`logWorkflowTransition` (`src/audit/audit.service.ts:177`) already fires on every transition. This
ADR extends its `context` payload (already `Record<string, any>`, no schema change) to include
`signedOffBy`/`signedOffCredential` when present, so a query against `audit_logs` for "every
sign-off this quarter" does not require walking `workflow_instances.history[]` for every instance
— the audit log becomes the queryable index, the history array stays the authoritative per-instance
record. No new audit action type; `AuditAction.WORKFLOW_TRANSITION` already exists and is unchanged.

---

## 7. Pack keys needed

| Key | Nests under | Status |
|---|---|---|
| `workflows[].steps[].requiresSignOff` | `workflows` (already persisted top-level array) | Zod schema change, two-part commit |

**No `roles[]` change, no new pack vocabulary.** This is the direct consequence of D1's narrowing
— ADR 0001 §7's version would have needed `roles[]` entries for `agent` (and the rename table in
ADR 0001 §6, `migration_agent` → `agent`) before enforcement could ship at all; this version needs
neither.

---

## 8. Options considered and rejected

- **Build ADR 0001 §7 as originally specified (`signOffRole` matched against `User.verticalRoles`).**
  Rejected for R1: correct long-term design, wrong-sized for the actual current requirement (§1.2),
  and carries real deployment risk (the census-to-zero gate) for a distinction — *which* named
  practice role, not merely *whether* one exists — that no current product requirement asks for.
- **Gate on `User.roles` containing a `PlatformRole` value instead of the credential column.**
  Rejected: `PlatformRole.STAFF` and `PlatformRole.FIRM_ADMIN` both include people who are not
  registered practitioners (a paralegal is `staff`; a firm's office manager can be `firm_admin`).
  This would fail to exclude exactly the people FR-1.2 exists to exclude.
- **Gate on `verticalRoles` but skip the JWT/rollout machinery by reading it live, same as this
  ADR's credential check.** Considered seriously — it removes ADR 0001 §5's JWT plumbing and §9's
  census-gate risk while keeping the richer "which named role" vocabulary. Rejected only because
  the *carrier itself* (`User.verticalRoles`, ADR 0001 §3) still does not exist and still needs its
  own migration, its own grant route (§8), and its own pack `roles[]` rename (§6) before a live
  read of it would return anything meaningful — none of which this ADR's narrower scope needs to
  build. If a second sign-off-capable role is ever needed (§9's trigger), **this is the option to
  revisit first**, because it keeps ADR 0001's richer vocabulary while dropping only the JWT-staleness
  trade-off this ADR already independently rejected in D3.
- **A boolean flag directly on `WorkflowTransition.permissions` set by hand per tenant**, bypassing
  the pack entirely. Rejected — reintroduces the exact "vertical vocabulary hardcoded per tenant"
  violation `meru-core/CLAUDE.md` §5.5b forbids by name (`if (tenant === 'x')`), just expressed as
  a database row instead of an `if` statement.

---

## 9. Consequences, including the unpleasant ones

1. **Any credentialed practitioner may sign off any `requiresSignOff` step, regardless of which
   practice role they otherwise hold.** A `firm_admin` who happens to also be a registered
   migration agent (plausible at a small firm) can sign off lodgement even though `firm_admin`'s
   normal role in `immistack/CLAUDE.md` §2 is administrative, not casework. This is **correct**
   under Australian Code of Conduct reasoning — the requirement is "a registered agent signed this
   off", not "someone in a specific job title did" — but it means this gate is *slightly* more
   permissive than ADR 0001 §7's role-matched version would have been, which could additionally
   restrict *which* credentialed practitioners on a specific step type. No current requirement asks
   for that narrower restriction (§8).
2. **No enforcement of "the credential is for the right jurisdiction/registry."** `MARN` and
   `OISC` and `RCIC` are treated identically — any non-null `practitionerCredentialType` satisfies
   the gate. A UK-registered practitioner's credential (if such a user existed in an AU-only
   tenant) would pass. Given ImmiStack tenants are single-country per `immistack/CLAUDE.md` §5 and
   no cross-jurisdiction staffing scenario is described anywhere in the product docs, this is
   accepted rather than engineered against; §7 names the trigger to revisit.
3. **The credential is self-asserted and unverified** (§1.1, inherited from FR-1.2's original
   migration, not new to this ADR) — this gate proves a firm *recorded* a number, never that OMARA
   confirms it is current. This must be stated plainly in every UI surface this ADR's data reaches
   (Mira's brief, §11) — rendering `signedOffBy: <a userId>` as "signed off by a registered agent"
   without qualification would be exactly the §3.1 "a default is a claim" failure applied to an
   attestation instead of a stage field.
4. **A firm with zero credentialed users cannot progress past any `requiresSignOff` step, ever,
   with no escape hatch.** This is intentional — the entire point of the gate — but it means a
   pack author flagging a step `requiresSignOff: true` before any user in a tenant has a recorded
   credential locks that tenant's matters at that step. Unlike ADR 0001 §7's version, **this
   version needs no census-query rollout gate** because there is no pre-existing gated transition
   this could newly lock — `requiresSignOff` does not exist in any materialised transition today
   (grep confirms), so shipping this is adding a new constraint to new pack authoring, not
   retrofitting one onto live data. The pack author is responsible for not flagging a step until
   confirming at least one credentialed user exists per tenant using that workflow — an
   operational note for whoever authors the AU pack change, not a code gate this ADR builds.

---

## 10. What would make this decision wrong later — the trigger to revisit

- **If a second sign-off-capable practice role is needed** — e.g. a GRC `mlro`-only SAR-filing
  gate, or an ImmiStack requirement to distinguish "any credentialed practitioner" from
  "specifically the matter's assigned agent." At that point, build ADR 0001 §7's `verticalRoles`
  carrier (§8 of this document names the specific fallback option to prefer: a live read of
  `verticalRoles`, not a JWT claim, extending this ADR's own D3 reasoning rather than reopening
  ADR 0001 §5's staleness trade-off).
- **If jurisdiction-matching becomes a real requirement** (§9 point 2) — the gate would need to
  compare `practitionerCredentialType` against a pack-declared expected registry per country
  overlay, not merely check non-null.
- **If a real registry-verification adapter is ever built** (per FR-1.2's migration comment, "when
  a real registry check exists, it adds its own `practitionerCredentialVerifiedAt` column") — this
  gate should then additionally require `practitionerCredentialVerifiedAt IS NOT NULL`, not merely
  a recorded number. Until then, self-asserted is the honest and only available signal.
- **If `checkPermissions`'s own ADR 0001 §5 deferral-branch deletion ships first** — this ADR's D3
  check is independent of that deletion (it runs regardless of how `checkPermissions` resolves
  `permissions.roles`), so ordering between the two ADRs does not matter, but confirm this
  assumption holds if ADR 0001 §5 lands with any change to the shape of `checkPermissions`'s
  return value.

---

## 11. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| D1 pack schema `requiresSignOff` | Remove the field from `WorkflowStepSchema`, regenerate. Any pack still declaring it is silently stripped by Zod on next load (workspace `CLAUDE.md` §6's "Zod strips anything else, silently") — **not an error**, so confirm no tenant depends on the gate before removing it, the same operational caution ADR 0008 §8 states for its own pack-key rollbacks | None — the field carries no data of its own |
| D2 materialisation change | Revert the commit. Already-materialised transitions keep whatever `permissions.requiresSignOff` value they were materialised with until the tenant re-materialises (same "materialisation is operator-triggered, not automatic" property `meru-core/CLAUDE.md` §16 already documents for `workflows[]`) | None |
| D3 the gate itself | Revert the commit. A transition that previously required sign-off becomes an ordinary role-gated transition again | **`signedOffBy`/`signedOffCredential` entries already written to `history[]` persist** — correct, they are a historical record of what was true when the transition happened, and removing the *check* does not and must not rewrite history |
| D5 credential snapshot | Revert independently of D3/D4 if the snapshot specifically (not the whole gate) needs to be undone — it is additive to the history-entry shape and nothing reads it as required | Existing snapshots persist |

**Rollback verification:** re-run the ImmiStack sweep (33/33). GovX is untouched by this ADR (no
GRC pack change, `WorkflowModule`'s wiring change is vertical-neutral) — confirm with the GovX
sweep (27/28) regardless, per every ADR in this family's standing discipline.

---

## 12. Implementation briefs

### Luke (backend-dev)

1. **`packages/config-packs/_schema/pack.schema.ts`** — add `requiresSignOff: z.boolean()
   .default(false)` to `WorkflowStepSchema` (currently `~line 37`, verify against current line
   count before editing — the file has grown since ADR 0001 was drafted). Run `npm run
   packs:schema`.
2. **`src/workflow/services/pack-workflow.service.ts:202`** — change the `permissions` object
   construction per D2. Update `pack-workflow.service.spec.ts` for the new field.
3. **`src/workflow/entities/workflow-transition.entity.ts:71-76`** — extend the `permissions`
   TypeScript type: add `requiresSignOff?: boolean`. Leave `requireApproval`/`approvers` alone —
   still unwired, still out of scope, per ADR 0001 §7's own note that reusing them would leave two
   half-implemented concepts.
4. **`src/workflow/entities/workflow-instance.entity.ts:69-86`** — extend the `history[]` array
   type with `signedOffBy?: string` and `signedOffCredential?: { type: string; number: string }`
   per D4.
5. **`src/workflow/workflow.module.ts:25-34`** — add `User` (`src/iam/entities/user.entity.ts`) to
   the existing `TypeOrmModule.forFeature([...])` array.
6. **`src/workflow/workflow.service.ts`**:
   - Inject `@InjectRepository(User) private readonly usersRepo: Repository<User>` in the
     constructor.
   - Insert D3's gate immediately after the existing `checkPermissions` block (currently ending
     line 534), before the arrears-gate block (currently starting line 536-548) — the comment
     already there ("The payment gate...") should move to sit after this new block, not be
     interleaved with it.
   - Extend the `history.push({...})` call (currently lines 623-633) per D4, reusing the `actor`
     row already loaded by the gate check above it — do not re-query.
   - Extend the `logWorkflowTransition` call site (wherever the non-automated path's audit write
     happens — `[UNVERIFIED: the exact line for the human-triggered audit call; the automated path
     at lines 573-601 is the only one read for this ADR, and it explicitly only fires `if
     (request.automated)` — confirm where the equivalent human-triggered audit write lives, or
     whether one exists at all, before assuming this extension point exists]`) with the
     `signedOffBy`/`signedOffCredential` context per §6. **If no human-triggered audit write
     currently exists on this path, that is a pre-existing gap this ADR does not introduce and
     should not silently fix inside this commit** — flag it to Owen as a separate finding rather
     than bundling an unrelated audit-coverage fix into a sign-off-enforcement change.
7. Specs: `workflow-signoff.spec.ts` (new) — a transition with `requiresSignOff: true` refuses an
   actor with `practitionerCredential: null`; succeeds for one with it set; `signedOffBy` and
   `signedOffCredential` land correctly on the history entry and nowhere else; a transition without
   the flag is completely unaffected (regression-proves D3 is opt-in per transition, matching
   `assertNoLockedFieldChanged`'s own "opt-in per field" discipline in `crm.service.ts`); the
   credential snapshot reflects the value **at sign-off time**, not a later edit to the user row
   (write the test by signing off, then mutating the user's credential, then re-reading the
   instance history and asserting it did not change).
8. **Pack authoring** (separate commit, not performed here, per ADR 0001's own discipline) — a
   product decision on exactly which AU `wf_visa_matter` steps get `requiresSignOff: true`. §1.1
   names `lodged`, `art_review`, and `decision` as the candidates that map onto
   `immistack/CLAUDE.md` §2's three named actions ("advice, lodgement, ART advice"); confirm with
   product before authoring, and bump `au-immigration.json`'s version in the same commit as the
   flag.

### Mira (frontend-dev)

1. **Render `signedOffBy: null` on a sign-off-required step exactly per `immistack/CLAUDE.md` §3's
   table**: "not yet reviewed by a registered agent" — never "complete", never silently absent.
   This is a render-absent-as-absent case, the same class of failure §3.1 in that document already
   documents for `current_stage`'s default-value trap: **do not let a missing `signedOffBy` fall
   through to whatever the UI shows for a normal, non-gated transition.**
2. **When `signedOffBy` is present, render it alongside its credential** (`signedOffCredential`)
   but **qualify it**: "Signed off by [name], [registration type] [number] (self-recorded, not
   independently verified)" or equivalent — per §9 point 3, an unqualified "registered agent"
   claim overstates what this system actually knows. Match the wording discipline
   `immistack/CLAUDE.md` §9 already uses for the acceptance record's `isSignature: false` ("The
   client ticked a box" and "the client signed" are not the same thing, and a firm will assume they
   are unless told otherwise" — apply the identical caution here to "recorded a credential" versus
   "is a verified practitioner").
3. **Staff UI attempting a gated transition without a credential** — the 400 from D3 should render
   as an actionable message ("Only a registered practitioner may sign off this step — you do not
   have a recorded credential. Ask a firm admin to record one, or have a credentialed colleague
   perform this step."), not a generic error toast. Distinguish this 400 from the adjacent
   `checkPermissions` 400 (insufficient role) if the response bodies differ enough to tell them
   apart; if they do not, that is a signal to give this ADR's error its own distinguishable message
   text at minimum, which D3's implementation already does.
