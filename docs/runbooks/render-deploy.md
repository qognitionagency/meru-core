# Runbook — bring Meru back on Render

**Reader:** the operator (or an engineer acting for them) standing the platform back up after Vercel
was disabled (every Vercel host answers HTTP 402 `DEPLOYMENT_DISABLED`). You have a Render account,
a GitHub account with admin on `qognitionagency/meru-core` and `qognitionagency/meru-core-fe`, and the
`render` CLI at `/opt/homebrew/bin/render`.
**Files:** `meru-core/render.yaml` (API + two crons), `meru-core-fe/render.yaml` (three Next.js apps),
`meru-core/Dockerfile` (not used by Render; kept for later).

> **Status of everything below, updated 2026-11-17.** The `render` CLI (v2.19.0) is now signed in to
> workspace "My Workspace". `render blueprints validate render.yaml` on **both** blueprints returns
> `valid: false` with exactly **three `need_payment_info` errors each, one per service** (every
> service asks for `plan: starter` and the account has no payment method). **No schema error was
> reported.** That is the only thing the validator objected to; see §0b. Nothing here has been
> deployed, and no Render hostname has been observed. Every `[UNVERIFIED]` below is something the
> first sync will confirm or break.
> **Do not claim document encryption at rest to anyone.** The reasons, and what the fix does and does not close, are in the banner at the top of §4. Luke's document-key fix is carried on branch `wave0/back-online` and is **not deployed anywhere**; Render builds only what is pushed to the branch the Blueprint names (§2 step 2), and `git log origin/wave0/back-online..` in `meru-core` shows what has not reached it yet.
> What *was* verified locally: `pnpm install --frozen-lockfile --prod=false && pnpm run build`
> exits 0 on a clean copy of the tree and produces `dist/src/main.js`; `pnpm prune --prod` exits 0
> and leaves `bcrypt` and `@nestjs/core` loadable. That ran on Node 25 and pnpm 10.26.2, **not Node 22**, and before Luke's document-key change, so it is not evidence about the tree as it now stands.

---

## 0. What blocks the first deploy

| # | Blocker | Why it blocks | Clear it by |
|---|---|---|---|
| 1 | **The encryption-key gate (§1) is unresolved.** | `generateValue` is gone from the blueprint on purpose, so the two keys must be supplied by you. Neither old key is held by anyone (§1), so a fresh key is forced, not chosen; the open question is what it orphans. If production data was encrypted under the old keys, the new ones do not decrypt it. And there is no way to defer: with `NODE_ENV=production` the API **refuses to boot** without both, and also refuses a `CREDENTIALS_ENCRYPTION_KEY` shorter than 32 characters (the two key entries in `validationSchema`, `src/config/configuration.ts`). | Run the SQL in §1 against production, read-only, **role check first** (a role without `BYPASSRLS` reads a false zero everywhere), and apply the decision table. That read was denied by the permission system in the authoring session, so it is yours to run. If encrypted document versions exist, the operator's choice in §1 must be made before §4 step 9. |
| 2 | **The Render account has no payment method.** | Validation fails with `need_payment_info` on every service. See §0b. | Add a payment method, or take the free-plan fallback in §0b knowing what it does not give. |
| 3 | **Which Neon project is live is an open decision (§5).** | The live database (`ep-small-darkness-aeyx0p5j`, `us-east-2`) is not in the Neon account currently signed in on the authoring machine; the project that is, is the old Singapore one. | Operator decision in §5. |

**Cleared since the first draft: the scheduler.** The earlier blocker "`INTERNAL_SCHEDULER` is read by
nothing in `src/`, so every minute-level job runs twice" no longer holds. It is now read in
`src/config/configuration.ts` (the `INTERNAL_SCHEDULER` entry of `validationSchema`, and `internalSchedulerEnabled()`),
`src/app.module.ts` (the `ScheduleModule.forRoot()` import, gated on `internalSchedulerEnabled()`) and
`src/queue/queue.processor.ts` (`onModuleInit`), defaults to `off`, and the blueprint sets `off` explicitly. With `off`, `ScheduleModule` is not
imported, so no `@Cron` handler fires and the queue processor loop does not start; the two Render
crons calling `/jobs/tick` are the only driver. Only `on` and `off` are accepted; any other value
(`true`, `1`) **refuses to boot**. `on` plus the crons would run every minute-level job twice, and
the `@Cron` handlers would run with no tenant bound. Do not set it to `on` on Render. Confirm after
deploy with the boot log line in §8. This is read from code; it has not been observed on a running
instance. This still depends on Luke's change being on the branch Render builds (§2 step 2).

---

## 0b. Render account: payment method, and the free-plan fallback

**What the operator must do.** Add a payment method to the Render account (Dashboard -> Billing,
`dashboard.render.com/billing`; `[UNVERIFIED: exact menu path]`). Then, from each repo root:

```bash
render blueprints validate render.yaml
```

Expected after payment is on file:

- `meru-core-fe/render.yaml`: `"valid": true`, listing `meru-dashboard`, `immistack`, `governancex`.
- `meru-core/render.yaml`: still `"valid": false` **until the env group `meru-secrets` exists** (§3), with
  `env var group linkage depends on non-existent group: meru-secrets`. That error was observed on a scratch
  copy of this file (web service set to `free`, so the payment check did not mask it); it was not observed on
  the real file because payment is still missing. Create the group, re-run, expect `"valid": true` with a plan
  listing three services.

**Observed on 2026-11-17 (CLI, scratch copies, nothing written to the repos):**

| Variant validated | Result |
|---|---|
| Real files, `plan: starter` | 3 x `need_payment_info` each |
| API web service `free`, both crons `free` | `free not a valid plan for service type cron` (x2) |
| API web service `free`, crons `starter` | web service passes; crons still `need_payment_info` |
| API web service `free`, crons removed, `fromGroup` lines removed | `valid: true` (1 service) |
| API web service `free`, crons removed, `fromGroup` kept | `env var group linkage depends on non-existent group: meru-secrets` |
| Frontends, all three `free` | `valid: true` (3 services) |

**What a free-plan fallback would give.** Source: Render docs `render.com/docs/free` and
`render.com/docs/cronjobs`, read 2026-11-17. Re-read them before relying on any figure; they change.

| Gives you | Does not give you |
|---|---|
| A free **web service** for the API and for each frontend: validated, no payment method needed to pass validation. | **Crons.** Free instances exist only for web services, Postgres, Key Value and static sites. The validator rejects `free` on a cron (above). Without them nothing calls `/jobs/tick`: no queue drain, notification dispatch, SLA watchdog, alert rules, daily billing, regulatory radar or watchlist ingest. The paid cron has a documented **$1/month minimum per cron service** (cronjobs doc), and a paid plan needs a payment method anyway. |
| Managed TLS, custom domains, log streams. | **Always-on.** A free web service spins down after **15 minutes without inbound traffic** and takes **about one minute** to spin back up on the next request. The first request after idle will be slow or time out for a browser or a frontend. In-process caches and the rate limiter reset on every spin-down. |
| Rollback to the **two most recent** previous deploys. | **Enough hours for all services.** **750 free instance hours per workspace per month**, shared by every free service, and all free web services are suspended when they run out. A 31-day month is 744 hours, so one always-awake service fits and two do not (arithmetic on the documented figure). Spun-down services do not consume hours. An external scheduler hitting `/jobs/tick` every minute (CLAUDE.md §8.4: cron-job.org, QStash) would keep the API awake and spend those hours. |
| `numInstances: 1` is what the blueprint asks for anyway. | **Production use.** Render's own page says: "Do not use them for production applications." Render may also restart a free service at any time, and may suspend one that initiates unusually high outbound traffic, naming "accessing an external database", "invoking external APIs" and external object storage as examples. This API does all three (Neon, Resend, S3). |
| | Shell/SSH, one-off jobs, persistent disks, scaling beyond one instance. Private-network *inbound* is unavailable to a free web service, so the blueprint's `fromService ... hostport` cron wiring could not reach it even if a cron were allowed; a public URL would be needed. |
| | Outbound SMTP ports 25/465/587 are blocked. Mail goes through Resend (`core/mail/mail.service.ts` imports the `resend` SDK); `[UNVERIFIED: that the SDK uses HTTPS and no SMTP port]`. |
| | `[UNVERIFIED: that the API runs inside the free plan's 0.1 CPU / 512 MB]` (figures from the glossary on the free page). Nothing has been run on it. |

