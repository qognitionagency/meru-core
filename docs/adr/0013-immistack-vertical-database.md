# 0013 — ImmiStack's own database: what stays on the control plane, and what has to be true before `forVertical()` is activated

**Status:** Proposed — 2026-09-10. Not merged. Requires review by `secops` (Anton) — this changes
where tenant data lives and where the audit chain is written, two of `definition-of-done.md`'s
review triggers — and by `quality` (Owen) before anything merges.

**Related:** [ADR 0012](0012-better-auth-adoption.md) — independent decision, one shared
constraint: identity and the tenant's vertical must be resolvable **before** anything else runs,
which is why the control-plane tables cannot move (D1 here).

---

## 1. Context

### 1.1 What was asked

The operator has provisioned a Neon project (`nameless-water-86335081`, branch `production`) and
wants ImmiStack on its own database. `src/core/tenancy/vertical-datasources.service.ts` already
designs that split, `IMMISTACK_DB_URL` and `IMMISTACK_DB_APP_URL` are both already set on Vercel
Production, and nothing calls any of it.

### 1.2 Where `IMMISTACK_DB_URL` actually points — measured, and the answer is not what the plan assumes

Read from the `.env` in this working tree (a `vercel env pull` artefact), extracting **host, role
and database name only — no credential was entered, decrypted or transmitted**:

| Variable | Host | Role | Database |
|---|---|---|---|
| `DATABASE_URL` | `ep-restless-thunder-azgspl7m.c-3.ap-southeast-1.aws.neon.tech` | `neondb_owner` | `neondb` |
| `IMMISTACK_DB_URL` | **the same host** | `neondb_owner` | `immistack` |
| `GOVX_DB_URL` | **the same host** | `neondb_owner` | `govx` |

**All three point at one Neon compute endpoint.** They are three *databases* on the same
project/branch, not three projects. Consequences, stated plainly:

- **No blast-radius isolation.** Same compute, same failure domain, same connection ceiling, same
  autoscaling budget, same PITR branch. Every reason one usually pays for a second database is
  absent.
- **The costs are all still there.** Cross-database joins are impossible in Postgres without FDW or
  `dblink` regardless of whether the databases share a cluster, so the split imposes its full
  application-level cost while delivering none of its infrastructure benefit.

`[UNVERIFIED: whether endpoint ep-restless-thunder-azgspl7m belongs to Neon project
nameless-water-86335081. Neon's endpoint hostnames do not encode the project slug, so this cannot
be determined from the connection string. Confirm in the Neon console or with `neonctl projects
list` — I did not enter a credential to check.]`

**Two further facts about the roles, and one thing I deliberately did not conclude:**

- All three URLs connect as **`neondb_owner`**, which on Neon holds `BYPASSRLS`
  (`src/core/tenancy/rls.datasource.ts:96-99`). These are owner/DDL URLs, correctly so —
  `MigrateService` uses exactly them (`src/jobs/migrate.service.ts:26-35`).
- `configuration.ts:117-119` reads `IMMISTACK_DB_APP_URL || IMMISTACK_DB_URL`. **If the `_APP_URL`
  is unset, runtime would fall back to the owner URL**, and `assertRlsEnforceable`
  (`rls.datasource.ts:102-124`) would then **throw at boot in production** — fail-closed, correctly,
  but a hard outage for any deployment that activated the split without provisioning `meru_app`
  in that database.
- `DATABASE_APP_URL`, `IMMISTACK_DB_APP_URL` and `GOVX_DB_APP_URL` are **all blank in the pulled
  file**. Per workspace `CLAUDE.md` §12, `vercel env pull` returns encrypted values blank, and
  `DATABASE_APP_URL` is certainly set on Production (the app boots and RLS is enforced). **A blank
  pulled value is therefore not evidence of an unset variable, and I am not claiming
  `IMMISTACK_DB_APP_URL` is unset.** Confirm with `vercel env ls`, and confirm the role it names by
  connecting — not by pulling.

### 1.3 The machinery that exists

**Routing — designed, wired to nothing.** `VerticalDataSources`
(`src/core/tenancy/vertical-datasources.service.ts:24-86`):

