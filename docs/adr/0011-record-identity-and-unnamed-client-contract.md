# 0011 — Record-identity contract: producers, guarantees, and the "unnamed client" renderer

**Status:** Proposed — 2026-09-09. Not merged. Requires `quality` (Owen) review and `secops`
(Anton) review of the pack-loader validation in §2.3 (a rejected pack is an availability
control, and Anton should confirm the failure direction is correct — reject at load, never at
read). Luke and Mira implement against this contract; this document specifies no feature code.

**Scope:** PRD FR-4.9. Companion to ADR 0010 (client and case numbering), which this document
depends on for part of its fallback chain (§2.4) but does not restate.

---

## 1. Context

### 1.1 The read side already does the right thing; the write side does not

`meru-core-fe/immistack/lib/api/services/clients.service.ts:83-113` (`adapt`) already prefers
the promoted `UniversalEntity.firstName`/`lastName`/`email`/`phoneNumber` columns over the legacy
`verticalAttributes.client` blob, field by field, with a comment stating exactly why: "Promoted
column wins over the stored blob — the column is what other producers write and what the API
filters on." That half of the contract is correct and this ADR does not change it. The problem is
upstream: **two producers create records without ever populating those columns**, so the correct
reader has nothing correct to read.

### 1.2 Producer 1 — lead creation never populates the promoted columns

