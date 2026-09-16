# 0019 — Firm-editable document templates: tenant overrides on top of pack templates, never a replacement of them

**Status:** Proposed — 2026-09-17. Not merged. Requires `quality` (Owen) and `secops` (Anton)
review — this adds two new RLS-carrying tables and a write surface `firm_admin` reaches directly
— per `definition-of-done.md`. Luke and Mira implement against this contract; this document
specifies no feature code.

**Scope:** PRD §9 / BC-5, FR-6.15–6.18, FR-6.22. (FR-6.19–6.21, the send-for-signature/assent
flow, are ADR 0020 — a separate document because they are a separate table with a separate
lifecycle, and conflating "editing a template" with "sending one" was the exact confusion PL-25/
26/27 already punished elsewhere in this product.)

---

## 1. Context

### 1.1 What exists today, verified against `/api-json` and the source

`GET /documents/templates` (`DocumentsController.listTemplates`, `@Roles(FIRM_ADMIN, STAFF)`,
`documents.controller.ts:268-283`) and `POST /documents/generate/{templateKey}` (`:286-...`, no
`@Roles` — open to any authenticated role, scoped by `DocumentAccessService.assertOwnsEntity` for
a `client` caller) are both live. Both read from exactly one place:
`VerticalPackService.sectionWithPack('documentTemplates')`
(`document-generation.service.ts:107-115, 145-149`) — the tenant's resolved **config pack**, and
nothing else. There is no tenant-level authoring, override or storage of a template anywhere in
`src/`. `grep -rn "tenant_document_template" src` returns nothing.

`DocumentTemplateSchema` (`packages/config-packs/_schema/pack.schema.ts:258-281`) is the whole
template contract: `key`, `label`, `documentTypeKey?`, `fileName?`, `pageSize`, `header?`,
`footer?`, `requires?`, `blocks[]`. `DocumentBlockSchema` (`:210-256`) has no concept of "this
part may not be changed" — every block a pack author writes is, today, equally editable by
nobody, because nobody can edit any of it.

The base `immigration.json` v2.6.0 carries exactly three `documentTemplates[]`: `cost_agreement`,
`tax_invoice`, `lodgement_confirmation`. The AU overlay v2.8.0 adds one more, `adm_disclosure` —
the APP 1.8 automated-decision-making notice (workspace `CLAUDE.md` §5–6). `[UNVERIFIED: exact
current block content of `cost_agreement` and `adm_disclosure` in the on-disk packs — Luke should
read `packages/config-packs/verticals/immigration.json` and `countries/au-immigration.json`
directly before authoring migration/seed data, rather than trusting this document's summary.]`

### 1.2 Why "let a firm edit the blocks array" is not the whole decision

Two of the four document types PRD §9 names carry content a firm must not be free to delete:

- `adm_disclosure` is a **statutory notice** (APP 1.8, commencing 10 December 2026, workspace
  `CLAUDE.md` §5–6) generated from `entitlements` and the pack's `prompts[]`. A firm editing this
  into something that no longer discloses what it is required to disclose is not a styling
  choice; it is the firm shipping a non-compliant privacy notice with ImmiStack's name on the
  render pipeline.
- `cost_agreement` is where `./CLAUDE.md` §4.2's non-refundability disclosure and §9's "this is
  assent, not a signature" labelling (ADR 0020) are expected to live. A firm free to delete a
  non-refundability sentence from its own cost agreement has removed the one disclosure BR-1 and
  `./BUSINESS.md` §9.2 exist to force.

**Nothing in the current schema can express "this block is not the firm's to remove."** This ADR
has to add that concept before it can safely let a firm touch anything.

### 1.3 The `documentTypeKey` binding is a second reason a naive override is unsafe

