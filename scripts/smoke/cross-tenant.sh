#!/bin/bash
# The test that matters: two real tenants over HTTP, each with a valid token.
# Tenant A must not be able to see or touch tenant B's data by any route.
#
# Usage:  ./scripts/smoke/cross-tenant.sh                    # local
#         BASE_URL=https://meru-core.vercel.app  ...         # deployed
B="${BASE_URL:-http://localhost:8000}/api/v1"
pass=0; fail=0
echo "Target: $B"
ok(){ printf "  PASS  %s\n" "$1"; pass=$((pass+1)); }
no(){ printf "  FAIL  %s — %s\n" "$1" "$2"; fail=$((fail+1)); }
jqid(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(eval('j'+process.argv[1])||'')}catch(e){console.log('')}})" "$1"; }

# ── Operator session, for minting signup invites (DEF-1) ─────────────────────
#
# `POST /tenants/signup` now requires a `token` minted by
# `POST /tenants/invitations` (platform_admin only). Before this block, this
# script called signup with no token: both calls 400'd, $TOKA/$TOKB came back
# empty and the run died at "cannot continue" — a BOOTSTRAP failure, not a red
# test, so the only endpoint-level "valid token, wrong tenant" suite in the repo
# went quiet rather than going red. Do not let that shape recur: if this section
# cannot get an operator session it must FAIL LOUDLY, never skip.
#
# `SWEEP_EMAIL`/`SWEEP_PASSWORD` is the same operator-credential convention
# `scripts/smoke/api-sweep.js` already uses; one of the three sweep accounts is
# platform_admin. Nothing is defaulted — a committed credential on a tenant
# nobody can delete is exactly the trap the password note below records.
OP_TOKEN=""
op_login() {
  if [ -z "$SWEEP_EMAIL" ] || [ -z "$SWEEP_PASSWORD" ]; then
    echo "SWEEP_EMAIL / SWEEP_PASSWORD are not set."
    echo "This script provisions two probe tenants, and POST /tenants/signup"
    echo "requires an invite token minted by a platform_admin (DEF-1)."
    echo "Export a platform_admin's credentials, or pre-mint two tokens and"
    echo "export XT_INVITE_TOKEN_A / XT_INVITE_TOKEN_B instead."
    return 1
  fi
  local l=$(curl -s -m 45 -X POST "$B/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SWEEP_EMAIL\",\"password\":\"$SWEEP_PASSWORD\"}")
  OP_TOKEN=$(echo "$l" | jqid "?.data?.access_token")
  [ -n "$OP_TOKEN" ]
}

mkinvite() { # email -> raw signup token
  # The raw token comes back in the response body as well as the email — see
  # `TenantProvisioningService.mintSignupInvite`. Without that, the token would
  # exist only inside a message this script cannot read, and there would be no
  # way to provision a probe tenant at all.
  local r=$(curl -s -m 45 -X POST "$B/tenants/invitations" \
    -H "Authorization: Bearer $OP_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\"}")
  echo "$r" | jqid "?.data?.token"
}

mktenant() { # slug-prefix [pre-minted token] -> "tenantId token slug"
  # Password used to be the committed literal "ProbePassw0rd!23". This script's
  # own usage comment above says to point BASE_URL at production, and there is
  # still no DELETE /tenants/:id (AGENTS.md — two sweep-pilot-* tenants already
  # stuck this way), so a probe tenant created against prod is not reliably
  # cleaned up. A password fixed in git history would then sit on a real,
  # still-existing tenant forever. Generated per run instead — the account is
  # created and used inside this same invocation, so nothing downstream needs
  # it to be memorable or stable. /iam/dto password rule is MinLength(8) only
  # (create-tenant.dto.ts), so 32 hex chars clears it with room to spare.
  local slug="$1-$RANDOM" email="$1-$RANDOM@probe.test"
  local pw="Px1_$(openssl rand -hex 16 2>/dev/null || echo "${RANDOM}${RANDOM}${RANDOM}${RANDOM}")"

  # An invite is minted for THIS address: `usedAt` makes it single-use and the
  # invite pins the redeeming email, so the two probe tenants cannot share one.
  local invite="$2"
  [ -z "$invite" ] && invite=$(mkinvite "$email")
  if [ -z "$invite" ]; then echo "  "; return; fi

  local s=$(curl -s -m 45 -X POST "$B/tenants/signup" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"slug\":\"$slug\",\"vertical\":\"immigration\",\"firstName\":\"A\",\"lastName\":\"B\",\"email\":\"$email\",\"password\":\"$pw\",\"token\":\"$invite\"}")
  # Single envelope: `{ data: { tenant, user, ... } }`. This used to read
  # `data.data.tenant.id` because the handler self-wrapped in `{success,data}`
  # and the interceptor then wrapped that again. That double envelope is gone.
  local tid=$(echo "$s" | jqid "?.data?.tenant?.id")
  local l=$(curl -s -m 45 -X POST "$B/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$pw\"}")
  local tok=$(echo "$l" | jqid "?.data?.access_token")
  echo "$tid $tok $slug"
}

echo "── Provisioning two tenants ───────────────────────────────"
# Pre-minted tokens win, so this suite can also run where an operator password
# is not available to the runner (a CI job holding two short-lived tokens as
# secrets rather than a long-lived credential).
if [ -z "$XT_INVITE_TOKEN_A" ] || [ -z "$XT_INVITE_TOKEN_B" ]; then
  # A bootstrap failure must be counted as a FAILURE, not a quiet exit. The
  # DEF-1 regression that killed this suite exited 1 from the block below with
  # `0 passed, 0 failed` printed above it — which reads like a suite that had
  # nothing to do rather than one that could not start.
  op_login || {
    no "operator session" "SWEEP_EMAIL/SWEEP_PASSWORD unusable — cannot mint signup invites"
    echo "══ $pass passed, $fail failed ══"
    exit 1
  }
  ok "operator session for invite minting"
