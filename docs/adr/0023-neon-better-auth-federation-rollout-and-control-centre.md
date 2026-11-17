# 0023 — Neon-managed Better Auth by federation: rollout, account linking, and the Control Centre operator surface

**Status:** Proposed — 2026-11-17. Not merged. **Amended 2026-11-17** after review: `quality`
(Owen) returned **FIX**, `secops` (Anton) returned **APPROVE WITH CONDITIONS**. Every finding and
condition is applied below; §11 is the review record and says which are already satisfied by code
on this branch and which are outstanding. Records operator decisions taken 2026-11-16/17, **minus
one that turned out to rest on a wrong fact** — which Neon project hosts auth is now an open
operator decision (D12). Nothing that touches Neon, federation or identity data is to be
implemented until D12's gate zero is met. The exceptions are the Neon-independent hardening in §10
step 1 (D13, D14, D8.4), which gate zero does not block.
**Amended a second time 2026-11-17** after Owen's final gate returned **FIX — stale against the
code, not a design objection**: §1.3, D7 precondition 7, §10 step 1 and §11 are re-read against the
working tree, and three decisions are added — **D13** (impersonation attribution on every audit
entry, via the tenancy context), **D14** (invites move to the strict audit path) and **D8.4**
(operator MFA reset, proposed with an interim procedure). The D10 and D11 decisions themselves are
unchanged.
**Amended a third time 2026-11-17** after two reviews of the second amendment: Owen returned
**FIX — consistency with code** (D14 and D8.4 wrote a fact-named audit row *before* the change,
which is the defect just removed from MFA/role/status; D8.4's 409 would be recorded as
`write_failed`; "this round" markers that are now done; §11's description of the strict path was
wrong for `verifyMfaSetup`). Anton returned **APPROVE WITH CONDITIONS on D13, D14, D8.4 and the
gate-zero scope, and REJECT on the best-effort completion row as an end state.** His conditions
are applied as numbered items: **D13.C1–C7, D14.C1–C4, D8.4.C1–C7, G0.C1, AC.C1–C3** (§11 maps
each). D8.4 **stays proposed — the operator's decision.**

**Supersedes:** [ADR 0002](0002-neon-auth-federation.md) **D6 only** (the per-tenant
`tenants.settings.authProvider` pilot flag). 0002's D1 (federation, not replacement), D4
(impersonation stays Meru-issued) and D5 (SAML is not silently dropped) stand. 0002's D2 and D3
stand in substance, with two corrections:
- D2's `NeonAuthStrategy` "parallel to `JwtStrategy`" is **withdrawn**. See D2 below.
- D3's matching key ("resolve the Meru `User` row by email") is **reversed**. See D3 below.
  D3's error code `MER-AUTH-0004` is also unusable: it is already `AUTH_MFA_REQUIRED`
  (`src/common/types.ts:60`).

**Builds on:** [ADR 0012](0012-better-auth-adoption.md) — D3's invariant table (what a
validated user must carry) is this ADR's acceptance criterion, unchanged. D4 (no community Nest
adapter) and D6 (no organization plugin) are adopted as written.

**Explicitly does not decide:** the `app_builder` role, a verticals registry, or a partner tier.
See D9. They are reserved for ADR 0024.

> **References into `src/iam/iam.service.ts` and `src/iam/services/saml.service.ts` are by
> method or symbol name, never by line.** Both files are being edited in parallel on this branch;
> line numbers into them went stale twice in one day. Other `file:line` references are as read on
> 2026-11-17 — re-grep the symbol before relying on one.

---

## 1. Context

### 1.1 What changed since ADR 0002 and 0012

- **Production is offline.** Every Vercel host returns HTTP 402 `DEPLOYMENT_DISABLED`, and the
  operator has decided to bring the backend back on **Render**, not Vercel. `render.yaml` exists and
  runs `node dist/src/main` (`startCommand`), so on Render **`src/main.ts` is the entrypoint, not
  `api/index.js`**. Any auth-hardening that lives only in `api/index.js` does not apply there.
  `[UNVERIFIED: the 402 status — stated by the operator for this run, not re-curled by this ADR's
  author.]`
- **The Neon project is not what this ADR first said. Corrected 2026-11-17.** The first draft
  recorded that the operator chose Managed Better Auth on project `cool-rice-41190255` and that it
  was the same project as the live control plane. **It is not.** As established in the operator
  session on 2026-11-17 and corroborated by `render.yaml`'s header comment and
  `docs/runbooks/render-deploy.md` §5 (both Jonas's):

  | | Project | Endpoint | Region | What it is |
  |---|---|---|---|---|
  | Old | `cool-rice-41190255` | `ep-restless-thunder-azgspl7m` | `ap-southeast-1` (Singapore) | The **pre-cutover** control plane, created 2026-07-23. Databases `neondb`, `govx`, `immistack`; production branch **archived**. Still named by `GOVX_DB_URL` (owner role). In the Neon account the operator is signed into (org "Qognition", Free plan) |
  | Live | **not identified** | `ep-small-darkness-aeyx0p5j` | `us-east-2` (Ohio) | The live control plane since the 2026-09-10 cutover (workspace `CLAUDE.md` §12). **Not in the Neon account the operator signed into.** Which account owns it, and who can access that account, is unknown |

  The operator's earlier "same project" answer was wrong. **Which project hosts Neon Auth is now
  an open operator decision**, and this ADR is written for both outcomes (D12). It does not assume
  one.
- **The user base is small and production is down.** ADR 0012 §5 named exactly this combination
  as the window in which changing the auth path is cheapest. It is the reason the per-tenant
  pilot flag is being replaced with a platform-wide mode switch (D7).
- **The direction is now explicit:** Meru is the platform; ImmiStack and GovX are example apps on
  it; regtech first; grant-funded. The operator surface is therefore a first-class product, and
  "Control Centre" is the operator's name for it. `[UNVERIFIED: that "Control Centre" means the
  existing meru-dashboard app — no document in either repo uses the term.]`

### 1.2 What Neon's Managed Better Auth issues — verified against vendor docs on 2026-11-17

From [Neon Auth JWT plugin](https://neon.com/docs/auth/guides/plugins/jwt) (page dated
2026-11-05):

| Property | Value |
|---|---|
| JWKS | `<NEON_AUTH_URL>/.well-known/jwks.json` |
| Algorithm | EdDSA (Ed25519) |
| Lifetime | 15 minutes, no refresh token |
| `iss` and `aud` | **both** the origin of the auth URL, without the path (e.g. `https://ep-xx.aws.neon.tech`) |
| Payload | `sub`, `email`, `role`, plus `o` (active organization: `id`, `slug`, `role`) when the Organization plugin is in use |
| Custom claims | "Not supported at this time" |
| `kid` | the header `kid` must match a key in the JWKS; on a miss, re-fetch |

**Not listed in that payload:** an `email_verified` claim, and a `jti`. `[UNVERIFIED: whether
either is present in practice.]` D3 and D2 depend on the first and are written not to depend on
the second.