`meru-core-fe/immistack/components/leads/lead-form-dialog.tsx:72-73,112-113` collects a lead's
name as `first_name`/`last_name` into the lead's freeform `fields` bag (`ImmigrationLead extends
MeruEntity`, and `MeruEntity.fields: Record<string, unknown>` —
`meru-core-fe/immistack/lib/types/meru.types.ts:100`). `leads.service.ts:53-59` (`toEntityDto`)
sends that whole bag as `verticalAttributes: { lead: l }` and **never lifts `first_name`/
`last_name`/`email`/`phone` into the DTO's top-level `firstName`/`lastName`/`email`/
`phoneNumber`** — contrast `clients.service.ts:120-144` (`toEntityDto`), which does exactly this
lift for a directly-created client. A lead is therefore created with `firstName = lastName = email
= null` on `UniversalEntity` from the moment it exists, not just after conversion.

`CrmService.convertEntity` (`src/crm/crm.service.ts:631-693`) confirms this is where the gap
compounds: converting a `LEAD` to `PERSON`/`ORGANIZATION` rewrites `type`, conditionally
`status`, and appends a `conversion` trail into `verticalAttributes` — it **never touches
`firstName`/`lastName`/`email`** (`:663-687`, read in full). If those columns were null going in
(§1.2's first paragraph — they always are, today), they are still null coming out. The record is
now permanently typed `person`, permanently rendered wherever the client list reads promoted
columns, and permanently lacking a name on them.

**This ADR does not ask `convertEntity` to fix it by reading `verticalAttributes.lead.fields`.**
Core has no way to know, generically, that a lead's name lives at `lead.fields.first_name` rather
than `lead.first_name` or `lead.applicant.name` — that is exactly the vertical-specific structure
`meru-core/CLAUDE.md` §7.1 forbids core from learning. The only correct fix is at the producer:
the lead must be created with the promoted columns populated in the first place, the same way
every other producer already is expected to.

### 1.3 Producer 2 — import, audited: currently correct, but not guaranteed correct

`ImportService.commit` (`src/integrations/services/import.service.ts:255-341`) **does** write to
the promoted columns correctly when a mapping's `fields[].to` names one
(`TOP_LEVEL_FIELDS`, `:318-326`, includes `firstName`/`lastName`/`email`/`phoneNumber`; `split`,
`:328-341`, routes each mapped value to the entity column or into `verticalAttributes`
accordingly). Checked against the live pack: `packages/config-packs/verticals/immigration.json`'s
two `importMappings[]` entries both do this correctly today —

```
leads_csv   → lead          "First Name"→firstName (required) "Last Name"→lastName (required) "Email"→email (required)
clients_csv → person        "First Name"→firstName (required) "Last Name"→lastName (required) "Email"→email (required)
```

So import, **as currently configured**, is not producing unnamed records. But nothing in
`ImportService` or `config-pack-loader.service.ts` **requires** this to remain true. A future
country overlay, a GRC import mapping for vendors/counterparties, or a careless edit to
`immigration.json` could declare a mapping whose `targetEntityType` is `person`/`organization`/
`lead` with every `to` pointed at `verticalAttributes.*` and nothing at `firstName`/`lastName`/
`email` — `ImportService.commit` would write it anyway, silently, exactly as it silently writes
today's correct mappings. This is the same shape of gap ADR 0009 §1.4 named for
`firm_professional_482`: a correctness property that happens to hold in the one shipped pack today,
enforced by nothing, and therefore not really a property of the system. §2.3 closes it the same
way `config-pack-loader.service.ts` already closes the analogous `atStep` gap (`:154-187`) — reject
the pack at load time, not the record at write time.

### 1.4 The renderer invents a label today, which is its own instance of the failure this workspace already names

`meru-core/CLAUDE.md` §7.3: "Never render unknown data as a positive result." "Unnamed client" is
exactly that — a fabricated positive-sounding label standing in for "we do not know this person's
name," in **ten** places (`meru-core-fe/immistack`, grepped 2026-09-09):
`app/(workspace)/clients/page.tsx:59,164`, `app/(workspace)/clients/[id]/page.tsx:229`,
`app/(workspace)/payments/page.tsx:91` ("Unnamed applicant"), `app/(workspace)/cases/[id]/page.tsx:500`
("Unnamed"), `components/layout/command-palette.tsx:99`,
`components/matter/acceptance-trail.tsx:73` ("Unnamed subject"),
`components/matter/new-matter-dialog.tsx:72,115`. A staff member reading "Unnamed client" cannot
tell a genuine data gap from a UI placeholder — it reads as a category of client, not as an alarm.
The record's own generated identity (ADR 0010) already exists precisely to give the renderer
something true to say instead.

**The same failure shape, same file class, one more instance.** `SearchService.indexEntityData`
(`src/search/search.service.ts:108-112`) titles an entity `${firstName} ${lastName}`.trim() ||
email || **`'Unknown'`** when none of those resolve — the identical anti-pattern in the search
index rather than the client list. §2.4's fallback chain applies there too.

---

## 2. Decisions

### 2.1 D1 — What every producer must guarantee at write time

**Decision.** Any producer creating a `UniversalEntity` of type `PERSON`, `ORGANIZATION`, or
`LEAD` **must** populate `firstName`/`lastName` (and `email`/`phoneNumber` when the source data
carries them) on the **top-level DTO fields**, not only inside `verticalAttributes`. This is not a
new rule — `clients.service.ts` and `ImportService`'s existing correct mappings already follow it
— this ADR makes it an explicit, named contract so the next producer does not have to rediscover
it by producing broken data first, the way lead creation did.

Concretely, in scope for this ADR:

- **`leads.service.ts:53-59` (`toEntityDto`) must lift `l.fields.first_name`/`last_name`/`email`/
  `phone` into the DTO's `firstName`/`lastName`/`email`/`phoneNumber`**, exactly mirroring
  `clients.service.ts:123-126`. This is the fix for §1.2 — a frontend change, Mira's.
- **No backend change to `convertEntity` is required once the above ships** — conversion already
  preserves whatever is on the promoted columns unchanged (§1.2); if they were populated correctly
  at creation, they survive conversion for free. This ADR explicitly does **not** ask
  `convertEntity` to backfill from `verticalAttributes` (§1.2's own reasoning — an 80/20
  violation).
- **Import (`ImportService`) needs no code change** — it already implements this correctly — but
  gains an enforcement check so it cannot regress silently (§2.3).

### 2.2 D2 — What the server guarantees (and does not)

**Decision, stated explicitly because the negative half matters as much as the positive half:**

- The server persists **exactly** what a caller sends to `firstName`/`lastName`/`email`/
  `phoneNumber` — no normalisation beyond what already exists (e.g. `subjectEmail`'s trim/lowercase,
  `crm.service.ts:236-247`), no derivation from `verticalAttributes`.
- **The server never invents or derives a name from `verticalAttributes` for any type, on any code
  path** — not on create, not on update, not on convert. This is the load-bearing negative
  guarantee: it is what keeps this contract from becoming a second, competing "smart" derivation
  path that could disagree with the vertical's own blob and confuse which one is authoritative.
  Core cannot safely guess where a vertical stores a name (§1.2); it must not try.
- `ADR 0010`'s `recordNumber` **is** guaranteed non-null for every `PERSON`/`ORGANIZATION`/(post-
  conversion) former-`LEAD` record going forward, and for every pre-existing one after that ADR's
  backfill migration runs. This is the one thing about a client record's identity the server can
  promise is always present, which is exactly why it anchors the fallback chain below.

### 2.3 D3 — Pack-load-time enforcement for import: reject, don't silently allow

**Decision.** `config-pack-loader.service.ts` gains a validation function alongside the existing
`danglingStepReferences` (`:160-189`, invoked at `:292-298`), same shape and same failure
direction — **reject the pack at load, name every offending mapping, write nothing**:

```ts
/**
 * Every importMappings[] entry whose targetEntityType is a subject type
 * (person, organization) or lead, but whose fields[] map nothing to
 * firstName, lastName, or email. Such a mapping can only ever produce
 * records with no promoted-column identity — the exact "unnamed client"
 * failure ADR 0011 exists to close off, but at authoring time instead of
 * production data.
 */