Do not use Render's free Postgres: it is not involved (the database is Neon), and per the same page it
expires after 30 days, holds 1 GB, and has no backups.

**Verdict.** The free plan is good for one thing: proving the blueprint builds and boots, with no
customer traffic and no scheduled work. It is not a way to bring Meru back for users. A free fallback
needs a separate blueprint file (crons removed, `plan: free`); none is committed, to avoid a second
source of truth. Prices for paid plans are not stated here: `[NEEDS DATA: operator's plan choice and
current price from render.com/pricing]`.

---

## 1. Gate: the encryption keys, and what a forced re-key costs

**Verdict as of 2026-11-17: NOT DECIDED — counts not obtained.** The production-database read that
would decide this was blocked by the permission system in the session that wrote this file, so no
row counts exist. This is a gap, not a pass. What *was* established:

- **Local copies:** in `meru-core/.env` and `meru-core/.env.backup-preneon`, both
  `DOCUMENT_ENCRYPTION_KEY` and `CREDENTIALS_ENCRYPTION_KEY` are present with a value **two characters
  long** (length checked, nothing printed; consistent with an empty quoted pair, and nowhere near the 32
  characters a real credentials key needs). So there is no local copy of either production key, and
  "REUSE LOCAL COPY" is not available.
- **Vercel:** the old values cannot be pulled (`vercel env pull` returns encrypted values blank,
  CLAUDE.md §12) and every Vercel host answers 402. `[UNVERIFIED: whether the operator can still reveal the
  old DOCUMENT_ENCRYPTION_KEY in the Vercel dashboard]`. The ruling below assumes they cannot; if they can,
  say so before §4 step 2, because it changes option B.
- **Last known inventory:** `CLAUDE.md` records **0 `document_versions` and 0 `storage_files`** on
  2026-08-22 (uploads were 500ing, nothing stored). That predates the S3 variables being set and the
  2026-09-10 database cutover, so it is **not** evidence about today.

### What the code says each key protects (read, not assumed)

| Key | Used by | Effect of a different key |
|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | `src/core/crypto/credential-cipher.ts` — AES-256-GCM envelope in `tenant_connectors.credentials`, key = SHA-256 of the string; throws if unset or under 32 chars; in production the boot guard refuses the same short value, so it never reaches the cipher | Every stored connector credential fails to decrypt (GCM auth failure). Tenants must re-enter them. Sandbox connectors hold none. |
| `DOCUMENT_ENCRYPTION_KEY` | `documents.service.ts` `encryptFile` (AES-256-GCM, key = `scryptSync(secret, 'salt', 32)`, stored object = 16-byte IV, 16-byte auth tag, ciphertext) when a document's level is not `none` | Files already stored under the old key cannot be decrypted with a different one, and nothing on a version records which key it used (no per-version key id). |

### What the code does now (read 2026-11-17 in the working tree of branch `wave0/back-online`; not deployed anywhere)

Luke's key fix is carried on branch `wave0/back-online` and is **not deployed anywhere**. Render builds only
what is pushed to the branch the Blueprint names, so check that the commit that carries the fix is on that
branch before relying on any line below. Re-grep before relying on any line below.

- **No write path stores the key.** `upload` and `createNewVersion` in `documents.service.ts` carry a comment
  "No `encryptionKey`: the key is never persisted" where they used to write `this.getEncryptionKey()`. A grep
  of non-spec `src/` for `encryptionKey` finds only the entity, the two migrations that create and erase the
  column, comments and `toVersionView`.
- **The column is `select: false` and nullable** (`document-version.entity.ts`), so no `find` or relation load
  reads it.
- **Reads go through `toVersionView`** (`documents.service.ts`, the three sites that return versions).
- **What returned the key at HEAD:** `GET /documents/:id` (it returns the `versions` relation),
  `GET /documents/:id/versions` and `GET /documents/:id/versions/:versionId`. Also two relation loads in
  `DocumentHubService` (`getEntityDocuments`, `getDocumentsByIds`, both `relations: ['versions']`), consumed by
  `crm.service`, `task.service`, `workflow.service` and `form-builder.service`.
  `[UNVERIFIED: which HTTP routes return the hub loads; not traced]`. With `select: false` those loads no
  longer carry the column either.
- **The erase migration exists and is registered last** in `ALL_MIGRATIONS` (`src/config/migrations.ts`):
  `1757400000000-NullDocumentVersionEncryptionKeys`. **Its `down()` is empty on purpose**: it restores
  nothing, and the file says why (the values are a leaked secret nothing reads). Its `up()` does three things,
  in this order (read 2026-11-17 from `src/migrations/1757400000000-NullDocumentVersionEncryptionKeys.ts`):
  1. **Role precondition.** It reads `current_user`, `rolbypassrls` and `rolsuper` from `pg_roles`. If no
     role row comes back, it throws. If the role holds neither `BYPASSRLS` nor superuser, it throws. In both
     cases **nothing has been updated**. This exists because `document_versions` carries ENABLE and FORCE
     row-level security: under a role without `BYPASSRLS` and with no tenant bound, the `UPDATE` matches zero
     rows and reports success while every key stays.
  2. **The `UPDATE`**: `UPDATE "document_versions" SET "encryptionKey" = NULL WHERE "encryptionKey" IS NOT NULL`.
  3. **Post-count.** `SELECT count(*)::int ... WHERE "encryptionKey" IS NOT NULL`. If it is not `0`, it throws.

  The two messages you will see if it refuses (the class name is prefixed to each; `<role>` and `<n>` are filled
  in at run time). They are built from concatenated strings in the file, so grep the migration for the pieces,
  not the whole line:

  - Role without `BYPASSRLS` (precondition): `NullDocumentVersionEncryptionKeys1757400000000: database role "<role>" does not have BYPASSRLS. "document_versions" has FORCE row-level security, so under this role the UPDATE would match no rows and report success while every stored key remained. Run migrations as the owner role (DATABASE_URL), not the application role.`
  - Keys remain after the `UPDATE` (post-count): `NullDocumentVersionEncryptionKeys1757400000000: <n> document_versions row(s) still hold an "encryptionKey" after the UPDATE. Refusing to record this migration as run.`
  - The third, rarer throw (no role row from `pg_roles`) starts `NullDocumentVersionEncryptionKeys1757400000000: could not read the current database role from pg_roles, so it cannot prove row-level security will not hide rows from this UPDATE. Refusing to run.`

  **Either throw rolls the run back.** The file's own comment says a throw inside `up()` rolls the migration's
  transaction back, so a failed post-condition is not recorded as run. Under `npm run migration:run` that
  transaction is the one covering **every** pending migration (the evidence is in §4 step 9, rule 4), so a
  refusal here leaves **no** pending migration applied and no new row in `migrations`. Nothing needs reverting.
  What to do instead: the first message means the connection is not the owner role (check `DATABASE_URL`, then
  the §1 role check); the second means the `UPDATE` did not reach every row, which is a stop-and-tell-Anton
  event, not a retry. These guards test the migration; the manual role checks in this runbook test **your
  connection before you start**. Both stay.
- **The literal key is down from three places to one.** At HEAD `default-encryption-key-32-chars!` was in
  `configuration.ts` twice and `documents.service.ts` once. Now only the Joi default for **non-production**
  remains (`configuration.ts`, the `DOCUMENT_ENCRYPTION_KEY` entry of `validationSchema`).
  `getEncryptionKey()` is `getOrThrow`, and with `NODE_ENV=production` the process refuses to boot without the
  variable (spec `boot-guards.spec.ts`).
- **Nothing decrypts an encrypted document.** `decryptFile` is `private` with no caller; a grep for
  `createDecipheriv` across `src/` finds only it and `credential-cipher.ts` (connector credentials). It also
  derives its key differently (`Buffer.from(key, 'base64')`) from `encryptFile` (scrypt). `downloadUrl` returns
  `storage.signedReadUrl(...)`, the stored bytes unchanged. An encrypted document is served as ciphertext.

