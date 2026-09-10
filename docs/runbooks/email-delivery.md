# Runbook — email delivery

**Reader:** whoever is on the hook when "the invite never arrived", and whoever is trying to
onboard the first real customer.
**Provider:** Resend. **Code:** `src/core/mail/mail.service.ts`.

> **The one thing to take from this file:** *mail is configured* and *mail can reach a
> customer* are two different claims, and the system currently satisfies the first and not
> the second. Everything below is about telling them apart quickly.

> **Verified 2026-09-10.** `RESEND_API_KEY` and `RESEND_FROM` are both set on Vercel
> Production (`vercel env ls` — added that day). The `mail` capability reports **live** on
> `GET /api/v1/health`. **No mail can currently reach anyone except the Resend account
> owner.** See §2.

---

## 1. Symptom → first move

| Symptom | Go to |
|---|---|
| An invited user says nothing arrived | §3 (triage), then §5 (recover the link) |
| You need to onboard a customer *right now* | §5 — hand them the link out of band |
| You are setting this up properly | §4 — verify a domain |
| `GET /health` says `mail` is unconfigured | `RESEND_API_KEY` is unset on that environment. §6.1 |
| Provisioning returned `inviteSent: false` | Expected while §2 holds. §5 |

---

## 2. Why nothing is being delivered

**Resend will only send from a domain verified in the account.** The account behind the
current `RESEND_API_KEY` has **no verified domain**. Consequence:

- Every recipient is refused **except the account owner**, `immistacktech@gmail.com`.
- **Plus-addressed variants are refused too** — `immistacktech+alice@gmail.com` does *not*
  work. This was tested; do not spend an hour rediscovering it.

So: the key is valid, the capability reads `live`, the send call returns cleanly-handled
errors, and **no customer can be onboarded.** That is the whole of the blocker the operator
tracks as DEP-2.

> `[UNVERIFIED: the current Resend account's domain list and the exact refusal message.
> `RESEND_API_KEY` exists only on Vercel Production as an encrypted value and is not in the
> local `.env`, so this could not be re-queried against the Resend API from the repo. The
> owner-only behaviour and the plus-address refusal are the operator's test result of
> 2026-09-10, not an independent measurement.]`

### What "configured" actually means in this codebase

`MailService.isConfigured()` returns `true` **when `RESEND_API_KEY` is a non-empty string.**
Nothing more. It does not check the account, the domain, or whether a single message has
ever been delivered.

The capability report is the same shape (`src/health/capabilities.service.ts`):

| `RESEND_API_KEY` | `RESEND_FROM` | reported |
|---|---|---|
| unset | — | `unconfigured` |
| set | unset | `degraded` — "Sending from the Resend shared default" |
| set | set | **`live`** — *even with no verified domain* |

**`live` here means "the variables are present", not "a customer received something".**
Treating that as delivery is exactly the "unknown rendered as a positive result" failure
`CLAUDE.md` §5.2 exists to prevent, and it is worth fixing at the source —
`[NEEDS DATA: whether to add a Resend domain-status probe to the mail capability. That is a
code change and an ADR-sized decision about calling a third party from a health route.]`

### The sandbox sender

If `RESEND_FROM` is unset the code falls back to `Meru <onboarding@resend.dev>` — Resend's
own sandbox sender, which works without domain verification but **only delivers to the
account owner**. It logs a warning at boot:

```
RESEND_FROM is unset, using Resend's sandbox sender. It only delivers to the
Resend account owner — set RESEND_FROM to an address on a verified domain
before relying on this.
```

`RESEND_FROM` *is* set on Production today, so this fallback is not the current cause —
but the observable behaviour (owner-only delivery) is identical, which is why it is easy to
misdiagnose.

---

## 3. Triage — is it delivery, or is it the link?

Two different failures produce "the invite didn't work". Separate them before doing anything
else.

### 3.1 Did the send succeed?

```bash
curl -s https://meru-core.vercel.app/api/v1/health | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).data.capabilities)))"
```

**Expected today:** `{"live":3,"degraded":0,"unconfigured":11,"unknown":0}`

That tells you the variables are present. For the send itself, read the function logs:

```bash
vercel inspect --logs <deployment-url> --scope qognitionagencys-projects
```

| Log line | Meaning |
|---|---|
| `Mail sent to <addr>: <subject> (id: …)` | Resend **accepted** it. Delivery is now Resend's problem — check their dashboard. |
| `Mail to <addr> rejected by Resend: <name> — <message>` | Resend **refused** it. This is the §2 case. The reason is in the message. |
| `[mail-undelivered] to=… subject="…" (body withheld …)` | Always follows a rejection. Tells you **that** it failed and to whom. **The link is not here** — recover it from the API. → §5 |
| `[mail-not-configured] to=… subject="…" (body withheld …)` | `RESEND_API_KEY` is unset on that environment entirely. |