fi
read TA TOKA SLUGA <<< "$(mktenant xt-alpha "$XT_INVITE_TOKEN_A")"
read TB TOKB SLUGB <<< "$(mktenant xt-bravo "$XT_INVITE_TOKEN_B")"
[ -n "$TA" ] && [ -n "$TOKA" ] && ok "tenant A $TA" || no "tenant A" "signup/login failed"
[ -n "$TB" ] && [ -n "$TOKB" ] && ok "tenant B $TB" || no "tenant B" "signup/login failed"
[ -z "$TOKA" ] || [ -z "$TOKB" ] && {
  no "bootstrap" "could not provision both probe tenants — every isolation check below is UNRUN, not passed"
  echo "══ $pass passed, $fail failed ══"
  exit 1
}

echo
echo "── Each tenant writes one entity ──────────────────────────"
EA=$(curl -s -m 30 -X POST "$B/crm/entities" -H "Authorization: Bearer $TOKA" -H 'Content-Type: application/json' \
  -d '{"type":"person","firstName":"AlphaSecret","lastName":"X"}' | jqid "?.data?.id")
EB=$(curl -s -m 30 -X POST "$B/crm/entities" -H "Authorization: Bearer $TOKB" -H 'Content-Type: application/json' \
  -d '{"type":"person","firstName":"BravoSecret","lastName":"Y"}' | jqid "?.data?.id")
[ -n "$EA" ] && ok "A wrote entity" || no "A write" "no id"
[ -n "$EB" ] && ok "B wrote entity" || no "B write" "no id"

echo
echo "── Listing must not leak across tenants ───────────────────"
LA=$(curl -s -m 30 -H "Authorization: Bearer $TOKA" "$B/crm/entities")
LB=$(curl -s -m 30 -H "Authorization: Bearer $TOKB" "$B/crm/entities")
echo "$LA" | grep -q AlphaSecret && ok "A sees its own row" || no "A self-read" "missing"
echo "$LA" | grep -q BravoSecret && no "A LEAKED B's row" "cross-tenant read" || ok "A cannot see B's row"
echo "$LB" | grep -q BravoSecret && ok "B sees its own row" || no "B self-read" "missing"
echo "$LB" | grep -q AlphaSecret && no "B LEAKED A's row" "cross-tenant read" || ok "B cannot see A's row"

echo
echo "── Direct fetch of another tenant's entity by id ──────────"
code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" -H "Authorization: Bearer $TOKA" "$B/crm/entities/$EB")
[ "$code" = "404" ] || [ "$code" = "403" ] && ok "A fetching B's entity -> $code" || no "direct fetch" "got $code (expected 404/403)"

echo
echo "── Another tenant's stats ─────────────────────────────────"
SB=$(curl -s -m 30 -H "Authorization: Bearer $TOKA" "$B/tenants/$TB/stats")
echo "$SB" | grep -q '"users":0\|MER-' && ok "A reading B's stats yields nothing/denied" || no "stats leak" "$(echo $SB | head -c 200)"

echo
echo "── Intra-tenant: one client must not see another's document ──"
# RLS isolates tenants, not users inside one (CLAUDE.md §5.1). This block used
# to mint two low-privilege same-tenant users via POST /auth/register to prove
# DocumentAccessService scopes each to their own uploads.
#
# POST /auth/register was removed 2026-09-04 (see iam.controller.ts): it ran
# its INSERT outside the runAsSystem bypass that wrapped its two reads, so on
# an unbound connection it 500'd the RLS WITH CHECK for every caller — and
# fixing that scoping bug alone would have shipped a worse one, since the
# route was @Public(), took only an anonymously-enumerable tenant slug
# (POST /tenants/check-slug has no guard), and let a caller self-provision
# into ANY existing tenant with no invite and no role gate. No product app has
# ever called it. There is currently no supported HTTP path that hands a
# freshly created low-privilege user a working session without email
# delivery (RESEND_API_KEY is unset in this environment), so this block can no
# longer run end-to-end over HTTP.
#
# The scoping logic itself is still covered at the unit level —
# src/documents/document-access.service.spec.ts — this is a loss of live HTTP
# confirmation, not a loss of test coverage for DocumentAccessService. Restore
# this block once an audited, operator-only "set initial password" path exists
# (see AGENTS.md / the register-removal note) or once invite email is wired up
# end-to-end so accept-invite can stand in for register here.
# Still skipped, but NOT for the reason this line used to give. It blamed a
# missing invite email; RESEND_API_KEY and RESEND_FROM are set on Production
# (verified 2026-09-08), so invites do send. The actual blocker is narrower:
# `IamService.inviteUser` only logs the acceptance link server-side and no route
# returns the token, so a script cannot obtain it without reading Vercel logs or
# a real inbox. That is exactly what ADR 0006 (operator invite link) specifies,
# and it is unimplemented. Fixing the wrong blocker has cost this project time
# before — hence the detail.
printf "  SKIP  intra-tenant document isolation — invites now send (Resend is configured), but no route returns the acceptance token, so a script cannot mint a client. Needs ADR 0006 (operator invite link).\n"

echo
echo "══ $pass passed, $fail failed ══"
echo "CLEANUP=$TA $TB"
[ "$fail" -eq 0 ] || exit 1