static unnamedSubjectMappings(pack: ConfigPackDefinition): string[] {
  const IDENTITY_TARGETS = new Set(['firstName', 'lastName', 'email']);
  const NEEDS_IDENTITY = new Set(['person', 'organization', 'lead']);
  const problems: string[] = [];
  for (const m of (pack.importMappings ?? []) as Array<{
    key: string; targetEntityType: string;
    fields?: Array<{ to: string }>;
  }>) {
    if (!NEEDS_IDENTITY.has(m.targetEntityType)) continue;
    const targets = new Set((m.fields ?? []).map((f) => f.to));
    const hasIdentity = [...IDENTITY_TARGETS].some((t) => targets.has(t));
    if (!hasIdentity) {
      problems.push(
        `importMappings[${m.key}] targets '${m.targetEntityType}' but maps ` +
        `no field to firstName, lastName, or email`,
      );
    }
  }
  return problems;
}
```

Wired into `loadFromDirectory` (or its successor) exactly where `danglingStepReferences` already
runs (`:290-298`) — same `report.errors.push(...); continue;` shape, so an offending pack fails
the same way a `packs:schema`/loader spec failure already does today, with the same visibility
(`config-pack-loader.service.spec.ts` is the precedent for a regex-matching guard test; this needs
its own equivalent case). **Generic, core-neutral by construction:** the check only references
`EntityType` values (`person`, `organization`, `lead`) and the pack's own declared `fields[].to`
— it does not know or care what a "client" is in any vertical's vocabulary, matching the same
justification §2.3 of ADR 0010 gives for `EntityType.CASE`.

**Why reject at load rather than warn, or check at import-commit time instead.** Rejecting at
import-commit time would let a bad pack sit live and undetected until the first real import run —
possibly a firm's entire client base, imported once, silently unnamed, discovered only when someone
notices the client list. Rejecting at pack load surfaces the authoring mistake to whoever is
publishing the pack, before any tenant's data is at risk — the same reasoning `danglingStepReferences`
already uses for `atStep`.

### 2.4 D4 — The renderer's fallback chain: never the literal string "Unnamed client"

**Decision.** Replace every "Unnamed …" literal named in §1.4 (and the search-index `'Unknown'`
title, `search.service.ts:108-112`) with a **strict, ordered fallback chain**, never a single
static string:

1. `firstName`/`lastName` joined and trimmed (today's happy path — unchanged).
2. **`recordNumber`** (ADR 0010) — e.g. `CL-000042`. Guaranteed non-null for every eligible record
   once ADR 0010 ships and its backfill runs (§2.2). This is the chain's real floor: it is always
   present, it is never invented (it is the record's own true, server-assigned identity), and it is
   visually distinguishable from a name.
3. `email`.
4. `phoneNumber`.
5. Only if all four above are somehow absent (pre-ADR-0010 window, or a record of a type ADR 0010
   does not number) — the record's short id, styled identically to how ids are already rendered
   elsewhere in this UI (`text-[10px] font-mono text-muted-foreground/70`,
   `clients/page.tsx:109`), never in the same visual weight as a real name.

**Rendering rule, not just a string swap.** Whatever step 2–5 resolves to must be styled
*differently* from a real name (muted/mono, as already established for ids elsewhere in this
codebase) — the point is not merely to avoid the word "Unnamed," it is to make "we do not have this
person's name" visually distinct from "this person's actual name is CL-000042," so staff read the
gap as a gap. A caption alongside it ("no name on file") is preferred where space allows; the
distinct styling is the non-negotiable minimum where it does not.

This is a frontend rendering change across the ten files named in §1.4, plus the search-index title
derivation on the backend (`search.service.ts:108-112`, swap the literal `'Unknown'` fallback for
`entity.recordNumber ?? entity.email ?? 'Unknown'` at minimum, pending ADR 0010).

### 2.5 D5 — Existing null-column records are a data-quality finding, not a code path

**Decision.** Any `PERSON`/`ORGANIZATION` record with `firstName`, `lastName`, and `email` all null
**today** is missing real data that this ADR cannot recover — there is nothing in
`verticalAttributes` that core is allowed to promote on its own (§2.2), and for a lead converted
before this ADR's frontend fix ships, the name the lead-intake form actually collected does sit in
`verticalAttributes.lead.fields`, just not promoted. **This ADR does not build an automatic
backfill for it** — that would be exactly the "core derives identity from a vertical's blob"
guess-work §2.2 forbids, done once as a migration instead of on every read, which does not make it
safer, only harder to see. The honest fix is operational: a read-only report (a SQL query naming
every affected tenant and record) so each firm can be told which of their own client records are
missing a name and can re-enter it themselves — this is squarely the "say what is actually true"
instinct (`meru-core/CLAUDE.md` §15) applied to a firm's own data, not a system defect to paper
over silently.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| Have `convertEntity` read `verticalAttributes.lead.fields.first_name`/`.last_name` and promote them at conversion time | Requires core to know a vertical-specific blob shape (`lead.fields.first_name`) — an 80/20 violation (§1.2, §2.2); also does nothing for a lead created and left unconverted, which still renders unnamed everywhere a lead list is shown |
| A generic "try common key names" heuristic (`first_name`, `firstName`, `name`, `applicant.first_name`, …) searched across `verticalAttributes` at read time | Fabricates a match with no way to know it is correct — the same class of invented-signal failure `meru-core/CLAUDE.md` §7.3 already names for a proxy risk factor; a coincidental key match (e.g. a GRC vendor's `verticalAttributes.name` meaning the *company*, matched by a heuristic meant for a person) produces a confidently wrong name, worse than an honest blank |
| Migrate every existing null-identity record automatically by copying whatever `verticalAttributes` seems to hold | Same objection as the heuristic above, done once instead of on every read — still guessing, just less visibly |
| Silently keep "Unnamed client" but add a tooltip explaining it might be a data issue | Does not fix the actual failure named in §1.4 — the label still reads as a settled category at a glance, and `meru-core/CLAUDE.md` §7.3's bar is about what is rendered, not what is available on hover |
| Require `email` as a mandatory field on every `PERSON`/`ORGANIZATION`/`LEAD` create, so the "all four are null" case cannot occur | Rejected as over-broad: a walk-in client with a phone but no email yet is a legitimate real-world case this system must still represent (this is exactly why ADR 0010's `recordNumber` fallback exists at all — it is guaranteed present without demanding any particular piece of contact data be captured up front) |

---

## 4. Consequences

1. **Two frontend changes ship together for the lead-creation fix to be complete**: `leads.service.ts`'s
   `toEntityDto` (D1) and the ten renderer call sites (D4) — landing D4 without D1 leaves the
   renderer correctly styled but still falling all the way to an id for every lead-derived client,
   since the promoted columns would still be null. Sequence: D1 first, D4 can land independently
   afterward and will simply have less need to fall past `recordNumber`.
2. **The pack-loader check (D3) can reject a pack that loads cleanly today** if a future edit to
   `importMappings[]` regresses it — this is the intended, deliberate behaviour (§2.3's "why reject
   at load"), not a bug; a pack author who hits it needs to add a `to: 'firstName'`/`'lastName'`/
   `'email'` mapping, not work around the check.
3. **D5 explicitly produces no code** — only a report. Anyone expecting this ADR to "fix" existing
   blank client names is expecting the wrong thing; it fixes the code paths that produce new blank
   ones and gives firms an honest accounting of the old ones.
4. **The search-index fix in D4 is a one-line change with an outsized effect**: `'Unknown'` as a
   search-result title is the same failure as "Unnamed client" but has gone unnoticed longer because
   it is inside a result list rather than a primary client screen.

---

## 5. What would make these decisions wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A vertical introduces a subject type where "name" is not naturally `firstName`/`lastName` (e.g. GRC's `VENDOR`, which may be identified by a registered company name with no first/last split) | D1's "promote firstName/lastName" framing, if `VENDOR` is ever put through the client-number/renderer path | Confirm whether `VENDOR` should join `SUBJECT_TYPES` (ADR 0010 §2.3) at that point — if so, this ADR's D1 needs a stated convention for org-shaped names (likely: `firstName` holds the full name, `lastName` empty, matching how `ORGANIZATION` already works today) rather than a new field |
| A second import path (HubSpot/Zoho/Salesforce — declared in `ImportMappingDefinition.source` but not implemented in `ImportService.parse`, `import.service.ts:393-397`) is actually built | D3's assumption that all import runs through `ImportService.commit`'s existing `TOP_LEVEL_FIELDS` split | Confirm the new path also runs through `commit`/`split`, or gains the equivalent guarantee independently — do not assume D3's pack-load check alone is sufficient if a new commit path bypasses `ImportService.commit` entirely |
| A firm reports the D5 data-quality list is large enough to be a real onboarding blocker, not a handful of records | D5's "report only, no automated fix" | Consider a guided re-entry UI flow (staff reviews and confirms each name) rather than an automated derivation — still never a silent backfill |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `leads.service.ts` `toEntityDto` lift (D1) | Revert the commit | Leads created while this was live keep their promoted columns populated — reverting does not blank them |
| `config-pack-loader.service.ts` `unnamedSubjectMappings` check (D3) | Remove the function and its call site | None — a pure validation, no data written |
| Renderer fallback chain (D4) | Revert to the previous literal strings | None — display-only |
| Search-index title fallback (D4) | Revert `search.service.ts:108-112` to `'Unknown'` | Re-indexes on next write; no stored data lost |

**Rollback verification:** reverting D1 alone (without also reverting D4) leaves the renderer
correctly falling back to `recordNumber`/email/phone instead of "Unnamed client" even for newly
broken leads — a strictly better state than before this ADR, so D4 should be treated as safe to
keep even if D1 is ever rolled back for an unrelated reason.