**Past exposure, separate from the above.** If the Vercel Production environment never had
`DOCUMENT_ENCRYPTION_KEY` set, versions written there were encrypted under the public literal
`default-encryption-key-32-chars!`, which was the fallback at HEAD. Query (a2) tells you. If (a2) is above
zero those versions were never protected from anyone with the repository, and a fresh key on Render does not
re-protect them. That is a question for Anton, not a deploy step.

`CREDENTIALS_ENCRYPTION_KEY` is `required` at boot in production **and** must be at least 32 characters (Joi
`.min(32)`, matching the floor in `credential-cipher.ts` `key()`; spec `boot-guards.spec.ts`). A short value
**refuses to boot**; it no longer boots and fails later at the first connector write. Verified 2026-11-17
against the installed `joi`: a 5-character value prints `length must be at least 32 characters long`; an
absent or empty one prints `is required`.

### Ruling on the document key (MARS) — pending the operator's confirmation and the production counts

This is a ruling, not a decision. It becomes a decision when the operator confirms it and the counts below are
in.

1. **This is a forced re-key, not an optional rotation.** The operator does not hold the old Vercel
   `DOCUMENT_ENCRYPTION_KEY` and no local copy exists (above), so Render will necessarily start with a **new**
   key. There is no "keep the old one" branch to choose.
2. **The old key is treated as exposed.** It was returned by the three document routes above to any caller
   who could read one encrypted document, a `client` reading their own passport included. It is never reused.
3. **Versions encrypted under the old key, if any exist, cannot be decrypted with the new key.** They also
   could not be read back through the product before: `decryptFile` has no caller and download serves
   ciphertext. The re-key therefore removes no capability the product had.
4. **The only decision that needs the operator** is what to do about existing encrypted versions **if the
   production count is non-zero**: **(A)** accept them as unreadable and have the files re-uploaded, or
   **(B)** recover the old key from the pre-migration backup (§4 step 4) for an offline decrypt. The
   derivation is in `encryptFile` (scrypt, literal salt `'salt'`, AES-256-GCM, IV, then tag, then ciphertext);
   `[UNVERIFIED: that an offline decrypt with the stored secret reproduces the plaintext. Nobody has tried
   it, and decryptFile, which expects a base64 key, cannot be used for it]`. **This decision must be made
   before §4 step 9**, because the erase migration destroys the in-database copy and the backup is then the
   only source. If the count is zero there is nothing to decide.
5. **"Rotation" in the ongoing sense is not safe until per-version key ids exist.** Changing
   `DOCUMENT_ENCRYPTION_KEY` later, with documents written under the current one, orphans them, because
   nothing records which key a version used. That is AGENTS.md §2.3's "cannot be rotated safely yet", and it
   is the long-term caveat. Once real documents exist on Render, do not change the variable again without
   Anton and a key-id design.

Relation to AGENTS.md §2.3, which says the key "cannot be rotated safely yet": that sentence is about item 5
(changing the key later while documents exist under it). The one-off replacement here is item 1 and is not a
rotation. AGENTS.md is Luke's file and was not edited from this runbook.

### The queries (SELECT only; run in a read-only transaction)

Use the owner `DATABASE_URL` from `meru-core/.env` in a shell you control. **Do not echo it.**
`psql "$DATABASE_URL"` then `BEGIN READ ONLY;` first. None of these write.

**Run the role check first, and read it before you trust any count.** `document_versions` carries ENABLE and
FORCE row-level security (migration `1753500000000` lists it; CLAUDE.md measured every tenant-scoped table on
2026-09-10). With no tenant bound, a role **without** `BYPASSRLS` sees zero rows, so every count below reads
`0` whatever the data holds: a false clear, and the same trap the erase migration's role precondition exists for (§4 step 6).

```sql
BEGIN READ ONLY;
-- (0) FIRST. rolbypassrls must be 't'. If it is 'f', STOP: every count below is a false zero.
SELECT current_user, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user;
-- (a) encrypted document versions
SELECT "storageProvider", count(*) AS versions,
       count(*) FILTER (WHERE "encryptionAlgorithm" IS NOT NULL) AS encrypted_versions
FROM document_versions GROUP BY 1;
SELECT count(*) FILTER (WHERE encryption <> 'none') AS docs_encrypted,
       count(*) FILTER (WHERE "requiredEncryption" <> 'none') AS docs_requiring_encryption,
       count(*) AS docs_total
FROM documents;
-- (a2) were documents encrypted under the public default key? (prints only a count)
SELECT count(*) AS versions_under_default_key
FROM document_versions WHERE "encryptionKey" = 'default-encryption-key-32-chars!';
-- (a3) how many rows still carry a stored key, and how many different values (counts only)
SELECT count(*) FILTER (WHERE "encryptionKey" IS NOT NULL) AS rows_with_stored_key,
       count(DISTINCT "encryptionKey") AS distinct_stored_keys
FROM document_versions;
-- (b) connector credentials under CREDENTIALS_ENCRYPTION_KEY
SELECT count(*) AS connectors_total,
       count(*) FILTER (WHERE credentials IS NOT NULL) AS connectors_with_credentials
FROM tenant_connectors;
-- (c) storage files by provider (do objects exist in the old S3 bucket?)
SELECT provider, count(*) FROM storage_files GROUP BY 1;
-- (d) scale
SELECT count(*) AS tenants FROM tenants;
SELECT role, count(*) FROM users GROUP BY 1 ORDER BY 1;     -- [UNVERIFIED: column is named "role"; check \d users]
SELECT count(*) AS watchlist_entries FROM watchlist_entries;
-- (e) packs, and which migrations production has applied (compare to ALL_MIGRATIONS; see section 5)
SELECT code, version FROM config_packs ORDER BY code;
SELECT timestamp, name FROM migrations ORDER BY timestamp DESC LIMIT 10;   -- [UNVERIFIED: TypeORM default columns; not run]
ROLLBACK;
```

Do **not** `SELECT "encryptionKey"` itself into a terminal or log; it is a live secret. Counts and
`count(DISTINCT ...)` are safe.
`[UNVERIFIED: the table and column names above come from the entities (document.entity.ts,
document-version.entity.ts, storage-file.entity.ts, tenant-connector.entity.ts), which were re-read on
2026-11-17 for the document and version columns; none was checked against a live \d.]`

### Decision table

| Result | Verdict | Then |
|---|---|---|
| (0) `rolbypassrls` is `f` | **Counts invalid** | Do not read the rest. Use the owner role (`neondb_owner` held `bypassrls = true` when measured 2026-09-10; re-check, do not assume) and re-run. |
| (a) `encrypted_versions = 0` **and** (a3) `rows_with_stored_key = 0` **and** (b) `connectors_with_credentials = 0` | **MINT FRESH** | Forced re-key, nothing orphaned, nothing to decide. Generate both keys (§3). |
| (a) `encrypted_versions > 0` **or** (a3) `rows_with_stored_key > 0` | **STOP — operator decision, before §4 step 9** | Ruling item 4: **(A)** accept as unreadable and re-upload, or **(B)** recover the old key from the step 4 backup for an offline decrypt. Either way the old key is never reused on Render. If (a3) `distinct_stored_keys > 1`, more than one key was in use and (B) needs each; tell Anton. If (a2) `> 0`, the "old key" is the public literal: those versions were never protected, and (B) needs no backup. Record the choice in writing. |
| (b) `> 0` | **STOP** | Mint fresh only with an explicit decision that those tenants re-enter connector credentials. Without the old key they cannot be recovered. The same no-local-copy finding applies to this key. |
| (c) shows rows with provider `s3` | **Separate question** | Objects live in the old AWS bucket. The AWS keys are not in `.env` (names only: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are not set locally). `[NEEDS DATA: whether the operator still holds the AWS credentials and bucket]` |
| `watchlist_entries = 0` | Expect it | Known: empty since the 2026-09-10 cutover. Screening answers 503 `listsLoaded:false` until ingest runs (§8). |