**The body is deliberately withheld from the logs** (`describeUndelivered()`, added
2026-09-10 in `d7381ea`). These three sites used to print the full text "so an operator can
still recover an action link", which made a **live credential** permanently readable by
anyone with Vercel project or log-drain access. Invite and signup tokens live 7 days, a
signup token provisions an entire tenant, and reset links target already-active accounts
including `platform_admin`. It was not a rare branch: with a valid key and no verified
sender domain, the rejection path runs on **every** message to a real customer.
**Recovery is an API response, not a log grep.** → §5

**A rejection never throws and never fails the request.** `send()` is documented as *never
throws* on purpose: a user has still been invited even if Resend is down, and a
password-reset request must not leak "this address exists" through a 500. It returns
`{ delivered: false }`.

One detail that matters and has bitten this codebase elsewhere: **Resend reports failures in
the response body, not by throwing.** The code checks the `error` field explicitly. Treating
a populated `error` as success would make the send look fine and the mail never arrive —
the same 200-with-an-error trap the government adapters had.

### 3.2 Did the link work?

If mail *was* delivered and the user still could not get in, check the URL they clicked:

| Email | URL built | Source |
|---|---|---|
| User invite (into an existing tenant) | `<APP_URL>/reset-password?token=…` | `inviteUrlFor()` |
| Signup invite (create a new workspace) | `<APP_URL>/onboarding?token=…` | `signupInviteUrl()` |

**If it points at `/accept-invite`, the deployment is out of date.** That route was **never
built**. Every invitation this product ever sent linked to it, and the app 307s it to
`/login?from=/accept-invite` — so an invited user landed on a sign-in form for an account
whose password they had come to set. Fixed 2026-09-10 (`c2729d7`); before that, `/signup`
was the same bug. **Both were found by clicking the link, not by reading the code — click
the link.**

**If the host is wrong:** `APP_URL` unset falls back to `https://app.immistack.com`, and the
service warns at boot. The old fallback was `app.meru.com`, which is **NXDOMAIN** — an unset
variable became a dead link rather than a loud failure. Set `APP_URL` explicitly per
environment.

---

## 4. Fix it properly — verify a domain

This is the only thing that turns "configured" into "can reach a customer". It needs DNS
access for the sending domain.

1. **Choose the sending domain.** It must be one whose DNS you control and which the
   recipient will recognise. For ImmiStack that is `immistack.com` (Vercel serves
   `www.immistack.com` and `app.immistack.com` from it) — a subdomain such as
   `mail.immistack.com` or `notifications.immistack.com` is the conventional choice, because
   it isolates sending reputation from the apex.
   `[NEEDS DATA: operator decision on the sending domain and whether a per-vertical sender
   is wanted — GovX mail signed from an ImmiStack domain would be wrong.]`

2. **Add the domain in the Resend dashboard** (Domains → Add Domain) and publish the DNS
   records it gives you. Resend issues DKIM and, for the return path, an MX/TXT pair.
   `[UNVERIFIED: the exact record set — it is generated per domain by Resend and must be
   copied from their dashboard, not from this file.]`

3. **Wait for Resend to show the domain `verified`.** Not "pending". Until then nothing
   changes.

4. **Set `RESEND_FROM` to an address on that domain**, in `Name <addr@domain>` or bare
   `addr@domain` form (`mail-brand.ts` parses both; only the display name is overridden
   per-tenant, the address is preserved).

   ```bash
   vercel env add RESEND_FROM production --scope qognitionagencys-projects
   # value, e.g.:  ImmiStack <no-reply@mail.immistack.com>
   ```

   **`RESEND_FROM` is the variable the code reads.** `MAIL_FROM` appears in older docs, is
   read by nothing, and does nothing.

5. **Redeploy.** Vercel injects environment variables at deploy time; changing a variable
   does **not** affect the running deployment. This is the most common way step 4 appears
   not to have worked.

6. **Prove it end to end**, to an address that is *not* the account owner:

   ```bash
   # As a platform_admin, invite a user to a throwaway tenant and read the result.
   curl -s -X POST https://meru-core.vercel.app/api/v1/iam/users/invite \
     -H "Authorization: Bearer $OPERATOR_JWT" \
     -H 'Content-Type: application/json' \
     -d '{"email":"<a real external address>","firstName":"Test","lastName":"User","role":"staff"}'
   ```

   **Expected:** `"inviteSent": true` in the response body, `Mail sent to …` in the logs,
   and **the message actually in that inbox**.

   `inviteSent: true` alone is not proof. Open the inbox, click the link, complete the
   password set. "Valid send" and "user can sign in" are different claims — that gap is what
   this whole runbook is about.