- `urlFor` maps `grc` → `database.govxUrl`, `immigration` → `database.immistackUrl` (`:34-43`).
- `forVertical` returns the default DataSource when the vertical is unknown or its URL unset
  (`:46-58`) — so an unconfigured environment degrades to the control plane silently.
- `initialize` (`:60-78`) builds a DataSource loading **`ALL_ENTITIES`** (`:65`) — the *entire*
  70-entity catalogue (`src/config/entities.ts:81-163`) — then applies `applyRlsToDataSource`
  (`:74`) and `assertRlsEnforceable` (`:75`). On Vercel it sets `max: 1` (`:68-70`).
- Provided and exported by `TenancyModule` (`src/core/tenancy/tenancy.module.ts:19-20`).
- **`forVertical()` has zero callers.** `grep -rn "forVertical(" src` returns only its own
  definition at `:46`.

**Migrations against a second database — already built.** `MigrateService`
(`src/jobs/migrate.service.ts`), reachable at `POST /jobs/migrate/:target`
(`src/jobs/jobs.controller.ts:96-115`) behind `CronSecretGuard`:

- `ownerUrlFor` (`:26-35`) selects `DATABASE_URL` / `GOVX_DB_URL` / `IMMISTACK_DB_URL`.
- Installs `uuid-ossp` and `pgcrypto` (`:76-77`), then stubs `app.has_access()` and
  `app.set_context_fields()` (`:90-103`) — which **no migration creates**; the control plane only
  has them because it was baselined (`scripts/baseline-migrations.js`), so the chain genuinely
  cannot replay from empty (`:106-119`).
- **Empty database ⇒ bootstrap, not migrate** (`:120-169`): `ds.synchronize()` from entity
  metadata (`:123`), replay four RLS-carrying migrations explicitly (`:136-150`) — including
  `AddTenantRowLevelSecurity1753500000000`, which is what creates the `meru_app` role
  (`src/migrations/1753500000000-AddTenantRowLevelSecurity.ts:101-132`) — then insert all 43
  `ALL_MIGRATIONS` names as applied (`:152-159`) so future incremental migrations run normally.

**So the answer to "how do migrations run against a second database when `ALL_MIGRATIONS` is a
single list" is: the same single list, against a different URL, with a bootstrap shortcut. That
part is done and it already handles RLS.** What is not done is verifying it.

**RLS provisioning and verification are hardcoded to the control plane.**
`scripts/provision-rls-role.js:55-60` reads only `process.env.DATABASE_URL`.
`scripts/verify-tenant-isolation.js:31-32` reads only `DATABASE_APP_URL` and `DATABASE_URL`.
Neither takes a target. **`npm run rls:verify` therefore cannot verify the ImmiStack database**,
and workspace `CLAUDE.md` §8 is explicit: never trust "RLS is on" without running it.

One Postgres subtlety that currently helps and will stop helping: **roles are cluster-wide, grants
are per-database.** Because `immistack` is a database on the *same* Neon project as `neondb`
(§1.2), `meru_app` already exists there and its password already works. If the operator moves to a
genuinely separate Neon project — which D3 requires — `meru_app` must be created and granted
afresh in that cluster, i.e. `provision-rls-role.js` must be run against it.

### 1.4 Why the control-plane tables cannot move — this is mechanical, not a preference

The vertical is not known until the tenant is known, and the tenant is not known until the token is
validated. Both lookups run on the **default** DataSource, before any routing decision could exist:

- `JwtStrategy.assertSessionLive` reads `sessions` via `TenantContext.runAsSystem`
  (`src/iam/strategies/jwt.strategy.ts:84-91`) — its own comment: "the token's tenant has not been
  bound yet".
- `PolicyGuard.resolveVertical` reads `SELECT vertical FROM tenants WHERE id = $1`
  (`src/iam/guards/policy.guard.ts:103-110`) — its own comment: "Guards run before
  `TenantBindingInterceptor`".
- `IamService.validateUser` / `refreshTokens` / `verifyMfaLogin` all resolve identity before
  `TenantContext.setTenantId` (`src/iam/iam.service.ts:144`, `:237`, `:424`).

`tenants`, `users`, `sessions`, `auth_tokens` and `tenant_signup_invites` are therefore
prerequisites of the routing decision itself. Putting them behind it is a circular dependency.

### 1.5 The audit chain — the most dangerous property of this split

