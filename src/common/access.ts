import { PlatformRole } from '../iam/enums/platform-role.enum';
import { TenantContext } from '../core/tenancy/tenant-context';

/**
 * Who is asking, reduced to the two facts an authorisation decision needs.
 *
 * Deliberately not `UserPayload`: services must not depend on the HTTP request
 * shape, and a job or a sweep that legitimately acts on a user's behalf can
 * construct one of these without faking a request.
 */
export interface Actor {
  id: string;
  roles: string[];
  /**
   * The caller's own email, when there is a caller.
   *
   * `own` scope needs it because an applicant is not the *assignee* of their
   * case — staff are — so identity-by-user-id cannot answer "is this record
   * mine". Records carry `subjectEmail` for exactly this comparison. Optional
   * so `SYSTEM_ACTOR` and any call site that predates it still compile; an
   * absent email simply never matches, which fails closed.
   */
  email?: string;
}

/**
 * The roles that work inside a tenant on its behalf.
 *
 * `platform_admin` is NOT here, and that is the point — see `isGodContext`.
 */
const TENANT_STAFF_ROLES: readonly string[] = [
  PlatformRole.FIRM_ADMIN,
  PlatformRole.STAFF,
];

/**
 * True when this unit of work is executing inside `TenancyService.runAsGod`.
 *
 * That wrapper writes a `CRITICAL` audit entry *before* the work and rethrows
 * if the audit write fails, so "we are in a god context" is the same statement
 * as "this access has been recorded". Operator reach into a tenant's records is
 * granted here and nowhere else: a bare `platform_admin` role on a token is a
 * claim about who someone is, not a record that they looked.
 */
export function isGodContext(): boolean {
  return TenantContext.getBypass()?.kind === 'god';
}

/** `firm_admin` or `staff` — the roles that work a tenant's whole caseload. */
export function isTenantStaff(roles: readonly string[] = []): boolean {
  return roles.some((r) => TENANT_STAFF_ROLES.includes(r));
}

/**
 * A `client` and nothing else: an applicant or a counterparty, never staff.
 *
 * A user holding both `client` and `staff` is staff — the wider role wins, or a
 * staff member with a client login for their own matter would lose their
 * caseload.
 */
export function isClientOnly(roles: readonly string[] = []): boolean {
  return roles.includes(PlatformRole.CLIENT) && !isTenantStaff(roles);
}

/**
 * How far inside one tenant a caller may see.
 *
 * RLS isolates tenants, not users inside a tenant, so this is the *only* thing
 * standing between one applicant and another's passport scan. It has to live in
 * a service, never a controller: `/crm/entities`, `/payments` and
 * `/communications/threads` each shipped this check on the controller or not at
 * all, and each time a later caller reached the service without it.
 *
 * - `god`    — inside `runAsGod`; already audited, unrestricted.
 * - `tenant` — `firm_admin` / `staff`; everything RLS lets the connection see.
 * - `own`    — everyone else, including a bare `platform_admin` token: their own
 *              records only. A platform operator who needs more takes the god
 *              path, which writes the audit entry that makes the reach legal.
 */
export type AccessScope = 'god' | 'tenant' | 'own';

export function scopeOf(actor: Actor): AccessScope {
  if (isGodContext()) return 'god';
  if (isTenantStaff(actor.roles)) return 'tenant';
  return 'own';
}

/**
 * **The predicate every narrowing decision must ask.** True only for a caller
 * entitled to the tenant's whole caseload; false for everybody else, including
 * anyone this file has never heard of.
 *
 * This exists because `scopeOf` is the right *answer* expressed in a shape that
 * invites the wrong *question*. Sixteen of nineteen call sites were written as
 *
 *     if (scopeOf(actor) !== 'own') return;      // skip narrowing
 *     if (scopeOf(actor) === 'own') { …narrow… }
 *
 * — a deny-list keyed on one value. Both read as correct and both fail OPEN the
 * moment `AccessScope` gains a fourth member: a scope that is not literally
 * `'own'` skips the narrowing and receives the firm's entire caseload. Nothing
 * would flag it, because `scope !== 'own'` stays valid, type-checking code when
 * the union widens — the compiler has no opinion about a comparison that is
 * merely now *wrong*. Every one of those sixteen was a list route; the three
 * that happened to fail closed were by-id checks written as
 * `scope === 'god' || scope === 'tenant'`, i.e. an allow-list, by accident of
 * style rather than by rule.
 *
 * Expressed as a boolean the fail-open idiom stops being expressible. There is
 * no fourth branch to forget: a caller either has tenant-wide reach or is
 * confined to their own records, and a role, scope or portal added tomorrow
 * lands in the confined branch by construction. Adding reach then becomes a
 * deliberate edit *here*, in one place, reviewable — which is the property the
 * partner-portal work needs before it introduces a role at all.
 *
 * Exactly equivalent to `scopeOf(actor) !== 'own'` today, so every current token
 * behaves identically. That equivalence is the point: it is free now and a
 * migration later.
 *
 * `AccessScope`/`scopeOf` stay for the callers that genuinely need to name
 * *which* wide scope applies (an audit reason, a spec pinning the model). They
 * are not for branching on `'own'`; `common/allow-list-scoping.spec.ts` fails
 * the build if that idiom reappears anywhere under `src/`.
 */
export function hasTenantWideReach(actor: Actor): boolean {
  return isGodContext() || isTenantStaff(actor.roles);
}

/**
 * The caller when no user is asking.
 *
 * Some work inside a tenant genuinely has no user behind it — the AI service
 * assembling context for a prompt, a sweep, a scheduled job. Those callers are
 * already confined by the `tenantId` they pass and by RLS on the connection;
 * what they lack is a *person* to scope to, and inventing one would be a lie.
 *
 * It carries `firm_admin` because tenant-wide is the correct reach for work the
 * tenant itself initiated, and because the alternative — leaving `roles` empty —
 * resolves to `own` scope against a user id of `system`, which matches nothing
 * and would silently return zero rows rather than failing.
 *
 * Two rules, and they are the reason this is a named export rather than an
 * inline object literal:
 *
 *  1. **Never derive it from request input.** It is a constant. A route that
 *     reaches this value because a header said so is an authorisation bypass.
 *  2. **Never use it to serve a user.** If a human is waiting on the response,
 *     the real `Actor` is available — pass that. `grep SYSTEM_ACTOR` should
 *     only ever find internal, non-user-facing call sites.
 */
export const SYSTEM_ACTOR: Actor = {
  id: 'system',
  roles: [PlatformRole.FIRM_ADMIN],
};
