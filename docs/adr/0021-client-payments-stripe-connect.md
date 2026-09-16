# 0021 — Client payments: Stripe Connect Standard, direct charges into the firm's own account, built now against unset keys

**Status:** Proposed — 2026-09-17. Not merged. Requires `quality` (Owen) and `secops` (Anton)
review — a new RLS-carrying table, a new third-party integration handling real card/bank-debit
flows, and a second Stripe webhook surface, per `definition-of-done.md`. Luke and Mira implement
against this contract; this document specifies no feature code.

**Amended 2026-09-17, following Anton's (secops) review — approved with changes, text only, no
code:** (1) **BLOCKER, now specified:** `PATCH /payments/:id/settle` is `@Roles(PLATFORM_ADMIN,
FIRM_ADMIN, STAFF)` today (`payments.controller.ts:304-309`), which lets `staff` approve a refund
through the generic settle route — a pre-existing defect against FR-7.10/BR-3 ("admin-only"), not
introduced by this ADR but one this ADR's own refund-calls-Stripe change makes urgent to close in
the same build; §2.7 now specifies a **service-level** `firm_admin`-only check on the `refunded`
transition specifically, decorator unchanged for every other transition. (2) `settle()` writes
**no audit event today** (confirmed — `PaymentsService`'s constructor injects no `AuditService`);
§2.7 now specifies an audit write on **every** settle transition, `CRITICAL` on the
Stripe-calling refund branch, written **before** the Stripe call with fail-closed behaviour on an
audit-write failure. (3) Idempotency and concurrency for the refund branch are now fully specified
— a Stripe idempotency key derived from `payment.id`, and `SELECT ... FOR UPDATE` inside a
transaction spanning check → Stripe call → local write (no new migration/version column needed).
(4) `/billing/webhook/connect`'s raw-body reachability is now confirmed, not asserted, against
both `main.ts` and `api/index.js`, with the same boot-grep gate ADR 0020 specifies. (5) **Partial
refunds are explicitly out of scope for R1** — full refunds only; FR-7.10's partial-refund case is
later work, stated rather than silently unhandled. Two `[UNVERIFIED]` items (§2.1's Express/Custom
comparison wording remains genuinely unverified — Stripe's own current documentation, not this
codebase — and is unchanged) are otherwise resolved against the installed `stripe@22.4.0` SDK's own
bundled type declarations: `'au_becs_debit'` is a confirmed literal of
`Checkout.SessionCreateParams.PaymentMethodType`, and `Session.payment_intent` is confirmed present
directly on the Checkout Session object — §2.5 and §2.7 are both corrected accordingly.

**Amended a second time, 2026-09-17, same review pass — a correctness bug in point (3) above found
before merge, text only, no code:** point (3)'s "`SELECT ... FOR UPDATE` inside a transaction
spanning check → Stripe call → local write" **deadlocks under this codebase's own serverless
constraints and is withdrawn.** `meru-core`'s DB pool is `max: 1` per invocation (`CLAUDE.md` §10);
`AuditService.logEvent` opens its **own** connection via its own injected repository, so calling it
from inside an already-open `settle` transaction — which is already holding the invocation's one
connection — deadlocks every refund into `FUNCTION_INVOCATION_TIMEOUT`, the same class of fault
ADR 0022 §2.5 names for nested `QueryRunner`s, here triggered by a service-layer call rather than a
second explicit transaction. §2.7c–§2.7g are rewritten: **two short transactions with the Stripe
call in between, holding no lock and no open transaction across the network call** — Phase 1 locks
the row, checks role/transition, marks `refund_pending` and audits the authorisation (through the
Phase 1 `QueryRunner`'s own manager); Stripe is called with **no transaction open**; Phase 3
re-locks the row and audits the outcome (`refunded` or reverted to `paid`) through a **second**,
separate `QueryRunner`'s manager. `AuditService.logEvent` gains an additive `manager?` parameter
(§2.7d) so both phases can write through their own transaction instead of opening a second pool
connection — this is the actual mechanism that makes either phase's audit write safe. A new
migration (`1757440000000-AddPaymentRefundPendingStatus.ts`, §2.7f) adds `refund_pending` to
`payments_status_enum` — a real schema change this ADR did not previously carry. A new Connect
webhook event, `charge.refunded` (§2.7g, confirmed against the installed SDK's own types), reconciles
the case where Phase 3 never commits. §4, §5 and §9 are updated to match.

**Scope:** PRD §10 / BC-6, FR-7.1–7.16, E4/E20/E21. Adopts operator decisions verbatim, not
reopened here: **Stripe Connect** as the provider; the client funds account is visibly separate
from ImmiStack's own subscription billing (PL-28); **build now even though `STRIPE_*` keys are
unset**, failing closed with a clean 503 exactly as `/billing/checkout` does today; card
surcharging must be structurally impossible for AU tenants (RBA ban, 1 October 2026); **BECS
Direct Debit is the default nudge**, not an equal alternative to card.

---

## 1. Context

### 1.1 What exists today, and why it cannot simply be turned on

Two Stripe integrations already exist in `src/billing/`, and they must **not** be confused —
`payments.service.ts:28-36`'s own doc comment already states the danger precisely: "Wiring client
fees through the platform's Stripe key would settle a client's visa fee into Meru's balance, which
is a silent financial misroute, and doing it properly would mean Stripe Connect, money-transmission
licensing and holding client funds."

| | `StripeService` (`stripe.service.ts`) | This ADR |
|---|---|---|
| Whose Stripe account | Meru's own (`STRIPE_SECRET_KEY`) | Each tenant's own **connected** account |
| What flows | Meru billing a **tenant** for its ImmiStack subscription | A **client** paying their **firm** |
| Existing routes | `/billing/checkout`, `/billing/portal`, `/billing/webhook` | New, §3 |

`PaymentsService.settle` (`payments.service.ts:381-425`) is, today, **record-only** — "No payment
processor is called... Stripe in this platform is Meru billing the firm, not the firm billing its
clients" (its own Swagger description, confirmed against `/api-json`). `Payment.providerRef` is
already declared on the entity as "Stripe Checkout Session id. Unique so a webhook replay...
cannot mark one payment paid twice" (`payment.entity.ts:145-152`) — **that comment describes this
ADR's use of the column, written before this ADR existed**, and confirms the column was reserved
for exactly this purpose rather than needing a new one.

`GET /payments/plans`, `POST /payments/schedule` (both live, confirmed on `/api-json`) already
expand a pack's `fees[]`/`paymentPlans[]` into individual `Payment` rows, one per instalment or
stage, each carrying `feeKind`, `feeKey`, `planKey`, `atStep`. **This ADR does not touch that
expansion.** Its whole job is: make an existing `Payment` row payable by a client, by card or BECS,
into the firm's own account, and record the result — the "raise a charge" and "instalment
arithmetic" halves of BC-6 are already built; the "collect it" half is not.

### 1.2 The three business rules that shape every decision below

- **§4.1 of `CLAUDE.md`**: `feeKind` is `firm | government | disbursement`, never summed, never
  marked up if `government`. This ADR must not let a Stripe flow blur that line.
- **§4.5**: `duty_floor` transitions — a client's own document access, and responding to a
  statutory deadline — never freeze on arrears, at any level. This ADR's payment collection is
  additive to the existing arrears model (`paymentPlans[].blockProgressOnArrears`), not a
  replacement of it, and does not touch the duty floor.
- **BUSINESS.md §5.6**: "never route client disbursements or government fees through your own
  Stripe account — a A$4,765 visa charge would cost ~A$81 to process and would put trust-adjacent
  money on your balance sheet." This is the platform's own subscription-Stripe account being
  warned against; this ADR routes client money through the **tenant's** connected account
  instead, which is the intended fix, not a repeat of the warning — but the same caution applies
  to *which fee kinds* this ADR will collect at all (§2.6).

### 1.3 What "build now against unset keys" means operationally

`STRIPE_SECRET_KEY` is set on Vercel Production today (workspace `CLAUDE.md` §12) for the
*subscription* Stripe use. **Connect requires nothing additional on the platform side to create a
connected account** — Standard Connect accounts are created and managed using the platform's own
secret key, the same one `StripeService` already uses (`stripe.accounts.create(...)` is a call on
the platform account, not a second credential). What is genuinely unset today is
`STRIPE_CONNECT_WEBHOOK_SECRET` (new, §2.2) — Connect account-scoped events need their own
registered webhook endpoint with its own signing secret, separate from `STRIPE_WEBHOOK_SECRET`.
Every route in this ADR that needs that secret degrades exactly like `StripeService.handleWebhook`
already does: `ServiceUnavailableException` naming the missing variable, never a silent no-op.

---

## 2. Decisions

### 2.1 D1 — Standard Connect accounts, not Express or Custom

**Decision.** Every tenant's merchant account is a Stripe **Standard** connected account. The firm
completes its own Stripe onboarding (KYC, bank details, tax) directly with Stripe, on Stripe's own
hosted flow; the firm's Stripe dashboard is genuinely theirs. Meru holds no card data, no bank
details, and — critically — **no compliance obligation for the connected account's KYC**, because
Standard accounts are the one Connect account type where the connected party, not the platform,
carries that relationship with Stripe.

**Why not Express.** Express accounts still put the platform in the KYC/compliance loop (Stripe's
own docs describe Express as "Stripe manages onboarding but the platform has more responsibility
for the relationship" — `[UNVERIFIED: exact current Stripe documentation wording; Luke/Anton
should re-confirm against Stripe's Connect account-type comparison page before implementation,
since this materially changes what Anton's security review needs to check]`). This product has no
existing PCI/KYC posture to extend and no stated appetite in the BRD/PRD for building one — FR-7.13
is explicit that "the application never sees a card number," which is a *data-handling* boundary,
not a KYC one, and Standard is the account type that keeps both boundaries entirely on Stripe's and
the firm's side.

**Why not Custom.** Custom accounts make the platform responsible for building the entire
onboarding UI and for a much larger slice of Stripe's compliance surface (tax forms, identity
verification flows). Nothing in BC-6 asks ImmiStack to look like a payment platform to the firm; it
asks ImmiStack to let the firm collect its own money. Standard is the minimum machinery that
satisfies that.

### 2.2 D2 — New table `tenant_merchant_accounts`, one row per tenant, a projection of Stripe's own state — never authored locally

**Decision.** Mirrors `StripeService`'s own stated pattern for subscriptions ("Money truth lives in
Stripe; local rows... are a synced projection updated by webhooks, never authored locally,"
`stripe.service.ts:21-24`) — this ADR applies the identical discipline to the Connect side.

```sql
CREATE TABLE "tenant_merchant_accounts" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenantId"         uuid NOT NULL,
  "stripeAccountId"  character varying(255) NOT NULL,
  "status"           character varying(16) NOT NULL DEFAULT 'unconfigured',
                     -- unconfigured | pending | active | restricted | rejected
                     -- same vocabulary discipline as CapabilityStatus (capabilities.service.ts:37):
                     -- 'unconfigured' is never evidence of a fault and must never render as 'active'
  "chargesEnabled"   boolean NOT NULL DEFAULT false,
  "payoutsEnabled"   boolean NOT NULL DEFAULT false,
  "detailsSubmitted" boolean NOT NULL DEFAULT false,
  "country"          character varying(2),
  "defaultCurrency"  character varying(3),
  "statusReason"     text,                    -- e.g. Stripe's own `requirements.disabled_reason`
  "lastSyncedAt"     timestamptz,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "updatedAt"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_tenant_merchant_accounts_tenant" UNIQUE ("tenantId"),
  CONSTRAINT "UQ_tenant_merchant_accounts_stripe_account" UNIQUE ("stripeAccountId")
);
CREATE INDEX ON "tenant_merchant_accounts" ("stripeAccountId");
```

`ENABLE`+`FORCE` RLS at creation, `tenant_isolation` policy — identical shape to every precedent
named in ADR 0019/0020. The `stripeAccountId` unique index is what the Connect webhook uses to map
an account-scoped event (which carries `account`, not `tenantId`) back to a tenant — the same
"account id is the lookup key" shape `StripeService.ensureCustomer` already uses for subscription
customers (`stripe.service.ts:107-125`), one level removed.

**No credential envelope needed here**, unlike `TenantConnector`/`user_calendar_links`
(ADR 0015 §2.3) — a Connect account id is not a secret (Stripe's own dashboard shows it to the
firm), and no token is stored locally; every authenticated call to the connected account uses the
**platform's own** `STRIPE_SECRET_KEY` with a `{ stripeAccount: id }` request option, not a
per-tenant credential.

### 2.3 D3 — Onboarding: an account-link flow, not an embedded form

**Decision.** `POST /billing/merchant-account/onboarding-link` (`firm_admin` only): if no
`tenant_merchant_accounts` row exists, calls `stripe.accounts.create({ type: 'standard', email:
<tenant's billing contact>, metadata: { tenantId } })` and inserts the row (`status: 'pending'`);
either way, calls `stripe.accountLinks.create({ account, refresh_url, return_url, type:
'account_onboarding' })` and returns `{ url }`. The firm is redirected to Stripe's own hosted
onboarding, then back to `return_url` — mirroring `StripeService.createCheckoutSession`'s existing
redirect shape exactly, so this is a proven pattern in this codebase, not a new one.

`GET /billing/merchant-account` (`firm_admin`, `staff` read) returns the **local row**, never a
live Stripe call on every page load — matching why `tenant_merchant_accounts` exists at all (D2).
`POST /billing/merchant-account/refresh` (`firm_admin`) pulls `stripe.accounts.retrieve(id)` and
updates the row — needed for the moment right after onboarding, before the first webhook has
necessarily arrived, so the settings screen does not show stale `pending` for longer than
necessary.

### 2.4 D4 — Payment collection: direct charges on the connected account, zero platform fee, no surcharge field anywhere

**Decision.** `POST /payments/:id/checkout-link` (`firm_admin`, `staff`, and `client` for their
**own** payment — §4) creates a Stripe Checkout Session with `{ stripeAccount:
merchantAccount.stripeAccountId }` as a request option (a **direct charge** — the charge and the
money both belong to the connected account from the instant it succeeds; Meru's own Stripe balance
is never touched, satisfying BUSINESS.md §5.6's warning by construction rather than by discipline).

```ts
stripe.checkout.sessions.create(
  {
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: payment.currency.toLowerCase(),
        unit_amount: Number(payment.amountMinor),
        product_data: { name: payment.description },
      },
      quantity: 1,
    }],
    payment_method_types: merchantAccount.country === 'AU'
      ? ['au_becs_debit', 'card']   // BECS listed first — the default nudge, operator decision
      : ['card'],
    success_url, cancel_url,
    metadata: { tenantId, paymentId: payment.id },
  },
  { stripeAccount: merchantAccount.stripeAccountId },
);
```

**No `application_fee_amount` is set.** BRD §11 D-2 ("who bears payment processing fees") is an
**open business decision** — this ADR does not answer it, and shipping a hardcoded platform cut
would be inventing a business answer nobody has given. The seam is left explicit and inert: a
`STRIPE_CONNECT_APPLICATION_FEE_BPS` env var is read but **unset today**, and when unset no
`application_fee_amount` is passed at all — the firm receives 100% of the client's payment minus
Stripe's own processing fee, which is the only default this ADR is entitled to choose without
BRD D-2 being resolved (§9 names the trigger to revisit once it is).

**No surcharge field exists anywhere in `CreatePaymentDto`, `ScheduleFeesDto`, or this session
body.** The Checkout line item is always exactly `payment.amountMinor` — BR-5's "no surcharge for
Australian tenants" is satisfied by there being no mechanism to add one for *any* tenant, which is
a stronger and simpler guarantee than a conditional check that could be missed for one country and
not another (§7 rejects the conditional-check alternative for this reason).

**Idempotency.** Unlike `POST /payments/schedule`'s idempotent-per-(matter,fee) contract, this
route always creates a **new** Checkout Session on each call — Stripe Sessions are single-use and
self-expire (24h); there is no meaningful "the same session already exists" state to return
instead. What *is* protected against double-processing is the **result**: `payment.providerRef`'s
existing unique index (`payment.entity.ts:150`, `where: "providerRef" IS NOT NULL`) means a webhook
retry for the same session id cannot mark two different `Payment` rows paid, and the settlement
handler (§2.5) checks the row's current status before writing, the same allowed-transition
discipline `settle()` already enforces (`payments.service.ts:385-408`). Creating a link is refused
outright (400) if `payment.status !== 'pending'` — a paid or cancelled payment gets no new link, so
a client cannot generate a redundant charge attempt against a row already settled.

### 2.5 D5 — Settlement: a second webhook endpoint, because Connect account-scoped events are not the same stream as platform events

**Decision.** `POST /billing/webhook/connect` (`@Public()`, signature-verified against
`STRIPE_CONNECT_WEBHOOK_SECRET`, distinct from `STRIPE_WEBHOOK_SECRET`) — Stripe delivers events
for a connected account's own activity (a direct charge's `checkout.session.completed` fires as an
event **on the connected account**, carrying `account: <connectedAccountId>` at the top level, not
inside `data.object`) to a webhook endpoint registered separately from the platform's own event
stream. Mirrors `StripeService.handleWebhook`'s structure exactly (`stripe.service.ts:128-176`):
verify signature, run the handler inside `TenantContext.runAsSystem` (Stripe carries no tenant
JWT — the tenant is resolved from `event.account` via `tenant_merchant_accounts.stripeAccountId`,
not from any header a caller controls), switch on `event.type`.

Handled events:

- **`checkout.session.completed`** — `session.metadata.paymentId` names the `Payment` row.
  Resolve the tenant from `event.account` → `tenant_merchant_accounts` → `tenantId`, then load the
  payment `{ id: paymentId, tenantId }`. **If the payment is already `paid`, the event is a no-op**
  (at-least-once delivery is Stripe's documented contract — `StripeService`'s own comment already
  states this discipline for the subscription webhook, `:127`). Otherwise: set `status: 'paid'`,
  `paidAt: now()`, `providerRef: session.id`, `metadata.method` from
  `session.payment_method_types?.[0]` (`'card'` or `'au_becs_debit'` — **confirmed, not
  `[UNVERIFIED]`**: `'au_becs_debit'` is a literal member of
  `Stripe.Checkout.SessionCreateParams.PaymentMethodType` in the installed
  `stripe@22.4.0` SDK's own bundled types,
  `node_modules/stripe/cjs/resources/Checkout/Sessions.d.ts:2887`). **Also set
  `metadata.stripePaymentIntentId: session.payment_intent`** (a plain string id on the Checkout
  Session object at webhook-delivery time — `payment_intent: string | PaymentIntent | null`,
  confirmed at `Sessions.d.ts:215` — no `expand` needed, since `checkout.session.completed`'s
  payload already carries it) — this is what §2.7's refund branch reads directly, replacing the
  session-retrieve round trip an earlier draft of this ADR left `[UNVERIFIED]`. Audit `UPDATE`/`INFO`
  with `{ actorId: 'system:stripe-webhook', beforeStatus: 'pending', afterStatus: 'paid',
  amountMinor, currency, feeKind }` (§5). Then
  — best-effort, non-blocking — attempt `DocumentGenerationService.generate('receipt', ...,
  entityId: payment.entityId ?? payment.clientId, { store: true })` **if the tenant's resolved pack
  declares a `receipt` documentTemplate** (ADR 0019); on any failure (no such template, `requires`
  unmet), log a `Logger.warn` and audit a `WARNING`, but **do not fail the webhook** — Stripe
  requires a prompt 200, and a missing receipt is a follow-up task, not a reason to leave the
  payment's own status unrecorded (§9 names this as a trigger for a proper retry job once one
  exists).
- **`account.updated`** — sync `chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`, `country`,
  `defaultCurrency` onto `tenant_merchant_accounts` from the event payload; derive `status` as
  `active` (charges+payouts both enabled), `restricted` (either false with a `requirements.disabled_reason`
  present), or `pending` (submitted, not yet enabled). **Never write `active` on `chargesEnabled:
  false`** — the same "never report unconfigured as live" discipline `CapabilityStatus` already
  enforces platform-wide.
- **`charge.refunded`** — added on review (§2.7d/§2.7g), the reconciliation path for a refund whose
  Phase 3 (§2.7c) never committed. Resolve the tenant from `event.account`; match the `Payment` row
  by `metadata.stripePaymentIntentId` against the charge's `payment_intent`. Idempotent: no-op if
  already `refunded`. If `refund_pending`, write `status: 'refunded'`, `metadata.stripeRefundId`,
  and a `CRITICAL` audit entry with `userId: 'system:stripe-webhook'` — the same terminal write
  Phase 3's success path makes, reached by a second path so a crash between Stripe accepting the
  refund and Phase 3's commit never leaves a payment silently stuck at `refund_pending`.
- Anything else: `this.logger.debug('Unhandled Connect event: ' + event.type)`, matching
  `StripeService`'s own default branch.

### 2.6 D6 — Only `feeKind IN ('firm', 'disbursement')` may be collected via a checkout link. `government` is always refused.

**Decision.** `POST /payments/:id/checkout-link` returns **400 `MER-BILL-0002`** for any payment
with `feeKind === 'government'`, unconditionally — no exception, no tenant setting overrides it.
A government charge continues to be handled exclusively by the existing evidentiary path
(`CLAUDE.md` §4.4: `vacStatus` three-valued, artifact upload, staff verification) or by the
`firm_pays_on_behalf` outbound-payment flow, neither of which this ADR touches.

**Why not gate on `vacSettlementMode` instead of a blanket refusal.** `vacSettlementMode` is
immigration vertical vocabulary (`verticalAttributes.matter.vacSettlementMode`,
`immistack/CLAUDE.md` §4.2) — reading a **named vertical-specific key** from `src/billing/`, a
core module, to decide whether a Stripe route may run would be exactly the 80/20 violation
`CLAUDE.md` §5.5 exists to prevent, and would make this route silently GRC-incompatible (a bank
has no `vacSettlementMode` and no visa matters, but might one day have its own "who pays a
regulator charge" question with a different name). A blanket refusal on `feeKind === 'government'`
needs no vertical knowledge at all — `feeKind` is core vocabulary (`payment.entity.ts:158-163`),
already read by this exact module for the exact same disclosure reason (`§4.1`). If a firm
genuinely needs `firm_pays_on_behalf` collected by card in future, §9 names the correct extension
(a pack-declared flag, not a hardcoded vertical read).

### 2.7 D7 — Refunds: a pre-existing role gap closed, an audit write added to every transition, and the concurrency/idempotency contract specified — full refunds only in R1

**This section was materially incomplete before Anton's review and is now the load-bearing part of
this ADR; read it in full, not just the decision line.**

**D7a — the role blocker, and the pre-existing defect it fixes.** `PATCH /payments/:id/settle` is
`@Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)`
(`payments.controller.ts:304-309`, confirmed) — every one of those three roles may today drive
`paid → refunded`, the *only* transition `settle()`'s allowed-transition matrix permits out of
`paid` (`payments.service.ts:396`). That contradicts PRD FR-7.10 ("Refund tracking... Admin-only")
and `immistack/CLAUDE.md` §2's own permission matrix row ("Approve refund / credit note / write-off
— `firm_admin` only"), and it predates this ADR — `settle()` has always allowed it, this ADR's
Stripe-refund branch just makes the consequence of getting it wrong a real, irreversible charge
reversal instead of a local-only status flip. **Decision: fix it in the same build as this ADR's
refund work, not as a separate ticket.** The `@Roles` decorator on the route is **not** narrowed —
`staff`/`platform_admin` still legitimately drive `pending → paid`, `pending → failed`,
`pending → cancelled` and `failed → paid`/`failed → pending` (recording a bank transfer that
landed, correcting a mis-recorded failure) via this same route, and narrowing the decorator would
break those. Instead, `PaymentsService.settle` gains an explicit **service-level** check, run
before anything else once the target status is known:

```ts
if (dto.status === PaymentStatus.REFUNDED && !actor.roles.includes(PlatformRole.FIRM_ADMIN)) {
  throw new ForbiddenException(
    'Only firm_admin may approve a refund — record the transition as firm_admin, ' +
    'or have a firm_admin approve it.',
  );
}
```

403, mapped to the existing convention (`AUTH_INSUFFICIENT_ROLE`, `MER-AUTH-0009` — no new code),
the same shape `CLAUDE.md` §5.5b's own worked example uses for a route-specific gate layered on top
of a broader decorator-level grant. This is a **service-level** check, not a second decorator,
because `PlatformRole.PLATFORM_ADMIN` legitimately reaches this route for *other* transitions and
Nest's `@Roles` is transition-blind — it cannot express "this role may PATCH this route, except
when the body says `refunded`."

**D7b — Stripe is called only when the payment was actually collected through it.** On a
`firm_admin`-approved transition to `refunded`, **if `payment.providerRef` is set** (collected via
this ADR's Checkout flow), call Stripe (D7c). If `providerRef` is null (a bank-transfer/trust-account
settlement recorded by hand, as `settle()` already supports), behaviour is **unchanged from
today** — record-only, no processor call. **Corrected from an earlier draft of this ADR, which
claimed the role gate was "unchanged" by this decision — it is not; D7a is a real, specified change,
not a restatement.**

**D7c through D7g below were redesigned on a second round of Anton's review, after the design
below this line was first approved.** The first design held one `QueryRunner` transaction open —
row lock, role/transition check, the Stripe HTTP call, the local write, the audit write — from lock
to commit. **That is wrong, for a reason specific to this codebase's serverless posture, and the
redesign is not a style change.** `meru-core`'s DB pool is `max: 1` **per invocation**
(`CLAUDE.md` §10). A `QueryRunner` transaction holds that invocation's one connection for its
entire duration. `AuditService.logEvent` — confirmed by reading `audit.service.ts:48-51` —
resolves `AuditLog` through its own `@InjectRepository(AuditLog)`, which draws from the **default**
DataSource's pool, not from whatever `QueryRunner` happens to be open elsewhere in the same
request. Calling `AuditService.logEvent` from inside an open `settle` transaction therefore tries
to check out a **second** connection from a pool that has exactly one, already held by the
transaction waiting on this very call to return — the identical deadlock shape ADR 0022 §2.5 names
for nested `QueryRunner`s in `convertEntity`, here triggered by a service boundary instead of a
second explicit transaction. Every refund would hang until Vercel's function timeout. **Holding
that same lock across an external Stripe HTTP call for the whole sequence compounds it**: a slow or
retried Stripe call extends how long the row — and, before this fix, the audit path — stays
blocked, inside a function with a hard 60-second ceiling. The redesign below removes both problems
by construction: no transaction is ever open across a Stripe network call, and `AuditService` is
given a way to write through the caller's own transaction instead of opening a second connection.

**D7c — three phases, no transaction ever spans the Stripe call.**

**Phase 1 (short transaction, `QueryRunner` #1):** lock the row, validate, commit to attempting a
refund, audit that commitment — all as one local, sub-second unit of work:

1. `queryRunner.startTransaction()`.
2. `SELECT * FROM "payments" WHERE "id" = $1 AND "tenantId" = $2 FOR UPDATE` via
   `queryRunner.manager.query` (or `queryRunner.query`) — this is the same lock D7's earlier draft
   specified; only its **scope** has shrunk, not its existence.
3. Re-check the allowed-transition matrix against the **locked** row (`status` must be `'paid'`).
4. The `firm_admin` check (D7a).
5. If `payment.providerRef` is null (a non-Stripe, record-only settlement, D7b) — **this whole
   three-phase design does not apply**; write `status: 'refunded'` and the audit entry (D7d) and
   commit, exactly as any other `settle` transition does. **Phases 2–3 below exist only for the
   case where a real Stripe call is about to happen.**
6. Otherwise: write `status: 'refund_pending'` (D7f — a new, narrow intermediate state, not
   `'refunded'`) and write a `CRITICAL` audit entry (D7d) **through the same `queryRunner.manager`**
   recording that a refund was authorised and is about to be attempted.
7. Commit. Release `queryRunner` #1. **The row lock is released here** — nothing is held across
   what happens next.

**Phase 2 (no transaction, no lock held):** call Stripe.

```ts
const refund = await stripe.refunds.create(
  { payment_intent: payment.metadata.stripePaymentIntentId },
  { stripeAccount: merchantAccount.stripeAccountId, idempotencyKey: `refund:${payment.id}` },
);
```

`metadata.stripePaymentIntentId` is already on the row, written by §2.5's webhook handler at the
moment the payment was marked paid — **no `stripe.checkout.sessions.retrieve` round trip is needed
at refund time**, correcting the extra-read design an earlier draft carried as `[UNVERIFIED]`
(§2.5 amendment). **The idempotency key is `refund:${payment.id}`** — stable across any retry of
this same logical refund (a network timeout causing the caller or this service to resubmit), and
safe because `refund_pending`/`refunded` are both states a payment passes through **at most once**
in this model (D7e's full-refund-only scope means there is exactly one refund per payment, ever).

**Phase 3 (short transaction, `QueryRunner` #2):** record the outcome. A **fresh** `QueryRunner` —
not the one from Phase 1, which was already released — re-locks the same row
(`SELECT ... FOR UPDATE`, same statement as step 2) and:

- **On Stripe success:** write `status: 'refunded'`, `metadata.stripeRefundId: refund.id`, a
  `CRITICAL` audit entry (the completion of the money movement Phase 1's audit already flagged as
  authorised). Commit.
- **On Stripe failure:** write `status: 'paid'` (revert — the refund did not happen, so the payment
  is exactly as paid as it was before this attempt started) with `metadata.lastRefundError` set to
  the Stripe error message, and a `WARNING` audit entry recording the failed attempt. Commit. The
  caller (`PaymentsService.settle`) then re-throws so the HTTP response reports the failure rather
  than a silent 200 — `firm_admin` sees "refund failed: {reason}", not a payment that quietly stayed
  `refund_pending` forever.

**Why re-lock rather than trust that nothing changed between Phase 1 and Phase 3.** The row could,
in principle, have been touched by something else in the gap (there is nothing else in this
codebase that writes to a `refund_pending` row today, but the lock costs nothing and removing it
would be relying on an invariant that is true only by the absence of a second writer, not by
construction). **Why two short transactions and not one long one, restated plainly:** this is
exactly the fix D2's problem needed — no transaction, at any point in this sequence, is ever open
while a network call to a third party is in flight, and no transaction is ever open while
`AuditService` might need a second pool connection it does not have.

**D7d — `AuditService` gains an additive `manager?` parameter so a caller inside a transaction can
write through it instead of opening a second connection.** Confirmed, not assumed: `AuditService`
(`audit.service.ts:48-51`) injects `Repository<AuditLog>` via `@InjectRepository`, and both the read
in `getLastChainHash` (`:531-538`) and the write in `logEvent` (`:82-99`) go through
`this.auditRepo`, unconditionally — there is **no existing path** to run either through a caller's
own `EntityManager`. **Decision: extend the signature additively.**

```ts
async logEvent(dto: LogAuditEventDto, manager?: EntityManager): Promise<AuditLog> {
  const repo = manager ? manager.getRepository(AuditLog) : this.auditRepo;
  // ...unchanged body, with `this.auditRepo` replaced by `repo` throughout,
  // and `getLastChainHash(dto.tenantId)` becoming `getLastChainHash(dto.tenantId, manager)`
}

private async getLastChainHash(tenantId: string, manager?: EntityManager): Promise<string> {
  const repo = manager ? manager.getRepository(AuditLog) : this.auditRepo;
  // ...unchanged body
}
```

**This is additive and safe for every existing caller.** `manager` defaults to `undefined`, in
which case both methods behave exactly as they do today — every other call site in this codebase
(`AcceptanceService.record`, `TenancyService.runAsGod`, `FeeScheduleService`, and every controller
that calls `AuditService.logEvent` directly) is unaffected and needs no change. This is the same
"extend, never replace" posture `CLAUDE.md` §5.5b states for core changes generally, applied to a
shared service instead of a pack vocabulary. **Tenancy is unaffected by routing through
`manager`**: a `QueryRunner`'s `manager` is bound to the request's tenant by the same
`applyRlsToDataSource` mechanism that binds any manually-opened `QueryRunner` — ADR 0010 §1.4 cites
this exact guarantee for `BillingService`'s and `CrmService`'s own `QueryRunner` usage
(`rls.datasource.ts:38-83`, "every connection checkout, including one obtained via a
manually-opened `QueryRunner`... is bound to `TenantContext.get()`'s tenant before it is handed
out") — writing an audit row through `queryRunner.manager.getRepository(AuditLog)` inherits that
binding for free, it is not a new tenancy mechanism.

Every write in D7c's three phases uses this overload, passing that phase's own `queryRunner.manager`
— Phase 1's `refund_pending` audit and Phase 3's `refunded`/failure audit each go through their
own, separate `QueryRunner`'s manager, matching that each is a genuinely separate transaction.
**Fail-closed, per phase, not across all three:** if the audit write inside Phase 1 or Phase 3
throws, **that phase's transaction rolls back** — for Phase 1, no `refund_pending` state is
persisted and no Stripe call is ever made (nothing was authorised, so nothing proceeds); for
Phase 3, the outcome-recording write rolls back, which is a real, named gap (§9): the Stripe
refund (or its failure) already happened in Phase 2 and cannot be undone by a database rollback —
the row would sit at `refund_pending` with no audit of what Stripe actually did, until reconciled.
D7g's webhook is exactly that reconciliation path, so this gap is closed by a second mechanism
rather than left open.

**D7e — partial refunds are out of scope for R1. Full refunds only, stated explicitly.** `settle()`
takes no amount parameter today and this ADR does not add one — Phase 2's `stripe.refunds.create`
refunds the full `PaymentIntent` amount by omitting `amount`. FR-7.10's "refund tracking" is
satisfied for the full-refund case only; a partial refund (crediting part of a professional fee
while the matter continues) is **explicitly deferred**, not silently unhandled — a firm needing one
today issues a `credit_note`-kind ledger entry through the existing mechanism (unchanged by this
ADR) rather than a partial Stripe refund. **Trigger to revisit:** §9.

**D7f — `refund_pending` is a new `PaymentStatus` value, and it needs a migration.** `Payment.status`
is a native Postgres enum, `"payments_status_enum"`, created by
`1755000000000-AddPayments.ts:17-21` as `('pending','paid','failed','refunded','cancelled')` —
`refund_pending` is not among them, so this is a real schema change, not merely a TypeScript
`enum` edit. New migration, following the exact precedent already established three times in this
codebase for the identical situation (`1756200000000-AddSarEntityType.ts`,
`1757100000000-AddIamAuditActions.ts`, `1753700000000-AddEntityLifecycleColumns.ts` — all
`ALTER TYPE ... ADD VALUE IF NOT EXISTS`, each migration doing nothing else, each with a no-op
`down()`):

```ts
// 1757440000000-AddPaymentRefundPendingStatus.ts
export class AddPaymentRefundPendingStatus1757440000000 implements MigrationInterface {
  name = 'AddPaymentRefundPendingStatus1757440000000';
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "payments_status_enum" ADD VALUE IF NOT EXISTS 'refund_pending'`,
    );
  }
  public async down(): Promise<void> {
    // Postgres cannot drop an enum value without recreating the type and every
    // dependent column. An unused value costs nothing — same reasoning as
    // AddSarEntityType/AddIamAuditActions/AddEntityLifecycleColumns.
  }
}
```

`PaymentStatus.REFUND_PENDING = 'refund_pending'` is added to the TypeScript enum
(`payment.entity.ts:25-31`) in the same commit. **`refund_pending` is never a caller-settable
target via `PATCH /payments/:id/settle`** — `SettlePaymentDto.status` still validates against the
full `PaymentStatus` enum (no DTO change needed), but `PaymentsService.settle` refuses (400
`MER-VAL-0001`, "refund_pending is an internal state reached automatically when a refund is
approved — request 'refunded' instead") if a caller names it directly as `dto.status`. It is an
**internal, service-authored** intermediate state, the same "not a state a caller may assert"
posture already applied to `isSignature` elsewhere in this codebase. **Rendering:** `refund_pending`
is neither `paid` nor `refunded` and must render as its own state — "refund in progress," never
collapsed into either neighbour — per the same three-valued-rendering discipline `CLAUDE.md` §5.2
applies everywhere else in this product; noted for Mira in §11.

**D7g — the Connect webhook's `charge.refunded` handler is the reconciliation path for the gap D7d
names.** §2.5's "Handled events" gains a third entry: **`charge.refunded`** (confirmed a real Stripe
event type, `node_modules/stripe/cjs/resources/Events.d.ts:78`, `'charge.refunded'`). On receipt:
resolve the tenant from `event.account` (unchanged mechanism), find the `Payment` row by
`metadata.stripePaymentIntentId` matching the charge's `payment_intent`. **Idempotent, by the same
rule as `checkout.session.completed`:** if the row is already `refunded`, no-op (Stripe's
at-least-once delivery, `stripe.service.ts:127`'s own precedent). If the row is `refund_pending`
(Phase 3 never committed — a function timeout or crash between Phase 2 succeeding and Phase 3's
commit, which is exactly the gap D7d names), this webhook is what finishes the job: write
`status: 'refunded'`, `metadata.stripeRefundId`, and the same `CRITICAL` audit entry Phase 3's
success path would have written, sourced this time from the webhook's own system actor
(`userId: 'system:stripe-webhook'`, matching §2.5's existing convention for the other two handled
events). **This closes the loop honestly rather than leaving a `refund_pending` row that is quietly
wrong forever** — the exact "unknown must never render as settled, and the reverse — settled must
never sit unrendered — is just as much a defect" instinct this whole ADR set is built around.

---

## 3. API contract

| Route | Method | Roles | Notes |
|---|---|---|---|
| `/billing/merchant-account` | GET | `firm_admin`, `staff` | Local projection (§2.3) |
| `/billing/merchant-account/onboarding-link` | POST | `firm_admin` | §2.3. 503 `MER-BILL-0001` if `STRIPE_SECRET_KEY` unset |
| `/billing/merchant-account/refresh` | POST | `firm_admin` | §2.3 |
| `/payments/:id/checkout-link` | POST | `firm_admin`, `staff`, `client` (own payment only) | §2.4. Body: `{ successUrl, cancelUrl }` |
| `/billing/webhook/connect` | POST | `@Public()`, signature-verified | §2.5 |

### DTOs

```ts
export class CreateCheckoutLinkDto {
  @IsUrl() successUrl: string;
  @IsUrl() cancelUrl: string;
}
```

No new DTO for onboarding-link/refresh — no body.

### Responses

- `GET /billing/merchant-account` → `{ status, chargesEnabled, payoutsEnabled, country,
  defaultCurrency, lastSyncedAt }` — **never** the raw `stripeAccountId` to a `staff` caller (no
  operational need to see it; `firm_admin` may, matching the existing distinction elsewhere in
  this product between what `staff` and `firm_admin` may read about firm-level configuration).
- `POST /billing/merchant-account/onboarding-link` → `{ url }`.
- `POST /payments/:id/checkout-link` → `{ url, expiresAt }` (Stripe's own session `expires_at`,
  surfaced so a UI can show "this link expires in 24 hours").

### MER-* errors — new family `MER-BILL-xxxx`

No `MER-BILL` family exists today (`src/common/types.ts:55-112`, confirmed, matching ADR 0009
§2.4's own note that this was true as of its writing and remains true now).

| Code | HTTP | When |
|---|---|---|
| `MER-BILL-0001` | 503 | `STRIPE_SECRET_KEY` unset, or `tenant_merchant_accounts` has no row / `chargesEnabled: false` for this tenant, on any route in §3 that needs to call Stripe on the connected account |
| `MER-BILL-0002` | 400 | `checkout-link` requested for a `feeKind: 'government'` payment (§2.6) |
| `MER-BILL-0003` | 400 | `checkout-link` requested for a payment not in `status: 'pending'` (§2.4) |

`MER-AUTH-0009` (403) and `MER-RES-0001` (404) reused unchanged for role/not-found cases.

---

## 4. Tenancy enforcement per route

| Route | RLS | Service-layer check |
|---|---|---|
| `GET /billing/merchant-account`, `.../onboarding-link`, `.../refresh` | `tenant_merchant_accounts` `ENABLE`+`FORCE` RLS at creation | `@Roles(FIRM_ADMIN)` (write) / `@Roles(FIRM_ADMIN, STAFF)` (read) — no client reach, no own-scope needed (one row per tenant, not per user) |
| `POST /payments/:id/checkout-link` | `payments` table RLS, unchanged | **Reuses `PaymentsService.findOne`'s existing own-scope enforcement** (`payments.service.ts:309-323`) unchanged — a `client` caller gets the identical `forceClientId` treatment already proven for `GET /payments/:id`, extended to this new route rather than reimplemented. 404, not 403, for a payment that is not the caller's own |
| `PATCH /payments/:id/settle` (existing route, decision logic amended, §2.7) | `payments` table RLS, unchanged | `@Roles(PLATFORM_ADMIN, FIRM_ADMIN, STAFF)` decorator **unchanged** (D7a — narrowing it would break legitimate non-refund transitions for `staff`). **New service-level check**: `dto.status === 'refunded' && !actor.roles.includes(FIRM_ADMIN)` → 403 `MER-AUTH-0009`, run inside Phase 1's locked transaction (§2.7c), before the row is marked `refund_pending` and before any Stripe call — this is the fix for the pre-existing role gap named in this ADR's amendment header |
| `POST /billing/webhook/connect` | N/A — no tenant JWT | Tenant resolved server-side from `event.account` (§2.5), never from any caller-supplied value. Runs inside `TenantContext.runAsSystem`, matching `StripeService.handleWebhook`'s existing pattern exactly — this is not a new tenancy mechanism, it is the proven one reused for a second event stream. **Reachability confirmed, not assumed:** `rawBody: true` is set at `NestFactory.create(AppModule, { rawBody: true })` in **both** `src/main.ts:15` and `api/index.js:214` (confirmed by direct read of both files) — this is an app-bootstrap-level option, not per-route middleware, so a new `@Post('webhook/connect')` route needs no additional raw-body wiring in either environment, exactly as the existing `StripeWebhookController` (`stripe-webhook.controller.ts`) already proves for `/billing/webhook`. **The gate that actually matters is still booting the compiled app and grepping `Nest application successfully started`** (`CLAUDE.md` §8.2/§8.6) after wiring the new controller into `BillingModule` — confirming the flag is set is necessary but not sufficient; confirming the module resolves and the route registers is the real proof, per ADR 0020's identical gate |

---

## 5. Audit events

**Amended per §2.7 — `settle()` moves from zero audit coverage to full coverage as part of this
ADR, not as a separate follow-up.** Every row below sourced `userId`/`userEmail` from the acting
`Actor` (the authenticated caller for `firm_admin`/`staff`-driven rows; a fixed
`system:stripe-webhook` marker for the three webhook-driven rows, since Stripe carries no Meru
identity — matching `StripeService.handleWebhook`'s existing `TenantContext.runAsSystem` posture
for the platform webhook). **The refund transition is now three separate audit writes across three
separate database transactions (§2.7c/§2.7d), not one** — this is the direct consequence of the
`max: 1` pool redesign, and the table below reflects that structure rather than a single row.

| Event | Action | Severity | Context |
|---|---|---|---|
| `POST .../onboarding-link` | `CREATE`/`UPDATE` | `WARNING` | `{ stripeAccountId }` — connecting a firm's bank/merchant relationship is higher-stakes than an ordinary settings write, matching the severity ADR 0019 gives template publishing |
| `account.updated` (webhook) | `UPDATE` | `INFO` | `{ status, chargesEnabled, payoutsEnabled }` — routine sync, matches `StripeService`'s own subscription-sync severity choice (unaudited there; this ADR chooses to audit it, a stricter posture, because money movement capability turning on/off is more consequential than a subscription tier changing) |
| `checkout.session.completed` (webhook, payment marked paid) | `UPDATE` | `INFO` | `{ paymentId, amountMinor, currency, feeKind, method }` |
| `PATCH /payments/:id/settle` — **every** transition (`pending→paid`, `pending→failed`, `pending→cancelled`, `failed→paid`, `failed→pending`) other than `refunded` | `UPDATE` | `INFO` | `{ beforeStatus, afterStatus, amountMinor, currency, feeKind, reason }` — **new coverage, §2.7d; `settle()` wrote no audit event at all before this ADR**. Written via `AuditService.logEvent(dto, queryRunner.manager)`, the single-transaction case (§2.7c step 5) |
| `PATCH /payments/:id/settle` → `refunded`, **Phase 1** (`paid → refund_pending`) | `UPDATE` | **`CRITICAL`** | `{ beforeStatus: 'paid', afterStatus: 'refund_pending', amountMinor, currency, feeKind, reason }` — the authorisation-to-attempt-a-refund event, written through Phase 1's `queryRunner.manager` (§2.7c step 6/§2.7d), **before** Stripe is ever called. Fail-closed **within Phase 1 only**: if this write throws, Phase 1 rolls back and Stripe is never called |
| Phase 3 success (`refund_pending → refunded`) | `UPDATE` | **`CRITICAL`** | `{ beforeStatus: 'refund_pending', afterStatus: 'refunded', stripeRefundId }` — written through Phase 3's own, separate `queryRunner.manager` (§2.7c), after Stripe has already confirmed the refund |
| Phase 3 failure (`refund_pending → paid`, reverted) | `UPDATE` | `WARNING` | `{ beforeStatus: 'refund_pending', afterStatus: 'paid', lastRefundError }` — a failed refund attempt is a warning, not a critical, because no money actually moved |
| `charge.refunded` (webhook, reconciling a Phase 3 that never committed) | `UPDATE` | **`CRITICAL`** | `{ paymentId, stripeRefundId }` — §2.7g. Same severity as Phase 3 success, since it is the identical terminal event reached by a second path |
| Receipt auto-generation failure (§2.5) | not a state-changing audit event — `Logger.warn` server-side, matching ADR 0019's identical choice for a rejected `locked`-block edit (a failure, not a decision, does not need audit-log volume) |

---

## 6. Pack keys touched

None, directly. This ADR reads `fees[].kind`/`feeKind` (already core vocabulary, §2.6) and, on
successful payment, optionally reads `documentTemplates[]` for a `receipt` key (ADR 0019,
already-declared array — no schema change). No new pack array, no new pack schema field.

---

## 7. Options rejected

| Option | Why rejected |
|---|---|
| Destination charges (money lands on the platform account, then transfers to the connected account) instead of direct charges | Puts client money on Meru's own Stripe balance, if only transiently — exactly the "trust-adjacent money on your balance sheet" warning BUSINESS.md §5.6 states, and the reason the whole `payments` table's doc comment (`payment.entity.ts:34-36`) already names Connect as the correct-but-undone answer |
| Express or Custom Connect accounts | Both put the platform further into Stripe's KYC/compliance surface than Standard does, with no stated product requirement that needs the extra control either buys (§2.1) |
| A hardcoded `application_fee_amount` (platform takes a cut of every client payment) | BRD §11 D-2 is an open business decision; hardcoding an answer nobody has given is inventing a business decision, not architecture |
| A per-tenant surcharge percentage field, gated `if (tenant.country === 'AU') refuse` | A conditional check is a control that can be missed for a new country or a misconfigured tenant; not building the field at all is a structural guarantee, and BR-5 asks for the guarantee, not the check (§2.4) |
| Gate government-fee collection on `vacSettlementMode` rather than a blanket `feeKind` refusal | Reads immigration vertical vocabulary from a core billing module — the exact 80/20 violation `CLAUDE.md` §5.5 exists to prevent (§2.6) |
| Reuse the existing `/billing/webhook` endpoint for Connect events too, distinguished by payload shape | Stripe recommends and this codebase's own `StripeService` precedent assumes one endpoint per event stream with its own signing secret; conflating them means one compromised/misrouted secret affects both the platform's own subscription billing and every tenant's client-payment collection |
| Build a fully custom card-collection form instead of Stripe Checkout | Directly violates FR-7.13 ("the application never sees a card number... hosted or redirect flow only") — not a close call |
| One `QueryRunner` transaction held open from the row lock through the Stripe call to the final write (this ADR's own first draft) | Deadlocks under the `max: 1` connection pool the moment `AuditService.logEvent` — which opens its own connection — is called from inside it; found on review, corrected in §2.7c–§2.7g |
| A version-column-based optimistic lock instead of `SELECT ... FOR UPDATE` | Requires `SettlePaymentDto` to carry `expectedVersion`, a breaking change to an already-live route for every transition, not just refund (§2.7c's D7c/D7d reasoning, unchanged by the redesign) |

---

## 8. Consequences

1. One new RLS-carrying table — run `npm run rls:verify` after the migration.
1a. **A second new migration** (`AddPaymentRefundPendingStatus`, §2.7f) — additive to
   `payments_status_enum`, no-op `down()`, matching three existing precedents in this codebase for
   the identical situation.
1b. **`AuditService` itself changes** (§2.7d) — an additive, backward-compatible signature change
   to a shared core service used well beyond this ADR's scope. Low risk (every existing call site
   is unaffected by construction), but it is a change to a file every other module's audit trail
   depends on, and deserves its own explicit review attention rather than being read as "just
   payments work."
2. A **second Stripe webhook endpoint** must be registered in the Stripe dashboard (platform-side
   operator action, not code) once `STRIPE_CONNECT_WEBHOOK_SECRET` exists — this is an operator
   step, named explicitly so it is not forgotten the way `CRON_SECRET`'s registration once was.
3. `PaymentsService.settle` gains a conditional Stripe call (§2.7) — its existing "no processor
   involved" doc comment (`:28-36`) becomes **partially wrong** the moment this ships and must be
   corrected in the same commit, or a future reader will trust a comment describing behaviour this
   ADR deliberately changes.
4. **Every payment collected through this ADR is, for the first time in this product, real money
   movement Meru's own code triggers** (previously: record-only). This is the single highest-risk
   change in this set of four ADRs and the one most deserving of Anton's full review — a bug here
   is a customer's client being charged wrong, twice, or not refunded when Stripe was.
5. BRD §11 D-2 remains open; this ADR ships with the only defensible default (zero platform fee)
   and a stated, inert extension point (§2.4) rather than blocking on a decision this document is
   not positioned to make.

---

## 9. What would make this wrong later

| Trigger | Invalidates | What to do |
|---|---|---|
| BRD §11 D-2 is resolved ("Meru takes X% of client payments") | D4's zero-application-fee default | Set `STRIPE_CONNECT_APPLICATION_FEE_BPS`; the code path already reads it (§2.4) — no redesign |
| A firm genuinely needs `firm_pays_on_behalf` government-fee collection via card | D6's blanket refusal | Add a **pack-declared** flag (e.g. `fees[].collectibleViaLink: boolean`, vertical/pack-owned, not a core read of `vacSettlementMode`) — extends D6 without violating §5.5 |
| GovernanceX needs the identical merchant-account/checkout-link capability | Nothing structural — `tenant_merchant_accounts`, `feeKind`, and the checkout-link route are all already vertical-neutral core concepts | Verify against a GRC tenant per `CLAUDE.md` §5.5b's stacking rule before assuming it "just works"; no redesign expected |
| Stripe deprecates or materially changes Standard Connect account semantics | D1 | Re-derive from Stripe's then-current documentation; do not assume this ADR's characterisation of Standard vs Express/Custom stays accurate indefinitely — flagged `[UNVERIFIED]` at §2.1 for exactly this reason |
| A firm wants instalment auto-retry on a failed BECS debit (BECS settlement can fail days after collection, unlike card) | Nothing in this ADR handles a **post-success** BECS failure (`charge.dispute.created`/late failure events) | This is a real gap this ADR does not close — add the relevant Connect webhook events (`charge.failed` after a `checkout.session.completed` already marked `paid`) as a follow-up, transitioning `paid → failed` with a clear "payment was reversed after initial success" audit trail, not silently leaving a `paid` row that is no longer true |
| A firm needs to refund part of a professional fee, not the whole payment | D7e's full-refund-only scope | Add an `amountMinor` field to `SettlePaymentDto`, validated `<= payment.amountMinor`, passed as `stripe.refunds.create`'s own `amount` parameter — additive to D7c's call shape, not a redesign of the lock/idempotency/audit machinery around it |
| Phase 3 (§2.7c) never commits — the process crashes or times out after Stripe confirms the refund but before the local write lands, and `charge.refunded` (§2.7g) is somehow never delivered or never processed (webhook outage, a bug in the handler) | D7d's stated gap, currently mitigated only by the webhook | Add a reconciliation job (matching every other `/jobs/*` scheduled-job pattern in this codebase) that periodically compares Stripe's own refund list for each tenant's connected account against local `payments` rows stuck at `refund_pending` beyond some age threshold, and flags any mismatch for manual review — a second, independent safety net beyond the webhook, not a replacement for it |

---

## 10. Rollback

| Change | Rollback | Data left behind |
|---|---|---|
| `tenant_merchant_accounts` (migration `AddTenantMerchantAccounts`) | `DROP TABLE tenant_merchant_accounts` | Any tenant that completed Connect onboarding loses the local record of it — **the Stripe connected account itself is untouched** (rollback is a Meru-side data change, not a Stripe-side deprovisioning); a re-run of onboarding-link would create a *second* Stripe account for the same firm unless the old `stripeAccountId` is recovered from Stripe's own dashboard first. **Confirm no tenant has an active connected account before dropping**, or hand-restore the row from Stripe's account list |
| New routes (§3) | Remove them | None |
| `PaymentsService.settle`'s Stripe-refund branch (§2.7) | Revert to record-only behaviour | A refund approved after rollback is recorded locally but **not actually returned via Stripe** — this is a real operational gap during any rollback window and must be flagged to firm_admins immediately if it happens, not silently reverted |
| `/billing/webhook/connect` | Remove the route; **de-register the endpoint in Stripe's dashboard** (operator action) so Stripe stops retrying delivery against a 404 | Any event Stripe sent during the gap between de-registering and confirming is lost — Stripe's own retry/event-log (available in their dashboard for 30 days) is the recovery path, not a Meru-side backfill |
| `payments_status_enum` gains `refund_pending` (migration `AddPaymentRefundPendingStatus`, §2.7f) | No-op `down()`, matching the established precedent for every prior enum-value addition in this codebase (`AddSarEntityType`, `AddIamAuditActions`, `AddEntityLifecycleColumns`) — Postgres cannot cheaply drop an enum value | An unused enum value if this feature is rolled back — **check for any row still sitting at `refund_pending` before rolling back the code that transitions out of it**, or that row becomes permanently stuck with no code path left to resolve it |
| `AuditService.logEvent`'s additive `manager?` parameter (§2.7d) | Revert the signature; every existing call site (all of which pass no second argument) is unaffected either way | None — purely additive, so reverting it is safe regardless of what else has or has not been rolled back |

**Rollback verification:** for the `tenant_merchant_accounts` drop specifically, query
`SELECT COUNT(*) FROM tenant_merchant_accounts WHERE "chargesEnabled" = true` first — that is
every tenant currently able to collect real client money, and each one needs to be told before
their onboarding link and payment history disappear from their own settings screen.

---

## 11. Implementation briefs

### For Luke (backend)

- **Migration** `1757420000000-AddTenantMerchantAccounts.ts` per §2.2. `down()` drops the table.
- **Entity** `TenantMerchantAccount` in `src/billing/entities/`, registered in
  `src/config/entities.ts` (§16's recurring registration defect class — do not skip this).
- **New `StripeConnectService`** in `src/billing/`, separate class from `StripeService` (not a
  method added to it — the doc-comment confusion §1.1 exists to prevent is worth a file boundary,
  not just a section heading). Methods: `createOnboardingLink`, `getMerchantAccount`,
  `refreshMerchantAccount`, `createCheckoutLink(paymentId, urls)`, `handleConnectWebhook(rawBody,
  signature)`, `refundViaStripe(payment, { stripeAccountId })` (called from
  `PaymentsService.settle`'s **Phase 2**, §2.7c — with no database transaction open while this
  runs; inject `StripeConnectService` into `PaymentsService`, not the other way, since
  `PaymentsService` owns the two `QueryRunner`s either side of the call).
- **New `StripeConnectWebhookController`** (`@Controller('billing/webhook/connect')`), mirroring
  `StripeWebhookController` exactly (`stripe-webhook.controller.ts` — read it before writing this
  one; do not guess the raw-body handling). **Raw-body reachability is confirmed already** (§4) —
  `rawBody: true` is set at the Nest bootstrap level in both `main.ts:15` and `api/index.js:214`,
  so no per-route raw-body wiring is needed in either environment. **What is not yet confirmed, and
  is the actual gate:** after wiring `StripeConnectWebhookController` and `StripeConnectService`
  into `BillingModule`, run `SKIP_CONFIG_PACK_LOADER=true JWT_SECRET=x node dist/src/main.js` (build
  first) and grep for **`Nest application successfully started`** — do this before considering the
  webhook route done, per `CLAUDE.md` §8.2/§8.6 and matching ADR 0020's identical gate.
- **`AuditService`** (`src/audit/audit.service.ts`): add the additive `manager?: EntityManager`
  parameter to `logEvent` and thread it into the private `getLastChainHash` (§2.7d). **This is a
  shared core service** — every existing caller (`AcceptanceService`, `TenancyService.runAsGod`,
  every controller calling `logEvent` directly) must keep working unchanged, since none of them
  pass the new parameter. Add a unit test asserting `logEvent(dto)` with no `manager` behaves
  identically to today, and a second asserting `logEvent(dto, someManager)` writes through that
  manager's repository instead of the injected one.
- **`PaymentsService`**: inject `AuditService`, `DataSource` and `StripeConnectService` (new
  constructor dependencies, `AuditService` matching `FeeScheduleService`'s existing precedent, ADR
  0009 §2.4). Rewrite `settle` per §2.7c/§2.7d/§2.7f/§2.7g in full — **three phases, not one**:
  - **Non-refund transitions, and a refund of a non-Stripe-collected payment (`providerRef` null):**
    unchanged single-transaction shape — open a `QueryRunner`, `SELECT ... FOR UPDATE` (raw query
    via `queryRunner.query`, matching ADR 0010 §2.2's own idiom), re-check the transition against
    the **locked** row, write status + audit (via the new `manager` overload) inside that one
    transaction, commit.
  - **A refund of a Stripe-collected payment (`providerRef` set):** **three separate steps, per
    §2.7c** — Phase 1 (`QueryRunner` #1: lock, check role/transition, write `refund_pending` +
    `CRITICAL` audit, commit, **release**); Phase 2 (**no transaction, no `QueryRunner` open**:
    call `stripeConnect.refundViaStripe(payment, { idempotencyKey: `refund:${payment.id}` })`);
    Phase 3 (`QueryRunner` #2, a **fresh** one: re-lock the same row, write `refunded` + `CRITICAL`
    audit on Stripe success, or revert to `paid` + `lastRefundError` metadata + `WARNING` audit on
    Stripe failure, commit, release). **Do not hold `QueryRunner` #1 open across the Stripe call —
    this is the bug the whole redesign exists to fix.**
  - `SettlePaymentDto.status === PaymentStatus.REFUND_PENDING` from an external caller is refused
    (400 `MER-VAL-0001`) — it is an internal, service-authored intermediate state (§2.7f).
  - **Update the class's own doc comment** (`:28-36`, "No payment processor is involved, by
    design") in the same commit — it is no longer accurate once this ADR ships (§8 item 3).
- **Migration** `1757440000000-AddPaymentRefundPendingStatus.ts` per §2.7f — `ALTER TYPE
  "payments_status_enum" ADD VALUE IF NOT EXISTS 'refund_pending'`, no-op `down()`, matching the
  three existing precedents named in §2.7f exactly. Add `PaymentStatus.REFUND_PENDING` to
  `payment.entity.ts`'s enum in the same commit.
- **`StripeConnectWebhookController`**'s handler gains the `charge.refunded` case (§2.7g/§2.5) —
  idempotent on an already-`refunded` row, otherwise completes the Phase 3 write via the webhook's
  own system-actor audit context.
- `payment_method_types` (§2.4): **resolved, not `[UNVERIFIED]`** —
  `'au_becs_debit'` is confirmed present in
  `Stripe.Checkout.SessionCreateParams.PaymentMethodType`,
  `node_modules/stripe/cjs/resources/Checkout/Sessions.d.ts:2887`, against the installed
  `stripe@22.4.0`. Re-confirm against whatever version is actually installed at implementation time
  if the lockfile has moved since this review.
- `session.payment_intent` (§2.5/§2.7c): **resolved, not `[UNVERIFIED]`** — present directly on the
  Checkout Session object (`Sessions.d.ts:215`, `payment_intent: string | PaymentIntent | null`),
  populated on the `checkout.session.completed` webhook payload with no `expand` needed. Store it in
  `payment.metadata.stripePaymentIntentId` at webhook-handling time (§2.5); read it from there at
  refund time — do not add a second Stripe read.
- Test: `settle` service-level role check — a `staff` token attempting `paid → refunded` gets 403,
  a `firm_admin` token succeeds. This is the BLOCKER fix (§2.7a) and must be tested explicitly, not
  inferred from the decorator.
- Test: two concurrent `settle` calls on the same payment (same or different target status) — assert
  the `FOR UPDATE` lock serialises them and the second sees the first's already-applied state when
  its own transition check runs (i.e., a second concurrent refund attempt on an already-`refund_pending`
  or `refunded` payment fails the allowed-transition check, not a duplicate Stripe call).
- Test: an `AuditService.logEvent` failure inside **Phase 1** rolls back Phase 1 — assert the
  payment's `status` stays `paid` (not `refund_pending`) and `stripeConnect.refundViaStripe` is
  never called. A **separate** test: an `AuditService.logEvent` failure inside **Phase 3** rolls
  back only Phase 3's write — assert the payment is left at `refund_pending` (not reverted to
  `paid`, since the Stripe refund genuinely succeeded) with no audit row for the outcome, and that
  a subsequent `charge.refunded` webhook delivery correctly completes it.
- Test: two concurrent Connect webhook deliveries for the same `checkout.session.completed` (Stripe's
  own retry behaviour) must not double-mark a payment or throw on the second delivery — assert
  idempotency explicitly, not just by inspection. Repeat for `charge.refunded`.
- **Test, specifically for the bug this redesign fixes:** call `AuditService.logEvent` from inside
  an open `settle` `QueryRunner` transaction using the **old**, no-`manager` call shape and confirm
  it would hang/deadlock against a `max: 1`-configured test pool — or, more practically, assert by
  code review / a DI-graph check that no code path in the final implementation calls
  `AuditService.logEvent` without passing `manager` from inside any open transaction. This is the
  one regression this whole amendment exists to prevent; do not skip verifying it.
- Test: a `client` token requesting a checkout-link for another client's payment id gets 404 —
  reuses `PaymentsService.findOne`'s existing coverage; confirm it, do not assume it transfers.

### For Mira (frontend)

- Settings → Billing gains a **second, visually distinct section**: "Client payments" (Stripe
  Connect status, onboarding-link button, `chargesEnabled`/`payoutsEnabled` badges using the same
  `unconfigured/pending/active/restricted` vocabulary as everywhere else honest-degradation is
  rendered) — kept structurally separate from the existing subscription-billing section
  (`/billing/checkout`, `/billing/portal`), per PL-28/FR-2.8's explicit requirement that these two
  financial connections are never visually conflated. **Do not reuse one card/section for both.**
- On a payment row (client detail, case detail, payments list), "Raise payment" → after creation,
  a "Get payment link" action calls `POST /payments/:id/checkout-link` and either copies the URL or
  opens it — disabled with an explanation when `GET /billing/merchant-account` reports anything
  other than `active`/`chargesEnabled: true` (never a dead button with no reason, per the no-slop
  standard).
- Client portal "Pay now" (FR-9.6/E21): same route, `client` role, scoped automatically server-side
  — the frontend does not need its own ownership check, but must still handle the 404 case (a
  stale/cached payment id that is no longer the client's) as "not found," not a crash.
- A government-fee payment row **never shows a "Pay now"/checkout-link button at all** — the 400
  `MER-BILL-0002` case should not even be reachable from the UI; render the existing evidentiary
  flow (§2.6, `vacStatus`) for that row instead, unchanged from today.
- **`status: 'refund_pending'` (§2.7f) is a new, real value `GET /payments` and `GET /payments/:id`
  can now return.** Render it as its own state — "Refund in progress" — never collapsed into
  `paid` (it is not still owed) or `refunded` (the money has not moved yet, or the attempt may still
  fail). A firm querying "why hasn't this shown as refunded yet" needs a state to look at, not a
  status that quietly looks like either neighbour — the same three-valued-rendering discipline
  `CLAUDE.md` §5.2 applies everywhere else in this product.
- BECS is presented as the **default/first** option wherever a payment method choice is shown
  before redirecting to Stripe Checkout, for AU tenants — matching the `payment_method_types`
  ordering (§2.4) and the operator's explicit "default nudge" instruction.
- Five states per definition-of-done: empty (no merchant account connected — clear call to action,
  not a blank payments-collection area), loading, error (Stripe onboarding interrupted/failed —
  `refresh` action visible), populated, overflowing (a firm with a long payment history — paginate
  the payments list, unchanged from existing behaviour, just confirm it still holds with checkout
  links added to each row).