7. **Then, and only then**, tell the operator onboarding is unblocked.

---

## 5. Recover an invite link when mail cannot deliver

This is the workaround that lets onboarding proceed while §4 is outstanding. **The link is
returned to the operator over TLS**, deliberately — the caller is already
`@Roles(PLATFORM_ADMIN)`, already ran the provisioning under `runAsGod`, and just created
both the tenant and the user. The link grants nothing they did not already have.

### 5.1 Provisioning a new tenant

`POST /api/v1/tenants` (platform admin) returns both:

```jsonc
{ "data": { …, "inviteSent": false, "inviteUrl": "https://app.immistack.com/reset-password?token=…" } }
```

Send `inviteUrl` to the customer through a channel you trust. It is single-use.

> **Why this exists:** the fallback added first (`resendInvite` returning the link) was
> **unreachable for the case that motivated it.** `POST /iam/users/:id/resend-invite` reads
> `req.user.tenantId`, and the operator who provisions a tenant **is not a member of it**;
> `platform.controller.ts` has no user routes at all. So when the admin invitation failed to
> send, the operator had no route to recover it and **the tenant could never be entered by
> anyone.** Verified against production on 2026-09-10.

### 5.2 An existing tenant, existing user

`POST /api/v1/iam/users/:id/resend-invite`, called by someone **inside that tenant**,
returns `inviteSent` and `inviteUrl` the same way.

### 5.3 The logs are **not** a recovery route — as of 2026-09-10

They used to be. `MailService.send` logged the full body at three sites, and the guidance
was to grep `[mail-undelivered]` for the link. **That was removed in `d7381ea`** because it
made a working credential readable by everyone with Vercel project or log-drain access — a
much wider audience than the recipient, and beside an `auth_tokens` table that is careful to
store only SHA-256 hashes.

The logs now record `to=`, `subject=` and `(body withheld — contains a credential; use the
inviteUrl returned by the API to recover)`. Use §5.1 or §5.2.

> **If you are reading an older deployment's logs and the body *is* there:** those are live
> single-use invite and password-reset tokens, including potentially for `platform_admin`
> accounts. Treat them as exposed credentials — rotate or expire rather than reuse, and
> confirm the deployment serving traffic includes `d7381ea`.

**Boot-log mismatch, flagged not fixed:** the "mail disabled" warning still reads
*"Messages will be logged in full (including action links) instead of delivered"*
(`mail.service.ts`, `RESEND_API_KEY` unset branch). After `d7381ea` that is no longer true —
the `[mail-not-configured]` site withholds the body like the other two. The log message
should be corrected in `src/`; it is left here as a note rather than edited, because
correcting a code string is a code change and not this runbook's to make.
`[NEEDS DATA: whether anyone relied on that behaviour for local development, where a logged
link is genuinely convenient and carries no production credential.]`

---

## 6. Reference

### 6.1 Variables

| Variable | Read by | Effect when unset |
|---|---|---|
| `RESEND_API_KEY` | `mail.service.ts` constructor | Mail disabled. `delivered: false`, nothing sent, recipient and subject logged with the **body withheld**. Capability `unconfigured`. |
| `RESEND_FROM` | `mail.service.ts` constructor | Falls back to `Meru <onboarding@resend.dev>` — owner-only delivery. Capability `degraded`. |
| `APP_URL` | `mail.service.ts` constructor | Falls back to `https://app.immistack.com`, with a boot warning. Every emailed link uses it. |
| ~~`MAIL_FROM`~~ | **nothing** | No effect. Present in older docs only. |

`vercel env pull` returns encrypted values **blank** — a pulled `.env` showing an empty
`RESEND_API_KEY` is *not* evidence that it is unset. Use `vercel env ls`.

### 6.2 Blast radius — what stops without delivery

Every flow whose only completion path is a link in an email:

- **Tenant provisioning** — the firm admin cannot set a password, so a newly provisioned
  tenant cannot be entered by anyone. Recoverable via §5.
- **User invites** (`POST /iam/users/invite`) — staff and client accounts cannot be created.
- **Password reset** — no self-service recovery for anyone.
- **Client-thread isolation testing** — recorded in `AGENTS.md` as untested-not-unsound
  precisely because no invite or reset token is reachable without working mail, so
  staff/client accounts could not be created to prove it live. **This one is a compliance
  argument, not a convenience:** §4 unblocks it.

### 6.3 Escalation

- Domain verification and DNS → the operator. It is an account and DNS action, not a code
  change; no engineer can complete it from the repo.
- Mail arrives but the link 404s or redirects → **frontend** (Mira). The route is in the
  product app, not the API.
- Anything that changes what is *in* an email body sent to a firm's own clients →
  brand-guard gate; the footer is deliberately the tenant's brand, not Meru's, because an
  applicant has no relationship with Meru.
