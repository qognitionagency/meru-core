# 0012 — Better Auth: decline replacement, defer partial adoption behind the ADR 0002 seam

**Status:** Proposed — 2026-09-10. Not merged. Requires review by `secops` (Anton) before any
implementation begins — this ADR touches auth, tenancy and a third-party integration, all three
of `definition-of-done.md`'s review triggers — and by `quality` (Owen) before anything merges.

**Companion:** [ADR 0002 — Neon Auth federation](0002-neon-auth-federation.md). This ADR does not
supersede 0002; it **corrects two of 0002's `[UNVERIFIED]` items**, extends its D1 federation seam
to name Better Auth explicitly, and answers the question 0002 did not ask: *what if we adopted
Better Auth directly, self-hosted, rather than through Neon's managed wrapper?*

**Related:** [ADR 0013](0013-immistack-vertical-database.md) — the two are independent decisions but
share one constraint: identity must be resolvable **before** anything else, which is why the
control-plane tables cannot move and why the token's claim set cannot change casually.

---

## 1. Context

### 1.1 What was asked, and why it needs an ADR rather than a ticket

The operator wants Better Auth adopted for authentication. Auth in this codebase is not a module
with a seam around it — it is the input to tenancy, which is the input to RLS, which is the only
thing isolating 51 FORCE-RLS tables, and it is the input to `scopeOf`, which is the only thing
isolating users *inside* one tenant. Changing what a token carries changes all of that at once.

**Measured blast radius, from the code:**

| Surface | Count | Where |
|---|---|---|
| `scopeOf(actor)` call sites (non-spec) | **24**, across 12 files | `src/common/access.ts:82-86`; callers in `crm`, `documents`, `storage`, `tasks`, `forms`, `workflow`, `search`, `ai` |
| Repository injections bound to the default connection | **119** `@InjectRepository` across 58 files | plus 23 `TypeOrmModule.forFeature` registrations |
| Tables under `ENABLE` + `FORCE` RLS, bound off the token's `tenantId` | **51** | `src/migrations/1753500000000-AddTenantRowLevelSecurity.ts` |
| Migrations in the single registered chain | **43** | `src/config/migrations.ts:52` |
| `/auth/*` routes | **16** | `src/iam/iam.controller.ts:38-366` |

### 1.2 The current auth surface, mapped from code

**Routes** — all on `@Controller('auth')` (`src/iam/iam.controller.ts:38`):

| Route | Guard | Line |
|---|---|---|
| `POST /auth/login` | `@Public()` + `AuthGuard('local')` | `:46-48` |
| `GET /auth/profile` | `AuthGuard('jwt')`, `PolicyGuard` | `:70-71` |
| `POST /auth/refresh` | `@Public()` | `:99-100` |
| `POST /auth/logout` | `@Public()` | `:128-129` |
| `POST /auth/forgot-password` | `@Public()` | `:155-156` |
| `POST /auth/reset-password` | `@Public()` | `:171-172` |
| `GET /auth/sessions` | `AuthGuard('jwt')`, `PolicyGuard` | `:197-198` |
| `DELETE /auth/sessions/:id` | `AuthGuard('jwt')`, `PolicyGuard` | `:213-214` |
| `POST /auth/logout-all` | `AuthGuard('jwt')`, `PolicyGuard` | `:230-231` |
| `POST /auth/mfa/verify` | `@Public()` | `:252-253` |
| `POST /auth/mfa/setup` | `AuthGuard('jwt')`, `PolicyGuard` | `:276-277` |
| `POST /auth/mfa/setup/verify` | `AuthGuard('jwt')`, `PolicyGuard` | `:292-293` |
| `POST /auth/mfa/disable` | `AuthGuard('jwt')`, `PolicyGuard` | `:303-304` |
| `GET /auth/saml/initiate` | `@Public()` | `:315-316` |
| `POST /auth/saml/callback` | `@Public()` | `:335-336` |

