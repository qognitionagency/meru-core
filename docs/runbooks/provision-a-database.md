# Runbook — provision a Meru database

**Reader:** an engineer standing up a new Postgres for Meru Core — the vertical split
(ADR 0013), a recovery of the control plane, or a throwaway environment.
**Assumes:** you can reach the target Postgres and you have `psql`, Node 24 and this repo.
**Time:** ~10 minutes. **Danger:** step 3 creates schema. Read §6 (rollback) first.

> **Verified 2026-09-10 against the live control plane** (`ep-small-darkness-aeyx0p5j`,
> `us-east-2`) unless a line says otherwise. Every count in this file was measured, not
> carried forward.

---

## 0. The two traps, before you type anything

These are the reasons this runbook exists. Both failures are **silent** — the app starts,
queries succeed, and the only symptom is one tenant reading another's rows.

### 0.1 Owner role vs application role

| Variable | Role | `rolbypassrls` | Used for |
|---|---|---|---|
| `DATABASE_URL` | `neondb_owner` | **`true`** | migrations, DDL, this runbook |
| `DATABASE_APP_URL` | `meru_app` | `false` | the running application, only |

Measured today on the control plane:

```
meru_app       bypassrls=false super=false
neondb_owner   bypassrls=true  super=false
```

A role holding `BYPASSRLS` **ignores every row-level-security policy** while `\d+` still
prints them as enabled. Point the runtime at the owner string and the schema looks isolated
and is not — across all 68 tenant-scoped tables at once.

The app defends itself: `assertRlsEnforceable()`
(`src/core/tenancy/rls.datasource.ts`) queries `pg_roles` for `current_user` at boot and
**throws under `NODE_ENV=production`** if the role has `BYPASSRLS` or `SUPERUSER`. Outside
production it logs an error and continues. Do not rely on that as the only control — it is
the last one, not the first.

### 0.2 Never use Neon's `-pooler` endpoint

The two connection strings are **visually identical apart from six characters**:

```
ep-small-darkness-aeyx0p5j.c-2.us-east-2.aws.neon.tech          ← direct.  USE THIS.
ep-small-darkness-aeyx0p5j-pooler.c-2.us-east-2.aws.neon.tech   ← pooled.  NEVER.
```

Tenant context is set with `set_config('app.current_tenant_id', $1, false)` — the `false`
means **session** scope. A transaction pooler hands the same backend to the next client
after each transaction, so the binding travels with it.

**Measured 2026-09-10:** a freshly opened connection through a `-pooler` host reported
`app.rls_bypassed() = true` and a tenant id left behind by an earlier session.
`npm run rls:verify` went **10/10 → 4/10**, every write-containment check failing. The same
credentials on the direct host passed 10/10 immediately.

`applyRlsToDataSource()` now **throws at boot** on any host matching `-pooler.`:

```
Refusing to enable RLS binding against a transaction-pooled host (<host>).
Tenant context is set with session-scoped set_config(), which leaks between
clients through a transaction pooler — including app.bypass_rls, which turns
RLS off for whoever inherits the connection. Use the direct endpoint: drop
"-pooler" from the hostname.
```

If you see that at boot, the fix is to **drop `-pooler` from the hostname**. It is not to
relax the guard. Making pooling safe means moving to `set_config(..., true)` and proving
every query runs inside a transaction — a much larger change than it sounds.

---

## 1. Get the connection strings

From the Neon console, take the **direct** (non-pooled) connection string for the target
database, as the owner role.

```bash
cd ~/dev/meru/meru-core
# Confirm what you are about to point at. Prints host and role only, never the secret.
grep -m1 '^DATABASE_URL=' .env | sed -E 's|^[A-Z_]+=.*://([^:]+):.*@([^/]+)/([^?]*).*|role=\1 host=\2 db=\3|'
```

**Expected:**

```
role=neondb_owner host=ep-small-darkness-aeyx0p5j.c-2.us-east-2.aws.neon.tech db=neondb
```

