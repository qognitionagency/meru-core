# 0024 — Platform groundwork: making "apps snap on" true

**Status:** Proposed — 2026-11-17. Not merged. Nothing here is implemented. Owner: Kyle (architect).
Implementation: Luke (`backend-dev`) for D1, D2, D4 and the D3 API work; Mira (`frontend-dev`) for
D3's app and D6. Gates: **Owen (`quality`) on every decision; Anton (`secops`) is mandatory on D1
(tenant-to-vertical binding and a new global table), D3 (a new app that holds a session cookie and
a new manifest route) and D4 (a new authentication path, and an outbound-request control).**

**Takes up the reservation in [ADR 0023](0023-neon-better-auth-federation-rollout-and-control-centre.md) D9.**
0023 deferred three things here: the `app_builder` role, a verticals registry, and a partner tier.
This ADR **decides the registry (D1)** and **defers the other two (D5)**, with the triggers to
reopen them. It does not touch 0023 D3's one-subject-one-`users`-row uniqueness. That stays until a
partner tier is actually decided.

**Preconditions, which none of this jumps:**
1. The Wave 0 change set (both repos, branch `wave0/back-online`) is committed and gated. D2 moves
   files that are uncommitted in that set today (`src/crm/vac.service.ts`,
   `src/tenant/services/card-data-guard.service.ts`, `src/common/card-data-detector.ts`). Moving
   uncommitted files under a pending gate would make the gate's verdict meaningless.
2. The backend is back online (Render). Every product host answers Vercel 402 today, so nothing
   in this ADR can be demonstrated live until that is done. `/api-json` cannot be read, so every
   claim below about "what the API offers" comes from controllers in this tree, **not from the
   spec**. `[UNVERIFIED: /api-json — every host offline 2026-11-17]`.

**Line numbers** are as read on 2026-11-17 in a working tree with large uncommitted changes. Re-grep
the symbol before relying on one.

---

## 1. Context — what "apps snap on" claims, and where the code disagrees

The workspace `CLAUDE.md` §2 says: *"Adding a vertical is a pack plus a UI. It is never a new
backend."* The operator's 2026-11-17 direction sells Meru as "one engine, every regulated app",
with ImmiStack and GovX as example apps. Both statements are only partly true today. Each claim
below was re-verified against this tree for this ADR.

### 1.1 A vertical is code: a TypeScript enum and a Postgres enum

- `tenants.vertical` is `@Column({ type: 'enum', enum: VerticalType })`
  (`src/iam/entities/tenant.entity.ts:64-65`). `VerticalType` is `immigration | grc | labour`
  (`:27-31`).
- The Postgres type is `vertical_type_enum AS ENUM('immigration','grc','labour')`
  (`src/migrations/1738479999999-FixVerticalsAndColumns.ts:12`).
- So a fourth vertical needs a migration (`ALTER TYPE … ADD VALUE`, which cannot be removed
  again), an enum edit, a build and a deploy. That is a new backend release, not a pack.

### 1.2 Four vertical vocabularies disagree (five, counting the database)

| Source | Values | Who reads it |
|---|---|---|
| Postgres `vertical_type_enum` | `immigration, grc, labour` | the column |
| `src/iam/entities/tenant.entity.ts:27` `VerticalType` | same three | DTOs, provisioning, middleware |
| `src/iam/enums/vertical.enum.ts:1` `VerticalType` | + `fintech, legal` | `PolicyGuard`, `VerticalPolicyService`, `ai.service.ts`, `ai.controller.ts`, `ai-request.dto.ts`, `orchestration.service.ts`, `tenant-context.middleware.ts` |
| `packages/config-packs/_schema/pack.schema.ts:797-807` | nine values, including `banking`, `health`, `tax`, `education` | the pack loader |
| `src/common/types.ts:293` `MeruVertical` | six values, includes `banking`, **excludes `grc`** | **nothing**: grep finds the declaration only |

Two of these share the name `VerticalType`, so an import picks one by path.

### 1.3 Hardcoded per-vertical maps in core

Every map below has to be edited when a vertical is added. That is the main reason "a pack plus a
UI" is not true yet.

| # | Where | What it hardcodes |
|---|---|---|
| M1 | `src/core/verticals/vertical-policy.service.ts:28-75` | `verticalConfigs: Record<VerticalType, VerticalPolicy>` covers MFA, IP list, business hours and retention days, for five verticals. **This is live enforcement**: `PolicyGuard` applies it to every guarded route. |
| M2 | `src/iam/tenant-provisioning.service.ts:84-100` | `GRC_PLAN_MODULES`, the per-plan module codes granted to a GRC tenant at provisioning |
| M3 | `src/iam/middleware/tenant-context.middleware.ts:39-52, :181` | domain map (`api.immistack.com`, `api.governancex.com`) and an `IMMIGRATION` default for "core platform". Grep found no reader of the `req.vertical` it sets. |
| M4 | `src/main.ts:72-90` (and its hand mirror `api/index.js:138-146`) | rate-limit tier chosen from the **client-supplied `x-vertical` header** or a substring of the host |
| M5 | `src/config/configuration.ts:23-25` | `VERTICAL` env var restricted by Joi to six values. It is read only for a log line and `/health` (`main.ts:171`, `health.controller.ts:36`). |
| M6 | `src/tenant/tenant.controller.ts:53` | Swagger body enum `['immigration','grc','labour']` |
| M7 | `src/core/tenancy/vertical-datasources.service.ts:34-43` | `switch` from vertical to a database URL. ADR 0013 governs this, and it is not activated. |
| M8 | `src/ai/ai.controller.ts:82`, `src/orchestration/orchestration.service.ts:382` | default the AI vertical to `IMMIGRATION` when none is given. That is core defaulting upward to a vertical. |
| M9 | `src/iam/dto/create-tenant.dto.ts:49-52` (and `provision-tenant.dto.ts:38`, `mint-tenant-signup-invite.dto.ts`) | `@IsEnum(VerticalType)` |

### 1.4 Immigration logic lives in core modules

- `src/crm/vac.service.ts` (829 lines, uncommitted, ADR 0026) is visa-application-charge logic. It
  holds `STAGE_AT_OR_BEYOND_LODGED` with immigration stage names (`:13-18`) and is wired in
  `CrmModule` (`src/crm/crm.module.ts:32`). It is reached through five
  `/crm/entities/:id/vac/*` routes on the generic CRM controller (`src/crm/crm.controller.ts:760-904`).
- `src/tenant/services/card-data-guard.service.ts:86` has `if (!pack && vertical === 'immigration')`,
  a vertical-specific fallback in a core service. Its own doc comment (`:34-35`) says so.
- The card-number detector itself (`src/common/card-data-detector.ts`) is **not** vertical logic.
  PAN detection is horizontal, and it stays in core.

### 1.5 Regulator routes are hand-written per adapter