`audit_logs` is hash-chained **per tenant**: `getLastChainHash(dto.tenantId)`
(`src/audit/audit.service.ts:72`, `:527-535`) with a per-tenant genesis anchor
(`:538-542`), verified by re-walking the chain (`:326-351`). It is sealed by a **database trigger**
— `audit_logs_worm_guard`, `BEFORE UPDATE OR DELETE`, plus a `BEFORE TRUNCATE` statement trigger
(`src/migrations/1755200000000-AddAuditWormEnforcement.ts:68-95`) — chosen over RLS precisely
because a `BYPASSRLS` owner would evade a policy (`:13-18`).

Because the chain is per-tenant and every tenant belongs to exactly one vertical, moving a whole
tenant's history would in principle preserve its chain. **That is not the hazard. The hazard is
this:**

`AuditLog` is in `ALL_ENTITIES` (`src/config/entities.ts:143-144`), and
`VerticalDataSources.initialize` loads the full catalogue (`vertical-datasources.service.ts:65`),
and `MigrateService`'s bootstrap runs `ds.synchronize()` over it (`migrate.service.ts:123`).
**An `audit_logs` table therefore already exists, or will exist, in the ImmiStack database.**

If any code path ever writes an audit entry on the vertical DataSource, that tenant's chain **forks
silently**: two `chainHash` successors to one predecessor, in two databases, and `verifyChain`
(`audit.service.ts:326-351`) fails for that tenant from that row onward. It cannot be repaired,
because the WORM trigger forbids UPDATE and DELETE on both halves. A regulatory product with an
unverifiable audit chain for one tenant has a finding it cannot close.

The same shape applies to `tenants` and `users`: `synchronize()` creates **empty copies** of them
in the ImmiStack database, complete with the FKs below. Any query that reads `tenants` on the
vertical DataSource returns **zero rows and no error** — workspace `CLAUDE.md` §7.3's exact failure
mode, missing data presented as a clean result.

### 1.6 Foreign keys cannot cross databases

The migration chain declares **30 foreign keys to `tenants(id)`** and **16 to `users(id)`**, and
domain entities carry the relations directly — `src/documents/entities/document.entity.ts:48`
(`@ManyToOne(() => Tenant)`) and `:133` (`=> User`), plus `storage-file`, `task`, `task-comment`,
`form-submission`, `form-field`, `workflow-state`, `workflow-transition`, `workflow-instance`,
`document-version`, `document-metadata`, and the five billing entities.

Postgres has no cross-database foreign key. **Every domain table moved to the ImmiStack database
loses its FK to `tenants` and `users`**, and referential integrity for tenant and user references
becomes an application concern with no database backstop. That is the constraint that actually
determines where the boundary can be drawn — not a preference about module ownership.

### 1.7 Cross-tenant jobs iterate one DataSource

42 `TenantContext.runAsSystem` call sites across 18 files. Eight of those files are jobs that
enumerate tenants or due work platform-wide:

`src/ai/engines/rescreening.service.ts` · `src/ai/engines/watchlist-ingest.service.ts` ·
`src/rules/alert-rule.service.ts` · `src/notifications/sequence-runner.service.ts` ·
`src/notifications/notification-dispatch.service.ts` · `src/audit/retention.service.ts` ·
`src/webhooks/inbound-webhook.service.ts` · `src/billing/stripe.service.ts` ·
`src/jobs/job-run.service.ts`

Each queries the default DataSource. After a data split they would process **only control-plane
tenants** and report success — notification dispatch would silently stop dispatching for every
ImmiStack tenant, and `GET /jobs/status` would show a clean run with zero due items. Workspace
`CLAUDE.md` §16 already records 34 hours of dead notification dispatch that the contract sweep
could not see; this would reproduce it by construction.

### 1.8 Serverless cost of a second DataSource

`vercel.json` gives one function, `maxDuration: 60`, pool `max: 1`
(workspace `CLAUDE.md` §10). `VerticalDataSources.initialize` sets `max: 1` under `VERCEL`
(`vertical-datasources.service.ts:68-70`), and the `sources` Map (`:27`) is per-process, so **every
cold start pays a fresh TCP + TLS handshake plus the `assertRlsEnforceable` query** (`:75`) before
the first vertical query runs. A request touching both databases holds **two** Neon connections —
doubling connection consumption per invocation against a shared endpoint (§1.2), where the
control plane and the vertical are competing for the same ceiling.