**If `host` contains `-pooler`** — stop, edit `.env`, remove it, re-run. Nothing below is
safe until this prints a direct host.
**If `role` is not the owner** — migrations will fail on `permission denied` at the first
`CREATE`. Use the owner string here; `meru_app` comes later.

---

## 2. Know which path you are on

There are two, and picking the wrong one wastes an hour.

| Target database | Path |
|---|---|
| **Empty** (no tables in `public`) | **§3 bootstrap.** The migration chain cannot build it. |
| Already has the Meru schema | **§4 incremental.** `npm run migration:run`. |

Check:

```bash
psql "$DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE';"
```

`0` → §3. Anything else → §4.

### Why the chain cannot build from empty — do not try to fix it

A fresh `npm run migration:run` dies, in this order:

1. `schema "app" does not exist`
2. `function app.has_access(...) does not exist`
3. `function app.set_context_fields() does not exist`

The mechanism, verified in the tree today:

- `1743900000000-AddWorkflowFormsTasksModules` and `1743910000000-AddBillingAnalyticsAuditModules`
  reference `app.has_access(...)` in policies and attach `app.set_context_fields()` as a
  trigger on ~20 tables — 16 and 19 references respectively.
- **No migration ever creates either function.** `grep -rn "FUNCTION app\." src/migrations/`
  returns only `current_tenant_id`, `rls_bypassed`, `audit_logs_worm` and
  `audit_logs_no_truncate`.
- The only `CREATE SCHEMA app` in the chain is in `1753500000000-AddTenantRowLevelSecurity`,
  which runs **ten migrations later**. The earlier `1743860000000-AddRowLevelSecurity` was
  stubbed to a no-op in 2026-06 and its own header note records the reason:
  *"called functions in an `app` schema that is never created (no CREATE SCHEMA app)."*

The control-plane database only ever survived because it was **baselined**
(`scripts/baseline-migrations.js`), not migrated from empty.

`MigrateService`'s own comment states the constraint and it is the reason to stop here
rather than "fix each error as it surfaces":

> *the migration chain cannot run from empty … "fix each error as it surfaces" would
> rewrite history that production already depends on.*
> — `src/jobs/migrate.service.ts`

The supported path is the bootstrap below. It is not a workaround; it is the design.

---

## 3. Bootstrap an empty database

`MigrateService.migrate()` detects an empty `public` schema (`isEmptyDatabase()`) and
switches from *migrate* to *bootstrap*:

1. `CREATE EXTENSION` `uuid-ossp` and `pgcrypto` — a fresh Neon database has neither, and
   the first migration calls `uuid_generate_v4()`.
2. Creates `schema app` and permissive stubs for `app.has_access()` (returns `true`) and
   `app.set_context_fields()` (a no-op trigger). Permissive **on purpose**: the
   vertical/environment policies those two migrations declare are superseded by the
   `tenant_isolation` policies in `1753500000000`, which is the isolation that actually
   holds. A restrictive stub would silently deny every row instead.
3. Builds the schema with `ds.synchronize()` **from entity metadata** — the same
   definitions the app runs against, so no drift is possible.
4. Replays the six RLS-carrying migrations explicitly, because `synchronize()` knows
   nothing about policies.
5. Records all migrations as applied, so future incremental migrations run normally on top.
6. **Asserts RLS coverage before reporting success** (see §3.2).

### 3.1 Run it

Against a deployed environment (the supported route — `CronSecretGuard`, machine endpoint):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "https://meru-core.vercel.app/api/v1/jobs/migrate/control"
```

`:target` is one of `control` (`DATABASE_URL`), `govx` (`GOVX_DB_URL`), `immistack`
(`IMMISTACK_DB_URL`). Anything else is a 400. The call is idempotent.

**Expected, first run on an empty database:**

```jsonc
{ "data": { "target": "control",
            "executed": ["bootstrap (47 baselined)"],
            "alreadyApplied": false },
  "meta": { … }, "error": null }