`JWT_SECRET` is different: a fresh value only signs everyone out. It is safe to mint whenever. It is
`required` at boot, and the `'default-secret'` fallback in `jwt.strategy.ts` is gone (it now uses
`getOrThrow`), so there is no unset-but-running state any more.

---

## 2. One-time setup (these write to your accounts)

```bash
render login                      # opens a browser; expected: "logged in" and a workspace name
render workspace current          # verified 2026-11-17: prints "Active Workspace: My Workspace (tea-...)"; confirm it is the intended one
```

1. **GitHub app.** Render Dashboard -> Account Settings -> GitHub -> install the Render app on
   `qognitionagency`, granting both `meru-core` and `meru-core-fe`. Without it a Blueprint cannot see the repo.
2. **Branch.** Render builds the branch you pick at blueprint creation. Both repos are on
   `wave0/back-online` locally. The backend work this runbook depends on is Luke's scheduler, boot-guard, SAML and
   document-key changes (the entity, `documents.service.ts` and migration `1757400000000`); run `git status` and
   `git log origin/wave0/back-online..` in each repo to see what is not yet committed or pushed. **Render
   deploys what is pushed, not what is on disk.** Decide the branch, get it through Owen (`quality`),
   and merge it before creating the Blueprint. This runbook does not push anything.
3. **Do not copy these variables from Vercel or any `.env` — ever:**

| Variable(s) | Why it must never reach Render |
|---|---|
| `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_TARGET_ENV`, `VERCEL_OIDC_TOKEN`, every `VERCEL_GIT_*` | **Behavioural, not cosmetic.** Code branches on `process.env.VERCEL` (the `isServerless` flag in `app.module.ts`, `onModuleInit` in `queue.processor.ts`, `initialize` in `vertical-datasources.service.ts`): set, the app believes it is serverless, **drops DB connect retries to 1 and the pool to 1** (and logs `Serverless runtime detected`). It also disables the queue processor loop, but that loop is off on Render anyway while `INTERNAL_SCHEDULER=off`, so that effect is now moot; the retry and pool effects are not. `VERCEL_OIDC_TOKEN` is also a live credential. |
| `TURBO_CACHE`, `TURBO_DOWNLOAD_LOCAL_ENABLED`, `TURBO_REMOTE_ONLY`, `TURBO_RUN_SUMMARY`, `NX_DAEMON` | Vercel build-tool settings; meaningless here. |
| `REDIS_HOST` (and `REDIS_PORT`) | Setting it flips the cache store from memory to Redis (the `cache.store` setting in `configuration.ts`). No Redis exists on Render in this plan; the app would try to connect to a dead host. Leave unset. |
| `PORT` | Render injects it (default 10000). The old blueprint's `8000` is removed. |
| `NODE_ENV`, `VERTICAL`, `SKIP_CONFIG_PACK_LOADER`, `INTERNAL_SCHEDULER`, `NODE_VERSION` | Set by the blueprint; do not also put them in the group (duplicate definitions leave it unclear which wins). |

---

## 3. Create the env group `meru-secrets` (by hand; the blueprint only references it)

Dashboard -> Env Groups -> New -> name **exactly** `meru-secrets`. Create it **before** syncing the
blueprint; a blueprint referencing a missing group fails. Variable **names** (enter values yourself;
never paste them into chat, a ticket or a CI log):

**Required for the API to boot or be useful**

| Name | Notes |
|---|---|
| `DATABASE_APP_URL` | `meru_app` role, **direct** endpoint, never `-pooler`. Boot refuses under `NODE_ENV=production` without it and throws on a pooler host. |
| `DATABASE_URL` | Owner role. Used for migrations and `POST /jobs/migrate/:target`. Required by the app only when `DATABASE_APP_URL` is absent. **Least privilege: leave it out of the group** and run migrations from your own machine (§5). Decision for the operator. |
| `JWT_SECRET` | Fresh random, 48+ bytes. Never `generateValue`. Boot refuses without it. |
| `JWT_EXPIRATION` | e.g. `1h` (prior blueprint value). |
| `CRON_SECRET` | Fresh random. Both crons and the API read it from this one group, so they cannot disagree. Blast radius: the cron containers can also read every other group variable. Accepted for simplicity; split a `meru-cron` group if that is not acceptable. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins of the three Render frontends **once their URLs exist** (§7). Additive to a built-in list. No hostname is hard-coded in the blueprint because none could be verified. |
| `DOCUMENT_ENCRYPTION_KEY` | The **forced re-key** from the §1 ruling, entered at §4 step 8. **Required: with `NODE_ENV=production` the API refuses to boot without it** (empty counts as unset). There is no production default; the public fallback string applies outside production only. Do not carry over the Vercel-era value: it is treated as exposed, and you do not hold it anyway. Keep your own copy, because nothing in the database records it, and do not change it again once real documents exist (§1 ruling, item 5). |
| `CREDENTIALS_ENCRYPTION_KEY` | Per the §1 gate. **Required at boot in production, and must be 32+ characters: a shorter value (e.g. 10 characters) REFUSES TO BOOT** with `length must be at least 32 characters long`. The same floor is also enforced when a connector credential is stored. |

**Needed for specific capabilities (unset = that capability reads unconfigured; see `GET /api/v1/health`)**

`RESEND_API_KEY`, `RESEND_FROM` (not `MAIL_FROM`; and the Resend account must have a verified domain — see `email-delivery.md`), `APP_URL`,
`BASE_DOMAIN`, `MAX_FILE_SIZE`, `RATE_LIMIT_TTL_MS`, `RATE_LIMIT_MAX_GLOBAL`, `RATE_LIMIT_MAX_IMMIGRATION`,
`RATE_LIMIT_MAX_BANKING`, `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`,
`STORAGE_PROVIDER` (only if both storage drivers are credentialed), `OPENAI_API_KEY`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `IMMISTACK_DB_URL`, `IMMISTACK_DB_APP_URL`,
`GOVX_DB_URL`, `GOVX_DB_APP_URL` (CLAUDE.md: the vertical datasource split has zero callers, so these are
fallback-only today; `GOVX_DB_URL` still names the old Neon project).

SAML SSO has **no variable**: `/auth/saml/*` answers 501 unconditionally (`saml.service.ts`, spec
`saml-disabled.spec.ts`), and the code states on purpose that there is no `SAML_ENABLED` flag, because a flag
would re-enable a verifier found unsound. `SAML_ENABLED` appears only as a *proposed* name in ADR 0023; nothing
reads it. Do not put it in the group.

Do **not** set `DEEPSEEK_API_KEY`, `AI_BASE_URL`, `AI_API_KEY`, `AI_DEFAULT_MODEL` or `UPSTASH_*`: nothing in `src/` reads them (CLAUDE.md §12).

---

## 4. Order of operations (so nothing breaks the other thing)

Per workspace CLAUDE.md §9 the cost of ordering mistakes here is real: migrations before code,
and the signup change (DEF-1) is a **release decision**, not just a deploy.

> **Do not claim document encryption at rest** to customers, funders or in any procurement answer. As read
> on 2026-11-17:
>
> 1. There is one platform-wide key and no key identifier on a version, so the key can never be changed later
>    without orphaning files (AGENTS.md §2.3).
> 2. An encrypted document cannot be read back through the product: `decryptFile` has no caller and download
>    serves the stored ciphertext (§1).
> 3. The presigned-upload path never encrypts (AGENTS.md §2.3), so a document that "requires" encryption can
>    be plaintext.
> 4. The old key was returned by the document routes and is being replaced (the §1 ruling).
>
> Luke's fix stops the key being stored or returned. It is carried on branch `wave0/back-online` and is **not deployed anywhere**.
> It closes item 4's leak and nothing in items 1 to 3. The claim stays off until Anton has evidenced it.
> Procurement documents are representations someone will rely on.