From the [Organization plugin](https://neon.com/docs/auth/guides/plugins/organization) and
[Admin plugin](https://neon.com/docs/auth/guides/plugins/admin) pages: the Organization plugin is
**enabled by default on every branch** and can be disabled in the Console or by API; a Console
user can be promoted with "Make admin", which sets the user's Better Auth `role`.

**Not found in vendor docs:** a setting to disable open sign-up on Managed Better Auth.
`[UNVERIFIED: whether open sign-up can be turned off at all — see D4 and §8.]` A
branch-scoped user-creation endpoint does exist,
`POST /projects/{project_id}/branches/{branch_id}/auth/users`
([reference](https://neon.com/docs/reference/api/auth/create-branch-neon-auth-new-user)).

### 1.3 The current auth surface, re-read from code on 2026-11-17

- **One session verifier.** `JwtStrategy.validate` (`src/iam/strategies/jwt.strategy.ts:53`)
  maps `sub → id` and calls `assertSessionLive`. **It now refuses two token shapes outright,
  before the session check:** any token carrying `mfaPending` (`:58`), and any token with neither
  `sid` nor `imp` (`:69`). So the MFA challenge and the SAML token can no longer be presented as a
  bearer credential at all, and an impersonation token (`imp`, no `sid`) is the only sid-less
  token it accepts. The second verifier ADR 0012 §1.3(c) found (`JwtAuthGuard`) has been
  **deleted**; `src/iam/one-jwt-verifier.spec.ts` fails the build if any file other than the
  strategy injects `JwtService` and calls `.verify`, or assigns a decoded token to `request.user`.
  The MFA challenge in `IamService.verifyMfaLogin` is the one named exemption.
- **Session issuance.** `IamService.issueSession` (`private`) is called from `login`,
  `refreshTokens` and `verifyMfaLogin`. `IamService.login` is where the MFA gate lives: a user with
  `mfaEnabled` gets `{requiresMfa, userId, temporaryToken}` and no session.
- **Password login** resolves the user **by email** under `TenantContext.runAsSystem`
  (`IamService.validateUser`), because no tenant is bound yet. `validateUser`'s status check
  refuses `locked` and `inactive` users.
- **Operators are not required to have MFA.** Nothing in `login` treats `platform_admin`
  differently. MFA *disable* requires a current TOTP code (`IamService.disableMfa`), so a stolen
  access token can no longer strip a second factor. MFA enable (`verifyMfaSetup`) and disable are
  audited **first, on the strict path** (§11, "Related hardening").
- **Nobody can reset another user's MFA.** `disableMfa` is the only code path in `src/` that sets
  `mfaEnabled = false` (grep 2026-11-17), and it needs the user's own current TOTP code. A user
  who loses their authenticator can be recovered only by editing the database. D8.4.
- **Invites.** `IamService.inviteUser` creates the `users` row with an unusable placeholder
  password and `status: invited`, then issues a SHA-256-only, single-use `AuthToken` of type
  `invite`, and writes `INVITE_ISSUED` **after** the save, through the best-effort `audit` helper.
  The row it creates carries a role, `firm_admin` included. D14.
  Redemption is `IamService.resetPassword`, which serves **both** `invite` and `password_reset`
  and **does not check `record.type`** (re-read 2026-11-17). That matters in D3.
- **Locking a user does not revoke their sessions.** `IamService.updateUser` audits a status
  change strictly before saving and never calls `logout(userId)`. A locked user keeps working
  sessions until they expire. That matters in D3.3.
- **Three IAM audit helpers.** `IamService.audit` swallows write failures (logs and continues): right
  for informational events, wrong for anything this ADR needs to fail closed on. `IamService.auditStrict`
  rethrows as a **503** and is called only by `IamService.auditedChange`, which records a change as
  a strict `*.requested` row before it, then a best-effort applied row or `*.not_applied` row
  (`context.reason` ∈ `audit_unavailable | no_row_updated | write_failed`) after it. Today
  `auditedChange` serves role change, status change, MFA enable and MFA disable (re-read
  2026-11-17). Its failure classifier maps **only `NotFoundException`** from the change callback to
  `no_row_updated`; every other exception is `write_failed`. That matters in D8.4. All three shape
  the entry through `IamService.toAuditEvent`.
- **Session revocation is filtered by user, not by tenant.** `IamService.logout(userId)` and
  `IamService.revokeAllSessions` both select sessions by `{ userId, revokedAt: IsNull() }` alone
  (re-read 2026-11-17). Under RLS that is tenant-scoped by the binding; **under `runAsGod` it is
  not**, and D3.2 and D8.4 call this from god mode. Revocation reaches a live token within
  `JwtStrategy`'s 60-second `session-live:<sid>` cache (`REVOCATION_TTL_MS`), **per instance**.
  That matters in D8.4.C5.
- **Nested impersonation could launder attribution (Anton, D13.C1). Closed on branch
  `wave0/back-online`, not deployed.** At HEAD, `POST /tenants/:id/impersonate`
  (`OperatorController.impersonate`) carried `AuthGuard('jwt')`, `PolicyGuard` and
  `@Roles(PLATFORM_ADMIN)` but not `NoImpersonationGuard`, did not refuse the operator's own tenant,
  and `IamService.issueImpersonationToken` took the oldest active user whatever their role, so a
  second impersonation's `imp` could name an impersonated `platform_admin`. Now the route carries
  `NoImpersonationGuard`, refuses the caller's own tenant with 403 before `runAsGod`, and
  `issueImpersonationToken` pages the target tenant's active users oldest first and takes the first
  not holding `platform_admin` (400 if none). `forTenant`'s cross-tenant branch and
  `PUT /tenants/:id/entitlements` also refuse an impersonation session
  (`src/iam/nested-impersonation.spec.ts`, `src/iam/operator-impersonation-guard.spec.ts`;
  re-read 2026-11-17).
- **The sign-off gate accepted an impersonation token (Anton, D13.C7). Closed on branch
  `wave0/back-online`, not deployed.** `WorkflowEngineService.transition`
  (`src/workflow/workflow.service.ts`) now refuses a `requiresSignOff` transition with 403 when
  `TransitionRequest.impersonatedBy` is set, before the practitioner credential is read;
  `WorkflowController` threads it from `req.user.impersonatedBy` (`src/workflow/workflow-signoff.spec.ts`;
  re-read 2026-11-17).
- **`impersonatedBy` reaches `request.user`** (`jwt.strategy.ts:89`, from the signed `imp` claim
  only) **and is carried into IAM audit entries, and no others.** `UsersController` passes
  `req.user.impersonatedBy` to `inviteUser`, `resendInvite` and `updateUser`, and
  `IamService.toAuditEvent` writes it into `context.impersonatedBy` — so **invite issue, invite
  resend, role change and status change** name the operator behind an impersonated action
  (`src/iam/impersonation-refusal.spec.ts`). `NoImpersonationGuard` reads it to refuse. **No other
  audit writer reads it** (grep 2026-11-17): every other caller of `AuditService.logEvent` — among
  them `documents.service.ts`, `tenant-provisioning.service.ts` and `config-pack.service.ts`, and
  also `workflow.service.ts`, `vac.service.ts`, `acceptance.service.ts`, `fee-schedule.service.ts`
  and `TenancyService.runAsGod`'s own entry — still records an impersonated action as the
  impersonated user alone. D13. (`ai.service.ts` and `orchestration.controller.ts` inject
  `AuditService` only to read with `queryLogs`; they write nothing.)
- **`context` is outside the audit row's checksum.** `AuditService.logEvent` checksums `tenantId`,
  `timestamp`, `userId`, `action`, `entityId`, `beforeState` and `afterState`; `context` is stored
  but not hashed. What protects `context` is the append-only triggers (workspace `CLAUDE.md` §7.7).
  **Neither the checksum nor the chain hash is keyed.** Both are plain SHA-256 over values stored in
  the row, so anyone able to write `audit_logs` can recompute them. They detect accidental
  corruption, not a deliberate rewrite. That matters in D13.C5.
- **The audit chain can fork under concurrency (Anton, AC.C3).** `AuditService.getLastChainHash`
  reads the tenant's chain tip with a plain `findOne` ordered by `timestamp DESC, createdAt DESC`,
  with no lock and no transaction around the read and the following `save`. Two concurrent writes
  in one tenant can read the same tip, and `verifyChain` would then report legitimate data as
  tampered. `[UNVERIFIED: a fork observed in production.]`
- **`AuthTokenType`** is a Postgres enum, `auth_tokens_type_enum` = `('password_reset','invite')`
  (`src/migrations/1754100000000-AddAuthTokens.ts:22-23`).
- **`users.email`** is globally unique (`User.email` in `src/iam/entities/user.entity.ts`). There is no
  `authSubject`, `neon_auth`, `NEON_AUTH_*`, `federated` or `jose` anywhere in `src/`, `api/` or
  `scripts/` (grep, 2026-11-17, exit 0, no matches). `jose` is not installed.
- **`meru_app`'s grants are schema-bounded.** `GRANT USAGE ON SCHEMA public, app` and default
  privileges `IN SCHEMA public` only (`src/migrations/1753500000000-AddTenantRowLevelSecurity.ts:114-133`).
  Nothing grants it anything on `neon_auth` today. `npm run rls:verify`
  (`scripts/verify-tenant-isolation.js:78`) only inspects `nspname = 'public'`, so **nothing
  would notice if it were granted later** — and `rls:verify` cannot run locally in any case
  (`DATABASE_APP_URL` is blank in the local `.env`; workspace `CLAUDE.md` §8).
- **`MigrateService` is public-schema-scoped where it inspects the database.** `isEmptyDatabase`
  counts `table_schema = 'public'` only (`src/jobs/migrate.service.ts:40-45`); the RLS coverage
  assertion filters `nspname = 'public'` (`:194`); the dynamic RLS loop it replays filters
  `c.table_schema = 'public'` (`AddTenantRowLevelSecurity.ts:150`). It reads **`GOVX_DB_URL`** as
  the owner URL for target `govx` (`migrate.service.ts:33`) and runs DDL there, reachable over
  `POST /jobs/migrate/:target` behind `CronSecretGuard`. `GOVX_DB_APP_URL || GOVX_DB_URL` is also
  read by `configuration.ts:166` for the (uncalled) vertical datasource.
- **God mode.** `TenancyService.runAsGod` (`src/core/tenancy/tenancy.service.ts:44-75`) writes a
  `CRITICAL` audit entry against `targetTenantId` *before* the work, rethrows if that write fails,
  then sets `app.bypass_rls = on` for the callback. **Under god mode, RLS filters nothing**, so
  every query inside it must carry its own `"tenantId"` predicate.
- **SAML is disabled unconditionally.** `SamlService.assertSamlAvailable`
  (`src/iam/services/saml.service.ts`) throws `NotImplementedException` (HTTP 501) at the
  top of both `initiateLogin` and the callback. The comment above that method records Anton's
  finding that the verifier is unsound (XML signature wrapping, regex-read assertion fields, locked
  users issued tokens, sid-less tokens) and states **"There is deliberately no SAML_ENABLED flag —
  a flag would re-enable this verifier."** Spec: `src/iam/saml-disabled.spec.ts`. Nothing in `src/`
  writes `ssoConfig`.
- **Rate limiting on Render** is the single IP-keyed global limiter in `src/main.ts:97-138`. There
  is no stricter `/auth/*` bucket in `main.ts`. `render.yaml` runs `numInstances: 1`, so the
  in-process limiter is the whole picture today.
- **Logins are not audited today.** `AuditAction.LOGIN` exists in the enum and has no caller in
  `src/`.
- **Residency, stated because it is already true.** The control plane is in `us-east-2`;
  `verticals/immigration.json` declares `compliance.dataResidency: "AU"` (workspace `CLAUDE.md` §6).
  ImmiStack records are therefore already held outside the region the pack declares. This ADR adds
  identity data to that question; it did not create it.

---

## 2. Decisions

### D1 — Neon-managed Better Auth authenticates the person; Meru remains the only authority on tenant, role and session

**Decision.** A user signs in with Neon's Managed Better Auth on **the Neon project chosen under
D12**; the frontend posts the resulting Neon JWT to `POST /auth/federated/neon`; Meru verifies it,
resolves the Meru `users` row by **linked subject**, and issues an ordinary Meru session through
the existing MFA gate and `issueSession`. The Meru `users` row is the **only** source of
`tenantId` and `roles`. `JwtStrategy` remains the **only** verifier of Meru session tokens.

What does not change: the RLS binding chain, the `sessions`/`auth_tokens` tables, the claim set
of the Meru access token, `scopeOf`, `issueImpersonationToken`, the three frontends' refresh
cookie handling. ADR 0012 D3's invariant table (`id`, `email`, `tenantId`, `roles`, `sid`) is the
acceptance test for every token this ADR causes to be issued.

### D2 — The Neon JWT is verified once, at the exchange, by a plain service — not a Passport strategy — and is single-use

**Decision.** A single verifier service (proposed name `NeonIdentityVerifier`, `[UNVERIFIED: name
— implementer's choice]`) uses `jose`'s `createRemoteJWKSet` + `jwtVerify` and enforces, all
mandatory:

| Check | Rule |
|---|---|
| `alg` | pinned to `EdDSA`. Anything else, including `none` and `HS*`, is refused |
| `kid` | must be present in the header and resolve in the JWKS. The remote set re-fetches on an unknown `kid`, with `jose`'s cooldown so a stream of junk `kid`s cannot hammer Neon |
| `iss` | exact string equality with configuration (`NEON_AUTH_ISSUER`, proposed name) |
| `aud` | exact string equality with configuration (`NEON_AUTH_AUDIENCE`, proposed name). Per §1.2 both equal the auth URL origin today; they are configured separately so a vendor change to one does not silently widen the other |
| JWKS URL | configuration (`NEON_AUTH_JWKS_URL`, proposed name). **`iss`, `aud` and JWKS are per Neon project (and per branch, §5 row 4)** — set from the project D12 selects, never copied from another environment |
| `exp` / `iat` | enforced, clock tolerance ≤ 30 s; `iat` no older than 15 minutes |
| `sub` | non-empty string |
| `banned` | if `true`, refuse. **Neon claims may only subtract access, never add it** |
| email verification | per D3 rule 1a |
| `role`, `o` | **ignored entirely.** Never read, never logged as an attribute, never mapped |

It returns an identity assertion `{ subject: 'neon:' + sub, email, emailVerified }` to the exchange
handler and nothing else. It is **not** registered with Passport, not a guard, and its output
**never** reaches `request.user`. `src/iam/one-jwt-verifier.spec.ts` gains one assertion: `jwtVerify`
from `jose` appears in exactly one file under `src/`.

#### D2.1 — Replay refusal (Anton, condition 5)

**Decision.** The exchange is **single-use per Neon JWT.** After the signature and claims verify,
and **before** any user lookup, the handler inserts `sha256(<the compact JWT as received>)` into a
new pre-tenant table `federated_assertion_replay ("tokenHash" char(64) PRIMARY KEY, "expiresAt"
timestamptz NOT NULL)` with `INSERT … ON CONFLICT DO NOTHING RETURNING`, under
`TenantContext.runAsSystem` (no tenant is bound on a public route). **Zero rows returned is a
replay → 401 `MER-AUTH-0011`** ("This sign-in has already been used"; proposed code). `expiresAt`
is the token's own `exp` plus the 30 s tolerance, never more than 15 minutes out.

- Hash the whole token, not `jti`: §1.2 does not list a `jti` claim.
- Verify first, then insert, so unauthenticated junk cannot fill the table.
- The insert commits on its own. If a later step fails (MFA, link 409, flagged link), the Neon
  token is still burned and the user signs in to Neon again. Fail closed; the cost is one extra
  sign-in.
- Postgres, not the in-process cache: a restart inside the 15-minute window must not reopen a
  token, and `numInstances: 1` is a current setting, not a guarantee.
- Expired rows are deleted opportunistically by the same insert path (`DELETE … WHERE
  "expiresAt" < now()` bounded by `LIMIT`) or by the daily tick — implementer's choice; either
  is correct because an expired row can never match a token `jwtVerify` would accept.

Schema: Migration C, §3.

#### D2.2 — A rate limit of its own (Anton, condition 5)

**Decision.** `POST /auth/federated/neon` gets a dedicated IP-keyed bucket in `src/main.ts`,
stricter than the global limiter at `:97-138` and **not** sharing its counter. Proposed starting
value: 10 requests per minute per IP `[UNVERIFIED: value — Anton to set]`. Same keying rules as
the global limiter (no client-supplied header in the key; `src/iam/rate-limit-key.spec.ts` is the
precedent). It is in-process, which is sufficient at `numInstances: 1`; a second instance makes it
per-instance and needs ADR 0004's shared store (§7).

**Why not ADR 0002 D2's `NeonAuthStrategy`.** A second Passport strategy is a second way to
populate `request.user`, which is exactly the split the single-verifier spec was written to make
impossible. The Neon token is a one-time identity assertion exchanged for a Meru session, not a
bearer credential for API calls; it never needs to be verified on any route but one.

`jose` is a new dependency. `[UNVERIFIED: which jose major is CommonJS-loadable on Node 20
(render.yaml NODE_VERSION). npm run check:cjs must pass with it, as it has caught uuid and otplib
before.]`

### D3 — Linking is by `users.authSubject`, written only by redeeming a Meru-minted single-use token. Never by email alone.

**Decision.** Add `users."authSubject"` — `varchar(255) NULL`, unique where not null,
`select: false` on the entity like `password` — and `users."authSubjectFlaggedAt"` —
`timestamptz NULL` (D3.3). `authSubject`'s value is `neon:<sub>`; the prefix exists so a second
provider can coexist without a migration. It is written in exactly three places, each of which is
the redemption of a token Meru minted and the caller presents:

| Redemption | Token | Precondition on the `users` row |
|---|---|---|
| Staff/client invite | existing `auth_tokens` type `invite` (from `inviteUser`) | `status = invited`, `authSubject IS NULL` |
| Tenant signup | existing `TenantSignupInvite` (`POST /tenants/signup`) | row is created in this request |
| Lazy migration of an existing user (D5), or re-link after unlinking (D3.2) | **new** `auth_tokens` type `federation_link` | `status = active`, `authSubject IS NULL` |

and cleared in exactly one place, D3.2.

Rules that hold for all three:

1. **Possession of the Meru token is the link proof.** The Neon identity's `email` must also equal
   `users.email` (case-insensitive) — a second condition, never the key. A mismatch is a 409 and
   the token is **not** burned.
   - **1a. The email condition counts only if Neon verified that email (Anton, condition 4).**
     Either the Neon JWT carries `email_verified: true` (refused if `false` or absent), **or** — if
     Neon does not emit that claim — the auth project is configured so that Neon will not issue a
     token for an unverified address, and that configuration is a recorded release precondition
     checked by Jonas for `link`. `[UNVERIFIED: whether Neon emits email_verified; whether Managed
     Better Auth has a "require email verification" setting.]` **If neither can be established,
     `link` mode does not open.** An unverified email is refused with `403 MER-AUTH-0013` ("Verify
     your email with your sign-in provider first"; proposed code) and the Meru token is not burned.
     The verifier is configured for exactly one of the two sources (`NEON_AUTH_EMAIL_VERIFIED_SOURCE
     = claim | project-config`, proposed name) so the rule is never silently "neither".
2. **One conditional write.** `UPDATE users SET "authSubject" = $1 WHERE id = $2 AND "tenantId" = $3
   AND "authSubject" IS NULL AND "authSubjectFlaggedAt" IS NULL`, in the same transaction as burning
   the token with the existing `usedAt IS NULL` conditional update. Zero rows affected, or a unique
   violation on `authSubject`, is a 409 and rolls back the burn. A subject is never re-pointed;
   only D3.2 clears it.
3. **`resetPassword` must refuse `federation_link` tokens.** Today it redeems any token type
   (`IamService.resetPassword` checks missing, used and expired, never `record.type`; re-read
   2026-11-17). Without this check, a link token presented to
   `POST /auth/reset-password` would let its holder set a password. This is a blocking implementer
   requirement, with a spec.
4. **No other code path writes the column.** Not `PATCH /iam/users/:id`, not
   `POST /platform/tenants/:id/users/invite`, not a backfill, not a script. A grep-based spec
   asserts `authSubject` is assigned in one service file only.
5. **Never auto-provision.** An unlinked Neon identity with no Meru token gets
   `404 MER-AUTH-0010` ("No Meru account is linked to this sign-in"; new code, next free after
   `MER-AUTH-0009`). ADR 0002 D3's reasoning stands.
6. **Every link is audited, fail-closed, and told to the user (Anton, condition 4).**
   - An audit entry — `AuditAction.UPDATE`, `entityType: 'user'`, severity `warning`,
     `context: { event: 'auth.federation.linked', redemption: 'invite'|'signup'|'federation_link',
     provider: 'neon' }` (the `verifyMfaSetup` precedent for riding an event on `UPDATE` without an
     enum migration) — is written through `AuditService.logEvent` directly, **before** the
     conditional `UPDATE`. If it cannot be written the request is a 503 and nothing is linked.
     **Not** through `IamService.audit`, which swallows (§1.3). The `authSubject` value is never
     written into the entry; `federated: true` is.
   - After commit, the user is notified at `users.email`: a sign-in method was linked, when, and
     the request IP, with "if this was not you, contact your firm administrator". Delivery is not
     proven (Resend, workspace `CLAUDE.md` §12), so a send failure is logged and audited as
     `context.notified: false` but does **not** undo the link — otherwise no one could link until
     mail works. `[UNVERIFIED: whether a user-targeted in-app notification type exists to carry the
     same message.]`

#### D3.2 — Unlinking, designed before `link` mode opens (Anton, condition 4)

**Decision.** One operator route, `DELETE /platform/users/:id/federation-link`:

| | |
|---|---|
| **Guards** | `AuthGuard('jwt')`, `NoImpersonationGuard`, `PolicyGuard`, `@Roles(PLATFORM_ADMIN)` — the impersonation refusal is the existing guard, in that order, and the handler is covered by the route-enumeration spec (D13 item 8) |
| **Body** | `{ reason: string }` (required, 10–500 chars) |
| **Effect, one transaction** | `runAsGod(actor.id, <user's tenantId>, 'Unlink federated sign-in for <userId>: <reason>')` (CRITICAL, written first, rethrows); `UPDATE users SET "authSubject" = NULL, "authSubjectFlaggedAt" = NULL WHERE id = $1 AND "tenantId" = $2`; revoke every session for the user, **filtered by `userId` and `tenantId`** (D8.4.C5; `IamService.logout` filters by user only today); mint a fresh `federation_link` token |
| **Response** | `200 { linkUrl }` — a bearer credential returned to the operator, the ADR 0006 `inviteUrl` precedent, because a federated-only user has only a placeholder password and cannot reach D5's password-login path |
| **Errors** | 404 user not found (resolved under `runAsSystem` selecting `id, tenantId` only, as D8.1's email mode); 409 user not linked |

The user is notified as in D3 rule 6. There is no self-service unlink and no firm-admin unlink in
this ADR; a firm admin who needs one asks the operator. Unlinking is the **only** way a flagged link
(D3.3) is resolved.

#### D3.3 — Locking a user revokes their sessions and flags the link (Anton, condition 4)

**Decision.** When `updateUser` changes `status` to `locked` or `inactive`, in the same request and
after its existing fail-closed status audit: revoke every session for that user (by `userId` and
`tenantId`, D8.4.C5), and if
`authSubject IS NOT NULL` set `authSubjectFlaggedAt = now()`. `POST /auth/federated/neon` refuses a
user whose `authSubjectFlaggedAt IS NOT NULL` with `403 MER-AUTH-0014` ("This sign-in is suspended;
contact your administrator"; proposed code), and refuses `locked`/`inactive` users exactly as
`IamService.validateUser`'s status check does.

**Unlocking does not clear the flag.** A lock is a statement that something was wrong; the person
who comes back with the same Neon subject is re-admitted only through D3.2's unlink and a fresh
link token. Revocation takes effect within `JwtStrategy`'s 60 s session cache.

**Why not email.** Email matching makes Neon's user directory the authority on who owns a Meru
account. Anyone who can get a Neon identity carrying a victim's address — open sign-up, a Neon
Console admin, a future social provider that does not verify email — would inherit the victim's
tenant and role. The invite token is already the audited proof of who a Meru account belongs to;
linking reuses it. Rule 1a makes even the secondary email check refuse to count an address nobody
proved they own.

### D4 — Neon-side configuration: open sign-up off, organizations off, Neon admin grants nothing, Neon 2FA off

**Decision.** On the auth project selected under D12, on every branch Meru uses:
- **Open sign-up off.** `[UNVERIFIED: that Managed Better Auth exposes this setting — not found in
  the docs read on 2026-11-17.]` This is **defence in depth, not the isolation mechanism**: D3
  already makes a walk-up Neon account worthless, because it cannot link without a Meru token. If
  the setting does not exist, D3 (with rule 1a) still holds and this ADR is not blocked.
- **Organization plugin disabled** (enabled by default per §1.2). The `o` claim is ignored
  regardless (D2); disabling it stops a second tenancy vocabulary existing in the auth database at
  all. ADR 0012 D6 stands.
- **The Neon admin role grants nothing in Meru.** "Make admin" in the Neon Console changes a Better
  Auth `role` that D2 never reads. A Neon Console operator can lock someone out (ban, delete) but
  cannot grant Meru access. That asymmetry is the design.
- **Neon's 2FA is not enabled.** MFA stays on the Meru side (D6). Two second factors at two
  vendors, only one of which Meru can verify, invites a support process that disables the wrong one.
- **Email verification required**, if the setting exists — D3 rule 1a.

**Consequence of sign-up being off:** a person needs a Neon identity before they can redeem an
invite. How they get one is constrained by D12 — see §8 item 1.

### D5 — Existing users migrate lazily, at their next password login

**Decision.** `AUTH_NEON_MODE` (proposed env name; see D7) governs this.

- **`link` mode.** `POST /auth/login` is unchanged for everyone. When it issues a full session —
  in `login`'s non-MFA branch, or in `verifyMfaLogin` after a correct TOTP — to a user whose
  `authSubject IS NULL`, the response gains one **additive** field, `federation_link_token`: an
  opaque 32-byte random, stored SHA-256-only as an `auth_tokens` row of the new type
  `federation_link`, single-use, **10-minute TTL**, bound to `userId` and `tenantId`. Existing
  frontends ignore an unknown field. The frontend then takes the user through Neon sign-in and
  calls `POST /auth/federated/neon` with `{ token, redeem: federation_link_token }`.
- **`enforce` mode.** A non-`platform_admin` user whose password and (if enabled) TOTP check out
  but whose `authSubject IS NULL` receives **no session** — `200 { requiresFederation: true,
  federation_link_token, link_expires_in: 600 }`, the same shape family as the `requiresMfa`
  response. A non-`platform_admin` user who *is* linked gets `403 MER-AUTH-0012` ("Use federated
  sign-in"; new code). `platform_admin` is unaffected — D8.

**Why a new `auth_tokens` type, not a short-lived JWT. Corrected 2026-11-17 (Anton, condition 6).**
The first draft argued that a `{sub, purpose}` JWT signed with `JWT_SECRET` would be accepted by
`JwtStrategy` as a bearer token because it has no `sid`. **That is no longer true:** `JwtStrategy`
now refuses every sid-less token that is not an impersonation token (`jwt.strategy.ts:69`), and
refuses `mfaPending` outright (`:58`). The `auth_tokens` design stands on its remaining merits,
which were always the stronger ones:
- **Single use.** A signed JWT is valid until `exp` however many times it is presented; making it
  single-use needs a store, and `auth_tokens` already is one, with the `usedAt IS NULL`
  conditional burn D3 rule 2 relies on.
- **Revocable and inspectable.** A row can be deleted (Migration B's rollback does exactly that);
  a JWT cannot be recalled.
- **SHA-256-only at rest**, the discipline `invite`, `password_reset`, `TenantSignupInvite` and
  `sessions.refreshTokenHash` already share.
- **No new token shape signed with `JWT_SECRET`.** The bearer-refusal in `JwtStrategy` is now a
  defence for that case, not the only one — this keeps it a second line rather than the first.

**Unpleasant, accepted:** a user with MFA enabled answers TOTP twice on the one occasion they link
(once at password login, once when the federated sign-in passes back through `login`'s MFA gate).
The alternative — letting a link token stand in for MFA — makes a 10-minute bearer token a second
factor, and is rejected.

### D6 — MFA stays on the Meru side

**Decision.** `POST /auth/federated/neon` ends in `IamService.login` (or an extracted equivalent
that keeps its MFA branch first), never in `issueSession` directly. A user with `mfaEnabled` gets
the existing `{requiresMfa, userId, temporaryToken}` and completes at the unchanged
`POST /auth/mfa/verify`. `mfaSecret`, `otplib@12` and the enrolment routes are untouched.

### D7 — Rollout is a platform-wide three-state mode, not a per-tenant flag (supersedes ADR 0002 D6)

**Decision.** One environment variable, proposed name `AUTH_NEON_MODE`, values
`off | link | enforce`, **default `off`**, read once at boot and reported (by name and value, never
a secret) on `GET /health`'s capabilities block.

| Mode | `POST /auth/federated/neon` | `POST /auth/login` (non-operator) | `POST /auth/login` (`platform_admin`) | `POST /auth/reset-password` (non-operator) |
|---|---|---|---|---|
| `off` | 404 | unchanged, byte-identical | unchanged, byte-identical | unchanged |
| `link` | live | unchanged + `federation_link_token` when unlinked (D5) | requires Meru TOTP; audited fail-closed (D8) | unchanged |
| `enforce` | live | link-only or 403 (D5) | requires Meru TOTP; audited fail-closed (D8) | refuses `invite` and `password_reset` tokens for non-`platform_admin` users with the same single generic message it already uses |

`POST /auth/forgot-password` keeps answering the same generic 200 to everyone in every mode (no
enumeration), but in `enforce` it only sends mail to `platform_admin` accounts.

**Why not 0002's per-tenant `tenants.settings.authProvider`.** It was designed for one pilot tenant
on a live Vercel deployment. That deployment is gone; the user base is small; and the Control
Centre's operator path (D8) is platform-wide by nature. A per-tenant flag also has to be consulted
*after* the user is identified, which means a federated sign-in for a user in a `local` tenant
needs a fourth answer the table above does not have. One switch with an `off` position gives the
same blast-radius control. It was never built (`authProvider` has no reader in `src/`), so
nothing is removed.

**Preconditions to move `off → link`, each verified by Owen (Anton's conditions, collected):**
1. D12 gate zero is met and the D12 outcome's own preconditions (A: D11-A; B: D11-B) are green
   **at boot on the deployed service**, not only in a spec.
2. D3 rule 1a's email-verification source is established and configured.
3. D3.2 and D3.3 are implemented with specs.
4. D2.1 replay refusal and D2.2's rate limit are live.
5. Every `platform_admin` has `mfaEnabled = true` — they cannot enrol after the flip, because D8
   refuses them a session without it. `[NEEDS DATA: count of platform_admin users without MFA]`
6. The `platform_admin` sweep password still present in git history (workspace `CLAUDE.md` §16)
   **has been rotated on production** (Anton, condition 7).
7. **Impersonation is attributed everywhere and refused where it must be** (Anton, condition 8)
   — required before §5 row 1's remedy may use impersonation as a smoke credential. Three parts,
   and "audit entries" means **every** entry, not IAM's:
   - (a) *Refusal* — **met in code** on branch `wave0/back-online`, not deployed: the six
     account-security routes (§11, A8), D13.C1 (no nested impersonation, no `platform_admin`
     target) and D13.C7 (no sign-off under impersonation). D13.C1 and D13.C7 still need Anton's
     code review (§10 1a).
   - (b) *Attribution* — **met for IAM only** (invite issue, invite resend, role change, status
     change). **Not met** for any other caller of `AuditService.logEvent`. Met when D13 is
     implemented, its specs are green, and Anton has reviewed it.
   - (c) *No accidental gaps* — the route-enumeration spec (D13 item 8) is green and covers every
     JWT-guarded handler on `IamController` (done), **and**, per D13.C2, `OperatorController`, every
     `platform_admin`-only handler, and the controller(s) hosting D3.2 and D8.x.
   - (d) *Answered* — the D15 reconciler is running (AC.C2), so no impersonated or operator change
     is left as an unanswered request row.

**Preconditions to move `link → enforce`, each verified by Owen:**
1. `scripts/smoke/cross-tenant.sh` and `meru-core-fe/tools/sweep` are green **under `enforce`**
   (§5, rows 1–2).
2. §8 item 1 (provisioning channel) is answered and exercised end to end for one invitee.
3. Neon Auth's own password-reset mail is proven to reach a non-owner inbox (§5, row 3).
4. `[NEEDS DATA: count of active, non-platform_admin users with authSubject IS NULL]` — each is
   locked out on the flip unless they link first or an operator re-invites them. Decide with the
   number, not before.

### D8 — Control Centre: admin means `platform_admin`; two new endpoints and an unlink; `/auth/login` is the operator's break-glass, behind Meru TOTP

**Decision.** There is no new role. The Control Centre's "admin" **is** `PlatformRole.PLATFORM_ADMIN`.
Every cross-tenant action goes through `TenancyService.runAsGod` **per target tenant**, which writes
the `CRITICAL` entry first and refuses to proceed if it cannot. Impersonation tokens (`imp` claim
present) are refused on every new route with 403: an operator acting *as* a tenant user must not
reach the operator surface from inside that session.

**Break-glass, hardened (Anton, condition 7).** `POST /auth/login` remains available to
`platform_admin` in every mode, as break-glass for a Neon Auth outage or misconfiguration. In
`link` and `enforce`:
- **Meru TOTP is required server-side.** A `platform_admin` whose `mfaEnabled` is `false` receives
  no session: `403 MER-AUTH-0015` ("Operator sign-in requires MFA"; proposed code). The password leg
  for an MFA-enabled operator returns the existing `requiresMfa` challenge, and the session is
  issued only by `verifyMfaLogin`. There is therefore no non-MFA operator session in these modes.
- **The `AuditAction.LOGIN` entry is written before `issueSession` and fails closed.** Severity
  `warning`, `context: {method: 'password', breakGlass: true, mode}`, written through
  `AuditService.logEvent` directly in `verifyMfaLogin`'s operator branch. If the write throws, the
  request is a 503 and **no session is issued**. Not through `IamService.audit`, which swallows
  (§1.3). It is the first caller of `AuditAction.LOGIN` in the codebase.
- **The sweep `platform_admin` password is rotated before `link`** (D7 `off → link` precondition 6).

In `off`, behaviour is byte-identical to today (D7's rollback guarantee). Requiring operator MFA in
`off` too is a reasonable separate hardening and is left to Anton; it is not bundled here because
it would break the `off`-is-identical rollback proof.

#### D8.1 — `GET /platform/users`

| | |
|---|---|
| **Guards** | `AuthGuard('jwt')`, `NoImpersonationGuard`, `PolicyGuard`, `@Roles(PLATFORM_ADMIN)` — the impersonation refusal is the existing guard, in that order, and the handler is covered by the route-enumeration spec (D13 item 8) |
| **Query** | exactly one of: `tenantId` (uuid) — a tenant's directory; or `email` (exact, case-insensitive) — find one person across the platform. Optional with `tenantId`: `status` (`UserStatus`), `role` (`PlatformRole`), `page` (≥1), `limit` (1–100, default 25). Neither or both → 400 `MER-VAL-*` |
| **Response** | `200`, envelope `data: PlatformUser[]`, pagination in `meta.pagination` (house convention, workspace `CLAUDE.md` §11) |
| **`PlatformUser`** | `DirectoryUser` (`src/common/types.ts:233`) **plus** `tenantId`, `tenantName`, `tenantSlug`, `tenantVertical`, `status`, `mfaEnabled`, `lastLoginAt`, `federated: boolean` (`authSubject IS NOT NULL`), `federationFlagged: boolean` (`authSubjectFlaggedAt IS NOT NULL`). **Never** `password`, `mfaSecret` or the `authSubject` value |
| **404** | `tenantId` names no tenant; `email` matches no user — `MER-RES-*` |

**Tenancy enforcement at this query:**
- *`tenantId` mode:* `runAsGod(actor.id, tenantId, 'List users of tenant <id> (Control Centre)')`.
  RLS is bypassed inside, so the repository call **must** carry `where: { tenantId }` — the same
  predicate `IamService.listUsers` already uses. That predicate is the only
  thing scoping the result; the spec asserts a second tenant's user is absent.
- *`email` mode, hit:* a bootstrap lookup under `TenantContext.runAsSystem` selects **only** `id,
  tenantId` for that email (global uniqueness makes it at most one row); then
  `runAsGod(actor.id, <thatTenantId>, 'Look up user by email (Control Centre)')` loads the
  projection with `where: { id, tenantId }`. The `CRITICAL` entry lands in **that firm's** audit
  trail, so the firm can see an operator looked one of its people up.
- *`email` mode, miss (Anton, condition 11):* there is no target tenant, so the lookup is audited
  against **the operator's own tenant** (the `GET /platform/stats` precedent,
  `src/iam/platform.controller.ts:50-60`) — `AuditAction.READ` (present,
  `src/audit/entities/audit-log.entity.ts:13`), severity `info`,
  `context: { event: 'platform.users.email_lookup', result: 'miss', emailSha256 }`, written
  **before** the 404 is returned and failing closed (503) if it cannot be written. The address is
  stored as SHA-256 of the lower-cased value, not in clear: a miss is by definition someone who is
  not a Meru user, and the evidence needed later ("did an operator search for this address?") is
  answerable from the hash without holding a stranger's email.
- **No unbounded platform-wide listing is offered.** "List every user on the platform" would have
  to be audited against the operator's own tenant, leaving no trace in any affected firm's trail.
  The operator's "per tenant" instruction rules it out. `[UNVERIFIED: that the Control Centre does
  not need a global list — operator to confirm.]`

#### D8.2 — `POST /platform/tenants/:id/users/invite`

| | |
|---|---|
| **Guards** | `AuthGuard('jwt')`, `NoImpersonationGuard`, `PolicyGuard`, `@Roles(PLATFORM_ADMIN)`; covered by the route-enumeration spec (D13 item 8) |
| **Path** | `id` — target tenant uuid. **The only source of the tenant**; any `tenantId` in the body is rejected by the DTO's whitelist |
| **Body** | `{ email, role, firstName?, lastName?, department?, practitionerCredential?, practitionerCredentialType? }` — the fields `inviteUser` already accepts. `role` ∈ {`firm_admin`, `staff`, `client`}. **`platform_admin` is refused (400)** even though `canGrantRole` would allow a platform admin to grant it: minting operators into a customer tenant is out of scope for this route, deliberately |
| **Response** | `201`, the same shape as `POST /iam/users/invite`: `DirectoryUser & { inviteSent, inviteUrl }` |
| **Errors** | 404 tenant not found; 409 tenant not `active`/`trial` (suspended, deleted); 409 email already registered anywhere, with the **single** message D14.C3 sets; 429 per-actor invite limit (D14.C3); 503 audit unavailable (D14) |

**Tenancy enforcement at this write:** `runAsGod(actor.id, id, 'Invite <email> as <role> into
tenant <id> (Control Centre)')`, then the **existing** `IamService.inviteUser(id, dto, {id:
actor.id, name: actor.email}, actor.roles)`. `inviteUser` writes `tenantId` explicitly on the
`users` row and the `auth_tokens` row, and loads the tenant by that id for mail branding — so under
the bypass every write is scoped by the path parameter, never by the operator's own tenant. The
existing `INVITE_ISSUED` audit row lands in the target tenant, attributed to the operator, beside
`runAsGod`'s `CRITICAL` row.

**`inviteUrl` is a bearer credential returned to the operator** — the ADR 0006 precedent, and today
the only working onboarding path while mail is unproven. Under `link`/`enforce`, the URL leads to
the frontend's invite page, which runs Neon sign-in and then calls `POST /auth/federated/neon` with
`redeem` set to the invite token (D3).

Under D14 the `invite.issue.requested` entry is written strictly before the `users` row is
inserted, so an operator invite that cannot be audited creates nobody. `INVITE_ISSUED` is written
only after the insert succeeds.

#### D8.3 — `DELETE /platform/users/:id/federation-link`

Specified in D3.2. Listed here because it is the third Control Centre route.

#### D8.4 — `POST /platform/users/:id/mfa/reset` — operator MFA reset (proposed; Owen, final gate)

**Status of this sub-decision: proposed, recommended, not yet accepted — the operator's decision**
(§8 item 19). Anton reviewed the contract on 2026-11-17 and returned **APPROVE WITH CONDITIONS**
(D8.4.C1–C7, applied below). It is **not** a D7 mode precondition. It is a support gap that exists
today in every mode, `off` included.

**The gap.** `IamService.disableMfa` is the only path in `src/` that turns MFA off, and it needs
the user's own current TOTP code. That is correct for self-service, because it stops a stolen access
token from stripping the second factor. But it means a user who loses their authenticator
has no route back. Recovery today is an owner-role `UPDATE` on `users`, which leaves **no
`audit_logs` row**, since the hash chain is computed in `AuditService.logEvent` and a hand-written
insert would break it. That is the worst way to perform the most security-sensitive change
an account can undergo.

**Amended 2026-11-17 (Owen, FIX; Anton, D8.4.C1–C7).** The first version wrote a fact-named
`mfa.reset` row *before* the change, recorded its own 409 as `write_failed`, reset to a
password-only account, and took a free-text reason. All four are corrected below.

| | |
|---|---|
| **Guards** | `AuthGuard('jwt')`, `NoImpersonationGuard`, `PolicyGuard`, `@Roles(PLATFORM_ADMIN)`; covered by the route-enumeration spec (D13 item 8, D13.C2). **Per-operator rate limit (D8.4.C6):** keyed on `actor.id`, never on IP or any header. `[UNVERIFIED: value — Anton to set; proposed 5 per hour per operator.]` It is in-process, which holds at `numInstances: 1` (D2.2's caveat applies) |
| **Body** | `{ actorTotp: string, reason: { verificationMethod, ticketRef, note } }`. **`actorTotp` (D8.4.C1, step-up):** the *operator's own* current TOTP code, checked against the actor's `users` row with `authenticator.check` before anything else happens. A valid session is not enough to strip someone's second factor. **`reason` (D8.4.C4)** is structured. `verificationMethod` is an enum. `[UNVERIFIED: the value list — Anton to set; proposed video_call, callback_to_number_on_file, firm_admin_attestation, in_person.]` `ticketRef` is 1–64 chars and `note` is 10–500 chars of free text. **Identity-document numbers are banned from every field** (passport, driving licence, national id, visa grant number). `audit_logs` is append-only, so a number written there can never be erased (cf. D14.C4). The DTO refuses a `note` or `ticketRef` that matches a document-number detector, the way `src/common/card-data-detector.ts` refuses card data. `[UNVERIFIED: that the detector's approach carries over to document numbers; the pattern set is Anton's.]` Swagger and the Control Centre form both state the ban |
| **Refused, before any audit row or god-mode entry** | **Invalid `actorTotp`** → 401, the `disableMfa` precedent. A best-effort `mfa.reset.stepup_failed` row (severity `warning`) is written in the **actor's** tenant. **actor = target** → 403 `MER-AUTH-0008`, because self-reset with a stolen operator session is the attack. **The actor has `mfaEnabled = false`** → 403 `MER-AUTH-0008`. This is read from the actor's row, since the token does not carry it. **The target is a `platform_admin`** → 403 `MER-AUTH-0008`. Operator MFA recovery is the interim procedure below until a sealed two-person design exists (§7, D8.4.C7). **Target `mfaEnabled = false` and not enrolment-required** → 409 `MER-RES-*` "MFA is not enabled for this user", with no intent row: nothing would change |
| **Effect, staff or client target** | (1) Resolve the target under `runAsSystem`, selecting `id, tenantId, roles, mfaEnabled, mfaEnrolmentRequiredAt` only (D8.1's email-mode pattern). (2) `runAsGod(actor.id, <target tenantId>, 'Reset MFA for <userId> (<verificationMethod>, <ticketRef>)')` writes the CRITICAL entry first and rethrows. (3) Inside it, `auditedChange` with **one** step, in the target tenant: **`mfa.reset.requested`**, severity **`critical`** (D8.4.C6), written strictly before the change. Per D15 item 1 it carries **no `beforeState`/`afterState`**: the target goes in `context.requested = { mfaEnabled: false, enrolmentRequired: true, by: 'operator', verificationMethod, ticketRef }`, `note` goes in `context.note`, and `context.changeId` is per call. If the row cannot be written: 503, nothing changes. (4) The change runs as **one transaction**: (a) `UPDATE users SET "mfaEnabled" = false, "mfaSecret" = NULL, "mfaEnrolmentRequiredAt" = now() WHERE id = $1 AND "tenantId" = $2 AND "mfaEnabled" = true`; (b) revoke every session for the user `WHERE "userId" = $1 AND "tenantId" = $2 AND "revokedAt" IS NULL` (D8.4.C5); (c) delete any unused `mfa_enrolment` token for the user, then issue a fresh one (SHA-256-only, single-use, `[UNVERIFIED: TTL — Anton; proposed 24 h]`). **If (a) affects zero rows, the callback throws `ConflictException`. `auditedChange` records that as `context.reason: 'no_row_updated'`, never `write_failed`.** This is the classifier change Owen asked for: `auditedChange` maps **`NotFoundException` and `ConflictException`** from the change callback to `no_row_updated`, and anything else to `write_failed`. Luke makes it in `auditedChange` itself, and a spec asserts a concurrent reset gets 409 and `no_row_updated`. (5) Outcome: **`mfa.reset`** (applied, carrying `beforeState: { mfaEnabled: true }`, `afterState: { mfaEnabled: false, enrolmentRequired: true }` and the same `changeId`), or **`mfa.reset.not_applied`** with its reason. (6) After commit, best-effort: email the enrolment link to `users.email`. **The link is never returned to the operator**, since an operator holding it could enrol their own authenticator on the account. Notify the user (second factor removed by platform support, when, and "if you did not ask for this, contact your firm administrator"). **Notify every active `firm_admin` of the target's tenant (D8.4.C3).** That query runs under god mode and carries `where: { tenantId }`. Record `mfa.reset.notified` with `{ userNotified, firmAdminsNotified, changeId }`; a send failure does not undo the reset |
| **Effect, `firm_admin` target (D8.4.C3): two operators** | The call does not reset. Under `runAsGod`, behind its own strict `mfa.reset.approval.requested` row, it creates a `mfa_reset_requests` row (`status: pending`, `expiresAt` = now + 24 h) and answers **`202 { requestId, status: 'pending_approval' }`**. The target's tenant's other active `firm_admin`s are notified that a reset was requested. A **different** `platform_admin` then calls `POST /platform/mfa-reset-requests/:requestId/approve` with the same guards, rate limit and their **own** `actorTotp`. The approver must not be the requester, must not be the target, and must hold MFA. That call resolves the request's `tenantId` under `runAsSystem` (selecting `id, tenantId` only), then runs steps (2)–(6) above with `context.approvedBy` and `context.requestedBy`. It flips the request with a conditional `UPDATE … WHERE id = $1 AND "tenantId" = $2 AND status = 'pending' AND "expiresAt" > now()` inside the same transaction as (4); zero rows means 409 and `no_row_updated`. **If fewer than two `platform_admin`s hold MFA, `firm_admin` targets cannot be reset by route,** and the interim procedure applies. `[NEEDS DATA: count of MFA-enrolled platform_admin users.]` |
| **Re-enrolment required, not password-only (D8.4.C2)** | While `mfaEnrolmentRequiredAt IS NOT NULL`, `IamService.login` (and therefore the federated path, D6) issues **no session and no `requiresMfa` challenge**: `403 MER-AUTH-0016` ("Your second factor was reset. Use the enrolment link sent to your email"; proposed code). Enrolment happens only through the link, in two `@Public`, rate-limited calls. **`POST /auth/mfa/re-enrol/setup { token }`** validates the token (type `mfa_enrolment`, unused, unexpired, user still enrolment-required), stores a new `mfaSecret` and returns `{ secret, qrCode, otpauthUrl }`. It does not burn the token. **`POST /auth/mfa/re-enrol/verify { token, code, password }`** checks the password and then the TOTP code, then runs `auditedChange` (`mfa.reenrol.requested` → `mfa.reenrolled` / `mfa.reenrol.not_applied`). In one transaction it burns the token (`usedAt IS NULL`) and runs `UPDATE users SET "mfaEnabled" = true, "mfaEnrolmentRequiredAt" = NULL WHERE id AND "tenantId" AND "mfaEnrolmentRequiredAt" IS NOT NULL`; zero rows is `ConflictException` and `no_row_updated`. **The `password` leg is Kyle's addition, so that the email channel alone cannot re-bind a second factor.** `[proposed — Anton to confirm.]` For a linked federated user under `link`/`enforce`, a fresh Neon assertion for the linked subject (D2) replaces the password. Never neither. **Link re-issue:** calling the reset on a target already enrolment-required re-issues the link with the same guards, step-up, rate limit and (for `firm_admin`) approval. Prior unused links are invalidated. It changes no other state and is recorded as `mfa.enrolment_link.requested` / `.issued` / `.not_applied` |
| **Response** | `200 { mfaReset: true, sessionsRevoked: n, enrolmentLinkSent: boolean }`, or `202` for a `firm_admin` target. No secret and no enrolment material, ever |
| **Errors** | 401 step-up invalid; 403 refusals above; 404 user (or request) not found; 409 MFA not enabled, already pending, or a lost race (`no_row_updated`); 429 operator rate limit; 503 audit unavailable |

**Tenancy enforcement at this write:** under god mode RLS filters nothing. So the `users` update,
the session revocation, the token write, the `firm_admin` notification query and the
`mfa_reset_requests` update each carry `"tenantId" = <target tenantId>` explicitly. The spec proves
a same-id user in a second tenant is untouched. Outstanding `mfaPending` challenges die on their
own: `verifyMfaLogin` refuses a user whose `mfaEnabled` is false.

**Session revocation, generally (D8.4.C5).** `IamService.logout` and `IamService.revokeAllSessions`
gain a `tenantId` predicate, not only this route. That is the only predicate that scopes them under
god mode (§1.3). **Revocation lag, stated plainly:** a revoked session stops working within
`JwtStrategy`'s 60-second cache, **per instance**. A stolen device can keep making requests for up
to 60 seconds on each instance that last saw the session as live. At `numInstances: 1` that is 60
seconds in total.

**The old secret (D8.4.C7).** NULLing `mfaSecret` is correct and sufficient. No backup or recovery
codes exist (grep for `backupCode` and `recoveryCode` in `src/`, 2026-11-17, no match), so there is
nothing else to invalidate. A future backup-code feature must be added to step (4).

**Mail dependency, stated as a consequence.** The enrolment link travels only by email. Until mail
reaches a non-owner inbox (workspace `CLAUDE.md` §12, `[NEEDS DATA: Resend domain verification]`),
a reset user stays locked out until the link arrives. That is the correct failure direction for
this operation, and it is why the interim procedure exists.

**Schema:** Migrations D and E (§3). They are built only if the operator accepts D8.4.

**Why not `firm_admin` as the actor.** A firm admin resetting a colleague is the usual SaaS shape.
But a compromised `firm_admin` session could then strip MFA from every staff member in the firm
with no operator in the loop. The identity check this reset depends on is a support process the
operator runs, not one a firm has. A firm-admin variant is the obvious later addition, gated on a
documented firm-side verification step (§7).

**Why two operators and not a 24-hour cool-off, for `firm_admin` targets.** Anton offered either.
A cool-off is only safe if its cancel link reaches the firm, and mail delivery is unproven. It also
needs a scheduler to apply the reset when the cool-off ends, and the fast tick is daily at best
(workspace `CLAUDE.md` §10). Second-operator approval depends on neither. It is also the shape the
sealed `platform_admin` recovery design will need, so it is built once. The cost: with one
MFA-enrolled operator, `firm_admin` resets stay on the interim procedure.

**Interim procedure, until D8.4 ships: pilot only (D8.4.C7, G0.C1).** **Not raw SQL.** A script
(`scripts/mfa-reset-interim.ts`, `[proposed name]`) runs from the operator's machine with the
owner URL (D11-A item 4). It is never run on the web service. The script:
1. Requires **two named people** as arguments, the operator running it and the verifier, plus the
   structured `reason` (with the document-number ban). It refuses if either name is missing.
   **Both must be among the people gate zero names** as having access to the account that owns
   `ep-small-darkness-aeyx0p5j` (D12, G0.C1). The script runs with that account's owner role, so
   it is that access.
2. Writes `mfa.reset.requested` through **`AuditService.logEvent`** (a Nest application context,
   so the hash chain holds), severity `critical`, with `context.interim: true`, both names and a
   `changeId`. If the write fails, the script stops before the `UPDATE`.
3. Runs step (4)(a) and (4)(b) in one transaction, with `tenantId` in both predicates. If
   Migration D has shipped, it sets `mfaEnrolmentRequiredAt`. If not, the user is password-only
   until they re-enrol at next sign-in. **That gap is why this is pilot-only.**
4. Writes `mfa.reset` or `mfa.reset.not_applied` through `AuditService.logEvent`.

For a `platform_admin` target the interim procedure is the **only** path, until a sealed
two-person operator-recovery design exists, and never without Anton present. The runbook (Jonas)
keeps an incident log alongside, but the audit row is now the record.

### D9 — Deferred to ADR 0024, with the reason

**Decision.** This ADR does **not** introduce the `app_builder` role, a verticals registry, or a
partner tier.

**Why.** Each changes something this ADR depends on staying still:
- **`app_builder`** is a new member of `ROLE_PRECEDENCE`. That moves `canGrantRole`,
  `resolvePrimaryRole`, the portals' role switch, and possibly `TENANT_STAFF_ROLES` and therefore
  `scopeOf` — the 24-call-site contract ADR 0012 D3 froze.
- **A verticals registry** replaces the enum `tenants.vertical` is typed with
  (`src/iam/entities/tenant.entity.ts`), one of the four disagreeing vertical enums workspace
  `CLAUDE.md` §5 already warns about.
- **A partner tier** almost certainly means one person acting across tenants, which is the
  `tenant_memberships` gap ADR 0002 §5 and 0012 D6 both bounded out — and it would directly
  contradict D3's **one subject, one `users` row** uniqueness.

Changing the auth mechanism and the role/tenancy vocabulary in one release would make any isolation
regression impossible to attribute. And the shape of all three depends on what the funding
groundwork scopes, which is not yet known. ADR 0024 should open after that groundwork, and **must
revisit D3's unique constraint** if it introduces cross-tenant people. ADR 0016 (partner referral
portal) is the existing partner decision and is not re-decided here. If `0024` is taken when that
ADR is written, use the next free number per `docs/adr/README.md`.

### D10 — SAML returns 501, unconditionally, until rebuilt. There is no flag.

**Corrected 2026-11-17 (Owen, FIX).** The first draft said SAML would return 404 unless
`SAML_ENABLED=true`. **That is not what this branch ships, and it would have been wrong.**

**Decision.** `GET /auth/saml/initiate` and `POST /auth/saml/callback` return **HTTP 501**,
unconditionally — `SamlService.assertSamlAvailable` (`src/iam/services/saml.service.ts`)
throws `NotImplementedException` before either handler does any work. **There is no environment
flag**, by design: the only thing a flag could do is re-enable a verifier Anton has confirmed
unsound (the comment above `assertSamlAvailable` — XML signature wrapping, regex-read `InResponseTo`/`StatusCode`/`Audience`,
locked users issued tokens, sid-less tokens). Spec: `src/iam/saml-disabled.spec.ts`. `render.yaml`
says the same and carries no `SAML_*` variable.

The code is not deleted, so ADR 0002 D5 still holds: nothing is dropped silently — the route
answers, says why, and Swagger documents the 501.

**Why.** A public route that reaches that code is not worth keeping open on a platform being
re-launched, and a flag is a standing invitation to turn it back on during a sales conversation.
Rebuilding it — on `@node-saml/node-saml` with signed assertions, a required Audience, persisted
request state, a user-status check, and tokens issued through `issueSession`, plausibly as
`POST /auth/federated/:provider` per ADR 0002 §5 row 5 — is its own ADR. The `KNOWN_DEFECT_SAML`
exemption in the single-verifier spec stays until then.

### D11 — The Meru web runtime has no path to identity credential material

D11 has two forms. **Which one applies is decided by D12; exactly one is implemented.** Under both,
Meru **never reads Neon Auth's data**: the Neon JWT is the only channel between the two; there is
no join from `users` to `neon_auth.*`, no sync job, no trigger, and migrations never create, alter
or grant on `neon_auth` — it is vendor-managed.

#### D11-A — Outcome A: auth on the live control-plane project. `meru_app` holds no privilege on `neon_auth`, proven at boot (Anton, condition 2)

**Decision.**
1. **The check covers every privilege path, not just schema and tables.** It fails if `meru_app`,
   directly or via `PUBLIC` or any role it is a member of, holds any of:
   - `USAGE` or `CREATE` on schema `neon_auth` (`has_schema_privilege`);
   - any privilege on any table or view in `neon_auth` (`has_table_privilege` over `pg_class`);
   - any privilege on any sequence in `neon_auth` (`has_sequence_privilege`);
   - `EXECUTE` on any function or procedure in `neon_auth` (`has_function_privilege` over
     `pg_proc`) — **`EXECUTE` is granted to `PUBLIC` by default on every new function**, so this is
     the line most likely to fail on day one; see below;
   - any `pg_default_acl` entry for schema `neon_auth` (or global, `defaclnamespace = 0`) that would
     grant `meru_app` or `PUBLIC` anything on objects created later.
2. **Where it actually runs as a release gate.** `rls:verify` cannot run locally and is a separate
   command a deploy can skip (§1.3). So the check runs **in the service itself, at boot, as the
   runtime role** — a sibling of `assertRlsEnforceable()` in `src/core/tenancy/rls.datasource.ts`,
   querying with `current_user` on the `DATABASE_APP_URL` connection. Under `NODE_ENV=production`
   a failure **refuses to boot**; Render's health check then never passes and the deploy is
   cancelled (`render.yaml` header). It is the only placement that runs on every deploy, against the
   real database, with the real role, and needs no extra credential. `scripts/verify-tenant-isolation.js`
   carries the same query for when `rls:verify` can run, so the two cannot drift: one shared SQL
   string, imported by both. If the schema does not exist, the check passes with the explicit log
   line "neon_auth absent — assertion vacuous", so a run against a database without Neon Auth does
   not read as proof.
3. **The day-one `EXECUTE` failure is resolved by a reviewed exception, not by surgery on a vendor
   schema.** If Neon leaves `PUBLIC` `EXECUTE` on its `neon_auth` functions (likely; Postgres
   default), the boot check fails. Two exits, Anton chooses: (a) a one-off owner-run
   `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA neon_auth FROM PUBLIC`, **not** a migration, only
   after Neon confirms Neon Auth does not rely on `PUBLIC` execute `[UNVERIFIED]`; or (b) an explicit
   allowlist in the check, by full function signature, never a wildcard, accepted on the reasoning
   that without schema `USAGE` the function cannot be named — and **any `SECURITY DEFINER`
   function in the list is refused regardless**, because that is where a bypass would live.
4. **`DATABASE_URL` stays out of the web service.** `neondb_owner` holds `BYPASSRLS` (workspace
   `CLAUDE.md` §8) and under Outcome A can read every row of `neon_auth`. It is therefore **not** in
   the `meru-secrets` env group the web service and crons read (`render.yaml`), and migrations run
   by hand from the operator's machine (`docs/runbooks/render-deploy.md` §3 already recommends
   this; under A it is a requirement, not a choice). Consequence: `POST /jobs/migrate/control`
   answers its existing "no owner URL" failure on the web service. The boot check in item 2 also
   logs a warning naming `DATABASE_URL` if it is set in production `[proposed — Anton may make it
   refuse to boot]`.
5. **`MigrateService`'s empty-database bootstrap must ignore `neon_auth`.** On a fresh project with
   Neon Auth enabled, `neon_auth` exists while `public` is empty — exactly the bootstrap case. The
   three queries that inspect the database are already public-scoped (§1.3). `synchronize()` is not
   proven to leave other schemas untouched `[UNVERIFIED: TypeORM 0.3 synchronize touches only entity
   schemas]`. A spec asserts the bootstrap issues no statement naming `neon_auth`, and the bootstrap
   refuses to run if any entity declares a non-`public` schema.
6. **Never branch production for previews.** A branch of the production branch carries a copy of
   `neon_auth` `[UNVERIFIED: whether neon_auth data is copied on branch — assume it is]` — real
   people's credential material in a preview environment. Previews get a branch of a non-production
   branch with its own Neon Auth, or run `AUTH_NEON_MODE=off` (§5 row 4).

**Why.** `neon_auth` tables have no `"tenantId"` and no Meru RLS policy; they hold every user's
credential material across every tenant. `meru_app` never needs it, so the correct privilege is
none, and the place to prove it is the one place guaranteed to run.

#### D11-B — Outcome B: auth on a separate project. The Meru runtime holds no credential for the auth project (Anton, condition 3)

**Decision.** D11-A's privilege check is **vacuous** under B — `meru_app` does not exist in the auth
project — and is replaced by: **no process Meru runs holds any credential for the auth project.**
1. **Precondition, before anything else:** remove `GOVX_DB_URL` and `GOVX_DB_APP_URL` from every
   environment, and **rotate `cool-rice-41190255`'s owner password.** Today `GOVX_DB_URL` (owner
   role) names `cool-rice` and `MigrateService` runs DDL there (`migrate.service.ts:33`,
   `POST /jobs/migrate/govx`), and `configuration.ts:166` reads both. The vertical datasource split
   has no callers (workspace `CLAUDE.md` §8), so nothing reads the database through them in normal
   operation; removing them breaks only `POST /jobs/migrate/govx`, which should break. The code
   change (dropping the `govx` target, or making it refuse) is Luke's; the variable removal and the
   rotation are the operator's, with Jonas.
2. **Do not host auth on `cool-rice-41190255` as it stands.** It holds pre-cutover tenant data in
   `neondb`, `govx` and `immistack`. Putting the identity store beside a stale copy of customer
   records means one credential compromise yields both. **Use a fresh project used for nothing but
   Neon Auth.** `cool-rice` is then decommissioned on its own schedule, after confirming nothing in
   it is the only copy `[NEEDS DATA: whether cool-rice holds any data absent from the live control
   plane]`.
3. **Boot assertion.** Under `NODE_ENV=production`, the service refuses to boot if any database
   URL it reads (`DATABASE_URL`, `DATABASE_APP_URL`, `*_DB_URL`, `*_DB_APP_URL`) has a host whose
   Neon endpoint id equals the endpoint id in `NEON_AUTH_ISSUER`'s host. `[UNVERIFIED: that the
   Neon Auth URL host carries the endpoint id, per §1.2's example — if it does not, this assertion
   compares against an explicitly configured NEON_AUTH_PROJECT_ENDPOINT instead.]`
4. **No Neon API key on the web process.** A project-scoped key `[UNVERIFIED: that Neon offers
   project-scoped API keys]` for the auth-only project may live in a **separate, non-web job**
   (open question 1) — acceptable under B because that project holds no Meru data.
5. **`iss`, `aud` and JWKS** are the auth project's, configured per environment (D2).
6. **Identity-data residency.** Identities (email, name, credential material) will live in the auth
   project's region; Meru records are in `us-east-2`; the immigration pack declares
   `dataResidency: "AU"`. Disclosure of personal information to an overseas recipient engages APP 8.
   `[NEEDS DATA: legal basis for holding ImmiStack users' identity data — and, already today,
   their records — outside Australia (APP 8 / s 16C), and therefore which region the auth project
   is created in.]` This is not a reason to prefer A: under A, identities sit in `us-east-2` beside
   the records, which is the same question.

**Why.** Separation is only worth something if it is real. The current environment already
contradicts it — an owner credential for `cool-rice` is live config — so the invariant has to be
"no credential", stated so a boot check can prove it.

### D12 — Which Neon project hosts auth is an open operator decision; gate zero applies to both outcomes

**Decision.** This ADR does not choose the project. It defines the two outcomes and what each
requires, and it blocks all implementation on one fact that matters under both.

**Gate zero (Anton, condition 1).** **No code from this ADR is written until the Neon account that
owns `ep-small-darkness-aeyx0p5j`, and every person with access to it, is named** — in
`docs/runbooks/render-deploy.md` §5 or `meru-core/AGENTS.md` §5, by Jonas with the operator. That
account holds every tenant's records and, under Outcome A, would hold every user's credential
material. A production database whose owning account nobody in the room can identify is the larger
finding; this ADR will not add identity data to it, or federate against it, until it is resolved.

*Scope of the gate, clarified 2026-11-17 (Kyle); **confirmed by Anton 2026-11-17**.*
The gate blocks D1–D7, D8.1–D8.3, D11, D12 and §3 migrations A–C, meaning everything that adds
identity data or a Neon dependency. It does not block D13, D14, D15 or D8.4 (with D8.4's
migrations D and E). Those touch no Neon-facing code and only tighten the existing audit and IAM
paths, and D13 is itself a precondition for leaving `off`. **One condition (G0.C1):** D8.4's
interim procedure runs with the owner role of the unnamed account, so **whoever runs it must be
among the people gate zero names**. Until gate zero is met, nobody runs the interim script, and a
locked-out user waits.

| | **Outcome A** — Neon Auth on the live control-plane project | **Outcome B** — Neon Auth on a fresh, auth-only project |
|---|---|---|
| Where identities live | `neon_auth` schema in the same database as the 68 FORCE-RLS tables | A project holding nothing else |
| D11 form | D11-A: privilege check at boot, `DATABASE_URL` out of the web service, bootstrap ignores `neon_auth`, never branch production for previews | D11-B: no credential for the auth project in any Meru process; `GOVX_DB_*` removed and `cool-rice` owner rotated first |
| Who can read credential material | Anyone holding `neondb_owner` for the live project (migrations), plus the Neon account | Only the auth project's Neon account |
| Neon API key for provisioning | **Not on the web process.** Console-created identities, or open sign-up with D3 + rule 1a carrying isolation | A project-scoped key in a separate non-web job is acceptable |
| Residency | identities `us-east-2`, same as records | identities in whatever region is created; `[NEEDS DATA]` per D11-B item 6 |
| Extra operational surface | none | a second project, its own config, its own account access to keep straight |
| Requires gate zero | yes | yes |

**My recommendation is in §12.** The operator decides; §8 item 2 records it as open.

### D13 — The operator behind an impersonation token is recorded on every audit entry, by the tenancy context, at the one write path (Anton, condition 8)

**Decision.** `impersonatedBy` is carried in the per-request `TenantStore`, set by
`TenantBindingInterceptor` from `request.user`, and `AuditService.logEvent`, the single path every
audit writer goes through, stamps it into `context.impersonatedBy` on every entry written inside
that request. It is not threaded per writer. **Decided by Kyle. Anton reviewed the contract on
2026-11-17: APPROVE WITH CONDITIONS (D13.C1–C7, applied below). He reviews the code again before
it merges, because it changes the audit write path for every module.**

**Why here and not per writer.** Owen named three writers (`documents.service.ts`,
`tenant-provisioning.service.ts`, `config-pack.service.ts`). The real set is every caller of
`AuditService.logEvent` outside IAM: eight writers in seven service files, plus `runAsGod`, today
(§1.3). It grows with every feature. Threading the claim through each service signature, as IAM
does now, is correct per call site and wrong as a mechanism: the next writer forgets, nothing
fails, and the log says the customer did what an operator did. Luke's assessment is the right one:
small but cross-cutting. Hitting a choke point once beats patching call sites forever.

**Preconditions. Both land with or before D13, because without them D13 would faithfully record a
laundered or misleading name:**
- **D13.C1 [HIGH] — nested impersonation (§1.3).** (a) `POST /tenants/:id/impersonate` carries
  `NoImpersonationGuard` after `AuthGuard('jwt')`. (b) It refuses `id === req.user.tenantId`: an
  operator does not impersonate inside their own tenant. (c) `IamService.issueImpersonationToken`
  **never selects a target holding `platform_admin`**. The query excludes them, and a tenant whose
  only active users are operators answers 400 "no active user that may be impersonated". The
  exclusion is applied in code over pages of the tenant's active users (`roles` is a
  `simple-array` column), not in SQL. Each part has a spec. **In the tree on branch
  `wave0/back-online`, not deployed (2026-11-17); Anton's code review outstanding.**
- **D13.C7 — sign-off under impersonation.** A `requiresSignOff` workflow transition refuses a
  caller carrying `impersonatedBy` with 403 `MER-AUTH-0008`. The check is in `WorkflowEngineService` at
  the sign-off gate, not the controller. An operator must not be able to sign off advice or
  lodgement under a practitioner's credential. Once D13 lands, the gate reads impersonation from
  the store (item 1); until then, from `TransitionRequest.impersonatedBy`, which the controller
  threads in. Spec required. **In the tree on branch `wave0/back-online`, not deployed
  (2026-11-17); Anton's code review outstanding.**

**The contract.**
1. **`TenantStore` gains `impersonatedBy?: { operatorId: string; operatorTenantId: string }`**,
   the same type as `UserPayload.impersonatedBy` (`src/common/types.ts`).
2. **Writers of that field, and only these (D13.C3).** In a request,
   `TenantBindingInterceptor`, in the same step that binds `tenantId`, copies
   `request.user.impersonatedBy` and nothing else. That value is set by `JwtStrategy.validate` from
   the signed `imp` claim only. In a queued job, the queue processor's restore step (item 5). No
   header, body, query parameter or service may set it. If the ALS store is missing, the
   interceptor already refuses the request, and that refusal covers this field too. **A spec fails
   the build if anything else assigns `impersonatedBy` on a `TenantStore`.** It is grep-based, in
   the `one-jwt-verifier.spec.ts` style. *Anton's condition names the interceptor alone. The
   queue-restore site is added because D13.C6 requires a restore. It is the second and last
   allowlisted writer, and Anton confirms that reading of C3 on the code.*
3. **`AuditService.logEvent` treats `context.impersonatedBy` as a reserved key (D13.C4).**
   `logEvent` builds a **new** `context` object (a shallow copy) and never mutates the object the
   caller passed. When `TenantContext.get()?.impersonatedBy` is set, it writes that value into the
   copy's `context.impersonatedBy`, **overwriting** whatever the caller passed under that key. When
   the store has none, it **omits** any caller-supplied `context.impersonatedBy` from the copy.
   **Top-level `context.impersonatedBy` is the only place that counts.** A key of that name
   anywhere else (`context.requested.impersonatedBy`, `afterState.impersonatedBy`) carries no
   attribution meaning, and no reader, report or reconciler may treat it as one. Only the signed
   claim can put an operator's name on a row, and no writer can launder one in or out.
4. **It survives nesting.** `TenantContext.runAsSystem` and `runAsGod` build their store as
   `{ ...parent, bypass }`, so the field carries into system and god contexts opened inside the
   request. That includes `TenancyService.runAsGod`'s own CRITICAL entry. This is wanted and is
   asserted by a spec.
5. **Queued work carries it (D13.C6). Replaces "not reached, accepted".**
   `QueueService.createJob` (a) **strips** any caller-supplied `impersonatedBy` from `data`, and
   (b) when `TenantContext.get()?.impersonatedBy` is set, writes it into the job's `data` under the
   reserved key `impersonatedBy`, beside the `tenantId` and `userId` it already stamps. When the
   processor runs the job, it restores that value into the worker's `TenantStore` in the same step
   that binds the job's tenant. Handlers never read it from the payload. `[UNVERIFIED: where
   queue.processor.ts binds a job's tenant today. That file changed on this branch (the scheduler
   change), so re-read it at implementation.]` Job handlers are stubs today, which is exactly why this would be
   forgotten. The spec enqueues inside an impersonated store and asserts the row carries it, a
   caller-supplied value is stripped, and a stub handler's audit write carries it. Work with no
   enqueuing request (the daily tick, `processScheduledJobs`) has no user and is audited as the
   job.
6. **IAM's explicit threading becomes redundant, not wrong.** `IamService.toAuditEvent` and the
   `impersonatedBy` parameters on `inviteUser`, `resendInvite` and `updateUser` produce the same
   value that item 3 now stamps. Removing them is a cleanup Luke may do in a separate commit after
   D13's specs are green. It is not part of meeting the condition.
7. **Integrity (D13.C5).** **`impersonatedBy` enters the row checksum when present.**
   `generateChecksum`'s input object gains `impersonatedBy` **only when the stamped value is set**,
   so every existing row, and every row without impersonation, hashes exactly as before.
   `verifyLogIntegrity` recomputes the same way. The chain hash already includes the checksum, so
   the chain covers it transitively. **Stated plainly: neither the checksum nor the chain is
   keyed** (plain SHA-256 over stored values, §1.3). Anyone who can write `audit_logs` can
   recompute both. They catch corruption and careless edits, not a deliberate rewrite. **The real
   controls are the append-only (WORM) triggers and an external anchor.** The anchor is not built:
   meru-core `CLAUDE.md` §5.4 names S3 Object Lock export as the path. A separate
   `impersonatedBy` column is **not needed**; the checksum covers the field without a migration on
   a WORM table.
8. **The route-enumeration spec keeps new routes honest. The `IamController` and `OperatorController` parts are done.**
   `src/iam/impersonation-refusal.spec.ts` enumerates every JWT-guarded `IamController` handler
   from the prototype against an explicit allowlist (`IMPERSONATION_ALLOWED`), fails on a stale
   allowlist entry, and cannot pass vacuously (in the tree, 2026-11-17).
   `src/iam/operator-impersonation-guard.spec.ts` does the same for `OperatorController` (in the
   tree, 2026-11-17). **D13.C2 widens it:** it
   must also cover `OperatorController` and **every handler whose `@Roles` admits only
   `PLATFORM_ADMIN`**, on any controller. Twenty-five controller files name `PLATFORM_ADMIN` in a
   `@Roles` decorator, counting decorators that span lines (grep 2026-11-17). The spec discovers them from route and roles metadata, not
   from a hand-kept list. Handlers that admit tenant roles **alongside** `platform_admin` are not
   required to refuse, because acting as the firm is what impersonation is for. The spec lists them,
   so a reviewer can see which exist. D3.2's unlink, D8.1, D8.2, D8.4 and the D8.4 approve route
   carry the guard and must appear in the enumeration in the same change that adds them.
   `POST /auth/federated/neon` and the D8.4 re-enrol routes are `@Public` and take no Meru bearer,
   so they are listed on the allowlist with that reason and are not guarded.
9. **Specs, each required:** (a) the interceptor copies `impersonatedBy` from `request.user` and
   ignores an `impersonatedBy`/`imp` supplied in a header or body; (b) `logEvent` inside a store
   carrying it writes it, and outside one writes none; a caller-supplied value is overwritten in the
   first case and omitted in the second; (c) one **non-IAM** writer end to end, through
   `DocumentsService`'s `logUpdate` call, inside an impersonated store, carries it; (d) the
   `runAsGod` CRITICAL entry carries it when opened inside an impersonated request; (e) the
   sole-writer spec (C3); (f) the caller's `context` object is unchanged after `logEvent` (C4);
   (g) `verifyLogIntegrity` passes for rows with and without the field, and fails when a stored
   `context.impersonatedBy` is altered (C5); (h) the queue capture, strip and restore (C6); (i) the
   C1 refusals; (j) the C7 refusal.

**Tenancy.** Unchanged. The field rides beside `tenantId` in the same store, and does not
influence binding, RLS or `bypass`.

### D14 — Invites grant a role, so the grant moves to the strict audit path (Owen, final gate)

**Decision.** `IamService.inviteUser` goes through `auditedChange` (D15). A strict
**`invite.issue.requested`** row comes before the `users` row is inserted. **`INVITE_ISSUED` is
written only after the insert succeeds**, and **`invite.issue.not_applied`** is written if it does
not. If the request row cannot be written, nobody is invited and the response is 503. **Decided by
Kyle. Anton reviewed on 2026-11-17: APPROVE WITH CONDITIONS (D14.C1–C4).**

*Corrected 2026-11-17 (Owen, FIX).* The second amendment wrote `INVITE_ISSUED`, a fact-named
action, **before** the save, with `afterState`. That reintroduced the defect just removed from
MFA, role and status changes: a compliance query on `INVITE_ISSUED` would return grants that never
happened.

**Why.** An invite is a privilege grant. It creates a user holding a role, up to `firm_admin`, and
mints the bearer credential that activates it. `updateUser` already refuses to change a role
without a strict entry, so today `firm_admin` is the one role that can be handed out with a
swallowed audit write, provided it is handed out by invitation. The inconsistency runs the wrong
way: a grant needs at least the audit discipline of a change. D8.2 makes this sharper, because the
operator invite reuses `inviteUser` and writes into another firm's tenant.

**The shape.**
1. **Checks first, then the request row (D14.C2).** The role ceiling (`canGrantRole`), the
   practitioner-credential pair check, the per-actor rate limit (C3) and the global-uniqueness
   lookup all run **before** `invite.issue.requested` is written. A 503 from the audit store
   therefore reveals nothing a 409 or 403 would not, and adds no oracle.
2. **Request row, strict:** `invite.issue.requested`, severity `info`, on `AuditAction.UPDATE` as
   `auditedChange` writes it. Per D15 it has **no `beforeState`/`afterState`**. The target goes in
   `context.requested = { email, role, status: 'invited' }`, with a per-call `context.changeId`.
   `entityId` is the id the service assigns (item 3).
3. **The change, one transaction (D14.C1):** `userRepo.insert()`, **not `save()`**, with the id
   assigned explicitly (`crypto.randomUUID()`), then issue the `invite` token. In TypeORM 0.3.31
   (installed), `InsertQueryBuilder.getInsertedColumns` omits only auto-increment columns, and a
   `uuid`-strategy primary is generated only when no value was provided. So the explicit id is the
   id persisted. That was read from the installed source on 2026-11-17, and Anton read it the same
   way. `save()` is rejected because, with the primary key set, it first looks the row up and can
   turn into an update. **Luke's spec is still required**: it asserts the persisted `users.id` equals
   the audited `entityId`. A concurrent invite of the same email loses on the unique index
   (`23505`). The callback maps that to `ConflictException` with the single C3 message, which D15
   records as `no_row_updated`.
4. **Outcome:** `INVITE_ISSUED` (applied; `afterState: { email, role, status: 'invited' }`, same
   `changeId`), written as soon as the change commits, **before** the mail is attempted. Or
   `invite.issue.not_applied` with its reason.
5. **Delivery is a separate best-effort row.** `inviteSent` is known only after the send, and a
   mail-provider stall must not delay the record of the grant. So `invite.delivery`
   (`context: { inviteSent, changeId }`) is written after the attempt. Putting the mail inside the
   change was rejected, because a mail failure would then record `not_applied` for a user who
   exists.
6. **`resendInvite` follows the same rule**, because it mints a fresh bearer credential and returns
   it as `inviteUrl`: `invite.resend.requested` → `INVITE_RESENT` / `invite.resend.not_applied`,
   then `invite.delivery`. The C3 rate limit applies to it. **Token redemption (`TOKEN_REDEEMED`)
   and session revocation stay best-effort.** They are the account holder acting on their own
   account, already authorised by possession, and this ADR does not re-decide them.

**D14.C3 — pre-existing enumeration, fixed in the same change.** `inviteUser` answers two different
409 messages today, "already exists in this tenant" and "already registered on the platform". That
lets a `firm_admin` test whether an address belongs to **another** tenant. The fix: **one message
for both** (`[wording — Luke's]`), and **a per-actor invite rate limit** keyed on `actor.id`
covering `inviteUser`, `resendInvite` and D8.2. `[UNVERIFIED: value — Anton to set; proposed 20
per hour per actor.]` What remains, accepted: a 409 still says the address is registered
*somewhere*. That is unavoidable while `users.email` is globally unique, and the rate limit bounds
the probe.

**D14.C4 — retention.** Invite request rows, like every invite audit row (`description`,
`context.requested`, `afterState`), keep the invitee's email **permanently** in an append-only
table. That includes invitees who never accept and invites that were never applied. It cannot be
erased in place. **This is recorded for the retention/erasure register:** data = invitee email,
role and inviter; store = `audit_logs`; basis = audit of a privilege grant; retention = the life of
the audit log; erasure = not possible in place (WORM). `[NEEDS DATA: no retention/erasure register
exists in either repo (grep 2026-11-17). Owner and location to be named before the first customer
erasure request.]` Whether request and `not_applied` rows should carry `emailSha256` instead (D8.1's
miss precedent) is open, §8 item 25.

**Cost, accepted:** with the audit table unavailable, nobody can be invited. That is the correct
direction to fail for a privilege grant, and it is the same cost role changes already carry.

### D15 — The strict-change audit shape: request → change → outcome, a reconciler, and a chain that cannot fork

**Decision.** Every security-posture change in IAM (MFA enable, MFA disable, role, status, invite
issue, invite resend, and D8.4's reset, re-enrolment and link re-issue) is recorded through
`IamService.auditedChange` in the shape below. **The best-effort outcome row is not the end state
(Anton: REJECT as an end state).** A reconciler closes every request that was left without an
outcome. **Decided by Kyle on Anton's conditions AC.C1–C3 and Owen's FIX.**

1. **Three row kinds, one `changeId` (AC.C1).** Every row from one call carries the same
   `context.changeId` (a fresh UUID per call):
   - **`<x>.requested`**: strict, written before the change; on failure the response is 503 and
     nothing changes. Worded as a request. **No `beforeState`/`afterState`.** `logEvent` derives
     `changes` from those two fields, so a request row carrying them reads as a change in any
     query over `changes`. The target goes in **`context.requested`**.
   - **applied** (`mfa.enabled`, `role.changed`/`ROLE_CHANGED`, `INVITE_ISSUED`, …): best-effort,
     written after the change. **The only row that states a fact**, and the only one that may carry
     `beforeState`/`afterState`.
   - **`<x>.not_applied`**: best-effort, **no `beforeState`/`afterState`**, `context.requested` as
     on the request row, `context.reason` ∈ **`audit_unavailable`** (a later step's request row
     could not be written, so earlier ones are answered), **`no_row_updated`** (the change matched
     nothing) or **`write_failed`** (anything else).
   - **Classifier:** `NotFoundException` **and `ConflictException`** thrown by the change callback
     are `no_row_updated`; anything else is `write_failed` (D8.4, D14 item 3).
   *State on 2026-11-17:* the request/`not_applied` reshape (no before/after, `context.requested`)
   and the per-call `changeId` are **in the tree** on branch `wave0/back-online`, not deployed
   (`IamService.auditedChange`, `src/iam/iam-audited-change.spec.ts`). The `ConflictException`
   classifier is **outstanding**: `auditedChange` still maps only `NotFoundException` to
   `no_row_updated` (§10 1b).
2. **The reconciler (AC.C2). Required before any customer relies on the trail.** A job on the
   daily tick (`audit-reconcile`, `[proposed name]`) finds `*.requested` rows older than **N
   minutes** (`[UNVERIFIED: N — Anton to set; proposed 15]`) with no row sharing their `changeId`.
   For each, it writes **`<x>.reconciled`** with the same `changeId` and `context.outcome`:
   - **`applied`**: the entity's current state equals `context.requested`, and no later request
     exists for the same entity;
   - **`not_applied`**: the current state differs, and no later request exists;
   - **`indeterminate`**: **a later request exists for the same entity**, the entity is gone, or
     the event family has no state reader (token-issuing events, whose outcome cannot be read back
     from a SHA-256-only row, are always `indeterminate`).

   It **never assumes `applied`.** Every reconciled row raises an alert.
   `[UNVERIFIED: the alert channel — an AlertRuleService firing or a log-based alert; Jonas.]`
   **Tenancy:** the job reads across tenants under `runAsSystem`, so every read and write carries
   `"tenantId"` explicitly. The reconciled row lands in the request row's tenant. A spec seeds two
   tenants and proves neither tenant's rows are reconciled against the other's state.
3. **The chain cannot fork (AC.C3, pre-existing, affects every writer).** `logEvent` runs
   `getLastChainHash` and the insert inside **one transaction**, holding
   **`pg_advisory_xact_lock`** on a per-tenant key (`[key derivation — Luke's; a 64-bit hash of
   'audit_chain:' + tenantId]`), so two writes in one tenant serialise on the tip. `[UNVERIFIED:
   that a transaction opened inside logEvent carries the tenant binding applyRlsToDataSource sets.
   Luke proves it against the existing RLS specs.]` Cost: audit writes serialise per tenant, which
   is acceptable at current volume. Forks already in the data stay. `[UNVERIFIED: a fork observed in
   production. Jonas can find out by running verifyChain per tenant.]` **Land this before or with
   D13.C5**, which changes the checksum input on the same path.
4. **Still not one transaction with the change.** `logEvent` uses its own repository and accepts no
   caller `EntityManager`. The reconciler is the answer to "the process died between the change and
   the outcome row", not a widened transaction across every module that audits.
5. **Ruling: `verifyMfaSetup` takes `tenantId` and filters on it (Owen asked for a decision; Luke
   left it as is).** Today it loads the user by `findOne({ where: { id } })` and changes it with
   `userRepo.save(user)`. Tenant scope comes from RLS alone, with no `"tenantId"` predicate and no
   condition on the current state (re-read 2026-11-17). **Decision:** the controller passes
   `req.user.tenantId`; the lookup is `{ id, tenantId }`; a user whose `mfaEnabled` is already
   true is refused with 400 "MFA is already enabled" **before** the request row (nothing would
   change); and the change is the conditional
   `update({ id, tenantId, mfaEnabled: false }, { mfaEnabled: true })`. Zero rows is
   `NotFoundException`, recorded as `no_row_updated`. **Why:** every other method this ADR touches
   (`disableMfa`, D8.4, D3.2) carries the predicate. RLS is the last line, not the first (meru-core
   `CLAUDE.md` §5.1). Under any future `runAsSystem`/`runAsGod` caller, RLS filters nothing. And the
   conditional update makes a double-submit a recorded `no_row_updated` rather than a second
   "enabled" fact. `setupMfa` writes `mfaSecret` with the same `{ id }`-only lookup and gets the same
   predicate in the same change. It writes no audit row: a pending secret changes no posture until
   `verifyMfaSetup` applies it.

---

## 3. Schema and migration

Migrations A–C (federation) and D–E (D8.4 only, if accepted), all registered in `ALL_MIGRATIONS` (`src/config/migrations.ts`) in the **same
commit** as the files — "migration on disk, missing from `ALL_MIGRATIONS`" has been a production
bug four times. `User` is already in `ALL_ENTITIES` (`src/config/entities.ts`); the new columns are
added to that entity. Migration C adds a new entity, which **must** be registered in
`ALL_ENTITIES` and its migration added to `MigrateService`'s `rlsMigrations` list
(`src/jobs/migrate.service.ts`, the list `job_runs` and `tenant_signup_invites` were once missing
from). Take the next free timestamps **at implementation time** — other passes are writing
migrations in this tree. All of them land on the **control plane**, under either D12 outcome.

**Migration A — `AddUserAuthSubject` (fully reversible)**
```sql
-- up
ALTER TABLE "users" ADD COLUMN "authSubject" varchar(255) NULL;
ALTER TABLE "users" ADD COLUMN "authSubjectFlaggedAt" timestamptz NULL;
CREATE UNIQUE INDEX "UQ_users_authSubject" ON "users" ("authSubject")
  WHERE "authSubject" IS NOT NULL;
-- down
DROP INDEX IF EXISTS "UQ_users_authSubject";
ALTER TABLE "users" DROP COLUMN IF EXISTS "authSubjectFlaggedAt";
ALTER TABLE "users" DROP COLUMN IF EXISTS "authSubject";
```
Additive, nullable, no backfill, no default — every existing row reads NULL, which means "not
linked, not flagged", which is true. `users` already carries ENABLE + FORCE RLS; new columns inherit
it. No grant change: `meru_app` already has table-level DML on `users`.

**Migration B — `AddFederationLinkTokenType` (forward-only enum value)**
```sql
-- up
ALTER TYPE "auth_tokens_type_enum" ADD VALUE IF NOT EXISTS 'federation_link';
-- down
DELETE FROM "auth_tokens" WHERE "type" = 'federation_link';
-- the enum value is left in place: Postgres cannot drop an enum value without recreating
-- the type and rewriting auth_tokens, which is a worse risk than an unused label.
```
Separate from A so that A's rollback is clean. `MigrateService` runs with
`migrationsTransactionMode: 'each'` precisely because `ADD VALUE` and a later use must not share a
transaction. `[UNVERIFIED: the Postgres major version on the live control plane — ADD VALUE inside
a transaction needs ≥ 12.]`

**Migration C — `AddFederatedAssertionReplay` (fully reversible; D2.1)**
```sql
-- up
CREATE TABLE "federated_assertion_replay" (
  "tokenHash" char(64) PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL
);
CREATE INDEX "IDX_federated_assertion_replay_expiresAt"
  ON "federated_assertion_replay" ("expiresAt");
ALTER TABLE "federated_assertion_replay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "federated_assertion_replay" FORCE ROW LEVEL SECURITY;
-- bypass-only policies, copied in shape from AddJobRuns1755100000000 (platform_global_read /
-- platform_global_write): a pre-tenant table no tenant may read; written under runAsSystem.
-- down
DROP TABLE IF EXISTS "federated_assertion_replay";
```
No `tenantId` by design — the assertion is checked before any user, and so any tenant, is known.
That is why it needs the explicit `rlsMigrations` entry: the dynamic `tenantId` loop cannot see it.

**Migrations D and E: D8.4 only, built only if the operator accepts D8.4. Not blocked by gate zero.**

**Migration D — `AddMfaResetState` (reversible, with a precondition on `down`)**
```sql
-- up
ALTER TABLE "users" ADD COLUMN "mfaEnrolmentRequiredAt" timestamptz NULL;
CREATE TABLE "mfa_reset_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId" uuid NOT NULL REFERENCES "tenants"("id"),
  "targetUserId" uuid NOT NULL,
  "requestedBy" uuid NOT NULL,
  "approvedBy" uuid NULL,
  "reason" jsonb NOT NULL,              -- { verificationMethod, ticketRef, note }; no document numbers (D8.4.C4)
  "status" varchar(16) NOT NULL CHECK ("status" IN ('pending','applied','expired','refused')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "decidedAt" timestamptz NULL,
  CHECK ("approvedBy" IS NULL OR "approvedBy" <> "requestedBy")
);
CREATE INDEX "IDX_mfa_reset_requests_tenant_status" ON "mfa_reset_requests" ("tenantId", "status");
ALTER TABLE "mfa_reset_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_reset_requests" FORCE ROW LEVEL SECURITY;
-- tenant policy (USING and WITH CHECK on "tenantId"), copied in shape from the most recent
-- tenant-table migration [UNVERIFIED: the exact policy helper name at implementation time]
-- down  (PRECONDITION below)
DROP TABLE IF EXISTS "mfa_reset_requests";
ALTER TABLE "users" DROP COLUMN IF EXISTS "mfaEnrolmentRequiredAt";
```
`gen_random_uuid()` needs `pgcrypto` or Postgres ≥ 13 `[UNVERIFIED: Postgres major, §8 item 14]`;
otherwise the service assigns the id. Additive and nullable: existing rows read NULL, meaning "not
enrolment-required", which is true. The entity is registered in `ALL_ENTITIES`, the migration in
`ALL_MIGRATIONS`. The table has a `tenantId`, so it gets its policy in its own migration, the way
every tenant table after `AddTenantRowLevelSecurity` does.
**`down` precondition:** dropping the column turns every enrolment-required user (`mfaEnabled =
false`) into a **password-only** account that `login` will admit. Before `down`, export
`SELECT id, "tenantId" FROM users WHERE "mfaEnrolmentRequiredAt" IS NOT NULL` and **set each to
`status = 'locked'`** through `updateUser` (audited). Also export `mfa_reset_requests`.

**Migration E — `AddMfaEnrolmentTokenType` (forward-only enum value)**
```sql
-- up
ALTER TYPE "auth_tokens_type_enum" ADD VALUE IF NOT EXISTS 'mfa_enrolment';
-- down
DELETE FROM "auth_tokens" WHERE "type" = 'mfa_enrolment';
-- the enum value stays, as in Migration B
```
`resetPassword` must refuse `mfa_enrolment` tokens, as D3 rule 3 requires for `federation_link`.
That has a spec, and it lands with this migration.

**Ordering on Render.** `render.yaml` sets `autoDeployTrigger: "off"`; deploys are manual. Apply all
migrations **before** deploying code that reads them (A–C before step 2's code; D–E before D8.4's) — the 2026-09-07 `subjectEmail` incident
(workspace `CLAUDE.md` §9) was exactly "code live before its column". With `AUTH_NEON_MODE=off` the
columns and table are inert, so migrating first is safe. Under Outcome A, migrations run from the
operator's machine (D11-A item 4).

---

## 4. Options considered

| Option | Verdict | Why |
|---|---|---|
| **Federation** — Neon authenticates, Meru issues the session and owns tenant/role (this ADR) | **Chosen** | Keeps the RLS binding, `scopeOf`'s inputs, revocation, impersonation and MFA exactly where they are. The only new trust is "this Neon subject, with a verified email, is the person who redeemed that Meru token" |
| **Full replacement** — Neon/Better Auth issues the session; Meru verifies Neon JWTs on every request | Rejected | Neon's JWT cannot carry `tenantId` or Meru `roles` ("custom claims not supported", §1.2), so RLS would have nothing verified to bind from; every refresh token is SHA-256-only and cannot be migrated, so every user is logged out at cutover (ADR 0012 D1.1); impersonation would have to be minted by a vendor; revocation would move to a 15-minute token with no Meru session row; and `JwtStrategy` would stop being the single verifier |
| **Keep current IAM** — password + Meru TOTP only | Rejected | Contradicts the standing decision to move to Neon Auth and the operator's 2026-11-16/17 decision. It also leaves Meru owning password storage, reset mail and credential stuffing defence indefinitely, against a mail provider that has never delivered to a non-owner inbox (workspace `CLAUDE.md` §12). Its one real merit — no new dependency on a Beta vendor — is preserved by D8's break-glass for operators |
| Auth on `cool-rice-41190255` as it stands | Rejected | D11-B item 2: it holds pre-cutover tenant data, and an owner credential for it is live config |
| Choose Outcome A or B in this ADR | Not taken | D12: the operator's earlier answer rested on a wrong fact, and gate zero is unmet under both. Recommendation in §12 |
| Link by email (ADR 0002 D3 as written) | Rejected | D3 |
| Per-tenant `authProvider` flag (ADR 0002 D6) | Superseded | D7 |
| A Passport `NeonAuthStrategy` (ADR 0002 D2 as written) | Rejected | D2 |
| A `JWT_SECRET`-signed link token instead of an `auth_tokens` row | Rejected | D5 (rationale corrected 2026-11-17) |
| Replay protection in the in-process cache | Rejected | D2.1: a restart reopens every token in its window |
| A `SAML_ENABLED` flag | Rejected | D10: it would re-enable an unsound verifier |
| Global, unscoped `GET /platform/users` | Rejected | D8.1 |
| `rls:verify` as the only home of the `neon_auth` check | Rejected | D11-A item 2: it cannot run locally and a deploy can skip it |
| Thread `impersonatedBy` through each audit writer's signature, as IAM does | Rejected | D13: correct per call site, wrong as a mechanism. Eight writers outside IAM today, more with every feature, and a forgotten one fails silently |
| Let callers keep supplying `context.impersonatedBy` alongside the store value | Rejected | D13 item 3: a reserved key only the signed claim can fill, or a writer can launder attribution in either direction |
| Leave `INVITE_ISSUED` best-effort | Rejected | D14: an invite grants a role, up to `firm_admin`, and role changes are already strict |
| Operator MFA reset callable by `firm_admin` too | Not now | D8.4: no firm-side identity verification exists to anchor it |
| No MFA reset route; owner-role SQL forever | Rejected as the end state | D8.4: it leaves no `audit_logs` row for the most sensitive change an account can undergo. Kept only as the interim procedure, now a script that writes through `AuditService.logEvent` (D8.4.C7) |
| A fact-named row (`INVITE_ISSUED`, `mfa.reset`) written before the change | Rejected | D15 item 1 (Owen, 2026-11-17): a query on the fact returns changes that never happened. A `*.requested` row comes first; the fact comes only after |
| `beforeState`/`afterState` on request and `not_applied` rows | Rejected | D15 item 1: `logEvent` derives `changes` from them, so the row reads as a change |
| Best-effort outcome rows as the end state | Rejected (Anton) | D15 item 2: a reconciler closes every request left without an outcome, and never assumes `applied` |
| MFA reset to a password-only account | Rejected (Anton) | D8.4.C2: the user re-enrols through a single-use emailed link before any session |
| 24-hour cool-off with a cancel link for `firm_admin` MFA resets | Not taken | D8.4: its safety rests on mail that is unproven and on a scheduler that is daily at best. Second-operator approval instead |
| Return the MFA enrolment link to the operator, as `inviteUrl` is | Rejected | D8.4: an operator holding it could bind their own authenticator to the account |
| `userRepo.save()` with an assigned id for invites | Rejected | D14.C1: with the key set, `save()` looks the row up and can update; `insert()` cannot |
| Two different 409 messages for "this tenant" vs "the platform" | Rejected | D14.C3: an enumeration oracle across tenants |
| A separate `impersonatedBy` column on `audit_logs` | Not needed | D13.C5: the checksum covers it when present, without a migration on a WORM table |

---

## 5. What breaks

| # | What | Why | Owner / remedy |
|---|---|---|---|
| 1 | **`scripts/smoke/cross-tenant.sh` in `enforce` mode, and under D8's operator TOTP in `link`** | Its operator login is `platform_admin`: in `link`/`enforce` that login now needs a TOTP code (D8). Each probe tenant's `firm_admin` logs in by password, which `enforce` refuses. The isolation gate would go **red at bootstrap** | Jonas. Operator leg: the script computes TOTP from an operator secret held as an env var `[proposed — Anton to accept a platform_admin TOTP secret in the smoke environment, or require a human-entered code]`. Tenant legs: obtain probe-tenant tokens via `POST /tenants/:id/impersonate` (`src/iam/operator.controller.ts:214`) — **only after** D7 `off → link` precondition 7, all three parts (refusal on the account-security routes, met; attribution on **every** audit entry via D13, outstanding; the route-enumeration spec). That changes what the smoke proves (impersonation tokens carry no `sid`); Owen to confirm it is still a valid isolation proof. **D7 blocks `enforce` until this is green** |
| 2 | **`meru-core-fe/tools/sweep` in `link`/`enforce`** | `lib.mjs:36-38` logs in three accounts by password; two are `firm_admin` (`sweep-demo@`, `sweep-grc@`), which fail under `enforce`; the operator (`sweep-operator@`) needs TOTP from `link` | Jonas. Same remedy as row 1, or give the sweep accounts Neon identities and a scripted Neon sign-in `[UNVERIFIED: whether Managed Better Auth's email/password sign-in can be driven headlessly from Node]` |
| 3 | **Password reset mail** | In `link`/`enforce`, a federated user's password is Neon's, so "forgot password" is Neon's flow and Neon's mail. Meru's `/auth/forgot-password` keeps serving `platform_admin` only in `enforce` (D7). Meru's **invite** mail still goes through Resend | `[NEEDS DATA: Neon Auth's email sender on the auth project — Neon-hosted or custom SMTP, and whether it reaches a non-owner inbox]` `[NEEDS DATA: current Resend domain verification status]`. Until both are known, `inviteUrl` handed to the operator (D8.2) is the onboarding path |
| 4 | **Branches and previews** | `iss`/`aud` are the auth URL origin, i.e. per Neon endpoint (§1.2), and Neon Auth is configured per branch. A preview needs its own `NEON_AUTH_*` values or every federated sign-in 401s | Jonas. **Under A: never branch the production branch for a preview** (D11-A item 6). **Under B:** previews use their own auth branch or project, never production's. `[UNVERIFIED: how Neon Auth configures trusted origins / redirect URLs]`. Recommended either way: previews run `AUTH_NEON_MODE=off` until answered |
| 5 | **Every federated login depends on a Neon-operated JWKS** | Unreachable JWKS on a cold cache = every non-operator login fails in `enforce`. Already-issued Meru sessions keep working (they never touch Neon) | Accepted; D8 break-glass covers operators. `[NEEDS DATA: Neon Auth availability commitment while Beta]` |
| 6 | **Signing out of Neon does not sign out of Meru, and a Neon ban does not kill a Meru session** | The Meru refresh token is independent of the Neon session | Frontends call both sign-outs. **The kill switch stays Meru's, and is now one action:** setting `users.status = locked` revokes sessions and flags the link (D3.3). Neon `banned` only blocks the *next* federated sign-in (D2) |
| 7 | **`render.yaml` and `meru-secrets` have none of the new variables, and under A must lose one** | `NEON_AUTH_ISSUER`, `NEON_AUTH_AUDIENCE`, `NEON_AUTH_JWKS_URL`, `NEON_AUTH_EMAIL_VERIFIED_SOURCE`, `AUTH_NEON_MODE` are proposed names nothing reads yet. Under A, `DATABASE_URL` must not be in `meru-secrets` (D11-A item 4). Under B, `GOVX_DB_URL`/`GOVX_DB_APP_URL` must be removed everywhere (D11-B item 1) | Jonas, when implemented. Not edited by this ADR. There is **no** `SAML_ENABLED` (D10) |
| 8 | **`POST /jobs/migrate/:target`** | Under A the web service has no owner URL, so `control` cannot run there. Under B the `govx` target loses its URL | Expected. Migrations run from the operator's machine (`docs/runbooks/render-deploy.md`) |
| 9 | **Operators without MFA** | D8 refuses them a session in `link`/`enforce`, and enrolment needs a session | Enrol every operator while still in `off` (D7 `off → link` precondition 5) |

---

## 6. Consequences

1. **Two entrances during `link`, one and a break-glass under `enforce`.** Both end in the same
   `issueSession`; a session from either is indistinguishable in `sessions`. That is what makes
   rollback lossless for sessions.
2. **Meru stops being a password store for customers** once `enforce` is reached — except for
   operators, by design, and their password now always comes with Meru TOTP.
3. **One Neon identity maps to at most one Meru user, forever, by construction**, until an operator
   unlinks it (D3.2). That is the unique index. It is the correct constraint for today's
   one-tenant-per-user model and the first thing a partner tier will hit (D9).
4. **A new dependency on a vendor product marked Beta** sits on the login path for every customer
   in `enforce`. The `off` position of D7 is the mitigation, and it is a deploy, not a migration.
5. **The Control Centre gains its first writes into another tenant that are not provisioning** —
   invite and unlink. They reuse `inviteUser`, `logout` and `runAsGod` verbatim rather than adding a
   third audit pattern. The cost is noisy, correct audit: per operator invite, two `CRITICAL` rows plus
   `invite.issue.requested`, `INVITE_ISSUED` and `invite.delivery` (D14).
6. **Logins start being audited**, but only operator break-glass (fail-closed) and token
   redemptions (fail-closed). Ordinary federated sign-ins are not audited by this ADR; open
   question.
7. **SAML stays dark, with no switch.** No tenant uses it (nothing writes `ssoConfig`), so nobody
   loses SSO today. A sales conversation that promises SSO needs the rebuild ADR first; there is no
   shortcut to offer.
8. **The MFA user links with two TOTP prompts**, once (D5).
9. **A lock is now heavier.** Locking a user ends their sessions within 60 s and, if they are
   federated, requires an operator unlink and re-link to come back. A firm admin who locks someone
   by mistake creates operator work. Accepted: the alternative is a lock that does not stop anyone.
10. **Under A, migrations leave the web service for good**, and so does the owner credential —
    which is the right end state regardless of auth, and costs `POST /jobs/migrate/control`.
11. **Under B, there are two Neon projects to operate**, and the account confusion that produced
    this amendment has already happened once.
12. **Every federated sign-in burns its Neon token.** A user whose federated sign-in fails at MFA
    or at a 409 signs in to Neon again. Mildly annoying; it is what single-use means.
13. **Every audit entry written under an impersonation token names the operator** (D13), not only
    IAM's (and queued work enqueued under it, D13.C6), and no writer can add or remove that
    attribution. An operator can no longer impersonate an operator, or sign off as a practitioner
    (D13.C1, C7). The cost is one more field on the
    audit write path every module shares, which is why Anton reviews it.
14. **Granting a role is never cheaper to audit than changing one** (D14). With the audit store
    down, nobody can be invited, by a firm or by the operator.
15. **A lost authenticator becomes a support ticket instead of a database edit** (D8.4, if
    accepted). Operators are the exception: their MFA recovery stays a two-person procedure. A reset
    user cannot sign in at all until they re-enrol through an emailed link, so **D8.4 is only as
    useful as mail delivery** (unproven today). Resetting a `firm_admin` needs two operators.
16. **Every security-posture change leaves a request row that will be answered** (D15): by its own
    outcome row, or by the reconciler within a day. The audit chain stops forking under concurrent
    writes, at the cost of serialising audit writes per tenant.
17. **Invites are rate-limited per actor, and the email is kept for the life of the audit log**
    (D14.C3, C4). That retention needs a register that does not exist yet.

---

## 7. What would make this wrong later

| Trigger | Invalidates | Do |
|---|---|---|
| Neon ships custom JWT claims | Nothing — and resist it | ADR 0012 D3: roles and tenant stay resolved from the `users` row. A vendor-asserted `tenantId` is still a client-adjacent assertion |
| Neon emits neither `email_verified` nor an enforceable verification setting | D3 rule 1a, and `link` itself | `link` does not open. Revisit: Meru-side email verification at redemption (a code mailed by Meru — blocked on mail) |
| Open sign-up cannot be disabled, **or** the only provisioning channel needs a Neon API key that can also read connection strings or delete branches | D4; §8 item 1 | Under A: no key on any process; Console-created identities or open sign-up with D3 + 1a. Under B: a project-scoped key in a non-web job, if one exists |
| The owning account of `ep-small-darkness-aeyx0p5j` turns out to be outside the operator's control | D12 gate zero; everything | Stop. That is a data-custody incident before it is an auth design question |
| Neon leaves `PUBLIC` `EXECUTE` on `neon_auth` functions and will not confirm a revoke is safe | D11-A item 3 | Allowlist by signature with `SECURITY DEFINER` refused, or choose Outcome B |
| A person legitimately needs two tenants (partner tier, contractors) | D3's unique index | ADR 0024. Relaxing uniqueness means a federated sign-in must choose a tenant — a membership model, not a patch |
| The count in D7 `link → enforce` precondition 4 is large | D7's `enforce` | Stay in `link` longer; do not flip with a large unlinked population |
| Render runs more than one web instance | D2.2's in-process rate limit | ADR 0004's shared store. D2.1's replay table is already shared and is unaffected |
| Neon Auth's `iss`/`aud`/JWKS shape changes, or Managed Better Auth leaves Beta with an SLA | D2 config, §6.4 risk framing | Config change; re-assess how long break-glass must remain |
| Legal advice says identity data must be held in Australia | D11-B item 6, and Outcome A outright | Under B, create (or recreate) the auth project in an AU region `[UNVERIFIED: Neon AU region availability]`; under A, the control plane itself must move — far larger |
| The control plane leaves Neon (Render Postgres, or elsewhere) | D1's vendor choice; makes Outcome A impossible | `authSubject`'s `neon:` prefix lets a second provider coexist; under A `neon_auth` leaves with Neon. Plan re-linking via D5 with a new prefix |
| A customer requires SAML | D10 | Open the SAML rebuild ADR; route it through `issueSession` and this ADR's link model |
| `POST /auth/login` break-glass is used for anything but outages | D8 | Remove password login for operators too, and keep a sealed recovery procedure instead |
| A new path takes work off the request other than `QueueService.createJob` (a direct `queue_jobs` insert, a second queue, an outbox) | D13 item 5 | Give it the same capture, strip and restore, and add its restore site to the D13.C3 sole-writer allowlist. Do not let a handler read attribution from its own payload |
| A second Render instance, or a second queue worker | D8.4.C6 and D14.C3 rate limits (in-process); D13.C5's lag statement | ADR 0004's shared store; restate the per-instance 60 s revocation lag |
| The reconciler writes `indeterminate` or `not_applied` more than rarely | D15 | A change path is dying mid-change. Find it; do not tune N to hide it |
| `verifyChain` reports a fork after D15 item 3 shipped | D15 item 3 | The lock is not on the path that wrote it, so some writer reaches `audit_logs` outside `logEvent`'s transaction. Find it |
| A backup-code or recovery-code feature is added | D8.4.C7 | Invalidate the codes in D8.4 step (4), in the same transaction |
| A customer asks for erasure of an invitee's email | D14.C4 | The register entry decides it; until the register exists there is no answer to give |
| A writer reaches `audit_logs` other than through `AuditService.logEvent` | D13 item 3 | The reserved-key rule only holds at that one path. A second writer re-opens it, so route it through `logEvent` or apply the same rule there |
| A firm asks to reset its own staff's MFA, or operator MFA recovery is needed more than rarely | D8.4 | Firm-admin variant gated on a documented firm-side identity check; a sealed operator-recovery design (two-person, audited) to replace the interim SQL for `platform_admin` |
| The strict invite path makes onboarding fail visibly during audit outages | D14 | Fix the audit store's availability. Do not relax the grant back to best-effort |

---

## 8. Open questions

| # | Question | Marker | Owner |
|---|---|---|---|
| 1 | **How does an invitee get a Neon identity if open sign-up is off?** Constrained by D12 (Anton, condition 10). **Under A:** no Neon API key on the web process — a Neon API key can read connection strings, which is owner access, which is RLS bypass. Prefer operator-created identities in the Neon Console, or leave sign-up open and let D3 + rule 1a carry isolation. **Under B with an auth-only project:** a project-scoped key in a separate, non-web job is acceptable. Either way: how the created user then sets a credential (Neon reset mail? Google?) | `[UNVERIFIED: project-scoped Neon API keys exist]` `[UNVERIFIED: credential-setting flow]` | Kyle + Anton, with Jonas |
| 2 | **Outcome A or Outcome B** (D12) | open | **Operator** — recommendation §12 |
| 3 | **Which Neon account owns `ep-small-darkness-aeyx0p5j`, and who has access?** Gate zero. *(Replaces the first draft's "does it belong to `cool-rice`?" — answered: no.)* | `[NEEDS DATA]` | Jonas, with the operator |
| 4 | Does the Neon JWT carry `email_verified`? Does Managed Better Auth have a "require email verification" setting? | `[UNVERIFIED]` ×2 | Jonas |
| 5 | Can Managed Better Auth's open sign-up be disabled at all? | `[UNVERIFIED]` | Jonas |
| 6 | Under A: owner of `neon_auth`, `PUBLIC` grants on its functions, `SECURITY DEFINER` functions in it, `pg_default_acl` entries. D11-A's boot check will report all four | `[UNVERIFIED]` | Jonas, then Anton for item 3's choice |
| 7 | Is `neon_auth` data copied on branch creation? (D11-A item 6 assumes yes) | `[UNVERIFIED]` | Jonas |
| 8 | Legal basis for identity data (and existing records) outside Australia; region of the auth project under B | `[NEEDS DATA: legal basis]` | Operator, with legal advice |
| 9 | Does `cool-rice-41190255` hold any data absent from the live control plane, before decommissioning? | `[NEEDS DATA]` | Jonas |
| 10 | Count of `platform_admin` users without MFA (D7 `off → link` precondition 5) | `[NEEDS DATA]` | Jonas, by query |
| 11 | Count of active, non-operator, unlinked users at the time of the `enforce` decision | `[NEEDS DATA]` | Jonas, by query |
| 12 | Neon Auth email sender and deliverability; Resend domain status | `[NEEDS DATA]` | Jonas |
| 13 | Which `jose` major is CJS-loadable on Node 20 | `[UNVERIFIED]` | Luke — `npm run check:cjs` |
| 14 | Postgres major on the live control plane (for `ALTER TYPE … ADD VALUE` in a transaction) | `[UNVERIFIED]` | Jonas |
| 15 | Does the Control Centre need an unscoped all-users list (D8.1 refuses one)? | `[UNVERIFIED]` | Operator |
| 16 | Should every federated login be audited, not only break-glass and redemptions? | `[UNVERIFIED]` | Operator, with Anton |
| 17 | May a `platform_admin` TOTP secret sit in the smoke-test environment (§5 row 1)? | open | Anton |
| 18 | D2.2's rate-limit value | `[UNVERIFIED]` | Anton |
| 19 | **Build the operator MFA reset (D8.4)?** Today a user who loses their authenticator is recoverable only by owner-role SQL with no `audit_logs` row. **Recommendation: build it as D8.4 specifies**: `platform_admin` only, with an operator TOTP step-up; actor ≠ target; actor holds MFA; `platform_admin` targets refused; `firm_admin` targets need a second operator; `runAsGod` + a CRITICAL `mfa.reset.requested` row; sessions revoked by user and tenant; reset to re-enrolment-required via an emailed link; user and firm admins notified; per-operator rate limit; Migrations D and E. It is a standalone change, not tied to `AUTH_NEON_MODE`. Until it ships, the interim script in D8.4 applies (pilot only; Jonas writes the runbook) | open, recommended; **Anton: approve with conditions, applied** | **Operator** decides |
| 20 | **Do invites move to the strict audit path?** **Ruled: yes**, as D14, with `resendInvite` following. Token redemption and session revocation stay best-effort | decided, D14; **Anton: approve with conditions (D14.C1–C4), applied** | Kyle |
| 21 | Should `context.impersonatedBy` enter the audit row checksum (D13 item 7)? | **Ruled: yes, when present** (D13.C5) | Anton |
| 22 | D13 contract review: the reserved-key rule, the interceptor as sole writer, propagation into `runAsGod` | **Done 2026-11-17: approve with conditions (D13.C1–C7)**. Code review still required | **Anton** |
| 23 | Does Anton accept the queue processor's restore as the second allowlisted writer of `TenantStore.impersonatedBy` (D13 item 2 vs C3)? | open | Anton, on the code |
| 24 | Rate-limit values: D8.4 per operator, D14.C3 per actor; the reconciler's N; the enrolment-link TTL; D8.4's `verificationMethod` list; the document-number pattern set | `[UNVERIFIED]` ×6 | Anton |
| 25 | Should invite request and `not_applied` rows carry `emailSha256` rather than the email (D14.C4)? | open | Anton, with the register's owner |
| 26 | Who owns the retention/erasure register, and where does it live? None exists (D14.C4) | `[NEEDS DATA]` | Operator |
| 27 | How many `platform_admin` users hold MFA? With fewer than two, `firm_admin` MFA resets stay on the interim procedure (D8.4) | `[NEEDS DATA]` | Jonas, by query |
| 28 | Does D8.4's re-enrol `verify` require the password (Kyle's addition)? | `[proposed]` | Anton |
| 29 | Which alert channel does the reconciler raise on (D15 item 2)? | `[UNVERIFIED]` | Jonas |

*Closed since the first draft:* "does `ep-small-darkness` belong to `cool-rice`?" — no (§1.1).
"Unlinking — not designed here" — designed, D3.2.

---

## 9. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| Any phase of D7 | Set `AUTH_NEON_MODE=off` and redeploy. `POST /auth/federated/neon` 404s; `/auth/login` is byte-identical for everyone, operators included | Sessions issued via federation are ordinary `sessions` rows — revoke with `IamService.logout(userId)` if wanted. **Users who were invited and redeemed via Neon have only a placeholder password** (`inviteUser`) and cannot password-login: they need `POST /auth/forgot-password`, which needs working mail. **Do not roll back to `off` with federated-only users present until mail is proven** — or plan to hand each a reset link out of band. `[UNVERIFIED: whether ADR 0006's regenerate path covers ACTIVE users, not just INVITED]` |
| `enforce → link` | Set the env var. Nothing else | None |
| Migration A | `down()` drops the index and both columns. **Before running it**, export `SELECT id, "authSubject", "authSubjectFlaggedAt" FROM users WHERE "authSubject" IS NOT NULL OR "authSubjectFlaggedAt" IS NOT NULL` to a secured file — `down()` destroys every link **and every lock flag**; a flagged user would be re-admittable by a fresh link | The export, if taken |
| Migration B | `down()` deletes `federation_link` token rows. The enum value stays (see §3) | An unused enum label. Harmless |
| Migration C | Set `AUTH_NEON_MODE=off` **first**, then `down()` drops the table | None. Rolling it back with the mode live would reopen every Neon token still inside its 15-minute window |
| `NeonIdentityVerifier`, the federated route, replay check, rate limit, link-token issuance | Revert the commit, after `off` | Replay rows, if Migration C stays; they expire on their own |
| D3.2 unlink route, D3.3 lock behaviour | Revert the commit | Unlinked users stay unlinked; flagged links stay flagged until Migration A is rolled back. Sessions already revoked stay revoked — correctly |
| D8 endpoints, operator TOTP, fail-closed LOGIN audit | Revert the commit | Users created by operator invites are ordinary invited users with ordinary `auth_tokens` rows; `CRITICAL`, `INVITE_ISSUED` and `LOGIN` audit rows are append-only and stay, correctly |
| D10 (SAML 501) | **There is no flag to flip.** Reverting the commit that introduced the 501 would reinstate a verifier Anton confirmed unsound (the comment above
`SamlService.assertSamlAvailable`). That is not a rollback anyone should take; the forward path is the rebuild ADR | None |
| D13 (attribution via tenancy context) | Revert the commit. IAM's explicit threading still covers invite issue, invite resend, role change and status change, **so do not remove it until D13 has shipped and held** (D13 item 6). D7 `off → link` precondition 7(b) is then unmet again, so a mode above `off` must be rolled back first | Entries written while D13 was live keep their `context.impersonatedBy`. Append-only, and correct |
| D13.C1 / C7 (no nested impersonation; no sign-off under impersonation) | **Not rolled back.** Reverting either reopens attribution laundering or practitioner impersonation. The forward path is a fix | None |
| D13.C5 (checksum includes `impersonatedBy`) | Revert the commit **only together with** a `verifyLogIntegrity` that still includes the field when present. Otherwise every row written while it was live fails integrity | None. Rows keep the checksum they were written with |
| D13.C6 (queue attribution) | Revert the commit | Job rows keep `data.impersonatedBy`. Inert once nothing restores it |
| D14 (strict invites) | Revert the commit; invites return to best-effort. **Keep D14.C3's single 409 message and rate limit**: they fix a pre-existing enumeration and do not depend on the audit shape | Request rows already written stay, append-only. A request with no outcome is answered by the reconciler if it is still running |
| D15 item 1 (shape) | Revert to the previous `auditedChange`. Do not revert to fact-named rows before the change | Rows keep the shape they were written in; `changeId` absent on older rows |
| D15 item 2 (reconciler) | Remove the job from the tick | Request rows without outcomes accumulate unanswered. That is visible, and correct to treat as a gap |
| D15 item 3 (chain lock) | Revert the commit | None. Concurrent writes can fork the chain again |
| D8.4 (operator MFA reset) | Revert the commit; the interim procedure resumes. **If the re-enrol routes are reverted, enrolment-required users can never get back in**, so revert them last, or lock those users first (Migration D's `down` precondition). Then Migrations E and D, in that order | Enrolment-required users, locked by the precondition, until an operator restores them. Pending `mfa_reset_requests`, exported. Revoked sessions stay revoked. Audit rows stay |
| D11-A (boot privilege check) | Revert the commit. **Do not** "fix" a failing check by granting or revoking on `neon_auth` from a migration | None |
| D11-B (no credential; `GOVX_DB_*` removed; `cool-rice` owner rotated) | Not rolled back. Re-adding an owner credential to a stale customer-data project is not a recovery step. If `POST /jobs/migrate/govx` is needed again, it gets a new decision | The rotated password, held by whoever rotated it |
| Neon-side configuration (D4) | Re-enable in the Neon Console. **Do not** disable Neon Auth on the branch as a rollback step: `[UNVERIFIED: whether DELETE …/branches/{id}/auth destroys neon_auth data]` | Neon Auth contents, vendor-managed |

**Rollback verification:** with `AUTH_NEON_MODE=off`, a spec proves `POST /auth/login`,
`POST /auth/refresh` and `POST /auth/mfa/verify` responses are byte-identical to `main` for a user
with `authSubject IS NULL`, for one with it set, and for a `platform_admin` with and without MFA;
and `scripts/smoke/cross-tenant.sh` is 10/10.

---

## 10. Implementation order (for Luke; each step gated by Owen)

0. **Nothing from step 2 onward starts until** D12 gate zero is met (owning account and access named) and the
   operator has chosen A or B. Under B, the `GOVX_DB_*` removal and `cool-rice` owner rotation
   (D11-B item 1) happen first and are operator/Jonas actions.
1. Independent of this ADR's mode, and not blocked by step 0 because none of it touches Neon
   (gate-zero scope confirmed by Anton, D12). **Each sub-step is gated by Owen, and those marked
   (A) also by Anton on the code.** In this order:
   - **Done (on branch `wave0/back-online`, through Owen's gate 2026-11-17, not deployed):** D10's 501;
     `NoImpersonationGuard` on the six account-security routes; IAM audit entries (invite issue,
     invite resend, role change, status change) carrying `impersonatedBy`; MFA enable/disable,
     role and status through `auditedChange` with a strict request row and 503 on an unavailable
     audit log; the route-enumeration spec over every JWT-guarded `IamController` handler (D13
     item 8, first half).
   - **1a. Done (on branch `wave0/back-online`, through Owen's gate 2026-11-17, not deployed;
     Anton's code review of the (A) items outstanding).** (A) D13.C1 nested impersonation
     (guard on `POST /tenants/:id/impersonate`, refuse the actor's own tenant, never a
     `platform_admin` target). (A) D13.C7 sign-off refuses an impersonation token. D15 item 1's
     reshape: no `beforeState`/`afterState` on request and `not_applied` rows, `context.requested`,
     and a per-call `context.changeId` on all three rows.
   - **1b.** D15 item 1's classifier: `ConflictException` → `no_row_updated`, with a spec. D14 and
     D8.4 both depend on it.
   - **1c.** D15 item 5: `verifyMfaSetup` and `setupMfa` take `tenantId`; conditional update.
   - **1d.** (A) D8.4.C5: `IamService.logout` and `revokeAllSessions` filter by `userId` **and**
     `tenantId`. D3.2, D3.3 and D8.4 depend on it, and it stands on its own.
   - **1e.** (A) D15 item 3: per-tenant advisory lock on the audit chain. It lands before 1f
     because 1f changes the checksum on the same path.
   - **1f.** (A) D13 in full: items 1–9 with C2–C6 and specs (a)–(h). This closes D7 `off → link`
     precondition 7(b) **and** 7(c) once the enumeration covers `OperatorController` and the
     `platform_admin`-only handlers.
   - **1g.** (A) D14 with C1–C3 (`insert()` with an assigned id and its spec; checks before the
     request row; one 409 message; per-actor invite rate limit). C4 is a register entry, not code.
   - **1h.** (A) D15 item 2: the reconciler on the daily tick. **Required before any customer
     relies on the audit trail.**
   - **1i.** (A) The D8.4 interim script (D8.4.C7). It may be built now, but it **may not be run
     until gate zero names the people who run it** (G0.C1).
   - **1j. Only if the operator accepts D8.4 (§8 item 19):** Migrations D and E with
     `resetPassword` refusing `mfa_enrolment`; then the reset route, the approval route, the
     re-enrol routes and the `login` refusal, with Anton's C1–C7. D8.4 adds four Control Centre
     routes, so the D13 enumeration must cover them in the same change.
2. Migrations A, B and C, registered (and C's entity in `ALL_ENTITIES`, its migration in
   `rlsMigrations`), applied before any code that reads them (§3).
3. `resetPassword` refuses `federation_link` (D3 rule 3) — with its spec, **before** step 6 mints a
   single such token.
4. D3.3: lock/inactive revokes sessions and flags the link. Valuable on its own; ship it first.
5. D11-A or D11-B boot assertion, whichever D12 selected, with the `MigrateService` spec under A.
6. `NeonIdentityVerifier` + replay table use + the single-verifier spec extension (D2, D2.1);
   D2.2 rate limit.
7. `POST /auth/federated/neon` behind `AUTH_NEON_MODE`, D3 rule 1a and rule 6 (fail-closed link
   audit, user notice), D5 link-token issuance, D6 MFA routing. Acceptance: ADR 0012 D3's table,
   for a federated session, a federated MFA session, and each of the three redemptions; plus a
   replay, an unverified email, a flagged link and a locked user, each refused.
8. D8 operator hardening: TOTP required, fail-closed `LOGIN` audit before `issueSession`.
9. `POST /tenants/signup` accepts a Neon token in place of `password` (D3 row 2): exactly one of
   the two, never both.
10. D8.1 (including the audited miss), D8.2, D3.2, each with a spec proving a second tenant's rows
    are absent under god mode.
11. Only then: Jonas wires `render.yaml` / `meru-secrets`, the D7 `off → link` preconditions are
    checked by Owen, and the operator chooses `link`.

---

## 11. Review record

| Reviewer | Date | Verdict |
|---|---|---|
| Owen (`quality`) | 2026-11-17 | **FIX** — D10 and the D10 rollback row described a `SAML_ENABLED` flag and a 404; the branch ships an unconditional 501 and states a flag would re-enable an unsound verifier |
| Anton (`secops`) | 2026-11-17 | **APPROVE WITH CONDITIONS** — eleven conditions, below |
| Owen (`quality`), final gate | 2026-11-17 | **FIX — stale against the code, not a design objection.** §1.3's `impersonatedBy` claim, §10 step 1's "in progress / outstanding", the A8 rows, the "Related hardening" note, and `iam.service.ts`/`saml.service.ts` line numbers throughout. Surfaced two decisions: operator MFA reset, and invites on the best-effort audit. **Applied in the second amendment**, which adds D13, D14 and D8.4 |
| Owen (`quality`) | 2026-11-17 | **FIX — consistency with code.** D14 item 1 wrote `INVITE_ISSUED` before the save; D8.4 wrote `mfa.reset` before the change; D8.4's 409 would be recorded as `write_failed`; four "this round" markers already done; §11's strict-path description wrong for `verifyMfaSetup` and incomplete on `not_applied`; `user.entity.ts:44` off by one. Asked for a ruling on `verifyMfaSetup`'s tenant predicate. **Applied in the third amendment** (D14, D8.4, D15 items 1 and 5, §1.3, §10, below) |
| Anton (`secops`) | 2026-11-17 | **APPROVE WITH CONDITIONS on D13, D14, D8.4 and the gate-zero scope. REJECT the best-effort completion row as an end state.** Conditions D13.C1–C7, D14.C1–C4, D8.4.C1–C7, G0.C1, AC.C1–C3. **Applied in the third amendment**; the REJECT is answered by D15 item 2 (reconciler) |

Status of each, as read from the working tree on **2026-11-17**. **"Satisfied by code" means the
code is on branch `wave0/back-online`, has been through Owen's gate, and is not deployed.** Items
marked (A) in §10 also need Anton's code review.

| # | Finding / condition | Where in this ADR | State |
|---|---|---|---|
| Owen | D10 must match the code: 501, no flag | D10, §9 | **Satisfied by code** (`SamlService.assertSamlAvailable`, `saml-disabled.spec.ts`); ADR text now amended |
| A1 | No code until the account owning `ep-small-darkness-aeyx0p5j`, and who has access, is named | D12 gate zero; §10 step 0 | **Outstanding** — operator + Jonas |
| A2 | Outcome A: widen check to function `EXECUTE`, sequences, `pg_default_acl` | D11-A item 1 | **Outstanding** — design only |
| A2 | Say where the check runs as a release gate | D11-A item 2 (boot, as runtime role) | **Outstanding** — design only |
| A2 | `DATABASE_URL` out of the web service | D11-A item 4 | **Outstanding** — config (Jonas/operator); runbook already recommends it |
| A2 | `MigrateService` bootstrap ignores `neon_auth` | D11-A item 5 | **Partly satisfied by code** — the three inspecting queries are public-scoped (`migrate.service.ts:40-45`, `:194`; `AddTenantRowLevelSecurity.ts:150`). `synchronize()` unverified; spec outstanding |
| A2 | Never branch production for previews | D11-A item 6; §5 row 4 | **Outstanding** — process (Jonas) |
| A3 | Outcome B: D11 becomes "no credential for the auth project" | D11-B | **Outstanding** |
| A3 | Remove `GOVX_DB_URL`/`GOVX_DB_APP_URL`, rotate `cool-rice` owner first | D11-B item 1 | **Outstanding** — still read at `migrate.service.ts:33` and `configuration.ts:166` |
| A3 | Not on `cool-rice`; fresh auth-only project | D11-B item 2; §4 | Decision recorded |
| A3 | Identity residency / APP 8 | D11-B item 6; §8 item 8 | `[NEEDS DATA: legal basis]` |
| A3 | `iss`/`aud`/JWKS per project | D2 table | Decision recorded |
| A4 | Email match counts only if Neon verified it | D3 rule 1a | **Outstanding**; blocked on §8 item 4 |
| A4 | Notify the user and fail-closed audit on every link | D3 rule 6 | **Outstanding** |
| A4 | Design unlinking before `link` | D3.2 | Designed; **outstanding** in code |
| A4 | Lock revokes sessions and flags the link | D3.3; Migration A | **Outstanding** — `updateUser` does not call `logout` today |
| A5 | Single-use exchange: 15-minute replay hash | D2.1; Migration C | **Outstanding** |
| A5 | Own rate limit on `/auth/federated/neon` | D2.2 | **Outstanding** |
| A6 | D5 / §1.3 rationale stale; keep `auth_tokens` design | D5, §1.3 | **Satisfied by code** (`jwt.strategy.ts:58`, `:69`); ADR text now corrected |
| A7 | Operator password login requires Meru TOTP server-side | D8 | **Outstanding** |
| A7 | `LOGIN` audit before `issueSession`, fail closed, not via `IamService.audit` | D8 | **Outstanding** — no `AuditAction.LOGIN` caller exists |
| A7 | Rotate the `platform_admin` sweep password before `link` | D7 precondition 6 | **Outstanding** — operator |
| A8 | Carry `impersonatedBy` into audit entries | D7 precondition 7(b); D13; §10 step 1 | **Partly satisfied: IAM audit entries only.** `UsersController` passes the claim, and `IamService.toAuditEvent` writes `context.impersonatedBy` for invite issue, invite resend, role change and status change (`impersonation-refusal.spec.ts`). **Not met** for any other `AuditService.logEvent` writer, including `documents.service.ts`, `tenant-provisioning.service.ts` and `config-pack.service.ts` (full list §1.3). **Mechanism: D13, contract approved with conditions by Anton 2026-11-17.** Outstanding in code (§10 1f); Anton reviews the code |
| A8 | Refuse impersonation on `/auth/mfa/*`, `/auth/logout-all`, `/auth/sessions/*` | D7 precondition 7(a); §10 step 1 | **Satisfied by code.** `src/iam/guards/no-impersonation.guard.ts` (403, `MER-AUTH-0008`, fails closed with no user), listed after `AuthGuard('jwt')` on six routes: `POST /auth/mfa/setup`, `POST /auth/mfa/setup/verify`, `POST /auth/mfa/disable`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`. Spec: `src/iam/impersonation-refusal.spec.ts`. **Done in the tree:** that spec now enumerates every JWT-guarded `IamController` handler against an allowlist and fails on a stale entry. **That enumeration is the mechanism D3.2, D8.1, D8.2, D8.4 and `/auth/federated/*` must satisfy** (D13 item 8). Extending it to `OperatorController` and every `platform_admin`-only handler is D13.C2, **outstanding** |
| Owen-2 | Operator MFA reset has no route | D8.4; §8 item 19 | **Proposed, Anton-approved with conditions; operator decides.** Interim script outstanding (§10 1i) |
| Owen-2 | `inviteUser` grants a role through the swallowing audit | D14; §8 item 20 | **Decided: strict; Anton-approved with conditions.** Outstanding in code (§10 1g) |
| Owen-3 | D14: fact-named `INVITE_ISSUED` before the save | D14 items 2–4; D15 item 1 | **Text corrected.** Code outstanding (§10 1g) |
| Owen-3 | D8.4: `mfa.reset` before the change | D8.4 step (3)/(5) | **Text corrected.** Code outstanding, if D8.4 is accepted |
| Owen-3 | D8.4: a 409 would be recorded as `write_failed` | D8.4 step (4); D15 item 1 | **Decided:** the callback throws `ConflictException`; `auditedChange` maps it to `no_row_updated`. Code outstanding (§10 1b) |
| Owen-3 | Request/`not_applied` rows carry no before/after; `changeId` on all three | D15 item 1 | **Satisfied by code** (`IamService.auditedChange`, `src/iam/iam-audited-change.spec.ts`) |
| Owen-3 | "This round" markers at D13 item 8, §10, A8, "Related hardening" | those places | **Text corrected**: the enumeration and the MFA reshape are in the tree |
| Owen-3 | §11's strict-path description wrong for `verifyMfaSetup`; `not_applied` reasons incomplete | below; D15 items 1, 5 | **Text corrected.** Ruling: `verifyMfaSetup` takes `tenantId` (D15 item 5); code outstanding (§10 1c) |
| Owen-3 | `user.entity.ts:44` | §1.3 | **Text corrected**: cited by symbol |
| D13.C1 | [HIGH] Nested impersonation launders attribution | §1.3; D13 preconditions | **Satisfied by code** (`src/iam/nested-impersonation.spec.ts`). Precondition to D13. Anton's code review outstanding |
| D13.C2 | Enumeration covers `OperatorController` and every `platform_admin`-only handler | D13 item 8 | **Partly satisfied by code:** `OperatorController` (`src/iam/operator-impersonation-guard.spec.ts`). Every other `platform_admin`-only handler **outstanding** (§10 1f) |
| D13.C3 | Spec: only the allowlisted sites write `store.impersonatedBy` | D13 item 2 | **Outstanding.** Queue restore added as a second site; Anton to confirm (§8 item 23) |
| D13.C4 | `logEvent` copies `context`; top-level key only | D13 item 3 | **Outstanding** |
| D13.C5 | Checksum includes `impersonatedBy` when present; unkeyed, so WORM + anchor are the controls; no column | D13 item 7 | **Decided.** Code outstanding; external anchor not built |
| D13.C6 | Queue capture, strip, restore | D13 item 5 | **Outstanding** |
| D13.C7 | Sign-off refuses an impersonation token | §1.3; D13 preconditions | **Satisfied by code** (`WorkflowEngineService.transition`, `src/workflow/workflow-signoff.spec.ts`). Anton's code review outstanding |
| D14.C1 | `insert()` with assigned id | D14 item 3 | **Decided**; TypeORM 0.3.31 source read; Luke's spec outstanding |
| D14.C2 | Request row after the ceiling and uniqueness checks | D14 item 1 | **Decided**; code outstanding |
| D14.C3 | One 409 message; per-actor invite rate limit | D14.C3 | **Decided**; code outstanding; value `[UNVERIFIED]` |
| D14.C4 | Email retained permanently in audit rows: register it | D14.C4 | **Recorded here.** `[NEEDS DATA: no register exists]` |
| D8.4.C1 | Operator TOTP step-up | D8.4 Body | **Decided**; code outstanding, if accepted |
| D8.4.C2 | Re-enrolment required, via a single-use emailed link | D8.4; Migrations D, E | **Decided**; code outstanding, if accepted |
| D8.4.C3 | Notify firm admins; second operator for `firm_admin` targets | D8.4 | **Decided: second-operator approval** (cool-off not taken, §4); code outstanding, if accepted |
| D8.4.C4 | Structured reason; no identity-document numbers | D8.4 Body | **Decided**; value list and patterns `[UNVERIFIED]` |
| D8.4.C5 | Revocation filters by `tenantId`; 60 s per-instance lag stated | D8.4; §1.3 | **Decided for `logout` and `revokeAllSessions` generally**; code outstanding (§10 1d) |
| D8.4.C6 | Per-operator rate limit; CRITICAL request row | D8.4 | **Decided**; value `[UNVERIFIED]` |
| D8.4.C7 | NULL the secret (no backup codes exist); interim via a script through `logEvent`, two named people; `platform_admin` by interim only | D8.4 | **Decided**; script outstanding (§10 1i) |
| G0.C1 | Whoever runs the interim script is among the people gate zero names | D12; D8.4 | **Recorded.** Blocks running the script, not building it |
| AC.C1 | `changeId` on requested / applied / not_applied | D15 item 1 | **Satisfied by code** (`IamService.auditedChange`, `src/iam/iam-audited-change.spec.ts`) |
| AC.C2 | Reconciler on the daily tick; never assumes applied | D15 item 2 | **Outstanding.** Required before any customer relies on the trail |
| AC.C3 | Per-tenant chain lock (pre-existing fork risk) | §1.3; D15 item 3 | **Outstanding** (§10 1e). `[UNVERIFIED: a fork observed in production]` |
| A9 | D10 unconditional 501 | D10 | **Satisfied by code** |
| A10 | API-key rules for provisioning under A and B | §8 item 1; D11-B item 4; D12 table | Decision recorded |
| A11 | Audit email-mode lookups that miss | D8.1 | **Outstanding** |

**Related hardening on the branch, not a condition: MFA changes are audit-first on a strict path.**
`IamService.disableMfa` requires a current TOTP code. MFA enable, MFA disable, role change and
status change all go through `IamService.auditedChange` (re-read 2026-11-17;
`src/iam/mfa-audit-ordering.spec.ts`). It works as follows:
1. **Request row**, written strictly before the change through `auditStrict`. If it cannot be
   written, the state does not change and the request answers **503**, never a generic 500 and
   never `{success: true}`.
2. **The change.** The scoping differs by method, and the difference is deliberate to record.
   `disableMfa` is a conditional `update({ id, tenantId }, …)` that throws `NotFoundException` on
   zero rows. `verifyMfaSetup` is **`userRepo.save(user)` after `findOne({ where: { id } })`**:
   RLS only, with no `tenantId` predicate and no condition on the current state. D15 item 5 rules
   that it changes. Role and status are `userRepo.save(user)` after a `{ id, tenantId }` lookup.
3. **Outcome**: the applied row on success, or **`not_applied`** with `context.reason`. The reason
   is `no_row_updated` (the change threw `NotFoundException`; `ConflictException` is added by D15),
   `write_failed` (any other error from the change) or `audit_unavailable` (a later step's request
   row could not be written, so the earlier steps' request rows are answered). All outcome rows are
   best-effort. **Anton rejects that as an end state**, and the reconciler (D15 item 2) answers any
   request left without an outcome.

The shared best-effort `IamService.audit` stays as it is for its other callers (session
revocation, token redemption, password-reset request).

**Re-review required** from both before status moves from Proposed: Owen on the whole text, Anton on
D2.1, D3 rule 1a/6, D3.2, D3.3, D8, D11-A/B and D12 (unchanged since his 2026-11-17 conditions);
on **D15** (new: the reconciler answers his REJECT); on the D8.4 choices he left open
(second-operator approval over cool-off, the re-enrol password leg); and on D13 item 2's second
allowlisted writer. **D13, D14 and D8.4 are approved with conditions; Anton reviews their code.**

---

## 12. Recommendation to the operator: Outcome A or B

**I recommend Outcome B — Neon Auth on a fresh project used for nothing else, in a Neon account
you control — conditional on the residency answer in §8 item 8.** The trade-off, plainly: **A is
one project and one region with less to operate, but it puts every user's credential material in
the same database as every tenant's records, readable by the `BYPASSRLS` owner role that runs our
migrations, and its isolation rests on a privilege check that will probably fail on day one
because of a Postgres default we would then have to work around on a vendor-managed schema.**
**B costs a second project, a second set of config, and a second account to keep straight — and
we have just seen what happens when nobody is sure which project is which — but it makes the
isolation invariant something a boot check can prove ("no credential"), keeps a Meru owner-role
compromise from also being a credential compromise, and makes preview branching of production
harmless to identities.** B also forces the clean-up we need anyway: the live owner credential to
the stale Singapore project goes. Neither choice settles residency — under A identities sit in
`us-east-2` with the records, which is the same APP 8 question — so that is not a tiebreaker.
Neither choice proceeds until gate zero: whoever owns the account holding `ep-small-darkness-aeyx0p5j`
already holds every tenant's data, and that has to be named first. `[UNVERIFIED: that Managed Better
Auth is available on the Neon Free plan and that the Free plan allows another project.]`