```

**Expected, run again:**

```jsonc
{ "data": { "target": "control", "executed": [], "alreadyApplied": true }, … }
```

The boot log line to look for:

```
Bootstrapped 'control': schema from entities + RLS (74 policies, all tables forced), 47 migrations baselined
```

**If you get `401`** — `CRON_SECRET` is wrong or unset. `CronSecretGuard` fails closed; it
is set on Vercel Production (`vercel env ls`, 43 days old as of today). `vercel env pull`
returns encrypted values **blank**, so a pulled `.env` is not evidence either way.

**If you get `No owner database URL configured for target '<x>'`** — the matching
`*_DB_URL` is unset on that environment.

### 3.2 The coverage assertion — and the drift it caught

Bootstrap is the one path that builds a database **without running the migration chain**,
so it is the one path where a table can come up with no policy and nothing notice.

That happened. The replay list had drifted, and a bootstrapped database came up with **RLS
absent on `job_runs` and `tenant_signup_invites`**. Both are *pre-tenant by design* — they
carry no `tenantId`, so the dynamic loop in `AddTenantRowLevelSecurity` (which walks
`information_schema.columns WHERE column_name = 'tenantId'`) cannot see them, and their own
migrations were not in the list.

The list is now six entries, and coverage is **asserted inside bootstrap** rather than left
to a separate command someone may skip:

```
Bootstrap of '<target>' left N table(s) without ENABLE + FORCE row-level security: <names>.
Add the migration that creates each one to `rlsMigrations` above —
a table with no policy is readable across every tenant.
```

**If you see that error:** the bootstrap has already thrown and reported nothing as
provisioned. Add the migration that creates each named table to the `rlsMigrations` array in
`src/jobs/migrate.service.ts`, and re-run against a dropped/empty database. **Do not** hand
the database on. A provisioning step that cannot prove isolation must not report that it
provisioned anything.

**Any new pre-tenant table added in future must be added to that list.** The dynamic loop
will not find it.

---

## 4. Incremental migration (database already has the schema)

```bash
cd ~/dev/meru/meru-core
npm run migration:run          # builds first, then typeorm migration:run
```

Needs `DATABASE_URL` (owner). **Read the `down()` of anything about to run before you run
it.** If the reverse does not exist or does not work, the migration is not ready.

Revert one:

```bash
npm run migration:revert
```

**If TypeORM tries to replay `InitialSchema` and fails `42P07` (relation already exists)**,
the schema was created outside TypeORM and the `migrations` table is empty. Baseline once:

```bash
node scripts/baseline-migrations.js --apply --through 1744010000000
```

**Ordering, and it has teeth:** `meru-core` has a **live Vercel git integration** — its
production deployment carries the alias
`meru-core-git-main-qognitionagencys-projects.vercel.app` (verified today). A push to `main`
deploys the backend. **Apply migrations first, then push**, or the new code goes live
querying columns that do not exist yet. That has already happened once (`42703` on every
read of `universal_entities`).

---

## 5. Provision `meru_app` and prove isolation

### 5.1 Create the application role's login

The role itself is created by `AddTenantRowLevelSecurity`. This script only attaches a
password and `LOGIN`, so **no credential lives in a migration file or in git**.

```bash
node scripts/provision-rls-role.js --write-env
```

- Generates a 32-character password (guaranteed mixed case, digit and one of `-_.~` —
  Neon's control plane rejects weaker ones with a 400, and those symbols survive a
  URL-encoded connection string).
- `MERU_APP_PASSWORD=…` in the environment overrides generation.
- Prints the connection string to put in `DATABASE_APP_URL`.

**This prints a live credential to stdout.** Do not run it with output captured to a log,
a CI job, or a shared terminal. Put the value straight into `vercel env add DATABASE_APP_URL
production` and your local `.env`, then clear your scrollback.

**Check the result before using it** — same shape check as §1, and confirm the role:

```
role=meru_app host=<direct host, no -pooler> db=neondb
```

### 5.2 Prove it

```bash
npm run rls:verify        # node scripts/verify-tenant-isolation.js
```

**Expected tail:**

```
10/10 checks passed.
Tenant isolation verified.
```

Exit code is non-zero on any failure, so it can gate a deploy. It needs **both**
`DATABASE_URL` (admin, to inspect `pg_policy` and to clean up) and `DATABASE_APP_URL` (the
role under test).

> **This writes to the target database.** It inserts rows into `universal_entities` under
> two synthetic tenants (`…-00000000e001` / `e002`) with fixed synthetic ids, then deletes
> everything matching `id::text LIKE '00000000-0000-4000-8000-%'`. Against a **shared or
> production** database, treat that as a change requiring the same confirmation as any other
> write: name the environment, then run it.

**If it reports fewer than 10/10:**

| Symptom | Cause | Fix |
|---|---|---|
| every **write-containment** check fails, reads pass | connected through a **transaction pooler** | drop `-pooler` from the host (§0.2) |
| **everything** passes that should fail | runtime role holds `BYPASSRLS` | you are connected as the owner (§0.1) |
| `document_versions carries a policy` fails | child-table policy missing | the RLS migration did not fully apply — re-run §3/§4 |
| `Verification error: … does not exist` | schema incomplete | the bootstrap did not finish; re-run §3 |

**Do not deploy on a failure.** The script says so, and means it.

### 5.3 Read-only cross-check (safe anywhere, including production)

If you only need to confirm coverage and cannot write:

```bash
psql "$DATABASE_URL" -Atc "
  SELECT count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity)
         ||' of '||count(*)||' tables ENABLE+FORCE'
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'migrations';"