`src/integrations/integrations.controller.ts:372-823` declares **31** routes by hand across the eight
adapters (`au/*` 4, `ae/*` 4, `sa/*` 4, `qa/*` 4, `bh/*` 4, `ca/*` 3, `uk/*` 4, `nz/*` 4). There is
already a `GovernmentAdapter` interface (`src/integrations/interfaces/government-adapter.interface.ts:43`).
Adding a country is therefore a controller edit. **This ADR does not change that** (D5). The third
example app is chosen so that it needs no adapter.

### 1.6 `EntityType` is a Postgres enum, and it already carries vertical vocabulary

`EntityType` (`src/crm/entities/universal-entity.entity.ts:20-92`) has **20** values. The
workspace docs say 19; `sar` and `trade_instrument` were added since. It is stored as a Postgres
enum (`:140`) and has been extended by six migrations (`AddLeadEntityType`, `AddGovxEntityTypes`,
`AddSarEntityType`, `AddTradeInstrumentType`, …). Several values are GovX vocabulary
(`vendor`, `control_test`, `screening_match`, `turnover_record`, `sar`, `trade_instrument`), which
is in tension with the 80/20 rule. A vertical whose records do not fit the 20 values still needs a
backend release. That is deferred (D5), and the third app is chosen to avoid it.

### 1.7 Frontends are hand-built, and the one pack-driven form reads a frontend copy

- `immistack/` has 40 `page.tsx`, `governancex/` 31, and `meru-dashboard/` 12. All are hand-built
  pages. Only navigation renders from the pack (`GET /config-packs/me/navigation`, in both product
  apps).
- `governancex/components/govx/entity-form-dialog.tsx` + `pack-field-input.tsx` is the only
  pack-driven entity form, used by eight GovX pages. **It renders from a copy of the pack held in
  the frontend** (`governancex/lib/config-pack/entity-types.ts`). That file's header says
  `entityTypes` is stripped by Zod and not persisted by the loader. **That is no longer true**:
  `pack.schema.ts:888` declares `entityTypes`, and `config-pack-loader.service.ts:506` persists
  it. What is really missing is a **tenant-scoped route that returns it**. Only `me/navigation`
  and `me/dashboards` exist (`src/tenant/controllers/config-pack.controller.ts:124, :150`).

### 1.8 Nothing sits above a tenant

`Tenant` has no parent, group or partner column (grep of `tenant.entity.ts`). Every identity is one
`users` row in one tenant (ADR 0023 D3). ADR 0016's "partner" means a referral partner
*inside* a tenant. It is not a level above one.

### 1.9 Two more things found while verifying, which this ADR has to account for

- **`POST /config-packs` bypasses every pack safety check.** `ConfigPackService.create`
  (`src/tenant/services/config-pack.service.ts:41-61`) writes `dto.schema` straight to the row. It
  does no Zod parse, no overlay merge, no `danglingStepReferences` check and no
  `unnamedSubjectMappings` rejection. The route is `platform_admin`-only, but it is the one way a
  pack could reach a tenant without a deploy, so D1 has to close it.
- **An outbound request to any URL is reachable from a `staff` token in code.**
  `POST /notifications` is `@Roles(STAFF, FIRM_ADMIN)` (`src/notifications/notifications.controller.ts:49,70`)
  and accepts `type: 'webhook'`. `metadata.customData.url` passes `@IsObject()` and is persisted
  (`notifications.service.ts`, `metadata: options.metadata`). The dispatch sweep then calls
  `fetch(url)` with no host or address check (`src/notifications/notification-dispatch.service.ts:226, :262`).
  The workflow webhook action (`src/workflow/workflow.service.ts:1027-1105`) has the same missing
  check. It is **not** reachable over HTTP today, for the following reason. `POST /workflows` creates
  only `DRAFT` workflows; `startInstance` refuses non-`ACTIVE` ones (`workflow.service.ts:286`); and
  only pack materialisation sets `ACTIVE` (`pack-workflow.service.ts:114`), writing `actions: []`
  (`:203`). **Separately, `POST /workflows` carries no `@Roles`** (`workflow.controller.ts:125`),
  so any authenticated tenant user, `client` included, can create a draft workflow. Both items go
  to Anton (D4 and the closing note).

---

## 2. Decisions

### D1 — A vertical is a row in a `verticals` registry table, not an enum

**Decision.** Introduce a platform-global `verticals` table keyed by `code`. Convert
`tenants.vertical` from `vertical_type_enum` to `varchar(32)` with a foreign key to
`verticals(code)`. Seed exactly `immigration`, `grc` and `labour`, so every existing tenant and pack
keeps resolving unchanged. Replace each hardcoded map (M1–M9) with a column of that row.

#### D1.1 Shape

```
verticals
  code            varchar(32)  PK   CHECK (code ~ '^[a-z][a-z_]{1,31}$')   -- must match the pack `code` regex (pack.schema.ts:779)
  name            text         NOT NULL
  status          text         NOT NULL  CHECK (status IN ('active','preview','retired'))
  policy          jsonb        NOT NULL  -- M1: { mfaRequired, ipWhitelist[], businessHours{start,end}, dataRetentionDays }
  planModules     jsonb        NOT NULL DEFAULT '{}'   -- M2: { "<TenantPlan>": ["<ModuleCode>", …] }, additive to PLAN_MODULES
  rateLimitTier   text         NOT NULL DEFAULT 'default'   -- M4: a named tier; the numbers stay in env
  hostnames       text[]       NOT NULL DEFAULT '{}'        -- M3/M4: hosts that identify this vertical for pre-auth concerns only
  defaults        jsonb        NOT NULL DEFAULT '{}'        -- e.g. { cardDataGuardMode: 'warn' } (D2.3)
  createdAt, updatedAt timestamptz
```

- **No secrets and no customer data may go in this table.** It is readable by every tenant (D1.4).
  M7 (database URLs) does **not** move here. ADR 0013 owns it, and a connection string is a secret.
- Seed values copy today's code exactly. `immigration`, `grc` and `labour` get the `policy`
  values in `vertical-policy.service.ts:29-56`. `grc` gets `GRC_PLAN_MODULES[GRC]` as
  `planModules`. `immigration.defaults.cardDataGuardMode = 'warn'` (D2.3). `fintech` and `legal`
  are **not** seeded: no tenant can hold them, because the column enum forbids it today, so they are
  policy rows for nothing.
- `labour` is seeded `active`, because `CreateTenantDto` accepts it today. Changing that is a
  separate decision. It still has no pack, and that stays honest: `forVertical('labour')` returns
  `null` exactly as now.

#### D1.2 What each hardcoded map becomes

