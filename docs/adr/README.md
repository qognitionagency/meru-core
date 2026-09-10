# Architecture Decision Records

There was no ADR directory in this repo before 2026-09-03. This proposes the convention.

## Naming

`NNNN-kebab-case-title.md`, zero-padded to four digits, allocated in order. Never renumber
a merged ADR — a stale link to `0007` must not resolve to a different decision.

> **0008 is the one exception, and the reason for this rule.** `0008-vac-payment-integrity.md`
> was drafted as `0001` on a since-superseded branch (`fix/crm-entity-actor-scoping`) that never
> reached `main`, in parallel with an unrelated `0001-practice-role-tags.md` that did. It was
> rescued and renumbered to `0008` on merge into `main` rather than left to collide — see its
> own rescue note. It was never published under `0001` anywhere a link could have formed, which
> is why this was safe to do once and must not be repeated.

## Required sections

1. **Status** — Proposed | Accepted | Implemented | Superseded by NNNN. Dated.
2. **Context** — what forced the decision, with `file:line` or an `/api-json` path for
   every load-bearing claim. Anything unverified is marked `[UNVERIFIED: <thing>]` inline.
3. **Decision** — one sentence per decision, then the detail.
4. **Options rejected** — and why. The rejected option is the part future readers need.
5. **Consequences** — including the unpleasant ones.
6. **What would make this wrong later** — the trigger to revisit. Without this it is a
   record, not a decision.
7. **Rollback** — in this document, not a separate one.

## Scope

An ADR belongs here when the decision is expensive to reverse: schema, tenancy, auth,
anything on a public API, anything touching the pack contract. Decisions that span
`meru-core`, `packages/config-packs` and a frontend app live here because the pack and the
core both live in this repo; the frontend app docs link to the ADR rather than restating it.

## Index

Verified against `docs/adr/` on disk, 2026-09-10.

| # | Title | Status | Owner |
|---|---|---|---|
| [0001](0001-practice-role-tags.md) | Practice roles as additive vertical tags on `User` | **Accepted** — executable contract | Kyle (architect); implementation Luke; gate Owen |
| [0002](0002-neon-auth-federation.md) | Neon Auth federation (post-pilot) | Proposed — 2026-09-05, not merged | Requires `secops` (Anton) + `quality` (Owen) review |
| [0003](0003-ai-provider-abstraction.md) | Platform AI provider abstraction, and three agentic features | Proposed — 2026-09-05, not merged | Requires `quality` (Owen), and `secops` (Anton) for the audit/citation write path |
| [0004](0004-upstash-redis-qstash.md) | Upstash Redis (REST) for rate limiting, revocation and idempotency; QStash as the minute scheduler | Proposed — 2026-09-05, not merged | Requires `quality` (Owen); `secops` (Anton) for revocation/idempotency |
| [0005](0005-communications-thread-scoping.md) | Communications thread scoping: ratify what shipped, close what did not | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0006](0006-operator-invite-link.md) | Operator invite-link retrieval and regeneration | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0007](0007-operator-console-and-record-lifecycle-contracts.md) | Operator console and record-lifecycle contracts | Proposed — 2026-09-05, not merged | Requires `quality` (Owen) + `secops` (Anton) |
| [0008](0008-vac-payment-integrity.md) | VAC and payment integrity (ImmiStack Tier 1.1–1.4) | **Implemented** (core) — `vacStatus`, `vacSettlementMode`, field-level immutability, first `rules[]` entry and the `BackfillVacStatus` migration are on `main` and applied to production. Card-authority/PAN redaction (§4.3) and the duty floor (§4.5) not found in `src`/`packages` as of 2026-09-08 — still open | Rescued from a superseded branch; not formally re-gated by Owen against this document |
| [0009](0009-operator-console-and-tenant-lifecycle.md) | Operator console, tenant lifecycle, and fee-schedule contracts | Proposed — 2026-09-08, not merged | Adopts 0007 D2 (tenant deletion) and D7 (documents/job-run) rather than re-deciding them; adds operator entitlements and runtime fee overrides. Requires `quality` (Owen) + `secops` (Anton) |
| [0010](0010-client-and-case-numbering.md) | Client and case numbering (FR-4.10, FR-5.4) | **Backend implemented, uncommitted** — 2026-09-10. Not merged, not deployed | `recordNumber` + `tenant_record_counters` + the atomic claim, with a concurrency spec. **One extension beyond the ADR text:** `ImportService.commit` numbers its rows too (a third producer the ADR does not name) — Kyle to confirm. `generateInvoiceNumber`'s race untouched, per §1.2. Frontend read sites (§7 item 6) are Mira's, not done. Requires `quality` (Owen) + `secops` (Anton) |
| [0011](0011-record-identity-and-unnamed-client-contract.md) | Record-identity contract: producers, guarantees, and the "unnamed client" renderer (FR-4.9) | **Server half implemented, uncommitted** — 2026-09-10. Frontend half NOT started | D3 (pack-load rejection) and D4's search-index title chain are in. **D1's `leads.service.ts` lift and D4's ten render sites are Mira's and are the half that actually stops new unnamed records.** D5 produces no code by design. Requires `quality` (Owen) + `secops` (Anton) for the pack-loader rejection path |
| [0012](0012-better-auth-adoption.md) | Better Auth: decline replacement, defer partial adoption behind the ADR 0002 seam | Proposed — 2026-09-10, not merged | Corrects two of 0002's `[UNVERIFIED]` items; freezes the `scopeOf` contract as a written invariant. Requires `secops` (Anton) + `quality` (Owen) |
| [0013](0013-immistack-vertical-database.md) | ImmiStack's own database: what stays on the control plane, and what has to be true before `forVertical()` is activated | Proposed — 2026-09-10, not merged | Blocks activation on a Neon repoint; `audit_logs` never splits. Requires `secops` (Anton) + `quality` (Owen) |

**Reading `main`'s money model:** the ADR to cite for `vacStatus`, `vacSettlementMode`,
card-authority/PAN redaction and the duty floor is **0008**, not 0001. `0001` is the practice-role
tagging decision and has nothing to do with payments.

**0009 depends on 0007.** Both are Proposed, not merged. 0009's Contracts 1 and 3 restate 0007's
D2 and D7 with current line numbers and one correction (the job-dispatch extraction 0007 did not
specify); implement 0007 and 0009 together, not 0009 alone against a codebase where D2/D7 never
landed.

**0012 does not supersede 0002.** 0002 decided the *shape* of federation (Neon Auth authenticates,
Meru issues the session); 0012 answers the separate question of adopting Better Auth **directly**,
declines replacement, and corrects 0002 §1.1's two `[UNVERIFIED]` capability gaps — custom claims
and SAML are properties of Neon's *managed* wrapper, not of Better Auth itself. Read 0002 first;
0012 assumes it.

**0012 and 0013 are independent decisions sharing one constraint:** identity and the tenant's
vertical must be resolvable before anything else runs. That is why 0012 D3 freezes the token's
claim set and why 0013 D1 keeps `tenants`, `users` and `sessions` on the control plane
permanently — the same mechanical fact stated from two directions.