psql "$DATABASE_URL" -Atc "SELECT rolname||' bypassrls='||rolbypassrls
  FROM pg_roles WHERE rolname IN ('neondb_owner','meru_app') ORDER BY rolname;"
```

**Control plane, measured 2026-09-10:**

```
68 of 68 tables ENABLE+FORCE
74 policies in schema public
migrations is the one public table without RLS — correct, it has no tenantId
meru_app bypassrls=false / neondb_owner bypassrls=true
```

This proves the *schema*. It does not prove the *connection* — only `rls:verify` does that,
because it connects as `meru_app` and tries to read another tenant's rows. A pooled
connection passes every check in this section and still leaks.

---

## 6. Rollback

| You just did | To reverse |
|---|---|
| §3 bootstrap on an **empty** database | Delete the Neon branch/database. There is nothing to preserve — it had no data. Do **not** try to unwind it in place. |
| §4 `migration:run` | `npm run migration:revert`, once per migration, newest first. Read each `down()` first — if it is empty or wrong, restore from a Neon branch instead. |
| §5.1 role provisioning | Re-run with a new password; the old one stops working the moment the new `ALTER ROLE` lands. Update `DATABASE_APP_URL` **everywhere** in the same minute, or the app boots on the old credential and fails closed. |
| §5.2 `rls:verify` | It cleans up after itself. If it died mid-run, delete leftovers: `DELETE FROM universal_entities WHERE id::text LIKE '00000000-0000-4000-8000-%';` as the owner. |

**Before anything data-destructive on a database with real tenants: take a Neon branch and
verify it opens.** A plan to take a backup is not a backup.

---

## 7. Seeding an operator — there may be no way in at all

A freshly provisioned control plane has **zero users**. There is no way to sign into
`meru-dashboard`, and no self-service route to create one:
`POST /auth/register` was **removed** (it was `@Public()` and keyed on a guessable tenant
slug — anyone could self-provision into another firm's tenant). The two supported paths are
`POST /tenants/signup` and `POST /iam/users/invite`, and both need an authenticated caller
or an invite token you do not yet have.

So the bootstrap is:

```bash
DEMO_PASSWORD='<choose a strong one>' node scripts/seed-demo.js
```

The script **refuses to run without `DEMO_PASSWORD`** — it creates real login accounts.
It connects with `DATABASE_URL` (owner) and is idempotent: users are matched on email and
the password is re-hashed every run.

It creates one tenant and four accounts:

| Email | Role |
|---|---|
| `platform@demo.com` | `platform_admin` — **this is the operator account** |
| `admin@demo.com` | `firm_admin` |
| `staff@demo.com` | `staff` |
| `client@demo.com` | `client` |

**Two things to do immediately afterwards:**

1. **The script prints `password : <DEMO_PASSWORD>` to stdout.** It is in your scrollback
   and your shell history. Never run this in CI or with output captured.
2. **Rotate `platform@demo.com`'s password** before anyone else touches the environment.
   It is a `platform_admin` — it can reach every tenant through `runAsGod`. A seeded
   demo credential holding that role is not an acceptable steady state.

`[NEEDS DATA: whether the current production `platform@demo.com` password has been rotated
since the 2026-09-10 seed. Not determinable from this repo.]`

---

## 8. Where things currently point — verified 2026-09-10

| Variable | Role | Endpoint | Database |
|---|---|---|---|
| `DATABASE_URL` | `neondb_owner` | `ep-small-darkness-aeyx0p5j` (`us-east-2`) | `neondb` |
| `DATABASE_APP_URL` | `meru_app` | same, direct | `neondb` |
| `IMMISTACK_DB_URL` | `neondb_owner` | same, direct | `neondb` — **not a separate database yet** |
| `GOVX_DB_URL` | `neondb_owner` | `ep-restless-thunder-azgspl7m` (`ap-southeast-1`) | `govx` |

Read from `meru-core/.env` (host and role only). All four are **direct** endpoints; none
carries `-pooler`.

Three things follow that are easy to get wrong:

1. **The control plane moved on 2026-09-10.** `DATABASE_URL`, `DATABASE_APP_URL`,
   `IMMISTACK_DB_URL` and `IMMISTACK_DB_APP_URL` were all re-set on Vercel Production that
   day (`vercel env ls`). Any doc naming `ep-restless-thunder-azgspl7m` as *the* endpoint
   predates the cutover.
2. **`GOVX_DB_URL` was not moved with it.** It still points at the old project and its
   Vercel entry is 35 days old. Either that is deliberate or it is a loose end —
   `[NEEDS DATA: is the old Neon project still meant to serve `govx`, or should GOVX_DB_URL
   be cut over too?]`
3. **The immistack split is still scaffolding.** `IMMISTACK_DB_URL` names the same endpoint
   *and the same database* as the control plane, and
   `vertical-datasources.service.ts::forVertical()` still has zero callers. All vertical
   data lands in the control plane, protected by RLS alone. ADR 0013 is the design; this
   is not it yet.

**Region note:** the Vercel function runs in `sin1` (Singapore — confirmed in
`vercel inspect`, `λ api/index [sin1]`); the control-plane database is now in `us-east-2`
(Ohio). Before the cutover both were in `ap-southeast-1`. Every query is now a
trans-Pacific round trip, inside a function with `maxDuration: 60` and a pool of `max: 1`.
`[UNVERIFIED: the actual added per-query latency — measurable only from inside a deployed
function, not from a developer machine.]`

---

## 9. Escalation

- RLS or isolation behaves unexpectedly → **Anton (`secops`)** before any deploy proceeds.
  Tenant isolation incidents are the one north-star metric with a target of zero.
- The migration chain, `MigrateService` or the bootstrap replay list → **Jonas (`platform`)**.
- Anything that would change *where tenant data lives* → **ADR first** (0013 is the open
  one), reviewed by `secops` and `quality`. Not a runbook decision.