| Map | Becomes |
|---|---|
| M1 `VerticalPolicyService.verticalConfigs` | `VerticalRegistryService.get(code).policy`, cached under the same key shape (`vertical_policy:<code>`). **The cache is keyed by vertical code and holds no tenant data**, so a shared key is correct. A registry miss for a tenant's own vertical cannot happen because of the FK. If one happens anyway, `PolicyGuard` refuses with 403. Today it would dereference `undefined.rules` and throw a 500. |
| M2 `GRC_PLAN_MODULES` | `registry.planModules[plan]`, appended at provisioning. Grants stay **frozen into `tenants.settings.modules` at provisioning** (workspace §7.2). A registry edit never rewrites a live grant. |
| M3 middleware domain map | **Deleted.** It sets `req.vertical`, which grep shows no reader of, and its `api.governancex.com`/`api.immistack.com` hosts do not exist. Host-to-tenant resolution already exists as `GET /tenants/resolve`. |
| M4 `x-vertical` rate limit | The tier comes from `registry.hostnames` matched against the request host, and **never from a request header**. Today any caller can send `x-vertical: immigration` to choose its own bucket. The per-tier numbers stay in env. `api/index.js` is Vercel-only, and Vercel is being retired (Render runs `dist/src/main.js`, `Dockerfile:67`), so it is changed only if Vercel is kept. |
| M5 `VERTICAL` Joi list | Becomes `Joi.string()`, because it is a deployment label used for logs only. **`src/config/**` is frozen by Wave 0. This row waits for that commit.** |
| M6 Swagger enum | `type: string`, with a description pointing at `GET /verticals` (D1.5) |
| M7 datasource switch | **Unchanged.** ADR 0013's decision, and inert (`forVertical()` has zero callers). |
| M8 AI default `IMMIGRATION` | Defaults to the **caller's tenant vertical** (`req.tenantVertical`, which `PolicyGuard` already attaches). Core stops defaulting to a vertical. |
| M9 DTO `@IsEnum` | See D1.3 |
| `src/iam/enums/vertical.enum.ts` | **Deleted** once M1, M8 and the AI DTO stop importing it. `VerticalCode = string` replaces both `VerticalType`s as the type. The entity-side `VerticalType` survives as a `const` of the three seeded codes, **only** for code that legitimately names a vertical (D2's `@ForVertical('immigration')`). |
| `src/common/types.ts:293` `MeruVertical` | **Deleted.** No reader. |
| `pack.schema.ts:797` nine-value `z.enum` | `z.string().regex(^[a-z][a-z_]{1,31}$)`, regenerated with `npm run packs:schema`. The loader then **refuses a pack whose `vertical` is not a registry row** (an error per pack, and the others still load), in the same direction as `danglingStepReferences`. This closes the trap in workspace `CLAUDE.md` §5: a pack declaring `health` would "load cleanly and resolve for no tenant, ever". `banking` legacy packs: none on disk (grep). **`packages/config-packs/**` is frozen by Wave 0. This row waits for that commit.** |

#### D1.3 How `CreateTenantDto` validates

`@IsString() @Matches(/^[a-z][a-z_]{1,31}$/)` in the DTO, which rejects malformed input at the pipe.
Then `VerticalRegistryService.assertProvisionable(code, actor)` runs in the service, before the
insert:

- unknown code → **400** `MER-VAL-xxxx` *"unknown vertical"* `[UNVERIFIED: next free MER-VAL code at implementation]`;
- `retired` → 400;
- `preview` → 400 unless the actor is `platform_admin`. A preview vertical can be provisioned by
  the operator for a demo, but not through a signup invite;
- `active` → allowed.

The FK is the backstop. Without the service check, an unknown code becomes an FK violation, which
is a 500 at insert, the exact failure `create-tenant.dto.ts:12` was written to prevent. The same
check applies to `ProvisionTenantDto` and `MintTenantSignupInviteDto`. An invite pinned to
`allowedVertical` is re-checked **at redemption**, because a vertical can be retired between mint
and redeem.

#### D1.4 Tenancy — stated per layer, derived from this tree

- **The table is platform-global and not tenant-scoped.** It follows the `config_packs` precedent
  exactly: `ENABLE` + `FORCE` RLS, `platform_global_read FOR SELECT USING (true)`, and
  `platform_global_write FOR ALL USING (app.rls_bypassed()) WITH CHECK (app.rls_bypassed())`
  (`src/migrations/1753500000000-AddTenantRowLevelSecurity.ts:63-69, :213-236`). The migration
  **must also be added to `MigrateService`'s `rlsMigrations` replay list** (`src/jobs/migrate.service.ts:150-157`).
  Otherwise a fresh-bootstrap database fails its own coverage assertion. That has already happened
  twice (`job_runs`, `tenant_signup_invites`).
- **The binding of tenant to vertical lives on `tenants`**, which keeps its `tenant_isolation` policy
  (`AddTenantRowLevelSecurity.ts:173-186`). **No route may change a tenant's `vertical`.** That is
  not offered today and is not offered here. Changing it would move a live tenant onto another
  vertical's pack, policy and module grants in one write.
- **Writes** go through two new routes, `POST /platform/verticals` and `PATCH /platform/verticals/:code`.
  Both are `platform_admin` only and run inside `TenancyService.runAsGod`. The `CRITICAL` audit
  entry is written first, and the call rethrows if the audit write fails (workspace §7.7). There is
  no `DELETE`: retire instead, because the FK makes a delete fail while any tenant holds the code.
- **Reads**: `GET /verticals` (authenticated) returns `code`, `name` and `status` only. It does
  not return `policy` or `hostnames`, because no tenant needs another vertical's IP list.
- **Caches**: the policy cache is keyed by code (global content). `PolicyGuard.verticalCache` stays
  keyed by `tenantId` (`policy.guard.ts`). `CardDataGuardService`'s cache stays keyed
  `${tenantId}:${vertical}`. None of the three caches can serve one tenant's data to another.
- **Propagation**: a registry `PATCH` takes up to the cache TTL to apply. That is 1 h for the
  policy cache and 5 min for `PolicyGuard`. The route invalidates the cache only on the instance
  that served it. `[UNVERIFIED: Render instance count — with more than one instance, other instances wait out the TTL]`.

#### D1.5 Close the pack side door (§1.9)

`ConfigPackService.create`/`update` must run the loader's own pipeline: Zod parse → overlay
merge → the reference checks → the 23-key persist list. A pack that would be refused at boot is
then refused over HTTP too. Until then, adding a vertical means a registry row (data, no deploy)
**plus a pack file on disk (an image rebuild and a deploy, with no `src/` change)**. That is the
honest version of the claim: **"no backend code", not "no deploy"**.

#### D1.6 Migration and rollback

**Forward** (one migration, timestamp after `1757400000000` `[UNVERIFIED: next free timestamp at implementation — 0023 and Wave 0 are also allocating]`,
registered in **both** `ALL_MIGRATIONS` and `ALL_ENTITIES`, and in `MigrateService`'s replay list):
1. `CREATE TABLE verticals …` + RLS + the two policies.
2. `INSERT` the three seed rows.
3. `ALTER TABLE tenants ALTER COLUMN vertical TYPE varchar(32) USING vertical::text`.
4. `ALTER TABLE tenants ADD CONSTRAINT fk_tenants_vertical FOREIGN KEY (vertical) REFERENCES verticals(code)`.
5. **Do not `DROP TYPE vertical_type_enum`.** It is left in place so the rollback is cheap. It is
   dropped in a later migration once this ADR is `Implemented` and a release has passed.

**Order and compatibility.** The forward migration is **compatible with the old code**. Old code
reads the column as a string, and writes only the three values, which all exist as registry rows.
So the migration can and **must** be applied before the code that reads `verticals` is deployed
(workspace §9: migrations first). Render's `autoDeployTrigger: "off"` (`render.yaml:125`) makes
that ordering a manual step. Write it into the runbook.

**Rollback (`down()`)**, in this order:
1. `ALTER TABLE tenants DROP CONSTRAINT fk_tenants_vertical`.
2. `ALTER TABLE tenants ALTER COLUMN vertical TYPE vertical_type_enum USING vertical::vertical_type_enum`.
   **This fails if any tenant holds a code outside the three.** That is deliberate: such a tenant
   exists only because a registry-only vertical was used, and rolling back would orphan it. The
   precondition is `SELECT count(*) FROM tenants WHERE vertical NOT IN ('immigration','grc','labour') = 0`.
   If it is not zero, rollback is an **operator decision** about those tenants (suspend, or keep
   the forward schema), never an automatic step.
3. `DROP TABLE verticals`.

Code rollback is a `git revert`. Because the forward schema is compatible with the old code, a code
revert **does not** require a schema revert.

**Stacking verification (workspace §7.2):** after the migration and after the code, call
`GET /config-packs/me/navigation` and one guarded write as **an immigration tenant and a GRC tenant**.
Re-run `scripts/smoke/cross-tenant.sh` and the frontend sweep against both baselines.
`[NEEDS DATA: current sweep baselines — 33/33 and 27/28 were measured on 2026-09-10, before the hosts went offline]`.

#### D1 — options rejected

- **Keep the enum and add a value per vertical.** `ALTER TYPE … ADD VALUE` cannot be removed, so it
  has no clean rollback. Every vertical would be a backend release, which is the opposite of the
  claim being made.
- **Store `vertical` as free text with no table.** The four-enum drift (§1.2) would become infinite
  drift. No FK means a typo provisions a tenant that resolves to no pack, silently, which is the
  GovX-resolved-to-nothing incident again.
- **Put the registry inside the config pack** (a pack declares its own vertical). A pack is per
  vertical *and* per country (five packs answer to `grc`), so there is no single row to own policy
  or plan modules. And pack upload has no validated HTTP path today (D1.5).
- **Hold the registry in env/JSON in the image.** That would still mean a deploy per vertical, with
  no FK and no audit trail on change.

#### D1 — consequences

- Good: verticals, policy and plan modules become auditable data, with one vocabulary instead of five.
- Bad: one more global table on a path every request takes (`PolicyGuard`), held behind two caches.
  A bad `policy` row (for example a non-empty `ipWhitelist`) locks out **every tenant of that
  vertical**, which is exactly the risk `vertical-policy.service.ts:21-27` warns about. The `PATCH`
  route therefore validates `policy` with the same Zod shape as the seed and refuses a non-empty
  `ipWhitelist` or `businessHours` narrower than 0–24 unless `?confirm=lockout-risk` is passed.
  Anton should rule on whether those two fields should be per-tenant instead.
- Bad: the error code for an unknown vertical changes, from the DTO's `@IsEnum` message to
  `MER-VAL-xxxx`. A frontend matching on message text breaks. `[UNVERIFIED: any frontend matches that message]`.

**Size (4-person team, estimate):** 8–12 engineer-days, plus Anton and Owen review. That is about
2 calendar weeks with two people. D1.5 adds 2–3 days of that.

**What a grant reviewer can be shown:** a screen recording in which the operator creates a
`preview` vertical row through `POST /platform/verticals`, loads a pack for it, and provisions a
tenant on it, with a diff showing **zero lines changed in `src/`** and the audit entries for each
step. Do not describe this as live, or as having a customer.

---

### D2 — Vertical logic lives in vertical modules under `src/verticals/<code>/`, which may import core and which core may never import

**Decision.** Create `src/verticals/<code>/` as the one place vertical-specific behaviour that cannot
be expressed as pack JSON is allowed to live. Each is a NestJS module that imports core modules'
exported services. **Core never imports from `src/verticals/**`**, and an ESLint
`no-restricted-imports` rule enforces that (`eslint.config.mjs` exists, ESLint 9). Routes in a
vertical module are gated by a `@ForVertical('<code>')` guard. The first, and in this ADR the only,
tenant is VAC.

#### D2.1 Where VAC goes

- `src/crm/vac.service.ts`, the five VAC DTOs in `src/crm/dto/`, and the VAC specs
  (`vac-*.spec.ts`) **move** to `src/verticals/immigration/vac/`. This is a **pure move**: no
  behaviour change, and each spec moves with the file it tests.
- The five routes move off `CrmController` to a new `ImmigrationVacController`, **keeping the
  identical paths** `/crm/entities/:id/vac/*`. The public API, the Swagger tag and ImmiStack's
  calls do not change. Path and module are independent in Nest. Keeping the path avoids a
  frontend change and a contract break.
- `VacService` keeps calling what it calls today, through exported core services. If something it
  needs is not exported, it gets exported. The vertical does not reach into core internals.
- `STAGE_AT_OR_BEYOND_LODGED` (`vac.service.ts:13`) stays in the vertical module for now. It is
  pack vocabulary in principle (`lockedWhen` already does this in the pack), and moving it into
  the pack is a later pack change, not part of this move.

#### D2.2 Tenancy, per layer

The routes keep exactly today's chain: `AuthGuard('jwt')` → `PolicyGuard` → `TenantBindingInterceptor`,
with RLS on `universal_entities`. Then **`ForVerticalGuard`** answers **404**, not 403, when
`req.tenantVertical !== 'immigration'`. A GRC tenant probing `/vac/*` learns nothing, by the same
404 logic the document routes use. Then, unchanged, `VacService`'s own `{id, tenantId}` load and
actor check, including client own-scope on `self-report` (ADR 0026). The move must not route any
of these through `CrmService.updateEntity`; ADR 0026 §9 bypasses it deliberately. Owen's gate
for D2 is: the moved specs pass unmodified, plus one new spec showing a GRC-tenant token gets 404
on each of the five paths.

#### D2.3 What happens to `CardDataGuardService`

It stays in core (`src/tenant/services/`), because card-data scanning of comments and threads is
horizontal. The `vertical === 'immigration'` fallback (`card-data-guard.service.ts:86`) becomes
`registry.defaults.cardDataGuardMode` (D1). Core then reads data, not a vertical name.
`src/common/card-data-detector.ts` stays where it is.

#### D2 — options rejected

- **Leave VAC in `src/crm`.** It works, but every vertical then grows `src/crm`. The next one (GRC
  trade or vessel logic) would land beside it, and "core knows a record that can be worked" stops
  being true at the file level.
- **Express VAC entirely as pack JSON** (rules, `lockedWhen`, alert rules). The parts that are
  *data* are already there. The parts that are *access control* (who may write which status,
  the either/or in `verify`, client own-scope on `self-report`) are actor checks. Putting access
  control in JSON authored by a pack writer is the sandbox problem the no-`eval` rule exists for.
- **A separate service per vertical.** It cannot share a transaction with the entity row, it
  doubles the deploy surface for a team of four, and it buys nothing at current load.
  `[NEEDS DATA: any production load figure — none exists; there is no traffic]`.
- **Runtime-loaded vertical code (plugins from the database or a bucket).** That is code execution
  from data, the same class as `eval`. Rejected outright.

#### D2 — consequences

- Good: a reviewer can verify "core is vertical-neutral" with a lint rule, not by reading.
- Bad: `@ForVertical` is a new guard on a path ImmiStack already calls. Per workspace §7.2 it must
  be verified against an **immigration tenant first**. A registry or cache fault that makes
  `tenantVertical` null would 404 ImmiStack's VAC routes, which fails closed but is still an outage
  for that feature. Applying it **only** to the moved VAC routes, and nothing else, bounds that.
- Bad: two controllers serve `/crm/entities/:id/*`. Route-order collisions are possible
  (`GET /workflows/:id` once swallowed `instances`). VAC is all `POST` with literal suffixes, so
  `[UNVERIFIED: no collision — confirm with the route table at boot]`.

**Size:** 4–6 engineer-days, including the lint rule and the 404 spec. It cannot start until Wave 0
is committed and ADR 0026's gate has passed on the files being moved.

**What a grant reviewer can be shown:** the module graph (core ← verticals, never the reverse)
and the lint rule failing on a deliberately bad import. This is engineering hygiene, not a demo.

---

### D3 — One generic Next.js app, `meru-apps`, renders a vertical entirely from its pack, proven by a third example app

**Decision.** Build `meru-core-fe/meru-apps/` as a fourth Next.js app, alongside the others and on
the same conventions (own lockfile, own Render service, httpOnly session cookie). It renders
navigation, entity lists, entity detail and forms, workflow steps and transitions, document
checklists and dashboards **only from the caller's resolved pack and the existing generic
endpoints**, with no per-vertical page. ImmiStack and GovernanceX stay as they are. They are the
bespoke example apps, and `meru-apps` is the proof that a bespoke app is optional.

#### D3.1 The API contract it needs, and what exists today (from controllers; spec unreadable)

| Need | Route | State |
|---|---|---|
| Brand the login page by host | `GET /tenants/resolve?host=` (public; slug, name, vertical, logo, colours) | **exists** |
| Sign in / session | existing auth routes | exists. ADR 0023 may change the flow; meru-apps follows whichever ships |
| Sidebar | `GET /config-packs/me/navigation?portal=` | exists (`config-pack.controller.ts:124`) |
| **Entity types, fields, status labels, workflow step/transition labels, document types, locales, `uiConfig`** | **`GET /config-packs/me/manifest?portal=`** | **MISSING.** This is the one new backend route |
| Lists, detail, create, edit | `/crm/entities?type=`, `/crm/entities/:id`, `POST`, `PATCH` | exists |
| Record rule report | `GET /crm/entities/:id/rules` | exists |
| Workflow steps | `GET /workflows/pack`, `GET /workflows/instances/:id/transitions`, `POST /workflows/instances/:id/transition` | exists |
| Checklist | `GET /documents/checklist`, `POST /documents/checklist/request` | exists |
| Dashboards and KPIs | `GET /config-packs/me/dashboards`, `GET /analytics/dashboards/:key`, `GET /analytics/trends/:kpiKey` | exists |

**The manifest route.** It returns the render-relevant subset of the pack that
`VerticalPackService.forVertical` resolves for the caller's tenant, honouring pins
(`vertical-pack.service.ts:58, :94`): `code, version, vertical, locales, entityTypes,
documentTypes (key, label, appliesWhen), workflows (ids, names, step ids/names/types/formFields,
transition labels), roles (key, label), uiConfig`. It **never** returns `prompts`, `scoringModels`,
`rules` bodies, `alertRules`, `messaging` or `importMappings`. Those are operational internals,
and a `client`-role token has no business reading a firm's prompt library. It filters by
portal and role in the same way `PackUiService` filters navigation. Today `GET /config-packs/:id`
returns the **whole raw pack to any authenticated token** (`config-pack.controller.ts:205-212`,
no `@Roles`). That is pack content, not tenant data, so it is not a tenancy breach. But
`meru-apps` must not be built on it, and Anton should decide whether it narrows to staff
(closing note).

**One additive pack-schema key.** `navigation[].target`:
`{kind:'entityList', entityType} | {kind:'dashboard', key} | {kind:'checklist'} | {kind:'workflowQueue', workflowId}`.
Today a nav item carries an app-specific `path` (`/obligations`, …) that only a hand-built app
understands. `target` is optional and additive, and `path` stays for ImmiStack and GovX. This is
the three-part schema commit from workspace §6 rule 1 (Zod, `packs:schema`, loader key list), plus a
version bump. **`packages/config-packs/**` is frozen by Wave 0. This waits for that commit.**

**Field types.** `entityTypes[].fields[].type` is deliberately loose (`pack.schema.ts:880-887`).
`meru-apps` supports the set GovX's `PackFieldType` already handles, and renders **anything else as
read-only text with a visible "unsupported field type" marker**, never as a silent text input. A
renderer that quietly accepts input for a type it does not understand produces wrong data, the
plausible-wrong-value failure workspace §16 recorded for the stage vocabulary.

#### D3.2 Tenancy in the app, per layer

- **Identity and tenant come only from the session token.** The resolved host is used for
  branding before login and never for authorisation. `meru-apps` holds no tenant data server-side.
- **No shared fetch cache across users.** Every server-side call to the API is `cache: 'no-store'`,
  and authenticated pages are `dynamic`. A Next.js data cache keyed by URL alone would serve one
  tenant's `/crm/entities?type=case` to the next. That is the cache-key form of a tenant leak, and
  it is the single most likely way this app could cause an isolation incident. Owen's gate: a test
  that two sessions from different tenants never receive each other's response from the same URL.
- **The manifest** is resolved under the caller's `TenantContext`, so pins apply per tenant. Its
  cache, if any, is keyed by `pack code + version + portal + role`. Those are global content keys
  with no tenant data in the value.
- **Records** are confined by the API as today: RLS for the tenant, and `scopeOf`/`assertOwnsEntity`
  for a `client`. Hiding a nav item or an entity type in the manifest is **cosmetic, not access
  control** (workspace §7.6). Every route behind it enforces its own.

#### D3.3 The third example app: **Compliance Register** (vertical code `register`)

What it is: an obligations register, a breach and incident register, a policy library and training
attestations for a small regulated firm. It is one product a compliance officer could use on day one.

Why this one:
- **No regulator adapter.** These registers are records a firm keeps about itself. Nothing in them
  calls a government API.
- **No new `EntityType`.** It uses `obligation`, `breach`, `person`, `training_module` and
  `knowledge_article`, all among today's 20 (§1.6). Attestation is a `relationships[]` edge between
  `person` and `training_module` via `EntityRelationService`. That is pack JSON, not a type.
- **Regtech-first**, matching the operator's direction. The buyer is a regulated firm. It is also the
  part of GovX's value that is **not** UAE-specific: `grc.json` carries `dataResidency: "AE"`, CBUAE
  frameworks and a `uae-central-bank` adapter step (workspace §6), and this pack would carry none
  of them.
- It exercises every D3 surface: lists and forms (obligations), a workflow (breach triage →
  assess → decide reportable → close), a checklist (policy documents per obligation) and a
  dashboard (open breaches, overdue obligations).

**Alternatives rejected:**
- *`labour`*: it already exists in the enum and needs no D1. But the valuable labour checks (right
  to work) need regulator adapters (`uk/right-to-work`), and labour is not the operator's
  regtech-first story. It stays the **fallback** if D1 slips: a `labour` pack could prove the
  renderer with no registry.
- *A new vertical needing `complaint` or `policy` types*: that would need an `EntityType` migration,
  which this proof exists to avoid.
- *Re-rendering `grc` or `immigration` only*: it proves genericity but not "a new app". It is still
  step 1 of the build (D3.4), because it is the cheapest regression check that the renderer is
  generic.

**Open:** whether `breach`'s pack workflow materialises with `entityType: 'breach'`
(`pack-workflow.service.ts` reads `def.entityType`; all current pack workflows use `case`)
`[UNVERIFIED]`. Also `[NEEDS DATA: first target jurisdiction for the register, which sets compliance.dataResidency and the regulator vocabulary]`
and `[NEEDS DATA: whether the operator sees this as overlapping GovX in the market — a positioning call, not an architecture one]`.

#### D3.4 Build order inside D3

1. Manifest route + `navigation[].target`, backend (Luke).
2. `meru-apps` rendering the **existing `grc` and `immigration` packs**, side by side with the
   bespoke apps. Every screen that cannot be rendered is a contract gap to list, not a page to
   hand-build.
3. Author `register.json`, add the registry row as `preview` (D1), provision a demo tenant, and
   render it with no `meru-apps` code change. **If step 3 needs a code change in `meru-apps`, that
   change is a finding against the contract.**

#### D3 — options rejected

- **Grow GovX's pack-driven pages into the generic app.** GovX is locale-routed (`/en`, `/ar`),
  UAE-flavoured, and its form reads a frontend copy of the pack. Generalising it would make
  GovX-the-example and Meru-the-platform one deployable, the merge workspace §4 warns against for
  marketing and product.
- **A shared component package used by all three apps.** That conflicts with the deliberate
  one-lockfile-per-app, not-a-workspace rule (workspace §9). It may come later. It does not prove
  that apps snap on.
- **Server-driven UI (the API returns rendered screen JSON).** It moves UI decisions into core,
  which is a layer violation (core knowing screens), and doubles the contract surface.

#### D3 — consequences

- Good: "new vertical = pack + registry row" becomes demonstrable end to end.
- Bad: a fourth frontend to keep alive with a team of four. A generic renderer is plainer than a
  bespoke app. The first paying customer may want bespoke screens, and the answer then is an
  example app like ImmiStack, not bending `meru-apps`.
- Bad: `meru-apps` makes every pack defect visible at once. That is the point, but it will surface
  latent pack problems (for example unsupported field types) as visible gaps.

**Size:** manifest route and schema key: 4–6 engineer-days. `meru-apps` shell (auth, sidebar,
entity list/detail/form, workflow transitions, checklist, dashboards): 4–6 engineer-weeks frontend.
`register.json` authoring and review: 1–2 weeks. **About 6–8 calendar weeks with two or three
people.** This is the largest item here, and the estimate is the least certain.

**What a grant reviewer can be shown:** one app build rendering three different products from three
packs, with no per-product page code. The third product was created as data. Label everything as
demo tenants with sandbox data: there are no customers and no pilots (client `context.md`).

---

### D4 — API keys become a real, scoped, deny-by-default auth path; every outbound URL goes through one SSRF policy

**Decision (keys).** Build the guard that `validateApiKey` has been waiting for
(`src/iam/iam.service.ts:921`, dead per `:865-868` and `src/iam/entities/api-key.entity.ts:13-27`).
A key is a tenant-bound credential. It acts as its creator **re-validated on every request**, never
carries a platform role, and reaches **only routes that declare an API-key scope**.

- **Strategy and guard**: an `x-api-key` header becomes a `HeaderAPIKeyStrategy`, which calls
  `validateApiKey`, which finds the key in `TenantContext.runAsSystem` by `keyHash` (already
  so). Then:
  - **re-check the creator** on each request: user active, not locked, not deleted, and tenant not
    suspended. Today `validateApiKey` returns `apiKey.creator`'s roles with no status check, so a
    key would outlive its creator's removal;
  - **strip platform roles** (`platform_admin` and the operator roles). A key never acts across tenants;
  - **refuse a key whose creator is `client`**, at mint and at use.
- **Scopes, deny by default**: a route accepts key auth only if it carries `@ApiKeyScope('<scope>')`,
  and the key's `scopes[]` must include that scope. Every other route answers 401 to a key. Starting
  with an empty set of keyed routes is correct. The first scopes are the ones the first integration
  actually needs. `[NEEDS DATA: the first integration a customer has asked for]`.
- **Tenancy per layer**: the tenant comes from the key row, never from the request. The principal
  carries `tenantId`, and `TenantBindingInterceptor` binds it exactly as it does for a JWT, so RLS
  applies. In-tenant scoping (`scopeOf`) sees the creator's roles minus platform roles. The audit
  entry for every keyed write carries `apiKeyId` (`UserPayload.apiKeyId`, `src/common/types.ts:190`,
  already declared).
- **Routes**: `POST/GET/DELETE /iam/api-keys`, `firm_admin` only, audited. The raw key is returned
  once and only its SHA-256 is stored (already so). Rate limiting is keyed per key, not per IP.
- **Kill switch**: `API_KEY_AUTH=off|on`, default `off`, which refuses to boot on any other value.
  This is the `render.yaml` pattern. It exists because this is a new way into the system, and
  turning it off must not need a deploy.

**Decision (SSRF).** One `OutboundUrlPolicy` in `src/common/` is the only way core makes a request
to a URL a tenant influenced. It is used by both `notification-dispatch.service.ts` (webhook) and
`workflow.service.ts` (`executeWebhookAction` / `fireWebhook`):
1. `https:` only in production (`http:` allowed only outside production);
2. resolve DNS, **reject private, loopback, link-local (incl. `169.254.169.254`), CGNAT,
   multicast, unspecified and IPv6 ULA/link-local addresses**, then **connect to the resolved
   address** (pinning it) so DNS rebinding cannot swap it;
3. no redirects followed; ports 443 only (80 outside production); 10 s timeout (already so);
4. **plus a per-tenant host allowlist** in `tenants.settings.outboundWebhooks.allowedHosts`, managed by
   `firm_admin` and audited. An empty list means no outbound webhooks for that tenant.
   **No allowlist entry can override rule 2.**

Platform-fixed fetches (OFAC/UN feeds in `watchlist-ingest.service.ts`, regulatory radar sources,
regulator adapters) are **not** tenant-influenced and do not go through the tenant allowlist.
`[UNVERIFIED: regulatory-radar.engine.ts:336 and vessel-tracking.engine.ts:319 URLs are platform-fixed and not tenant-supplied — Anton to confirm]`.

**Why now:** the notification path (§1.9) is reachable in code by any `staff` token. It is not
reachable in production today **only because every host is offline**. It must close before the
backend comes back on Render, where the private network is reachable from the service.
**`src/notifications/**` and `src/workflow/**` are frozen by Wave 0.** This is the first thing to
land after that commit, or Anton may rule that it goes into Wave 0 itself. That is his call and
the operator's, not mine.

#### D4 — options rejected

- **Drop `api_keys` entirely** (the entity's own suggestion). That is reasonable if no customer
  integrates. But regulated firms' systems (core banking, practice management) integrate by service
  credential, and a grant reviewer will ask how. Kept, but off by default.
- **Keys as full impersonation of the creator** (what `validateApiKey` returns today). Rejected: no
  scope, and the key survives the creator's demotion.
- **OAuth2 client-credentials instead of keys.** It is the better end state, but too much for now.
  ADR 0023 is mid-flight on identity, and two auth changes in one release cannot be attributed if
  isolation regresses (0023 D9's own argument).
- **An SSRF denylist with no tenant allowlist.** It handles internal addresses but still lets any
  staff user send tenant data to any public host. That is an exfiltration path for a regulated
  firm's records.

**Size:** keys 4–6 engineer-days; SSRF policy 2–3 engineer-days. Each needs Anton's review.

**What a grant reviewer can be shown:** a test suite covering key scope denial, creator revocation
and the rejection of private addresses, plus a one-page security note. No claim of certification
(there is none).

**Rollback:** keys: `API_KEY_AUTH=off`. Every key then answers 401, with no deploy and no schema
change. SSRF: a code revert, but **do not roll back rule 2**. If the tenant allowlist breaks a
legitimate webhook, the rollback is adding that host to the tenant's list, which is data.

---

### D5 — Explicitly deferred, each with the trigger that reopens it

| Deferred | Why not now | Reopen when |
|---|---|---|
| **Self-serve builder UI** (and ADR 0023's `app_builder` role) | needs a new `ROLE_PRECEDENCE` member, which moves `scopeOf`, the 24-call-site contract ADR 0012 D3 froze; and D1.5's validated upload path must exist first | someone **outside the four-person team** needs to author a pack for a paying tenant |
| **Marketplace** | no third-party authors, no customers, no terms | a third party asks to publish a pack to tenants that are not its own, **and** commercial terms exist |
| **Partner tier above tenant** | contradicts ADR 0023 D3 (one subject, one `users` row); needs a `tenant_memberships` model ADR 0002 §5 and 0012 D6 bounded out | a signed customer needs one login across several tenants (a group with subsidiaries, or a reseller). Revisit 0023 D3 first. ADR 0016's referral partners are a different thing |
| **Three-database split** | ADR 0013 owns it; `forVertical()` has zero callers | 0013's own triggers: a contractual physical-separation or residency requirement |
| **Sovereign / single-tenant deployment** | the Render container is the prerequisite and is not live | a signed regulated customer whose regulator requires in-country hosting. Then it is the same image plus its own database, not a fork |
| **Generic regulator route** (`/integrations/adapters/:id/:op` over `GovernmentAdapter`) | the 31 hand-written routes work and are sandbox-only | the next adapter is written. Write the generic route instead of route 32 |
| **`EntityType` enum → text** | 20 values cover the third app; changing it touches `universal_entities`, the largest table | the first vertical whose records do not fit the 20 values |

---

### D6 — The GovX tasks board: two options, the operator decides

**The defect, verified.** The page renders four drag columns: `backlog`, `in-progress`, `review`
and `done` (`governancex/app/[locale]/(dashboard)/tasks/page.tsx:25-28`; type
`lib/types/index.ts:5`). A drop calls `updateTask`, which sends `PUT /tasks/:id` with
`{status: <column id>, tags, order, …}` (`governancex/lib/api/services/tasks.service.ts:67-79`).
The backend `UpdateTaskDto` has no `status`, `tags` or `order` (`src/tasks/dto/create-task.dto.ts:91-123`),
and the global pipe runs `forbidNonWhitelisted` (`src/main.ts:154-155`). **So every drag is a 400.**
The column ids are not even backend values (`in-progress` against `in_progress`, `backlog` and
`review` against `todo`/`under_review`). Also: `createTask` sends `status`/`tags`/`order` (400) and
omits `assignedTo`, which `CreateTaskDto` requires (`:51`). And `deleteTask` calls
`DELETE /tasks/:id`, which does not exist. The page itself handles the failure honestly (it
reverts and shows an error strip, `page.tsx:316-325`), so this is not a §7.3 lie. It is a board
that cannot do its job.

The backend can only `start` (→`in_progress`), `complete` (→`done`) and `cancel` (→`cancelled`)
(`task.controller.ts:171-222`). `todo`, `under_review` and `blocked` have no HTTP writer
(ADR 0014 §1.1).

**Option A: extend the backend.** Implement **ADR 0014** as written, rather than re-deciding it:
`PATCH /tasks/:id/move` (neighbour-resolved fractional position, compare-and-set,
`expectedVersion`, 409 with the truth attached). Then rewire the GovX service to map its columns
onto real statuses and send moves. Cost: 0014's backend (a migration adding `position` + `version`,
one route, a concurrency spec) about 5–8 engineer-days, plus 2–3 days frontend. It needs the 0014
gates (Owen on concurrency, Anton on the role gate). Benefit: free reordering and all six statuses
reachable, for **both** apps, because ImmiStack's board has the same limits.

**Option B: redesign the board around the transitions that exist.** Columns become `todo`,
`in_progress` and `done`. Drops are allowed only along `start` (todo→in_progress) and `complete`
(in_progress→done). Other drops are disabled with a stated reason, as ImmiStack's `resolveMove`
already does. `under_review`/`blocked` render as read-only columns if any task holds them. Cancel
replaces delete. Create sends `assignedTo` and drops `status`/`tags`/`order`. Within-column order
is `createdAt` (the only order the API has). Cost: 2–3 days, frontend only, no migration, no
backend gate beyond Owen's review.

**Recommendation: B now, A when ADR 0014 is accepted.** B is frontend-only, needs no backend
release while the backend is offline and Wave 0 is pending, and turns a board that 400s on every
drag into one that works within honest limits. A is the right end state, but it is already its own
ADR with its own gates, and should not be pulled forward for one page. **This is the operator's
decision.** Note that `meru-core-fe` currently has a frontend agent working in it, so B is
sequenced after that agent's change set lands.

**Rollback:** both are reverts. A's migration has 0014's own rollback.

---

## 3. Recommended order

| Step | What | Who | Depends on | Size (estimate) | Grant-showable |
|---|---|---|---|---|---|
| 0 | Wave 0 committed, gated; backend live on Render | operator, Jonas | operator: Neon account owner, Render payment method, a production data read | not mine to size | the platform answering at all |
| 1 | **D4 SSRF policy** | Luke, Anton | step 0 (frozen files) | 2–3 days | security note + tests |
| 1′ | **D6 option B** (if chosen) | Mira | the current frontend agent's work landing | 2–3 days | a working board |
| 2 | **D1 registry** (incl. D1.5) | Luke, Anton, Owen | step 0 (`src/config`, `packages/config-packs` frozen) | 8–12 days | a vertical added as data, zero `src/` diff |
| 3 | **D4 API keys** | Luke, Anton | can run in parallel with step 2 | 4–6 days | scoped integration story |
| 4 | **D3 manifest + `meru-apps` on existing packs** | Luke, then Mira | step 2 for `navigation[].target` landing in the same pack release | 4–6 days + 4–6 weeks | one app, two products |
| 4′ | **D2 VAC move** | Luke | step 0 and the ADR 0026 gate | 4–6 days | module-boundary lint |
| 5 | **D3 `register` pack as third app** | pack author, Mira | steps 2 and 4 | 1–2 weeks | three products from one app, the third created as data |

Steps 2 and 3 never ship in the same release as each other, nor in the same release as any `AUTH_NEON_MODE` change or ADR 0023 auth code (0023 D9).

End to end, with four people and nothing else competing: **about 10–12 calendar weeks after step 0**.
That is an estimate, and every other release (ImmiStack R0–R3, ADR 0023) competes for the same
four people. `[NEEDS DATA: how much of the team the operator assigns to this versus the ImmiStack release]`.

The order follows the risk. D4's SSRF is a live-in-code exposure and goes first. D1 is the
foundation everything else names. D3 is the grant story, but it is only honest once D1 makes the
third app *data*. D2 is hygiene that the grant story does not depend on, so it slots in wherever
Luke has capacity after Wave 0.

## 4. What would make this ADR wrong later

- **D1:** if the third app (step 5) still needs a `src/` change beyond D3's two contract items, the
  registry is ceremony and "apps snap on" is still false. Find out which core assumption leaked
  before adding a fourth vertical.
- **D1:** if no vertical beyond the three is provisioned within two quarters of D1 landing, the
  registry cost bought nothing. Leave it, but stop building on it.
- **D2:** if a second vertical module needs to call the first (GRC calling immigration), the
  boundary is wrong. Verticals must never import each other, and that need means something
  belongs in core.
- **D3:** if more than a handful of `meru-apps` screens end up needing per-vertical branches, the
  renderer has become a bespoke app with extra steps. Stop and decide between a component library
  and per-vertical example apps. The threshold is a judgement, not a measured number.
- **D3:** if the first paying customer is won on a bespoke example app and never touches
  `meru-apps`, the operator should know the renderer is a grant and engineering asset, not a
  sales one.
- **D4:** if no customer integrates within the first pilots, keep `API_KEY_AUTH=off` and consider
  dropping `api_keys`.
- **D6:** if ADR 0014 is accepted and built, option B's restrictions become wrong. 0014 §1.2 already
  says the same about ImmiStack's `resolveMove`.

## 5. Rollback — summary

D1: `down()` as in D1.6, guarded by the non-seed-vertical precondition. Code revert is independent of
the schema. D2: a pure-move revert, no schema. D3: delete the `meru-apps` Render service. The
manifest route and `navigation[].target` are additive, and packs that omit `target` still load. D4:
`API_KEY_AUTH=off`, and the SSRF allowlist is data. D6: a frontend revert.

## 6. Open questions

- `[UNVERIFIED: /api-json path list — every host offline; the D3.1 "exists" column is from controllers in this tree]`
- `[UNVERIFIED: Render instance count — sets how far registry cache staleness reaches (D1.4)]`
- `[UNVERIFIED: next free migration timestamp and MER-VAL code at implementation time]`
- `[UNVERIFIED: pack workflows materialise for entityType 'breach' (D3.3)]`
- `[UNVERIFIED: regulatory-radar and vessel-tracking fetch only platform-fixed URLs (D4)]`
- `[NEEDS DATA: production count of tenants per vertical, especially any 'labour' tenant — no database read was available]`
- `[NEEDS DATA: frontend sweep baselines once hosts are back]`
- `[NEEDS DATA: first target jurisdiction for the register app; whether it overlaps GovX commercially]`
- `[NEEDS DATA: first customer integration that would set the initial API-key scopes]`
- `[NEEDS DATA: team allocation between this groundwork and the ImmiStack release]`

## 7. Handed to others, not decided here

- **Anton:** (a) the `staff`-reachable outbound webhook (§1.9). Rule on whether D4's SSRF policy
  ships in Wave 0 or immediately after. (b) `POST /workflows` has no `@Roles`
  (`workflow.controller.ts:125`), so a `client` token can create draft workflows. Today they are
  inert, because only pack materialisation activates a workflow, but it is the shape of the
  recurring defect. (c) Whether `GET /config-packs` and `GET /config-packs/:id` should narrow to
  staff. (d) Whether `policy.ipWhitelist`/`businessHours` belong per vertical at all.
- **Mira:** `governancex/lib/config-pack/entity-types.ts`'s header is stale. `entityTypes` is now
  persisted (`config-pack-loader.service.ts:506`). Only the tenant-scoped read route is missing,
  and D3's manifest supplies it.
- **Docs:** the workspace and repo `CLAUDE.md` say `EntityType` has 19 values. It has 20.