**Why the migration steps are shaped this way.** `npm run migration:run` applies **every** pending migration,
in order, and `1757400000000` (the one-way key erase) is the last entry in `ALL_MIGRATIONS`. It cannot be run
on its own, so "run the erase" and "run the remaining migrations" are one command and one step (step 9).
Everything the erase needs first (the decision, the backup, the rehearsal) has to be finished before that
single command. Which migrations are pending on production is
`[NEEDS DATA: the (e) query in §1 against production, compared with ALL_MIGRATIONS]`. The control plane had 47
applied rows on 2026-09-10 (CLAUDE.md §8.3) and `src/migrations/` now holds 51 files, so assume some are pending.

There is also no separate "rotate the key" step. The key is replaced because it cannot be recovered, and that
happens when you enter the new value in step 8 (§1 ruling).

**Thirteen steps, numbered 1 to 13. Do not reorder.**

1. **Account preconditions.** Payment method added (§0b). The Neon decision (§5) is made, and you are signed
   in to the Neon account that owns the live control plane. Steps 4 and 5 cannot be done without it.
2. **Resolve the §1 gate.** Run the §1 queries (the `rolbypassrls` check first) and record every count,
   including the pending-migration list. Apply the decision table. If any encrypted document version exists,
   the operator's choice between option A and option B is made and written down **now**: step 9 destroys the
   in-database copy of the old key, and there is no later chance to choose.
3. **The code is on the branch Render will build, and has passed Owen** (§2 step 2): Luke's document-key fix
   (no write path, `select: false`, `toVersionView`, migration `1757400000000` with its role precondition and
   post-condition, §1), plus the scheduler, boot-guard and SAML changes. `[NEEDS DATA: the commit that carries all
   of it, and confirmation it is on the branch Render will build; as of this edit it is on branch
   `wave0/back-online` and not deployed anywhere]`. Steps 6 and 9 run `npm run migration:run` from a
   checkout of **exactly this branch**, so the migration list the CLI sees is the list Render builds. A build
   without the fix would write the key into the database again.
4. **Backup.** Take a Neon branch of the live control plane and verify it: it opens, and the (a3)
   `rows_with_stored_key` count read on it equals the one you read on production. It contains the old document
   key, so handle it as a secret. **Never rehearse on it and never write to it.** If you chose option B, take
   the old key out of band now (see rule 3 under "Step 9" below). The branch is a copy inside the same Neon
   project and its retention is bounded: `[UNVERIFIED: Neon history retention on the operator's plan]`.
5. **Rehearsal database.** Create a second, disposable Neon branch from the live control plane (or from the
   step 4 backup). You need its owner connection string (for migrations) and its `meru_app` direct string (for
   the boot rehearsal). Both are secrets. Delete the branch after step 7.
6. **Migration rehearsal on the step 5 branch**, with the rules under "Step 6" below.
7. **Boot rehearsal (§4a)** against the step 5 branch, after step 6 has run on it.
8. **Create the env group `meru-secrets` (§3)**, including a new `DOCUMENT_ENCRYPTION_KEY` that you generate
   yourself: random, never one used in step 7, never one that has run against a pre-fix build, entered
   directly in the dashboard and never pasted into chat or a log. **Keep a copy in your password manager now.**
   This value is what every document written on Render is encrypted under, and nothing in the database records
   it (ruling item 5).
9. **Production migration**, with the rules under "Step 9" below. This is the one command that also erases the
   stored keys.
10. **API blueprint (§6).**
11. **Verify the API (§8)**, including the manual database check and the document-route check.
12. **Frontends (§7)**, with the API URL.
13. **Add the frontend origins to `CORS_ALLOWED_ORIGINS`** and redeploy the API.

### Step 6 — migration rehearsal (on the step 5 branch only)

1. Read every pending migration's `down()` first. For `1757400000000` it is empty on purpose, which means
   the only restore is the step 4 backup. If any other pending `down()` is missing, or is a no-op that
   pretends to restore, that migration is not ready.
2. Run the §1 role check against **this exact connection string**. `rolbypassrls` must be `t`.
3. Read `rows_with_stored_key` (§1 (a3)) on the branch and record it. If production's count is zero, the
   rehearsal proves only that the migration runs.
4. `npm run migration:run`. It applies every pending migration and the key erase is last. Expect each
   migration listed as executed, the last being `NullDocumentVersionEncryptionKeys1757400000000`. Re-read
   `rows_with_stored_key`: it must be `0`. If instead the run stops with one of the two messages in §1 (role
   without `BYPASSRLS`, or keys remaining), the whole run rolled back: fix the connection and run again, and
   do not proceed to step 7 until a clean run.
5. `npm run migration:revert`, **once**. It reverts the last executed migration, which is the key erase.
   **Expectation: the count stays `0`**, because `down()` restores nothing. A forward, down, forward sequence
   against an empty `down()` proves nothing beyond "the revert does not crash"; do not report it as evidence
   of reversibility. If the count rises, the `down()` that ran is not the one you reviewed: stop.
6. `npm run migration:run` again (the revert left it pending). Count is `0`.

### Step 9 — production migration