---

## 2. Decisions

### D1 — The control plane keeps identity, tenancy, audit and billing. Permanently.

**Decision.** These tables stay on `DATABASE_URL` / `DATABASE_APP_URL` and are never routed:

`tenants` · `users` · `sessions` · `auth_tokens` · `tenant_signup_invites` · `roles` ·
`api_keys` · `tenant_config_pins` · `tenant_settings` · `config_packs` · `feature_flags` ·
`audit_logs` · `billing_plans` · `subscriptions` · `usage_records` · `credit_ledger` ·
`invoices` · `invoice_items` · `job_runs`

**Why identity and tenancy:** mechanical, per §1.4 — they are prerequisites of the routing decision
and cannot sit behind it.

**Why audit:** §1.5, and D2.

**Why billing and `job_runs`:** they are platform-wide by definition. A revenue query that has to
union two databases is a reporting defect waiting to happen, and `job_runs` is the record of the
sweeps in §1.7.

### D2 — `audit_logs` never splits, and the vertical database's copy is dropped

**Decision.** Every audit write goes to the control plane, on the default DataSource, for every
tenant of every vertical, forever. In addition — and this is the part that is easy to skip —
**provisioning a vertical database must `DROP TABLE audit_logs` after the bootstrap**, so that an
accidental write on the vertical DataSource fails loudly with an undefined-table error instead of
forking a sealed chain silently (§1.5).

Same treatment, same reason, for the `synchronize()`-created copies of every D1 table: **drop
them.** An empty `tenants` table that returns zero rows and no error is worse than no table at all.

**`runAsGod` is unaffected and needs no change.** The bypass lives in `TenantContext` (AsyncLocal
storage), `applyRlsToDataSource` reads that same store at connection checkout
(`src/core/tenancy/rls.datasource.ts:49-51`), and `VerticalDataSources.initialize` applies the same
patch to every DataSource it creates (`:74`) — so the god bypass propagates automatically to a
vertical connection. The `CRITICAL` audit entry `TenancyService.runAsGod` writes **before** the
work (`src/core/tenancy/tenancy.service.ts:54-72`) already goes through `runAsSystem` on the
default source, and under D2 it stays there. `runAsGod` therefore survives the split unchanged,
and this is the one part of the design that needs no work.

### D3 — The vertical database must be a separate Neon **project** before anything is activated

**Decision.** `IMMISTACK_DB_URL` pointing at a database on the control-plane endpoint (§1.2) buys
no isolation and costs a second connection per invocation (§1.8). Activation is **deferred until
`IMMISTACK_DB_URL` and `IMMISTACK_DB_APP_URL` name a distinct Neon project** — presumably
`nameless-water-86335081`, pending the §1.2 `[UNVERIFIED]`.

Repointing them is not free: it changes which database `POST /jobs/migrate/immistack` targets, and
if anything has already been written to the current `immistack` database it must be moved or
discarded deliberately. Confirm the current database is empty before repointing — and confirm it by
querying it, not by assuming.

### D4 — Do not "activate `forVertical()`". There is no switch; it is a per-module rewrite.

**Decision.** `forVertical()` returns a DataSource at **request time**. The 119 `@InjectRepository`
injections across 58 files and the 23 `TypeOrmModule.forFeature` registrations are resolved by
Nest's DI at **module-instantiation time**, against the default connection. There is no seam
between the two.

Routing one module means replacing, at every call site in it,
`@InjectRepository(X) private repo` with
`(await this.verticals.forVertical(vertical)).getRepository(X)` — and threading the tenant's
vertical (available on `request.tenantVertical`, set at `policy.guard.ts:53`) into every service
method that needs it. **That is the honest scope, and it must not be described as flipping a
flag.**

**Sequencing, if D3 is satisfied and the work is authorised:**