`document-generation.service.ts:246-248`'s `store()` writes `metadata.documentTypeKey` from the
template onto the generated document, and `GET /documents/checklist` matches on it
(`CLAUDE.md` §4.2, item 5: "A generated document that also satisfies a checklist requirement
names it with `documentTypeKey`, or the checklist keeps asking for the document the firm just
produced"). A tenant override that silently drops or changes `documentTypeKey` would reopen a
checklist item the firm believes it has just closed — the exact "unknown rendered as a positive
result" shape in reverse (a satisfied requirement rendering as outstanding). §2.2 pins this field.

### 1.4 What versioning has to survive

FR-6.22: "a sent agreement always renders the version that was sent." `store()` already writes
`metadata.documentTemplateKey` onto every generated document (`:245`) but nothing that identifies
*which version of that template's content* produced it. A firm that edits its cost agreement
wording six months after a client signed one must not have that edit retroactively change what
the already-generated PDF is understood to say — the PDF bytes are already immutable (stored,
versioned, hash-anchored once ADR 0020 lands); only the *record of which template version made
them* is missing today.

---

## 2. Decisions

### 2.1 D1 — Two new tables: a live pointer, and an append-only version history. No new top-level pack array.

**Decision.** `tenant_document_templates` holds one row per **(tenant, template key)** — the
currently-active definition, whether it is an *override* of a pack template or a *wholly new*
firm-authored one. `tenant_document_template_versions` is an append-only history: every save
(draft or publish) writes a new row there; nothing in that table is ever updated or deleted from
the application.

```sql
CREATE TABLE "tenant_document_templates" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"        uuid NOT NULL,
  "key"             character varying(100) NOT NULL,
  "baseTemplateKey" character varying(100),        -- NULL = wholly firm-authored; set = overrides a pack key
  "label"           character varying(200) NOT NULL,
  "documentTypeKey" character varying(100),
  "fileName"        text,
  "pageSize"        character varying(10) NOT NULL DEFAULT 'A4',
  "header"          text,
  "footer"          text,
  "requires"        jsonb NOT NULL DEFAULT '[]',
  "blocks"          jsonb NOT NULL,
  "active"          boolean NOT NULL DEFAULT true,  -- false = reverted to pack default (override) or retired (authored)
  "currentVersion"  integer NOT NULL DEFAULT 1,
  "createdBy"       uuid NOT NULL,
  "updatedBy"        uuid NOT NULL,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_tenant_document_templates_tenant_key" UNIQUE ("tenantId", "key")
);
CREATE INDEX ON "tenant_document_templates" ("tenantId", "active");

CREATE TABLE "tenant_document_template_versions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"        uuid NOT NULL,
  "templateId"      uuid NOT NULL REFERENCES "tenant_document_templates"("id"),
  "version"         integer NOT NULL,
  "label"           character varying(200) NOT NULL,
  "documentTypeKey" character varying(100),
  "fileName"        text,
  "pageSize"        character varying(10) NOT NULL,
  "header"          text,
  "footer"          text,
  "requires"        jsonb NOT NULL DEFAULT '[]',
  "blocks"          jsonb NOT NULL,
  "publishedBy"     uuid NOT NULL,
  "publishedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_tenant_document_template_versions" UNIQUE ("templateId", "version")
);
CREATE INDEX ON "tenant_document_template_versions" ("tenantId", "templateId");
```

Both `ENABLE` and `FORCE ROW LEVEL SECURITY` at creation, `tenant_isolation` policy, identical
shape to `1756700000000-AddTenantFeeOverrides.ts` — the direct precedent ADR 0009 §2.4 set for a
small per-tenant settings table with a real FK inside the same feature. The FK from versions to
the live row is safe *because the parent is never hard-deleted* (§2.5) — the same reasoning that
lets `BillingService.createInvoice` and `CrmService.createEntity` hold a transaction open across
a related write (ADR 0010 §2.2), not the CRM's deliberately-unenforced-reference pattern, which
exists for a different reason (a record whose reference must survive the referent's deletion).

**Why not one table with a `versions` jsonb array column.** The version history is exactly the
kind of "immutable historical record" the WORM audit trigger already models for `audit_logs`
(`CLAUDE.md` §5.4) — append-only, never edited. A jsonb array column can be edited by anyone with
write access to the row; a separate table with no `UPDATE`/`DELETE` code path anywhere in the
service cannot be, by construction, without someone writing that code path deliberately. This ADR
does not add a WORM trigger (the stakes are a template's wording, not a compliance ledger), but it
keeps the same shape so one could be added later without a schema change (§5).

**Why not a new top-level pack array (`tenantDocumentTemplates` living inside the pack merge
algorithm).** The pack is vertical/country configuration, resolved identically for every tenant
of that vertical+country pin (`CLAUDE.md` §4). A tenant override is tenant *data*, exactly the
same category ADR 0009 §2.4 already drew for `firm_professional_482` — "a firm's own price is not
vertical vocabulary." The same reasoning applies to a firm's own wording. This also means **no
change to the loader's 23-key list** and no three-part pack-schema-change commit (`CLAUDE.md`
§4.2 rule 1) — this ADR does not touch what the pack loader persists at all. The only pack-schema
change is §2.2's two new optional fields on the *existing* `documentTemplates[]`/`blocks[]`
shapes, which is additive to an already-declared array, not a new one.

### 2.2 D2 — Two additive pack-schema fields: `firmEditable` and `locked`, so a pack author can say what a firm may not touch

**Decision.** `DocumentTemplateSchema` gains one optional field:

```ts
firmEditable: z.boolean().default(true),
```

`documentTypeKey`, when present, is **never overridable** regardless of `firmEditable` — see
below. A pack author sets `firmEditable: false` on `adm_disclosure` specifically (§1.2); every
other existing template defaults to `true` and needs no pack edit to keep working exactly as it
does today (`CLAUDE.md` §4.2 rule 2, "every array is optional and additive").

`DocumentBlockSchema` gains one optional field:

```ts
locked: z.boolean().default(false),
```

**Validation rule, enforced in the service, not the DTO** (it needs the resolved pack template to
compare against, the same reasoning ADR 0009 §2.4 gives for fee-key validation): when a tenant
override names a `baseTemplateKey`, every block in the **pack** template's `blocks[]` that carries
`locked: true` must appear, byte-for-byte identical on every field the schema defines, at the
**same array position**, in the submitted override. A mismatch is a 400 naming the block index
and the field that differs. **A wholly firm-authored template (`baseTemplateKey: null`) may not
set `locked: true` on any of its own blocks** — `locked` is a promise a *pack author* makes about
statutory content; it means nothing coming from a firm and the service strips it (silently, not
an error — the same "additive field a firm cannot see" posture packs already take with unknown
top-level keys, `CLAUDE.md` §6 rule 5).

**`documentTypeKey` is separately protected, unconditionally.** An override may not change or add
a `documentTypeKey` relative to its `baseTemplateKey`'s pack value (§1.3); if the base template
had none, the override may not add one — introducing a checklist binding is a decision about what
satisfies a regulatory requirement, and that is not a wording edit. A wholly firm-authored
template's `documentTypeKey` is always `null` — a brand-new document a firm invents cannot claim
to satisfy a checklist requirement the pack defined, for the same reason.

**Run `npm run packs:schema` in the same commit** that adds these two fields, per `CLAUDE.md`
§4.2 rule 1 — this is the two-part version of that rule (Zod + regenerated JSON Schema); there is
no third part here because neither field is a new top-level array.

### 2.3 D3 — Resolution order: tenant override wins by key, pack is always the fallback, and the merge is at the service, not the pack loader

**Decision.** `DocumentGenerationService.listTemplates` and `.generate` both change to: fetch the
pack's `documentTemplates[]` (unchanged), fetch the tenant's `tenant_document_templates` where
`active = true`, and for `listTemplates`, produce the union — a tenant row with a given `key`
**replaces** the pack entry of the same key in the listing (never both), tagged
`source: 'pack' | 'tenant'` so the UI can show "customised" without a second call; a
wholly-authored tenant template (no matching pack key) is simply added. For `.generate`, the
lookup for a given `templateKey` checks the tenant table first, falls through to the pack — this
is a two-line change to the existing `find()` at `document-generation.service.ts:149`, not a
rewrite of `render()`/`buildContext()`, both of which already operate on the generic
`DocumentTemplate` shape and do not care which table produced it.

**Why resolution lives in the service and not the pack loader.** The pack loader
(`config-pack-loader.service.ts`) resolves one merged document **per vertical+country pin**,
shared by every tenant on that pin — that is its entire job (`CLAUDE.md` §4). Folding a
*per-tenant* override into that merge would mean re-running pack resolution on every tenant's
first document-template read, which the loader does not do today and should not start doing for
one feature. `VerticalPackService.sectionWithPack` is already called per-request
(`document-generation.service.ts:107,145`); adding one more per-tenant query beside it is the
correct place for the correct kind of merge.

**Deactivating a tenant override (`active: false`) reverts that key to the pack default on the
very next read** — no data migration, because the pack row was never deleted, only shadowed.

### 2.4 D4 — Token vocabulary and preview: exactly the existing `buildContext`, no new tokens, no new preview route

**Decision.** A tenant-authored or tenant-overridden template may reference exactly the same
placeholder paths a pack template can — `tenant.*`, `client.*` (including
`client.attributes.*` → `verticalAttributes`), `payments[].*`, `paymentsTotal`, `today`, `now`
(`document-generation.service.ts:303-345`). **No new context keys are added by this ADR.** A firm
cannot invent a token that resolves to data the render context does not already expose — the
token palette IS `buildContext`'s return shape, and the "palette" the settings UI shows is
generated by listing that object's keys, not maintained as a second, hand-written list that could
drift from what actually resolves.

**No new preview route.** `POST /documents/generate/:templateKey?entityId=…` (without `?store=true`)
already renders against a real record and returns bytes without filing anything — that is a
preview, today, for a pack template, and §2.3 makes it one for a tenant template too with no
route change. "Preview against a real record" (the task's own phrasing) is satisfied by reusing
this route once resolution is in place, not by building a second one that could drift from what
generation actually does.

### 2.5 D5 — Editing, publishing and versioning: draft in place, version on publish only, never delete a template with any version ever generated

**Decision.** `PUT /documents/templates/:key` upserts the **live** row (draft edits — a firm
iterating on wording before it is ever used does not need a new version number for every
keystroke's autosave). `POST /documents/templates/:key/publish` is the only action that writes
to `tenant_document_template_versions` and increments `currentVersion` — it snapshots the live
row's current content as the new version, atomically, in one transaction (same `QueryRunner`
shape as ADR 0010 §2.2, not two separate statements). **Only a published template may be
generated from** — `.generate` refuses (400) a tenant row with `currentVersion` still at its
initial unpublished state... **correction, stated precisely:** a template starts at `currentVersion:
1` with no row yet in the versions table; `.generate` checks the versions table for a matching
`(templateId, currentVersion)` row, not the live table alone, so a template that has never been
published cannot be generated from — this is what makes "draft" a real, distinct state rather
than cosmetic. `documents.controller.ts`'s existing `?store=true` continues to write
`metadata.documentTemplateVersion` (new field on the same `metadata` object `store()` already
writes, `:242-250`) sourced from `tenant_document_template_versions.version` for a tenant
template, or the resolved **pack's own `version` string** (e.g. `"2.6.0"`) for a pack template —
FR-6.22 is satisfied identically for both sources, because a pack template already has a
first-class version (the pack's), just never recorded on the generated document before now.

**No hard delete, ever, of a template with at least one published version and at least one
document generated from it.** `DELETE /documents/templates/:key` sets `active: false` (an
override reverts to pack default per §2.3; a wholly-authored template stops being generatable but
its versions and every document already produced from it remain exactly as they were) — the same
posture ADR 0009 §2.1 takes for tenant deletion: retire, never purge, because the record of what a
client was actually shown must outlive a firm's later decision to stop offering it.

---

## 3. API contract

Base path `/documents/templates`, all authenticated (`JWT-auth`), no route in this ADR reachable
by a `client`-role token — templates are a firm's own commercial content and a firm's back-office
setting, matching `documentTypeKey` being pack/firm concern, not applicant-facing (§4's client
column below is `—` throughout, unlike ADR 0020 where the client is the whole point).

| Route | Method | Roles | Notes |
|---|---|---|---|
| `/documents/templates` | GET | `firm_admin`, `staff` | **Changed** (§2.3): now returns pack ∪ active tenant rows, each tagged `source` |
| `/documents/templates/:key` | GET | `firm_admin`, `staff` | New. Full definition (with `blocks`) of the *resolved* template — pack or tenant, whichever is active. 404 if neither exists |
| `/documents/templates/:key/versions` | GET | `firm_admin` | New. `tenant_document_template_versions` for this key, newest first. Empty array for a pack-only key (pack templates carry no per-tenant version history) |
| `/documents/templates` | POST | `firm_admin` | New. Create a tenant row — `{ key, baseTemplateKey?, label, documentTypeKey?, fileName?, pageSize?, header?, footer?, requires?, blocks }`. 400 if `key` collides with an existing **active** tenant row for this tenant (reactivate via PUT instead); no collision check against pack keys required to *create* — `baseTemplateKey` is what declares an override, not `key` matching one by accident |
| `/documents/templates/:key` | PUT | `firm_admin` | New (§2.5). Upserts the **draft** content of the live row. Full `blocks` array required — complete desired state, matching `SetFeeOverridesDto`'s reasoning (ADR 0009 §2.4): a PATCH-style merge cannot express "I removed a block" |
| `/documents/templates/:key/publish` | POST | `firm_admin` | New (§2.5). Snapshots the live row into `tenant_document_template_versions`, increments `currentVersion` |
| `/documents/templates/:key` | DELETE | `firm_admin` | New (§2.5). Soft — sets `active: false` |
| `/documents/templates` (existing) | GET | `firm_admin`, `staff` | unchanged route, changed behaviour, see above |
| `/documents/generate/:templateKey` (existing) | POST | any authenticated (own-scope for `client`) | unchanged route, changed resolution (§2.3), changed metadata (§2.5) |

### DTOs

```ts
// New
export class DocumentBlockDto {
  @IsIn(['heading','paragraph','spacer','keyValue','table','list','signature','pageBreak'])
  type: DocumentBlockType;
  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3) level?: number;
  @IsOptional() @IsArray() rows?: { label: string; value: string }[];
  @IsOptional() @IsArray() columns?: string[];
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsArray() cells?: string[];
  @IsOptional() @IsArray() items?: string[];
  @IsOptional() @IsArray() widths?: number[];
  @IsOptional() @IsArray() signatories?: string[];
  @IsOptional() @IsNumber() fontSize?: number;
  @IsOptional() @IsBoolean() bold?: boolean;
  // `locked` is NOT a field a client may set — see §2.2. Present only in the
  // server's own response shape, never accepted on the request DTO. A
  // `locked` key in the request body is stripped by the global
  // `whitelist: true, forbidNonWhitelisted: true` ValidationPipe (ADR 0010
  // §2.4's precedent — ImmiStack's `main.ts:119-121`), same free 400 pattern.
}

export class CreateDocumentTemplateDto {
  @IsString() @MaxLength(100) key: string;
  @IsOptional() @IsString() @MaxLength(100) baseTemplateKey?: string;
  @IsString() @MaxLength(200) label: string;
  @IsOptional() @IsString() @MaxLength(100) documentTypeKey?: string;
  @IsOptional() @IsString() fileName?: string;
  @IsOptional() @IsIn(['A4','LETTER']) pageSize?: 'A4' | 'LETTER';
  @IsOptional() @IsString() header?: string;
  @IsOptional() @IsString() footer?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) requires?: string[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => DocumentBlockDto)
  blocks: DocumentBlockDto[];
}

export class UpdateDocumentTemplateDto extends CreateDocumentTemplateDto {} // same shape, full replace
```

### Responses

- `GET /documents/templates` → `{ packCode: string|null, templates: Array<{ key, label,
  documentTypeKey?, source: 'pack'|'tenant', firmEditable: boolean, currentVersion?: number }> }`
  — `currentVersion` present only for `source: 'tenant'`.
- `GET /documents/templates/:key` → the full `DocumentTemplate` shape plus `source`, `active`,
  `currentVersion?`, `baseTemplateKey?`.
- `POST/PUT` → the same shape, 201/200.
- `POST /documents/templates/:key/publish` → `{ key, version: number, publishedAt: string }`.

### MER-* errors

| Code | HTTP | When |
|---|---|---|
| `MER-VAL-0001` | 400 | A `locked` pack block was changed or removed in a submitted override; a `documentTypeKey` was added/changed on an override; `key` already active for this tenant on `POST`; unknown `feeKey`-style validation failures generally (reused, no new family) |
| `MER-RES-0001` | 404 | `:key` names neither a pack template nor an active tenant row, on any of the new GET/PUT/DELETE/publish routes |
| `MER-AUTH-0009` | 403 | Non-`firm_admin` attempting a write route (existing code, `AUTH_INSUFFICIENT_ROLE`) |

No new error family. This ADR does not need `MER-BILL-*` (that is ADR 0021's).

---

## 4. Tenancy enforcement per route

| Route | RLS | Service-layer check |
|---|---|---|
| All `/documents/templates*` routes (new and existing) | `tenant_document_templates`/`tenant_document_template_versions` both `ENABLE`+`FORCE` RLS, `tenantId` bound via the standard `TenantAlsMiddleware`→`applyRlsToDataSource` chain (`CLAUDE.md` §8) | No `client`-role token reaches any route here (§3) — nothing to `assertOwnsEntity` against, because a template is not owned by an applicant. `firm_admin`/`staff` split is a plain `@Roles` gate, no per-user scoping needed (unlike appointments/payments, a template has no "own" concept below the tenant) |
| `POST /documents/generate/:templateKey` (existing, resolution changed) | unchanged — `documents` table RLS, N/A here (no row written unless `?store=true`) | unchanged — `DocumentAccessService.assertOwnsEntity(tenantId, entityId, actor)` still runs before `buildContext` touches the entity (`:277-279`), regardless of whether the template resolved from the pack or a tenant override. This ADR does not touch that check |

---

## 5. Audit events

| Event | Action | Severity | Context |
|---|---|---|---|
| `POST /documents/templates` | `CREATE` | `INFO` | `{ key, baseTemplateKey }` — ordinary in-tenant commercial content, matching ADR 0009 §2.4's severity choice for fee overrides |
| `PUT /documents/templates/:key` | `UPDATE` | `INFO` | `{ key, changedFields }` |
| `POST /documents/templates/:key/publish` | `UPDATE` | `WARNING` | `{ key, version }` — a published version is what a client may be shown next; one severity step above a draft edit, matching `AcceptanceService`'s own choice for money/legal-adjacent writes |
| `DELETE /documents/templates/:key` | `DELETE` | `WARNING` | `{ key, hadPublishedVersions: boolean }` |
| A `locked`-block validation rejection | not audited as an event — it is a 400, the same as any other validation failure. **Do** log it at `Logger.warn` server-side (not `AuditService`) so a pattern of attempted edits to `adm_disclosure` is visible in application logs without adding audit-log volume for a rejected write that changed nothing |

---

## 6. Pack keys touched

- `documentTemplates[].firmEditable` — new, optional, `boolean`, default `true`. Set `false` on
  `adm_disclosure` in the AU overlay, in the same commit as the schema change.
- `documentTemplates[].blocks[].locked` — new, optional, `boolean`, default `false`. Author to
  set `true` on the non-refundability disclosure block(s) inside `cost_agreement`, once that
  content is written — `[UNVERIFIED: whether `cost_agreement`'s current blocks already contain
  such a sentence; if not, ADR-adjacent pack-authoring work, not this ADR's code, needs to add it
  before `locked` has anything to protect]`.
- No change to the loader's 23-key `upsertPack` list (§2.1) — `documentTemplates` is already one
  of them.
- `npm run packs:schema` regenerates `config-pack.schema.json`. Run `config-pack-loader.service.spec.ts`
  after — it asserts every declared array round-trips.

---

## 7. Options rejected

| Option | Why rejected |
|---|---|
| Let a tenant override replace the entire `blocks` array with no `locked` concept | Live 80/20-adjacent safety gap: nothing would stop a firm deleting a statutory disclosure it is required to show (§1.2) |
| Put tenant overrides inside the pack merge algorithm (a per-tenant "overlay" resolved by `ConfigPackLoaderService`) | The loader resolves one merged pack per vertical+country pin, shared by every tenant on it — folding per-tenant data into that path changes what "the pack" means for every reader of `VerticalPackService`, not just document generation |
| A single mutable `tenant_document_templates` row with no separate version-history table | FR-6.22 requires knowing which version an already-sent document renders; a row that is edited in place answers "what does it say now," never "what did it say when it was sent" |
| Allow `platform_admin` to also edit a tenant's templates | Not requested by any FR; a platform operator editing one firm's commercial wording is a different, unreviewed capability, matching ADR 0009 §2.4's identical exclusion for fee overrides |
| A separate `/documents/templates/:key/preview` route | `POST /documents/generate/:templateKey` (no `?store=true`) already is a preview; a second route risks drifting from what generation actually resolves and renders (§2.4) |
| Version on every `PUT`, not just `publish` | Makes autosave-while-drafting burn a version number per keystroke, defeating FR-6.22's actual purpose (know what a *sent* document said) with noise |

---

## 8. Consequences

1. Two new RLS-carrying tables — run `npm run rls:verify` after the migration specifically.
2. `DocumentGenerationService.listTemplates`/`.generate` both change (§2.3) — every existing
   caller of `GET /documents/templates` and `POST /documents/generate/:templateKey` keeps working
   unchanged for a tenant with no overrides (falls through to the pack, as today); behaviour only
   changes for a tenant that has actually created one.
3. `store()`'s `metadata` object gains one new key (`documentTemplateVersion`) — additive, no
   existing reader breaks.
4. A pack author must now decide `firmEditable` for every new template they write (defaults to
   `true`, so this is a decision to *opt out*, not a new mandatory field — no existing pack
   author's workflow breaks).
5. **A `locked` block whose content a pack author needs to change still requires a pack version
   bump**, exactly as any other pack content change does today — this ADR does not add a second
   mechanism for editing statutory pack content; it only stops a *tenant* from editing it.

---

## 9. What would make this wrong later

| Trigger | Invalidates | What to do |
|---|---|---|
| A second vertical (GRC) needs firm-editable templates with genuinely different locked-content rules | D2's binary `locked` flag | Extend to a `lockReason: string` alongside `locked: boolean` so the UI can explain *why* a block is protected, rather than a bare boolean — additive |
| A firm needs to edit a `locked` block because a regulator changed wording faster than a pack release cycle can reach them | D2's hard refusal | That is a pack-authoring latency problem, not a template-editing one — the fix is a faster pack release path (regulatory radar → draft pack diff ≤24h is already a north-star metric, `CLAUDE.md` §9), not loosening `locked` |
| Templates need approval before publish (a second admin sign-off) | D5's single-`firm_admin`-publishes model | Add a `pendingApproval` status between draft and published, gated the same way `PolicyGuard`-based dual-control decisions are elsewhere in this codebase — additive state, not a redesign |
| A firm needs the SAME override to differ by country (e.g. a UK cost agreement vs an AU one, one tenant, two overlays pinned) | D1's `(tenantId, key)` uniqueness | Extend the unique constraint to `(tenantId, key, countryCode)` — a real schema change, not covered here, because no FR asks for a tenant operating two country overlays simultaneously today |

---

## 10. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `tenant_document_templates`, `tenant_document_template_versions` (migration `AddTenantDocumentTemplates`) | `DROP TABLE tenant_document_template_versions; DROP TABLE tenant_document_templates;` (versions first — FK) | Every tenant override and its full edit history is lost. **Do not roll back once any tenant has generated and sent a document from an overridden template** — a document already in a client's hands would reference a `documentTemplateVersion` that no longer resolves to anything; confirm no live `document_send_requests` (ADR 0020) references a tenant template before dropping |
| `DocumentTemplateSchema.firmEditable`, `DocumentBlockSchema.locked` (pack schema) | Revert the Zod/JSON-Schema change; re-run `npm run packs:schema` | None — both fields default such that removing them changes no runtime resolution for a pack that never set them |
| `DocumentGenerationService` resolution change (§2.3) | Revert to the pack-only `find()` | Any tenant with an active override reverts silently to the pack default the next time it generates — **confirm with affected firms first**, same caution ADR 0009 §6 gives for its own merge-point rollback |
| New routes (§3) | Remove them; the service methods behind them are additive and called nowhere else | None |

**Rollback verification:** for the resolution-change rollback specifically, list every tenant with
at least one `active = true` row in `tenant_document_templates` before reverting — that is exactly
the set of firms who would silently see their customised wording replaced by the pack default,
and they should be told, not surprised.

---

## 11. Implementation briefs

### For Luke (backend)

- **Migration** `1757400000000-AddTenantDocumentTemplates.ts` — both tables from §2.1, `ENABLE`+
  `FORCE` RLS at creation, `tenant_isolation` policy copied verbatim from
  `1756700000000-AddTenantFeeOverrides.ts`. `down()` drops both (versions table first, FK order).
- **Entities**: `TenantDocumentTemplate`, `TenantDocumentTemplateVersion` in
  `src/documents/entities/`. Register both in `src/config/entities.ts`
  (`CLAUDE.md` §10 rule 3 — a new entity not in `ALL_ENTITIES` is invisible to `MigrateService`'s
  bootstrap path, §16's recurring migration-registration defect class).
- **Pack schema**: `packages/config-packs/_schema/pack.schema.ts` — add `firmEditable` to
  `DocumentTemplateSchema` (`:258-281`) and `locked` to `DocumentBlockSchema` (`:210-256`). Run
  `npm run packs:schema`. Update `countries/au-immigration.json`'s `adm_disclosure` entry to
  `firmEditable: false` in the same commit — **confirm the current key name and block content
  first**, do not guess it (§6's `[UNVERIFIED]`).
- **`DocumentGenerationService`**: change `.listTemplates` and `.generate`'s lookup per §2.3 —
  query `tenant_document_templates` (`active: true`) before/alongside the pack section, key-match
  by string equality. Add the `locked`-block comparison validator (§2.2) as a private method
  called from the new `PUT`/`POST` service methods — compare on every `DocumentBlockDto` field the
  schema defines, at matching array index, not a deep-equal of the whole object (a pack author
  reordering non-locked blocks around a locked one must not trip this check).
- **New `TenantDocumentTemplateService`** (or extend `DocumentGenerationService` — Luke's call,
  not architecturally significant either way) owning create/update/publish/delete, each per §2.5.
  `publish` opens a `QueryRunner` transaction exactly like `ADR 0010 §2.2`'s pattern: insert the
  version row, increment `currentVersion` on the live row, commit together.
- **`documents.controller.ts`**: five new routes per §3, all `@Roles(PlatformRole.FIRM_ADMIN)`
  except the two GETs which also allow `STAFF`. Add `X-`-style Swagger docs matching the existing
  file's density.
- **Do not touch** `assertOwnsEntity` or the `generate` route's role gate — unchanged by this ADR
  (§4).
- Concurrency test per ADR 0010's own precedent is not required here (no counter, no race) — but
  add a spec asserting a `locked: true` block cannot be altered by a submitted override, and that
  `.generate` refuses a template with `currentVersion` set but no matching versions-table row
  (the unpublished-draft case, §2.5).

### For Mira (frontend)

- New Settings → Templates screen (FR-6.15): list from `GET /documents/templates`, tag each row
  `source: pack | tenant`, show "customised" on tenant rows. A `firmEditable: false` pack row
  (e.g. `adm_disclosure`) renders read-only with an explanation, never a disabled-but-visible edit
  button that implies "coming soon."
- Editor: block-by-block form matching `DocumentBlockDto`. **Render `locked` blocks visibly
  locked** (not hidden — a firm should see what statutory content is in its own document, just not
  be able to edit it) with a short "why" string. The token palette (§2.4) is populated by calling
  `POST /documents/generate/:templateKey?entityId=<a real, already-selected record>` in preview
  mode (no `?store=true`) and showing the returned PDF inline — never a hand-maintained token list
  that can drift from what actually resolves.
- "Publish" is a distinct, explicit action from "Save draft" — the UI must make the version
  boundary visible (FR-6.22's whole point), not silently version on every autosave.
- On the case/client document flow (ADR 0020's UI, not this one), show the resolved template's
  `source`/`currentVersion` badge so staff know whether they are about to send the pack default or
  the firm's own customised version.
- Five states (definition-of-done): empty (no templates authored yet — pack templates still list,
  so "empty" only applies to the tenant-authored subset), loading, error (e.g. a `locked`-block
  validation 400 — surface the exact block/field named in the message, not a generic "save
  failed"), populated, overflowing (a firm with many custom templates — paginate/search, do not
  render an unbounded list).