1. **Get explicit confirmation in that message**, naming: the environment (the production control plane,
   `ep-small-darkness-aeyx0p5j` per §5, `[UNVERIFIED: still the live host]`); what changes (every pending
   migration from step 2's list, **plus the one-way erase of the N stored keys**, N from (a3)); the rollback
   (each `down()` for schema changes, and for the erase **none**: the step 4 backup only). Approval for the
   rehearsal is not approval for this.
2. Run the §1 role check on the exact `DATABASE_URL` in use. `rolbypassrls` must be `t`. Print the host to
   confirm the target, never the string.
3. **Option B only: preserve the old key before the run in rule 4, not after.** From the step 4 backup branch, write
   the single distinct value to a file with mode 600 outside any repository, redirected so it never reaches a
   terminal or a log. Confirm `distinct_stored_keys = 1` first. This copy exists only to decrypt existing
   files offline and is destroyed afterwards; it is the old, exposed key and is never used on Render.
4. `npm run migration:run` from the step 3 checkout (§5). It is not splittable. **It runs every pending
   migration in one transaction, so a failure (including either guard in §1) rolls the whole run back.**
   Evidence, read 2026-11-17 from the installed source, not from documentation:
   - `src/config/data-source.ts` (what `npm run typeorm` loads, via `-d dist/src/config/data-source.js`) sets
     no `migrationsTransactionMode`; grepping `src/` for that name finds it only in `src/jobs/migrate.service.ts:67`.
   - `node_modules/typeorm/commands/MigrationRunCommand.js` (typeorm 0.3.31) builds
     `transaction: dataSource.options.migrationsTransactionMode ?? "all"`, and the `npm run migration:run`
     script passes no `-t` flag, so its `switch (args.t)` falls to the no-op default.
   - `node_modules/typeorm/migration/MigrationExecutor.js` opens one transaction when the mode is `"all"` (line
     216: `this.transaction === "all" && !queryRunner.isTransactionActive`).
   What this does not show: it is read from source, not observed on a database. The step 6 rehearsal is where it
   is observed, because it runs the same command. One thing to watch there: `migrate.service.ts:65-66` says
   enum `ADD VALUE` plus a later use "must not share one giant transaction". Whether any pending migration
   does that is `[UNVERIFIED: not checked against the pending list]`; if it does, the failure appears in the
   rehearsal under this same single-transaction mode, not in production.
   **`POST /jobs/migrate/:target` is never this step.** `src/jobs/migrate.service.ts` calls
   `ds.runMigrations({ transaction: 'each' })` (line 224), one transaction **per migration**, so a failure
   partway leaves the earlier migrations committed. On an empty database it takes a different path altogether
   (bootstrap from entity metadata, then baselines `ALL_MIGRATIONS` as applied). Do not use it for step 9 or
   step 6, and do not read a result from it as evidence about `npm run migration:run`.
5. **Verify, counts only, role check first** (a `0` from a role without `BYPASSRLS` is a false clear):
   `SELECT count(*) FROM document_versions WHERE "encryptionKey" IS NOT NULL;` expects `0` (before: N), and
   `SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1;` expects
   `NullDocumentVersionEncryptionKeys1757400000000`. Anything else: stop, do not create the Blueprint, tell
   Anton.

### 4a. Pre-boot rehearsal (Owen's condition for the first Render deploy)

**Why.** Boot has never been exercised on this branch under production settings. The first Render
deploy cannot be the test: it runs against the production database, and a boot fault there is also a
fault against live data. Owen (`quality`) requires this run before the Blueprint exists.

**Conditions, all of them:**

| Condition | Detail |
|---|---|
| Command | `node dist/src/main` (the blueprint's `startCommand`), from a `pnpm run build` of the branch Render will build |
| `NODE_ENV` | `production` |
| Node | **22**, matching `NODE_VERSION=22` and `.nvmrc`. The authoring machine has Node 25; a pass there does not count |
| Database role | `meru_app` (no `BYPASSRLS`) via `DATABASE_APP_URL`, direct endpoint, never `-pooler` |
| Database | **Non-production** Postgres with **all migrations applied**, including the key-erase migration (applied by §4 step 6): the step 5 Neon rehearsal branch of the control plane, after step 6 has run on it |
| Secrets | Synthetic values for `JWT_SECRET`, `DOCUMENT_ENCRYPTION_KEY`, `CREDENTIALS_ENCRYPTION_KEY` (32+ characters), `CRON_SECRET`; never the production ones. Set `SKIP_CONFIG_PACK_LOADER=true`, as the blueprint does. Do not set any `VERCEL*` variable |
| Runs | **Twice:** once with `INTERNAL_SCHEDULER` **unset**, once with `INTERNAL_SCHEDULER=on` |

**Pass criterion, per run:** the output contains `Nest application successfully started`
(`grep` for it; "routes mapped" is not "booted"; a DI fault prints the route table and then dies).
Also expect, with the variable unset, the line `INTERNAL_SCHEDULER is off - processor loop disabled`; with
`on`, its absence. Record the Node version (`node -v`) and both outputs. A failure in either run blocks step 10 (the Blueprint).

**Does not count:** the first Render deploy; any run on Node other than 22; any run against the
production database; a run with an owner role (`neondb_owner`, which has `BYPASSRLS` and defeats the
boot check this exists to exercise).

**Status as of 2026-11-17: cannot be run today.** No suitable database is reachable: the live control plane
(`ep-small-darkness-aeyx0p5j`) belongs to a Neon account that is **not** the one currently signed in on
the authoring machine (§5), so a branch of it cannot be created. `[NEEDS DATA: access to the Neon account
that owns the live control plane, to create a branch, a meru_app connection string for it, and a Node 22
runtime]`. Booting against the old Singapore project instead would exercise a database whose schema
predates the 2026-09-10 cutover, which is not the condition Owen asked for.

---

## 5. Database, and migrations (writes to production; needs explicit confirmation)

### Which Neon project is live: OPEN OPERATOR DECISION

| | Project | Host | Region | State |
|---|---|---|---|---|
| Live control plane per `CLAUDE.md` §12 | not identified in the signed-in Neon account | `ep-small-darkness-aeyx0p5j` | `us-east-2` (Ohio) | Named by `DATABASE_URL` / `DATABASE_APP_URL` in the local `.env` and on Vercel Production. **Not visible in the Neon account currently signed in on the authoring machine.** |
| Old project | `cool-rice-41190255` | `ep-restless-thunder-azgspl7m` | `ap-southeast-1` (Singapore) | The **old** control plane, from before the 2026-09-10 cutover. It is what `GOVX_DB_URL` still names. |

What this means, and what was and was not done:

- `region: ohio` in `meru-core/render.yaml` stays correct **for the live database**. It would be wrong for the old
  Singapore project, which would want `singapore`. Nothing was changed on that basis.
- **No connection string was changed or read**, and no database was connected to in this pass. Nothing here verifies
  that `ep-small-darkness-aeyx0p5j` still exists or is reachable: `[NEEDS DATA: which Neon account/org owns
  ep-small-darkness-aeyx0p5j, and whether it is reachable]`.
- The backup step below ("take and verify a Neon branch/backup") cannot be done through the Neon account that is
  signed in, because the live project is not in it. Sign in to the account that owns it first.
- Decide one of: (A) find the owning Neon account and keep Ohio; (B) if the live project is gone, you are choosing
  to run on the old project, whose data predates the 2026-09-10 cutover: that is a data-loss decision as well as a
  region one (region `singapore`, a different connection string, and a re-read of §1), and it needs Kyle and the operator, not a
  quiet edit. This runbook does not recommend B.

### Migrations

Environment: the production Neon control plane. What changes: schema, via `ALL_MIGRATIONS`, **and data**: the
last migration in the chain, `1757400000000-NullDocumentVersionEncryptionKeys`, erases every stored
`document_versions."encryptionKey"`. It is one-way (`down()` is empty on purpose), so `npm run migration:run`
here is not a schema-only change. The order it runs in, and what must be true first, is §4 step 9; do not run
it from this section alone.
Rollback: a **failed** `npm run migration:run` has already rolled back (one transaction, §4 step 9 rule 4), so
there is nothing to revert. After a **successful** run, `npm run migration:revert` reverts **one** migration per call (the last executed); **read each pending
migration's `down()` before running `up`** (this repo has had migrations missing from `ALL_MIGRATIONS`
four times; check the pending list against files). For the key erase the only restore is the verified Neon
backup (§4 step 4). Pending list: `[NEEDS DATA: the (e) migrations query in §1 against production]`.

```bash
cd ~/dev/meru/meru-core
npm run migration:run     # needs DATABASE_URL (owner) in the local .env; builds first
```

Expected: TypeORM lists each migration executed. `npm run rls:verify` needs `DATABASE_APP_URL`
locally (blank in `.env`; do **not** run `scripts/provision-rls-role.js` to get one — it re-sets
the role's password and takes the API down until the group is updated). Use the HTTP proof in §8 instead.

---

## 6. API blueprint, first deploy (writes: creates billable services)

```bash
cd ~/dev/meru/meru-core
render blueprints validate render.yaml    # must say "valid": true. need_payment_info = §0b. "group ... meru-secrets" = §3.
```

Dashboard -> New -> Blueprint -> repo `meru-core` -> branch per §2 -> file `render.yaml`. It creates
`meru-core-api` (web), `meru-core-tick-fast` and `meru-core-tick-daily` (cron). `autoDeployTrigger`
is `off`, so creation builds once; later pushes deploy nothing.

| Blueprint value | Why |
|---|---|
| `runtime: node`, `region: ohio`, `numInstances: 1` | Control-plane Neon is `us-east-2` (Ohio). One instance because the rate limiter and caches are in-process. |
| `NODE_VERSION=22` | Matches `.nvmrc` and the Dockerfile (`node:22-alpine`). 22, not 20, because the lockfile's six `@supabase/*` packages declare `engines: node >=22.0.0` and Node 20 is past upstream EOL (2026-04-30). Not built under Node 22 here. `[UNVERIFIED: build on Node 22; Render accepts the bare "22"]` |
| `buildCommand` uses `corepack enable` and `--prod=false` | pnpm is pinned in `package.json` (`pnpm@10.26.2`). `--prod=false` because `nest build` is a devDependency. `[UNVERIFIED: corepack works in Render's native build image]` |
| `SKIP_CONFIG_PACK_LOADER=true` | Same as Vercel: stored packs stay as they are until you reload deliberately (§9). |
| `INTERNAL_SCHEDULER=off` | The crons are the single scheduler (§0). Only `on`/`off` are valid; anything else fails boot. |
| `healthCheckPath: /api/v1/health` | Passes while the database is **down** (§8). Not a database check. |

---

## 7. Frontend blueprint (writes)

**Only after the API is live (§8).** `NEXT_PUBLIC_*` is baked in at build.

1. API URL: dashboard -> `meru-core-api` -> the URL shown at the top. `[UNVERIFIED: its form; do not guess it]`.
   Your value is that URL plus `/api/v1`.
2. Dashboard -> New -> Blueprint -> repo `meru-core-fe` -> `render.yaml`. For each of the three services it
   prompts for the `sync: false` values: `NEXT_PUBLIC_MERU_API_URL` (all three) and `NEXT_PUBLIC_APP_URL` (immistack: that
   service's own origin; you will only know it after creation, so set it, then trigger a manual deploy).
3. Add the three origins to `CORS_ALLOWED_ORIGINS` in `meru-secrets`; redeploy `meru-core-api`.
4. **Confirm the build did not fall back to mocks:** open the app, DevTools -> Network, sign in attempt must hit the API host,
   not `localhost`. `NEXT_PUBLIC_ALLOW_MOCKS` must not exist on any service.
5. ImmiStack's onboarding wizard posts `/tenants/signup` with no `token`; with DEF-1 on the backend it 400s
   (`meru-core-fe/AGENTS.md` §0.0). Confirm which side ships first before announcing signup.

---

## 8. Verify the first deploy (never trust the deploy status; read these)

**Logs** (dashboard -> `meru-core-api` -> Logs, or `render logs`):

| Grep for | Expected | If different |
|---|---|---|
| `Nest application successfully started` | present | Absent after the route table printed = DI fault. Read the stack above. |
| `Config pack loader skipped (SKIP_CONFIG_PACK_LOADER=true)` | present | Absent: the variable did not apply. |
| `Rate limiting: global=` | present | |
| `INTERNAL_SCHEDULER is off - processor loop disabled; /jobs/tick drains the queue.` (the dash may print as an em dash) | present, once, at boot | Absent, with `Processing job:` lines that no tick request explains = the loop is on (`INTERNAL_SCHEDULER=on` or a different value reached the process). Set it to `off`. A value like `true` stops boot instead, with a Joi message naming `INTERNAL_SCHEDULER`. |
| Boot fails with `DOCUMENT_ENCRYPTION_KEY` or `CREDENTIALS_ENCRYPTION_KEY` ... `is required`, **or** `CREDENTIALS_ENCRYPTION_KEY` ... `length must be at least 32 characters long` | **absent** | Present = the key is missing or empty in `meru-secrets` (`is required`), or `CREDENTIALS_ENCRYPTION_KEY` is under 32 characters (`length must be at least 32 characters long`). The deploy never turns healthy and Render cancels it after 15 minutes. Fix the value in the group, then Manual Deploy. |
| (after step 9) a document read with a staff token **and** one with a client token that owns a document, on `GET /documents/<id>`, `GET /documents/<id>/versions` and `GET /documents/<id>/versions/<versionId>` | no `encryptionKey` in any of the three bodies. Check: `curl -sS -H "Authorization: Bearer $TOKEN" $API/api/v1/documents/<id>/versions \| grep -c encryptionKey` prints `0` (`$TOKEN` from your own login; never paste it into a log) | Non-zero = Luke's fix is not what is running. Stop, suspend, tell Anton. Needs a document with at least one version: if §1 (a) showed none, this check proves nothing and the evidence is `document-version-key.spec.ts` plus the step 9 count. `DocumentHubService.getEntityDocuments` and `getDocumentsByIds` also load `versions`; `[UNVERIFIED: which HTTP routes return those loads; not traced]`. |
| `Serverless runtime detected` | **absent** | Present = a `VERCEL*` variable leaked in. Remove it (§2). |
| `pooler` or `BYPASSRLS` | **absent** | Present = wrong connection string. Fix `DATABASE_APP_URL`. |
| `Processor loop error` | absent | Present: queue loop failing; read the line. |
| `Drained n job(s) from the queue` / `Processing job: <id>` | Only when a tick found a job. These come from `/jobs/tick` running **inside** the web service, so seeing them is normal. | Not evidence the loop is on; the boot line above is. If you see `Processing job:` with no corresponding tick request in the cron's Runs page, suspect `INTERNAL_SCHEDULER=on`. |

**GovX login: the SSO button must not reach the browser while the API answers 501.** Every `/auth/saml/*`
route answers 501 unconditionally on this branch (`saml.service.ts`, spec `src/iam/saml-disabled.spec.ts`).
The meru-core-fe change "no SSO entry while backend answers 501" (`governancex`: the login page renders the SSO
entry only when `SAML_SSO_AVAILABLE` is true, and that constant in `lib/api/services/auth.service.ts` is
hard-coded `false` as of this read) must be deployed **no later than the backend**. Without it, the GovX login
page offers an SSO button that lands on a raw 501.
`[NEEDS DATA: the commit hash of that meru-core-fe change, and confirmation it is on the branch the step 12 build uses]`.
Two things follow in this runbook's order:
- §4 puts the frontends (step 12) **after** the API (step 10), so "no later than" cannot be met literally here.
  The safe equivalent: no GovX Render URL exists until step 12, so nobody reaches that login page before then
  **provided the `governancex` build in step 12 comes from a branch that contains this change**. Check that
  before step 12, not after.
- Check after step 12: open the GovX login page and confirm there is **no** SSO entry. Its presence means the
  build predates the change; roll that service back (§10) and do not share its URL.
When SAML is later made real, `SAML_SSO_AVAILABLE` has to be flipped by hand; nothing derives it from the
backend.

**Smoke** (replace `$API` with the URL you read in the dashboard; no secrets in these):

```bash
API=https://<host-from-dashboard>
curl -sS -o /dev/null -w "%{http_code}\n" $API/api/v1/health           # expect 200. THIS ALSO RETURNS 200 WITH THE DATABASE DOWN.
curl -sS $API/api/v1/health | head -c 600                               # MUST contain "database":"up" and "status":"ok". Anything else = the DB check failed even though HTTP said 200.
curl -sS $API/api/v1/health | grep -q '"database":"up"' && echo DB_UP || echo DB_NOT_UP   # the manual database check; run it after every deploy
curl -sS $API/api-json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s).paths).length,"paths"))'
cd ~/dev/meru/meru-core
BASE_URL=$API bash scripts/smoke/cross-tenant.sh                        # expect 10 passed, 0 failed (tenant isolation, over HTTP)
BASE_URL=$API npm run smoke:sweep                                       # passes on well-formed 503s; it cannot see a wrong answer
```

### Health check limitation: Render cannot see a down database

`healthCheckPath: /api/v1/health` is the best path available but it is **not a database check**. Read from
`src/health/health.controller.ts` (not observed against a down database; none was connected to): `check()` runs
`SELECT 1`, catches a failure, and still returns **HTTP 200** with `"database":"down"` and `"status":"degraded"`.
The `503` in its Swagger annotation is never thrown. The body is wrapped in the standard envelope, so the field
sits under `data` (`{"data":{"status":"ok","database":"up",...},"meta":...}`); the `grep` above matches either way.

What Render therefore does, per `render.com/docs/health-checks`:

| Situation | What happens | Does Render notice? |
|---|---|---|
| New deploy cannot reach the database **at boot** | TypeORM retries 10 times at 3 s, then boot aborts; the port never opens; Render cancels the deploy after 15 minutes and keeps the old instances serving | Yes (TCP/HTTP check fails) |
| New deploy boots, then database is down or the credential is wrong at query time | `/health` returns 200; Render marks the deploy successful and routes traffic to it | **No** |
| Database goes down on a running instance | `/health` keeps returning 200; Render does not stop routing or restart | **No** |
| A process wedge or crash | Check fails; Render stops routing after 15 s and restarts the instance after 60 s | Yes |

There is no other public route to point Render at instead: `/` is a static string with no database access, and
`/tenants/resolve?host=` needs a parameter and answers 404 for an unknown host even when healthy. Until the backend changes, the operator's compensating controls are:

1. After **every** deploy, run the `grep` above and expect `DB_UP`. Do not treat Render's "Live" badge as proof.
2. Watch `meru-core-tick-fast` runs (below): a tick that cannot reach the database returns non-2xx and shows as a failed run
   each minute, which makes it the closest thing to an alert that exists today `[UNVERIFIED: that a DB outage makes /jobs/tick non-2xx]`.
3. Optional: an external uptime monitor that alerts on the body, not the status code. `[NEEDS DATA: which monitor the operator uses]`.

**Backend follow-up for Luke (not done; backend code is out of scope here):** make `check()` throw
`ServiceUnavailableException` when `database === 'down'`, which is what its own Swagger annotation already says.
`render.yaml` then needs no change. Decide the trade-off first: Render restarts an instance after 60 s of failed
checks, so a brief Neon blip would restart the API.

Cron check: dashboard -> `meru-core-tick-fast` -> Events. Expect a succeeded run each minute. A failed run =
non-2xx from `/jobs/tick` (`curl -f`): 401 means `CRON_SECRET` differs or is unset; connection refused means the
private-network `hostport` did not resolve `[UNVERIFIED: fromService hostport reaches a web service from a cron]`.
Then, with an operator token, `GET /api/v1/jobs/status` and look for `lastError`.

Known Render-specific risk: `src/main.ts` sets `trust proxy` to **1**. If Render puts more than one proxy hop in front
of the app, `req.ip` is a proxy address and every client shares one rate-limit bucket, so one noisy caller can lock out
`/auth/*` for everyone. `[UNVERIFIED: hop count on Render]` Test: from two networks, hit a rate-limited route and see
whether they exhaust the same bucket.

Data caveats that are not Render's fault but will look like it: `watchlist_entries` is empty (screening 503 `listsLoaded:false`
until `POST /jobs/watchlist-ingest`, `Authorization: Bearer <CRON_SECRET>`), Resend has no verified domain
(`email-delivery.md`), and `config_packs` rows are stale until reloaded (§9).

---

## 9. Pack reload (changes behaviour; deliberate)

`POST $API/api/v1/jobs/packs/reload` with `Authorization: Bearer <CRON_SECRET>` — enables rules and the VAC gate that have
never run on live data. Do it once, on purpose, after §8 passes. Then `SELECT code, version FROM config_packs`.

---

## 10. Rollback — there is no Vercel to fall back to

Vercel is disabled, so "redeploy the previous Vercel build" does not exist. What does:

| Situation | Action |
|---|---|
| A bad Render deploy | Dashboard -> `meru-core-api` -> **Deploys** -> a recent successful deploy -> **Rollback** -> *Rollback to this deploy* (per `render.com/docs/rollbacks`, read 2026-11-17: it starts a **new** deploy from the saved build artifact, only for deploys whose artifact is still retained, and the number retained depends on the workspace plan; on a free service only the two most recent previous deploys). Because `autoDeployTrigger` is off, nothing deploys unless you trigger it. While a new deploy is failing its health checks the previous one keeps serving and Render cancels the new one after 15 minutes. **That safety net does not cover a deploy that boots with a broken database**: the health check passes (§8). Catch that with the `DB_UP` check straight after deploy, and roll back by hand if it fails. |
| Bad code, no good deploy yet (first deploy) | There is no previous state. Suspend `meru-core-api` and the two crons (dashboard -> Suspend) so nothing runs against the DB; fix on the branch; resume. |
| A migration went wrong | If `npm run migration:run` itself **failed**, nothing was applied (one transaction, §4 step 9 rule 4): fix the cause and re-run; do not revert. If it **succeeded** and a migration is later found wrong: `npm run migration:revert` from your machine (one step per call; it reverts the **last** executed migration), after reading that migration's `down()`. The key erase `1757400000000` is last in the chain and its `down()` is **empty on purpose**: reverting it restores nothing. The only restore is the step 4 backup, and restoring puts the exposed old key back into the live database, which is Anton's decision, not a reflex. For any other destructive change, restore from the Neon backup you verified in §5. |
| Wrong env value | Edit in `meru-secrets`, then **Manual Deploy -> Restart** the service. Groups changes do not redeploy on their own with auto-deploy off. For frontends a `NEXT_PUBLIC_*` change needs a **rebuild**, not a restart. |
| Wrong encryption key already used to write data | Do not change it again. Suspend writes. The previous value is **not in the live database** once §4 step 9 has run (the migration NULLed it). The only remaining source of an old key is the step 4 backup, or the out-of-band copy if option B of §1 was chosen. Anything encrypted under the wrong key needs that key: decide with Anton before touching the variable. |
| Everything is down, need it off the public internet | Suspend all five services. The Dockerfile is the portable fallback to another container host; **it has never been built** (§ header of the Dockerfile). |

**Escalation:** platform issues (Render, deploy, crons) -> Jonas (`platform`). Auth, tenancy, key custody ->
Anton (`secops`). Any code change -> Owen (`quality`) before merge. Money/customer-visible decisions -> the operator.

---

## 10a. Interim: a user has lost their authenticator

**Reader:** the operator, woken because a firm admin cannot sign in. **Read all of this before touching the
database.** The honest state today is that the safe answer is "not yet", and the reason is below.

**What exists, read from the code 2026-11-17:**

- A user with MFA on gets only a single-purpose `mfaPending` token at login (`iam.service.ts`, the
  `requiresMfa` branch) and must complete `POST /auth/mfa/verify` with a code. A lost authenticator stops
  here, permanently.
- `POST /auth/mfa/disable` (`iam.controller.ts:314`, `iam.service.ts` `disableMfa`) needs the user's own
  authenticated session **and** a currently valid TOTP code. It cannot help someone who has lost the
  authenticator.
- There is **no operator route** to clear another user's MFA. `UpdateUserDto` deliberately carries no MFA
  field (`src/iam/dto/update-user.dto.ts`), and a grep of `src/` for the writers of `mfaEnabled: false` /
  `mfaSecret: null` finds one: `iam.service.ts:813`, inside `disableMfa`.
- So today a lost authenticator can only be fixed by an **owner-role database edit** of
  `users."mfaEnabled"` and `users."mfaSecret"` (columns per `src/iam/entities/user.entity.ts`).

**Why that is not a casual edit.** Removing a second factor is the first thing a stolen token is used for; the
code's own comment on `auditedChange` says so, and its normal path writes a `mfa.disable.requested` audit row
**before** the change and an outcome row after. A hand-typed `UPDATE` in `psql` writes no audit row at all. The
owner role also has `BYPASSRLS`, so nothing in the database stops it.

**Conditions (Anton, `secops`). All three, every time:**

1. **A script, not a runbook note.** The reset is done by a script that writes the audit row through
   `AuditService.logEvent` **before** the `UPDATE`, so the hash chain records it. A paragraph saying "remember
   to log it" does not meet this condition.
2. **Two named people present** for the run.
3. **The person who runs it must be one of the people named as having access to the live Neon account.**
   `[NEEDS DATA: that named list. Nothing in the repo records who has access to the live Neon account, and it
   is not in the signed-in Neon account on the authoring machine (§5).]`

**The script: `[NOT WRITTEN — Luke]`.** Its contents are not specified here and must not be improvised from
this section. For reference only, what the existing `disableMfa` path records is `action: update`,
`entityType: 'user'`, `entityId: <user id>`, severity `warning`, and `context.event` of
`mfa.disable.requested` / `mfa.disabled` (`iam.service.ts:784-808`); `LogAuditEventDto`
(`src/audit/audit.service.ts:13`) requires `tenantId`, `userId`, `action`, `entityType` and `entityId`.
`[NEEDS DATA: which userId attributes an operator-run reset (the existing path records the user themself, and
no operator identity exists in a database script), and how the requester's identity is verified before anyone
runs it. Neither is specified.]` Luke writes it; Owen gates it; Anton signs off.

**Until the script exists: do not edit `users` by hand.** Tell the user their account is locked pending a
security-reviewed reset, and tell Anton. The locked-out user is the safe failure; an unaudited second-factor
removal is not. After a reset the user re-enrols with `POST /auth/mfa/setup` and `POST /auth/mfa/setup/verify`
(`iam.controller.ts:285`, `:302`).

**Longer term** (not this runbook's decision): an operator route that goes through `auditedChange`, so the
audit-before-change guarantee is the code's, not a procedure's. Kyle and Anton.

---

## 11. Stale files left in place

`meru-core/fly.toml` (Fly.io, region `sin`, names `api.meru.com` which does not exist anywhere), `meru-core/vercel.json`,
`meru-core/api/index.js` (the Vercel entrypoint; Render runs `dist/src/main` instead, so **middleware
mirrored by hand in `api/index.js` — the `/api/__diag` gate and its rate limiter — does not apply on Render**; `src/main.ts`
carries its own limiter), `meru-core/k8s/`, `docker-compose.yml` (its `npm run start:dev` command cannot run in the pruned image).
Nothing was deleted.