| Phase | Scope | Why this order |
|---|---|---|
| **0** | Provision: repoint to the separate project (D3), run `POST /jobs/migrate/immistack`, drop the D1/D2 table copies, run `provision-rls-role.js` against it, extend `rls:verify` (D5) and prove 51 tables isolated **there** | Nothing routes until isolation is proven in the new database |
| **1** | `documents` + `document_versions` + `document_metadata` + `storage_files` + `file_versions` | Highest data volume, largest blast-radius win, and access is already funnelled through one decision point — `DocumentAccessService` (`src/documents/document-access.service.ts:76-77`, `:146`, `:160`, `:219`) — so the rewrite has a single seam rather than 14 |
| **2** | `universal_entities` and its dependants | The core record store. Touched by the §1.7 jobs, so D6 must land first |
| **3** | `tasks`, `forms`, `workflow_*`, `search_index` | Lower volume, higher job coupling |

**Phase 1 is a decision point, not a milestone.** Stop after it and measure: connection counts,
cold-start latency, and whether any §1.7 job silently lost coverage. If phase 1 costs more than it
buys, phases 2–3 are cancelled and this ADR is superseded — that is a legitimate outcome, not a
failure.

### D5 — RLS in the vertical database is proven, not assumed

**Decision.** Before any phase-1 traffic:

1. `scripts/provision-rls-role.js` and `scripts/verify-tenant-isolation.js` gain a **target
   parameter** (`control` | `govx` | `immistack`), reusing `MigrateService`'s vocabulary
   (`src/jobs/migrate.service.ts:10`) rather than inventing a second one. Today both are hardcoded
   to `DATABASE_URL`/`DATABASE_APP_URL` (`provision-rls-role.js:55-60`,
   `verify-tenant-isolation.js:31-32`).
2. `npm run rls:verify -- --target immistack` passes: the connecting role holds neither `SUPERUSER`
   nor `BYPASSRLS`, and every table carrying tenant data has `ENABLE` **and** `FORCE`.
3. The deploy gate in workspace `CLAUDE.md` §9 runs it for **every** configured target, not just
   the control plane. A vertical database that is not in the gate is a vertical database nobody is
   checking.

**`assertRlsEnforceable` already fails the boot** if the vertical role holds `BYPASSRLS`
(`vertical-datasources.service.ts:75` → `rls.datasource.ts:110-123`). That is a backstop, not a
substitute: it proves the role's attributes, not that a single row is filtered.

### D6 — Cross-tenant jobs enumerate every configured database, or fail loudly

**Decision.** Before phase 2, each of the nine services in §1.7 either:

- **(a)** iterates every configured DataSource explicitly and reports per-database counts in its
  `JobRun` record; or
- **(b)** asserts at startup that no vertical database is configured and **throws** if one is.

Silently processing only the control plane is not an option. This is workspace `CLAUDE.md` §7.3
applied to a job rather than a UI: a run that reports success having covered half the tenants is
missing data presented as a clean result.

`GET /jobs/status` must show which databases a run covered. A run that covered one of two is not a
successful run.

### D7 — Cross-vertical reads are rejected, not federated

**Decision.** No FDW, no `dblink`, no application-level join across databases. A query that needs
ImmiStack and GovernanceX data in one result set is a **platform** query and must be answered from
the control plane's own tables (tenants, billing, job runs, audit) or not at all.