`POST /auth/register` was **removed** 2026-09-04, not repaired (`:80-98`); `POST /tenants/signup`
(now gated by `TenantSignupInvite`) and `POST /iam/users/invite` are the two supported paths.

**Token issuance.** `IamService.issueSession` (`src/iam/iam.service.ts:1229-1254`) signs an HS256
access token via `@nestjs/jwt` carrying `{sub, email, tenantId, roles, role, sid}` — see
`JwtPayload` (`src/common/types.ts:154-171`). Secret is `JWT_SECRET`
(`src/config/configuration.ts:50`, mapped at `:132-135`), lifetime `JWT_EXPIRATION`, default `1h`
(`:51`), reported to the client as a hardcoded `expires_in: 3600` (`iam.service.ts:1251`).

**Refresh.** A 48-byte opaque random (`iam.service.ts:1230`), stored **only** as its SHA-256
(`:1012-1024`), 30-day TTL (`:64`). Rotation is a single conditional `UPDATE … WHERE revokedAt IS
NULL` (`:257-265`) — atomic, so a replayed refresh token loses the race rather than minting a
second session. **The plaintext refresh token is not recoverable from the database.** That single
fact decides §3's first row.

**Validation.** `JwtStrategy.validate` (`src/iam/strategies/jwt.strategy.ts:41-60`) maps the payload
to `{id, email, tenantId, roles, sessionId, impersonatedBy}` and calls `assertSessionLive`
(`:70-101`), which caches a live/revoked verdict for 60 s (`:25`) so revocation bites within a
minute without a DB read per request. A token with no `sid` is accepted (`:71`) and a DB error
fails **open** (`:93-94`) — deliberately, so a database blip does not lock the platform out.

**Authorisation.** `PolicyGuard` (`src/iam/guards/policy.guard.ts:33-85`) reads `user.roles` at
`:45`, then resolves the tenant's vertical (`:87-120`) with a `runAsSystem` bootstrap query
(`:103-110`) because guards run before `TenantBindingInterceptor` and RLS on `tenants` would match
zero rows.

**Tenancy.** `TenantAlsMiddleware` → `TenantBindingInterceptor` → `applyRlsToDataSource`
(`src/core/tenancy/rls.datasource.ts:36-91`) sets `app.current_tenant_id` on the *same pooled
connection* at `obtainMasterConnection` (`:46-69`), failing closed if the bind fails (`:70-76`).
`assertRlsEnforceable` (`:102-124`) refuses to boot in production under a `BYPASSRLS` role.

**`scopeOf` — the load-bearing piece.** `src/common/access.ts:82-86`:

```ts
export function scopeOf(actor: Actor): AccessScope {
  if (isGodContext()) return 'god';
  if (isTenantStaff(actor.roles)) return 'tenant';
  return 'own';
}
```

It reads exactly two inputs: `TenantContext.getBypass()?.kind` (`:45-47`) and `actor.roles`
against `TENANT_STAFF_ROLES = [FIRM_ADMIN, STAFF]` (`:31-34`). `own` scope then matches on
`actor.id` and, where a record is subject-keyed rather than assignee-keyed, `actor.email`
(`:14-23`). Five within-tenant isolation defects have been closed by routing through it —
`/crm/entities`, `/payments`, `/communications/threads`, documents, and
`POST /documents/generate/:templateKey` (`src/documents/document-generation.service.ts:269-288`).

**Anything that changes `roles`, `id` or `email` on the validated user changes all 24 call sites at
once, silently, with no compile error.** That is the property this ADR exists to protect.

### 1.3 Three defects in the *current* surface, found while mapping it

These are not arguments for or against Better Auth. They are the state of the thing being replaced,
and two of them mean the current surface is worse than its documentation suggests.

**(a) SAML issues an unrevocable token with empty roles.** `SamlService.handleCallback`
(`src/iam/services/saml.service.ts:196-204`) signs `{sub, email, tenantId, roles: []}` directly on
`jwtService`, bypassing `issueSession` entirely. Consequences, all three from the code:

- **No `sid`** ⇒ `assertSessionLive` returns immediately (`jwt.strategy.ts:71`) ⇒ the token cannot
  be revoked by `logout`, `logout-all` or session deletion. It is valid until `JWT_EXPIRATION`.
- **No `Session` row** ⇒ the SAML login never appears in `GET /auth/sessions`.
- **`roles: []`** ⇒ `isTenantStaff([])` is false ⇒ **`scopeOf` returns `'own'` for every SAML
  user**, including firm admins. A SAML-authenticated staff member sees their own records only.
- No `refresh_token` is returned, though `SamlLoginResult` declares one optional (`:36`).

**(b) SAML's request store cannot work on this runtime.** `pendingRequests` is a module-level
`Map` (`saml.service.ts:42`). `vercel.json` rewrites every path to one function (workspace
`CLAUDE.md` §10); `GET /auth/saml/initiate` and `POST /auth/saml/callback` are separate
invocations and routinely separate processes. The relay-state lookup therefore misses whenever the
callback lands on a cold process. The code's own comment says "production: use Redis with TTL".

**(c) There are two JWT verifiers, and they disagree.** Besides `JwtStrategy`, `JwtAuthGuard`
(`src/iam/guards/jwt-auth.guard.ts:17-44`) verifies the same secret but sets `request.user =
payload` **raw** (`:39`) and never calls `assertSessionLive`. It guards
`src/storage/storage.controller.ts:55`, `src/queue/queue.controller.ts:57` and
`src/search/elasticsearch/elasticsearch.controller.ts:64`.

Because the raw payload carries `sub`, not `id` (`src/common/types.ts:154-155`), every
`@CurrentUser() actor: UserPayload` on those routes has **`actor.id === undefined`** —
`storage.controller.ts:80, 108, 138, 172, 205, 224, 257, 275, 292, 320, 342, 369, 393, 419`. That
`actor` is passed straight into `scopeOf` at `src/storage/storage.service.ts:771` and `:1093`.
The role check still resolves, so this **fails closed** on reads (an `own`-scope caller matches
nothing and sees zero files) rather than open — but `storage.controller.ts:95` also writes
`userId: actor.id` as the uploader, so a client's own upload is attributed to nobody and is then
invisible to them. **This is a live defect for Luke, not a decision for this ADR**, and it is
recorded here because it proves the premise: the auth surface is not one code path, and a
migration that assumes it is will miss three controllers.

### 1.4 What Better Auth actually is — verified against vendor docs, not assumed

ADR 0002 §1.1 described **Neon's Managed Better Auth**, a hosted Beta wrapper. Self-hosted Better
Auth is a different proposition, and **two of ADR 0002's blocking `[UNVERIFIED]` items do not apply
to it**:

| Capability | Neon Managed Better Auth (ADR 0002 §1.1) | Better Auth self-hosted | Source |
|---|---|---|---|
| Custom JWT claims | "not supported at this time" | **Supported** — `definePayload` on the JWT plugin | [jwt plugin](https://www.better-auth.com/docs/plugins/jwt) |
| SAML 2.0 | not documented | **Supported** — SSO plugin does OIDC, OAuth2 and SAML 2.0 | [sso plugin](https://www.better-auth.com/docs/plugins/sso) |
| Signing | EdDSA, JWKS at a fixed path | EdDSA (default), ES256/ES512, RS256, PS256; JWKS path configurable | jwt plugin |
| Session model | HttpOnly cookie + 15-min JWT, no refresh token | DB-backed `session` row + cookie; the JWT plugin is **separate from** the session, "not meant as a replacement for the session" | jwt plugin |
| Multi-tenancy | none | Organization plugin: `organization`, `member`, `invitation` tables; `session.activeOrganizationId`; per-org roles | [organization plugin](https://www.better-auth.com/docs/plugins/organization) |
| Core schema | `neon_auth` schema in your Neon DB | **Four required tables** — `user`, `session`, `account`, `verification`; model and field names remappable via `modelName`/`fields` | [database](https://www.better-auth.com/docs/concepts/database) |
| NestJS | n/a | **No official integration.** Community `@thallesp/nestjs-better-auth`, which **requires `bodyParser: false` in `NestFactory.create()`** | [nestjs integration](https://www.better-auth.com/docs/integrations/nestjs) |

`[UNVERIFIED: whether Better Auth's SSO/SAML plugin is on the free tier or a paid plan. The docs
page fetched does not state a licence restriction; absence is not proof. Confirm before costing
anything.]`

`[UNVERIFIED: Better Auth version pinned for any of the above. The Neon page cited in ADR 0002
named 1.4.18 as of 2026-09-05; the plugin docs fetched for this ADR are unversioned.]`

### 1.5 The three constraints that decide this

**Serverless** (workspace `CLAUDE.md` §10, from `meru-core/vercel.json`): one function, 1024 MB,
`maxDuration: 60`, DB pool `max: 1` per invocation, read-only FS outside `/tmp`, no held-open
connections.

**`rawBody: true`.** Both entrypoints construct Nest with the body parser **enabled and raw-body
capture on** — `src/main.ts:15` and `api/index.js:178-183` — because Stripe webhook signatures are
computed over exact bytes. The community NestJS adapter's `bodyParser: false` requirement
(§1.4) is **directly incompatible** with that, and with every `ValidationPipe`-backed DTO in the
app.

**The migration chain is a single registered list.** `ALL_MIGRATIONS` (`src/config/migrations.ts:52`,
43 entries) is the only thing `MigrateService` runs (`src/jobs/migrate.service.ts:62`) and the only
thing `npm run rls:verify` (`scripts/verify-tenant-isolation.js`) is checked against. A library
that generates and applies **its own** schema outside that list produces tables with no RLS, no
`tenantId` column and no entry in the verification sweep. Four separate incidents in this repo's
history have been "a migration existed on disk but was not in the registered list".

---

## 2. Decisions

### D1 — Decline full replacement. Meru remains the session authority.

**Decision.** Better Auth does **not** replace `IamService`, the `sessions` / `auth_tokens` tables,
`JwtStrategy`, `PolicyGuard`, or the Meru-issued access token. The claim set in
`JwtPayload` (`src/common/types.ts:154-171`) and the `Actor` contract in `src/common/access.ts:11-24`
are unchanged by this ADR.

**Why, in order of weight:**

1. **Every existing session and refresh token would be destroyed, with no migration possible.**
   Refresh tokens are 48 bytes of randomness stored only as SHA-256 (`iam.service.ts:1012-1024`).
   The plaintext is not in the database, so there is nothing to translate into a Better Auth
   `session` row. Full replacement means **every user of all three product apps is logged out at
   the cutover instant**, and every `is_rt` / `gx_rt` / `md_rt` cookie
   (`meru-core-fe/immistack/lib/api/session-cookie.server.ts:15`) is dead. That is survivable at
   today's user count and is not survivable later — which makes "now or never" the wrong framing;
   see §5.
2. **RLS binds off `payload.tenantId`, and Better Auth's tenancy model is a different shape.**
   Meru is one tenant per user, a plain column (`src/iam/entities/user.entity.ts:35-38`) with
   globally-unique email (`iam.service.ts:713-717`). Better Auth's organization plugin models
   membership as `member` rows with `session.activeOrganizationId`. Adopting it means adopting a
   membership model Meru does not have and has never decided to have — ADR 0002 §1.2 explicitly
   bounded that out, and it remains out. See D6.
3. **`bodyParser: false` breaks Stripe webhooks and every DTO.** §1.5.
4. **Better Auth's four tables would land outside `ALL_MIGRATIONS`, with no RLS.** §1.5. A `user`
   and `session` table with no `tenantId` and no policy, next to 51 that have both, is the exact
   drift `rls:verify` exists to catch — and it would catch it, by failing the deploy.
5. **MFA would require re-enrolling every user.** `mfaSecret` is a `select: false` column on
   `users` (`src/iam/entities/user.entity.ts:69-70`) verified with `otplib`
   (`iam.service.ts:373-430`). Better Auth's 2FA plugin owns its own storage. A secret *can* be
   copied between schemas, but doing so moves plaintext TOTP seeds through a migration script —
   a worse artefact than asking users to re-scan.

### D2 — Adopt-partially, deferred: Better Auth may become a **login provider**, behind ADR 0002's seam and nothing else.

**Decision.** When Better Auth is adopted, it is adopted as a source of *authentication events*
consumed by a generalised `POST /auth/federated/:provider` — the route ADR 0002 D1 specified as
`POST /auth/federated/neon`, generalised now rather than copy-pasted later (ADR 0002 §5, row 5,
already names this trigger).

The exchange is unchanged from ADR 0002 D1: verify the provider's JWT against its JWKS (cached via
`jose`'s `createRemoteJWKSet`, ADR 0002 D2 — one cached fetch per key rotation, not a per-request
round trip inside a 60 s ceiling), resolve the existing Meru `User` **by email**, then call the
existing `issueSession` (`iam.service.ts:1229-1254`) unchanged. The response is byte-identical to
`POST /auth/login`, so the three frontends need a new entry point and no new code path.

**Gated per tenant** by `tenants.settings.authProvider` (ADR 0002 D6), default `'local'`, additive.
No tenant is flipped until the preconditions in D7 are met.

**No auto-provisioning** (ADR 0002 D3 stands): an unrecognised email is a 404, not a new user. The
`TenantSignupInvite` gate (`src/iam/entities/tenant-signup-invite.entity.ts:29-81`) and
`AuthToken`/`AuthTokenType` (`src/iam/entities/auth-token.entity.ts:9-58`) remain the only ways an
account comes into existence, and both keep their single-use, SHA-256-only, TTL-bound discipline.

### D3 — `scopeOf`'s contract is frozen, and stated here as an invariant

**Decision.** Any token source — password, MFA, SAML, federated, impersonation, future Better Auth
— must produce a validated user satisfying **all** of:

| Field | Requirement | Why |
|---|---|---|
| `id` | the Meru `users.id` UUID, never a provider `sub` | `own` scope matches on it (`access.ts:82-86`); §1.3(c) shows what happens when it is absent |
| `email` | the Meru `users.email` | `own` scope matches subject-keyed records on it (`access.ts:14-23`) |
| `tenantId` | the Meru `users.tenantId` UUID | RLS binds off it (`rls.datasource.ts:53-69`); a non-UUID is refused at bind, fail-closed |
| `roles` | `PlatformRole` values only, **never empty for a staff user** | `isTenantStaff` (`access.ts:50-52`) is the difference between `tenant` and `own` scope |
| `sid` | a live `sessions.id` | without it revocation is inert (`jwt.strategy.ts:71`) |

**A provider role string must never be mapped onto `roles` directly.** Roles are Meru's, resolved
from the `User` row after the email lookup. An IdP that can assert `roles` can assert
`firm_admin`, and `scopeOf` would believe it.

**This table is the acceptance criterion Owen tests against**, for this ADR and for any future one
that touches token issuance.

### D4 — Do not use the community NestJS adapter

**Decision.** `@thallesp/nestjs-better-auth` is rejected. Its `bodyParser: false` requirement
contradicts `rawBody: true` at `src/main.ts:15` and `api/index.js:178-183`, and its global
`AuthGuard` ("all routes are protected unless you explicitly allow access") would sit alongside
this codebase's existing `@Public()` convention as a **second, differently-spelled** default-deny
mechanism. Two authorisation defaults in one app is how a route ends up guarded by neither.

If Better Auth is ever mounted in-process, it is mounted as a plain handler on a dedicated path
prefix with the existing parser stack intact, and that is its own ADR.

### D5 — If Better Auth's tables ever land in a Meru database, they are schema-owned

**Decision.** Better Auth's four core tables (`user`, `session`, `account`, `verification` —
plus organization-plugin tables if D6 is ever reversed) may not be created by
`@better-auth/cli`. They must either:

- **(a)** be added to `ALL_MIGRATIONS` (`src/config/migrations.ts:52`) as a normal migration, with
  a `tenantId` column, `ENABLE` + `FORCE` RLS and a `tenant_isolation` policy, and be picked up by
  `npm run rls:verify`; **or**
- **(b)** live in a **separate, named schema** that `scripts/verify-tenant-isolation.js` is taught
  to exclude, with the exclusion and its reason written into that script as a comment.

Silently unpoliced tables in `public` are not an option. Better Auth's `user` table also collides
by name with nothing today, but its `session` table collides conceptually with `sessions` — two
tables that both answer "is this login live" is how a revocation gets missed.

### D6 — Do not adopt the organization plugin

**Decision.** Meru's tenancy is `User.tenantId` (`src/iam/entities/user.entity.ts:35-38`), one
tenant per user, globally-unique email. There is no `tenant_memberships` table and this ADR does
not create one. Better Auth's organization plugin is a **richer** model, and adopting it as a side
effect of adopting a login library would introduce multi-tenant membership by accident, into a
system whose isolation model assumes its absence.

If a user legitimately needs two tenants, that is the gap ADR 0002 §5 row 4 already names, and it
needs its own ADR — driven by the tenancy requirement, not by which library happens to offer it.

### D7 — What would have to be true first (the actual answer to "adopt Better Auth?")

**Decision.** No tenant is flipped to any federated provider until all five hold. Owen verifies
each; Anton signs off on 1, 2 and 5.

| # | Precondition | Evidence it is met | Owner |
|---|---|---|---|
| 1 | **SAML issues a real session.** `SamlService.handleCallback` routes through `issueSession` so the token carries `sid` and the user's actual `roles` (§1.3a) | A SAML login appears in `GET /auth/sessions` and is killed by `POST /auth/logout-all`; a SAML firm_admin gets `tenant` scope | Luke |
| 2 | **One JWT verifier.** `JwtAuthGuard` is deleted and its three controllers moved to `AuthGuard('jwt')`, or it is fixed to emit the same `{id, …}` shape and call `assertSessionLive` (§1.3c) | `actor.id` is defined on every `@CurrentUser()` route; a revoked session is rejected on `/storage/*` within 60 s | Luke |
| 3 | **SAML relay state survives a cold start.** `pendingRequests` (`saml.service.ts:42`) moves to the Upstash Redis store ADR 0004 specifies (§1.3b) | Two `initiate`/`callback` pairs succeed across separate invocations | Luke, after ADR 0004 |
| 4 | **Rate limiting covers the new route identically to `/auth/login`.** `api/index.js:78-85` currently names four `/auth/*` paths explicitly | The federated route is in that list; ADR 0002 §7 item 4 | Anton |
| 5 | **A pinned Better Auth version, with SSO/SAML licence confirmed** (§1.4 `[UNVERIFIED]` ×2) | A version number and a licence answer in writing, not inferred from a docs page | Product, with Jonas |

**Preconditions 1–3 are worth doing whether or not Better Auth is ever adopted.** That is the
honest headline: the fastest route to better authentication in this codebase is fixing the SAML
path and collapsing the second verifier — not adding a library.

---

## 3. Options rejected

| Option | Why rejected |
|---|---|
| **Full replacement of Meru IAM with Better Auth** | Destroys every session and refresh token with no possible migration (D1.1); imports a membership model Meru has not decided on (D1.2); `bodyParser: false` breaks Stripe webhooks and every DTO (D1.3); four unpoliced tables outside `ALL_MIGRATIONS` (D1.4); forces MFA re-enrolment (D1.5) |
| **Better Auth as the session store, Meru keeping authorisation** | Splits "is this login live" across two tables. `assertSessionLive` (`jwt.strategy.ts:70-101`) and the atomic rotation (`iam.service.ts:257-265`) are the two mechanisms that make revocation and single-use refresh actually work; both would need reimplementing against a foreign schema for no gain |
| **Better Auth mounted in-process via `@thallesp/nestjs-better-auth`** | D4 — `bodyParser: false` vs `rawBody: true`, plus a second global default-deny guard |
| **Better Auth issuing tokens Meru verifies via JWKS, with `tenantId`/`roles` in `definePayload`** | Technically possible now that custom claims are confirmed (§1.4) — and still rejected: it makes an external service the authority on `roles`, which `scopeOf` trusts absolutely (D3). The email-lookup exchange (D2) costs one query and keeps role resolution in this codebase |
| **Adopt the organization plugin for multi-tenancy** | D6 — introduces a membership model as a side effect of a library choice |
| **Decline outright, close the question** | Wrong for a different reason: Neon's managed offering is *already* Better Auth (ADR 0002 §1.1), and the golden-rule platform includes Neon Auth post-pilot. Declining Better Auth entirely would contradict a standing decision. D2 keeps the door open at the one seam that is safe |
| **Do it during the pilot** | The pilot is the only period where a forced logout of every user is cheap. It is also the only period where nobody can afford an auth outage. §5 records the trigger to revisit |

---

## 4. Consequences

1. **Nothing changes today.** No route, no table, no claim, no frontend. That is the intended
   outcome and the reason this ADR is cheap to accept.
2. **Three defects are now named, dated and owned** (§1.3, D7 rows 1–3). They were not visible
   before this mapping. Two of them — unrevocable SAML tokens, and SAML staff silently reduced to
   `own` scope — are `secops` findings independent of Better Auth, and Anton should triage them as
   such rather than waiting on this ADR.
3. **ADR 0002 is partially corrected, not superseded.** Its two `[UNVERIFIED]` blockers (custom
   claims, SAML) are properties of Neon's *managed* wrapper, not of Better Auth. 0002's D1/D2/D3/D6
   all still stand; its D5 (carry SAML forward) is reinforced by §1.3(a), which shows the SAML path
   needs repair before it could be migrated off anyway.
4. **`POST /auth/federated/neon` should be named `POST /auth/federated/:provider` when built.**
   Deciding it now costs one line of routing; deciding it after the second IdP costs a deprecation.
5. **The `JWT_SECRET` / HS256 symmetric model is untouched, and remains a single shared secret.**
   Better Auth's asymmetric default (EdDSA + JWKS) is genuinely better — a leaked verifier cannot
   mint tokens. This ADR does not adopt it, which means rotating `JWT_SECRET` still invalidates
   every access token platform-wide. That is a real cost of saying no, and it is the most likely
   reason a future ADR revisits this.
6. **`scopeOf` keeps its contract, explicitly** (D3), and now has a written acceptance criterion
   that did not exist before. Any future auth work is testable against it.

---

## 5. What would make this decision wrong later

| Trigger | Which decision it invalidates | What to do |
|---|---|---|
| A `JWT_SECRET` rotation is needed under load, or the secret is suspected leaked | §4.5 — the symmetric-signing consequence | Open an ADR on asymmetric signing (EdDSA + JWKS) for Meru's **own** tokens. That is a smaller change than adopting Better Auth and gets most of the benefit |
| Passkeys / WebAuthn become a requirement | D1 | Better Auth's passkey support is a genuine capability gap in Meru's IAM, which has none. Re-evaluate D2 as the delivery route — federated exchange, not replacement |
| A second IdP (Okta, Entra) is required by a customer | D2's single-provider route | Generalise to `POST /auth/federated/:provider` **before** the second provider, not after |
| A user legitimately needs access to two tenants | D6 | The `tenant_memberships` gap. Its own ADR, driven by the requirement — Better Auth's organization plugin becomes one candidate implementation, not the decision |
| Neon's Managed Better Auth exits Beta **and** ships SAML | ADR 0002 D5, and D7 row 5 here | Only then open the SAML-cutover ADR. §1.3(a) must be fixed first regardless |
| The user base is still small enough that a forced logout is free, **and** D7's five preconditions are met, **and** an asymmetric-signing ADR is going to be written anyway | D1 | This is the one combination where full replacement becomes cheaper than incremental repair. It is a narrow window and it closes when the first customer goes live |
| `@thallesp/nestjs-better-auth` gains a `bodyParser`-compatible mode, or Better Auth ships an official Nest integration | D4 | Re-check only; D1's other four reasons are unaffected |

---

## 6. Rollback

This ADR is a decision not to change code, so most rows are the rollback of things it *permits*
later rather than things it does.

| Change | Rollback | Data left behind |
|---|---|---|
| This ADR (document only) | Set status `Superseded by NNNN`; never renumber (`docs/adr/README.md`, Naming) | None |
| `POST /auth/federated/:provider` + provider strategy (D2, when built) | Delete the route; set every tenant's `settings.authProvider` back to `'local'`. Revert the commit | **None.** The route issues ordinary `Session` rows through the unchanged `issueSession` — indistinguishable from a password login. This is the property that makes D2 safe |
| `tenants.settings.authProvider` flag (D2/ADR 0002 D6) | Delete the key from `settings`. It is a JSONB bag, never a column, so no migration | None |
| A tenant flipped to a federated provider | Flip back to `'local'`. Users who never set a Meru password go through `POST /auth/forgot-password` — which requires `RESEND_API_KEY` to be set, or the invite/reset mail records and never arrives (workspace `CLAUDE.md` §12). **Do not flip any tenant before Resend is configured**, or rollback strands them | Sessions issued while flipped are ordinary rows; `IamService.logout(userId)` (`iam.service.ts:309`) revokes them |
| D7 precondition 1 (SAML through `issueSession`) | Revert the commit. SAML returns to issuing sessionless tokens | `Session` rows created for SAML logins remain and expire on their own 30-day TTL. Harmless |
| D7 precondition 2 (collapse `JwtAuthGuard`) | Revert the commit; the three controllers return to the second verifier | None — but §1.3(c)'s `userId: undefined` uploads written before the fix stay unattributed. A backfill is not possible; the uploader was never recorded |

**Rollback verification, for anything built under D2:** `POST /auth/login` and `POST /auth/refresh`
must be byte-identical before and after, for a tenant that never sets `authProvider`. That is the
strongest available evidence the change was additive rather than a rewrite — same test ADR 0002 §6
specifies.

---

## 7. Open items for the implementers

| # | Item | Owner |
|---|---|---|
| 1 | Triage §1.3(a) — SAML tokens are unrevocable and SAML staff get `own` scope — as a `secops` finding on its own timeline, not gated on this ADR | Anton |
| 2 | Fix §1.3(c) — `actor.id === undefined` behind `JwtAuthGuard` on `/storage/*`, `/queue/*`, `/elasticsearch/*`; `storage.controller.ts:95` writes it as the uploader | Luke |
| 3 | `[UNVERIFIED]` Confirm Better Auth's SSO/SAML plugin licence tier and pin a version (§1.4) | Product, with Jonas |
| 4 | Confirm `POST /auth/forgot-password` actually delivers (needs `RESEND_API_KEY` + verified sender) before any tenant is flipped under D2 — see §6 | Jonas |
| 5 | Security review of D3's invariant table as the acceptance criterion for all future token work | Anton |
| 6 | Decide whether an asymmetric-signing ADR (§4.5, §5 row 1) should be opened now rather than waiting for a rotation incident | Kyle, with Anton |
