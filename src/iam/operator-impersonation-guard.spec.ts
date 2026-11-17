import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { OperatorController } from './operator.controller';
import { NoImpersonationGuard } from './guards/no-impersonation.guard';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/**
 * Sibling of `impersonation-refusal.spec.ts`'s IamController check, for the
 * operator surface (`/tenants/:id/*`, God View).
 *
 * Every authenticated `OperatorController` handler refuses an impersonation
 * token unless it is named below with a reason. Enumerated by reflection,
 * so a NEW God-View handler that forgets the guard fails here instead of
 * shipping (Owen's gate). The helper is a deliberate copy of the one in
 * `impersonation-refusal.spec.ts`, kept separate so the two can land as
 * separate commits; fold them together when either is next touched.
 */
describe('OperatorController — impersonation tokens', () => {
  /**
   * Allowed under impersonation, each with why. All three are reads routed
   * through `forTenant`: the own-tenant branch is what the impersonated user
   * could already see, and the cross-tenant (`runAsGod`) branch refuses an
   * impersonation session in `forTenant` itself — behaviour-tested in
   * `nested-impersonation.spec.ts`.
   */
  const IMPERSONATION_ALLOWED: Record<string, string> = {
    entitlements: 'own-tenant read; cross-tenant branch refuses in forTenant',
    branding: 'own-tenant read; cross-tenant branch refuses in forTenant',
    connectors: 'own-tenant read; cross-tenant branch refuses in forTenant',
  };

  const JWT_GUARD = AuthGuard('jwt');

  type Finding = { handler: string; problem: string };

  function routes(controller: new (...args: any[]) => unknown) {
    const proto = controller.prototype as Record<string, unknown>;
    const classGuards =
      (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .filter((name) => typeof proto[name] === 'function')
      .filter((name) => Reflect.hasMetadata(PATH_METADATA, proto[name] as object))
      .map((name) => {
        const handler = proto[name] as object;
        const guards = [
          ...classGuards,
          ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []),
        ];
        const isPublic =
          classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true;
        const authenticated = guards.includes(JWT_GUARD) || !isPublic;
        return { name, guards, authenticated };
      });
  }

  function findings(
    controller: new (...args: any[]) => unknown,
    allowed: Record<string, string>,
  ): Finding[] {
    const out: Finding[] = [];
    const all = routes(controller);
    for (const r of all.filter((x) => x.authenticated)) {
      if (r.name in allowed) continue;
      const at = r.guards.indexOf(NoImpersonationGuard);
      if (at === -1) {
        out.push({ handler: r.name, problem: 'missing NoImpersonationGuard' });
        continue;
      }
      const jwtAt = r.guards.indexOf(JWT_GUARD);
      if (jwtAt !== -1 && at < jwtAt) {
        out.push({ handler: r.name, problem: 'NoImpersonationGuard before AuthGuard(jwt)' });
      }
    }
    for (const name of Object.keys(allowed)) {
      if (!all.some((r) => r.name === name && r.authenticated)) {
        out.push({ handler: name, problem: 'allowlisted but not an authenticated route' });
      }
    }
    return out;
  }

  it('finds every handler (the check cannot pass vacuously)', () => {
    expect(
      routes(OperatorController)
        .filter((r) => r.authenticated)
        .map((r) => r.name)
        .sort(),
    ).toEqual(
      ['branding', 'connectors', 'entitlements', 'impersonate', 'updateEntitlements'].sort(),
    );
  });

  it('every handler refuses an impersonation token, except the allowlist', () => {
    expect(findings(OperatorController, IMPERSONATION_ALLOWED)).toEqual([]);
  });

  it('the two God-View writes are the ones guarded', () => {
    const guarded = routes(OperatorController)
      .filter((r) => r.guards.includes(NoImpersonationGuard))
      .map((r) => r.name)
      .sort();
    expect(guarded).toEqual(['impersonate', 'updateEntitlements']);
  });
});