The operator console reads `tenants`, `audit_logs` and billing — all D1 tables — so it keeps
working unchanged. An operator console feature that wants to list *records* across both verticals
does not get built; it would be the first cross-vertical read, and workspace `CLAUDE.md` §3 already
forbids a vertical reaching sideways into another. The database split makes that architectural rule
physically enforced rather than merely stated, which is the one genuine benefit on offer here
beyond blast radius.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| **Activate `forVertical()` now against the current `IMMISTACK_DB_URL`** | It points at a database on the control-plane endpoint (§1.2): all of the cost, none of the isolation, plus a second connection per invocation against the same ceiling (§1.8) |
| **Move everything, including `tenants` / `users` / `sessions`, to the ImmiStack database** | Circular: the vertical is unknowable before the token is validated and the tenant read (§1.4). It also fragments identity — one email, two `users` tables, and `email` is globally unique in neither |
| **Let `audit_logs` follow the data** | §1.5. A forked per-tenant chain is unrepairable under the WORM trigger, and the chain is the product's evidence to a regulator |
| **Deploy a separate "ImmiStack API" whose `DATABASE_APP_URL` *is* the vertical database** | Superficially simpler — one DataSource per process, no per-module rewrite. It fragments identity, audit and billing across two full schema copies, makes `runAsGod` across verticals impossible, and leaves the operator console unable to see both. Strictly worse than D4 |
| **Postgres FDW or `dblink` to keep cross-database joins working** | D7. It reintroduces exactly the coupling the split exists to remove, at worse performance, and an FDW connection is a held-open connection — impossible on this runtime |
| **Rely on the vertical database instead of RLS** | The service's own doc comment refuses this (`vertical-datasources.service.ts:20-21`): "A vertical DB is NOT a substitute for RLS — it is blast-radius containment on top of it." RLS isolates tenants *within* a vertical, which is where every real customer boundary lies |
| **Leave `VerticalDataSources` unused indefinitely and close the question** | The bootstrap path, the `POST /jobs/migrate/:target` route and the env vars all already exist; leaving them wired to nothing is how a future engineer activates them without reading any of §1. This ADR at minimum documents why they are inert |
| **Delete `VerticalDataSources` and the migrate targets entirely** | Genuinely tempting, and rejected only because the migration/bootstrap path (`migrate.service.ts:120-169`) is the sole working way to stand up a fresh Meru database from empty — including for disaster recovery of the control plane itself. Deleting it costs more than leaving it |

---

## 4. Consequences

1. **Nothing activates today.** D3 blocks on a repoint the operator has not yet made, and D4
   phase 0 blocks on verification tooling that does not exist. The immediate output of this ADR is
   a `NEEDS DATA` item and two small pieces of script work, not a data migration.
2. **The "three-database split" claim in the workspace and repo docs is now precisely bounded.**
   It is designed, its migration path works, its env vars point at three databases on **one**
   endpoint, and `forVertical()` has zero callers. Workspace `CLAUDE.md` §8's "designed, not active"
   framing is correct and should now also say "and the URLs are not separate projects".
3. **Foreign-key integrity to `tenants` and `users` is lost for every moved table** (§1.6) — 30 and
   16 constraints respectively. Orphan rows become possible where the database previously made them
   impossible. Deletion paths (`TenantProvisioningService.deleteTenant`) need explicit
   cross-database handling or they leave the vertical database's rows behind.
4. **Every phase adds cold-start latency and a second connection** (§1.8) on a runtime with a
   `max: 1` pool and a 60 s ceiling. This is the cost that most likely cancels phases 2–3, and D4
   builds the measurement point in deliberately.
5. **`runAsGod` survives unchanged** (D2) — the one part of the design that costs nothing, because
   the RLS patch and the ALS bypass are already applied uniformly to every DataSource.
6. **The nine cross-tenant jobs are a hard dependency, not a follow-up** (D6). Phase 2 cannot ship
   before them, and shipping phase 2 without them would reproduce a silent-dispatch-outage this
   repo has already had once.
7. **`ds.synchronize()` in the bootstrap path creates every table in the catalogue, including ones
   that must not exist there** (§1.5, D2). Dropping them is a provisioning step that is easy to
   forget and produces a silent, unrepairable failure when forgotten. It belongs in a runbook with
   a verification query, owned by Jonas — not in a commit message.

---

## 5. What would make this decision wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| `IMMISTACK_DB_URL` is repointed to a genuinely separate Neon project | D3's block | D4 phase 0 becomes runnable. Re-confirm `meru_app` exists in the new cluster — roles are cluster-wide (§1.3), so a new project means provisioning it afresh |
| The control-plane database hits a size, connection or autoscaling ceiling attributable to ImmiStack | D4's "phase 1 is a decision point" | The measured evidence that the split pays for itself. Proceed to phase 2 with the numbers recorded here |
| Phase 1 ships and cold-start latency or connection exhaustion gets materially worse | D4 phases 2–3 | Cancel them and supersede this ADR. A half-split is a legitimate end state if the boundary is documented |
| A data-residency requirement arrives — AU immigration data must sit in an AU region | D1, D3 | This becomes the strongest argument for the split and changes its shape: the driver is region, not vertical. `immigration.json` already carries `dataResidency: "AU"` while the control plane is `ap-southeast-1` (Singapore) — worth checking whether that is already a live problem |
| A second immigration-vertical tenant needs data physically separated from the first | D1, and the whole model | Per-vertical is the wrong axis; per-tenant database is a different and much larger ADR. RLS is the current answer and remains it |
| Anyone proposes an operator-console feature listing records across both verticals | D7 | Refuse, and point at workspace `CLAUDE.md` §3. If the requirement is real, it needs an ADR that decides where a cross-vertical read may legally happen |
| `ALL_ENTITIES` gains an entity that belongs to the control plane | D1's list, D2's drop step | The list in D1 is enumerated, not derived. Adding a control-plane entity means adding it to D1 **and** to the provisioning drop step, or the empty-copy hazard (§1.5) returns |

---

## 6. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| This ADR (document only) | Set status `Superseded by NNNN`; never renumber | None |
| D3 repoint of `IMMISTACK_DB_URL` / `_APP_URL` | Set both back to the previous values via `vercel env`, redeploy. **Nothing reads them today** (`forVertical()` has zero callers), so a repoint before phase 1 is inert and reversible with no data consequence at all | Whatever was written to the new database — nothing, if the repoint happens before phase 1 |
| D4 phase 0 — bootstrap the vertical database | `DROP DATABASE` on the vertical, or leave it. Nothing routes to it | The bootstrapped schema. Harmless while unrouted |
| D5 — target parameter on `provision-rls-role.js` / `verify-tenant-isolation.js` | Revert the commit. Both default to the control plane, so existing invocations are unchanged | None |
| **D4 phase 1 — documents and storage routed to the vertical database** | **This is the first irreversible step and needs its own written plan before it runs.** Reverting the code is one commit; the rows written to the vertical database in the interim are not in the control plane and must be copied back. Requirements, all three: **(a)** a dual-write or read-through window so both databases hold the same rows during the cutover; **(b)** a row-count and checksum comparison per table before the read path is switched; **(c)** the FKs to `tenants`/`users` dropped in the vertical database (§1.6) must be re-established on the way back, which fails if any orphan row was created while split. **Do not run phase 1 without (a)–(c) written down and rehearsed against a Neon branch.** | Rows written to the vertical database after the read switch and before the revert. Recoverable only by the copy-back in (a)/(b) |
| D4 phases 2–3 | Same shape as phase 1, larger. Each phase gets its own plan | Same |
| D6 — jobs enumerate both databases | Revert to single-DataSource iteration **only if no vertical database is configured**. Reverting while one is configured silently drops half the tenants — the failure D6 exists to prevent | None |
| D2 — dropped table copies in the vertical database | Re-create with `ds.synchronize()`. **Do not**, without superseding D2 first: the empty-copy hazard (§1.5) is the reason they are gone | None |

**Rollback verification, before any phase is considered reversible:** with the vertical database
configured and routed, `npm run rls:verify` must pass against **both** targets, `GET /jobs/status`
must report per-database coverage for all nine §1.7 jobs, and a `runAsGod` read of an ImmiStack
record must produce exactly one `CRITICAL` audit entry, in the control plane, with the tenant's
chain still verifying via `AuditService.verifyChain`.

---

## 7. Open items

| # | Item | Owner |
|---|---|---|
| 1 | `[NEEDS DATA]` Confirm whether `ep-restless-thunder-azgspl7m` is in Neon project `nameless-water-86335081` or a different one (§1.2). Neon console or `neonctl projects list` | Operator, with Jonas |
| 2 | `[NEEDS DATA]` Confirm via `vercel env ls` whether `IMMISTACK_DB_APP_URL` is genuinely set on Production, and which role it names. A blank `vercel env pull` value proves nothing (§1.2) | Jonas |
| 3 | `[NEEDS DATA]` Confirm the `immistack` database is empty before D3's repoint — by querying it, not assuming | Jonas |
| 4 | Add a `--target` parameter to `provision-rls-role.js` and `verify-tenant-isolation.js` (D5) | Luke |
| 5 | Write the vertical-database provisioning runbook, including the D2 drop step and its verification query (§4.7) | Jonas |
| 6 | Check whether `immigration.json`'s `dataResidency: "AU"` against a Singapore-region control plane is already a compliance gap, independent of this split (§5, row 4) | Product, with Anton |
| 7 | Security review of D1's table list and D2's audit decision | Anton |
