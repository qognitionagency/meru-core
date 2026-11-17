import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { IamController } from './iam.controller';
import { UsersController } from './users.controller';
import { IamService } from './iam.service';
import { NoImpersonationGuard } from './guards/no-impersonation.guard';
import { PolicyGuard } from './guards/policy.guard';
import { IS_PUBLIC_KEY, Public } from './decorators/public.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { UserStatus } from './entities/user.entity';

/**
 * Anton's sign-off: an impersonation token (`imp` claim, minted by
 * `OperatorController.impersonate`, 15 minutes, no session row) acts as the
 * tenant's first active user and was accepted on that user's own account-
 * security routes. A support operator could therefore enrol or remove the
 * user's second factor, list their devices and IPs, or sign them out of
 * everything — none of which a support diagnosis needs, and all of which the
 * user would experience as an attack.
 *
 * Refused (403) with an impersonation token:
 *   POST   /auth/mfa/setup, /auth/mfa/setup/verify, /auth/mfa/disable
 *   POST   /auth/logout-all
 *   DELETE /auth/sessions/:id
 *   GET    /auth/sessions — refused too: it is the user's own device list,
 *          IPs and user agents included, and it hands out the session ids
 *          DELETE takes. `issueImpersonationToken`'s own comment already
 *          says that list is the user's, not the operator's.
 *
 * `POST /auth/mfa/verify` is `@Public` and takes a body challenge, not a
 * Bearer; an impersonation token is not an `mfaPending` challenge and
 * `verifyMfaLogin` already refuses it.
 *
 * Separately: IAM audit entries written while impersonating now carry
 * `context.impersonatedBy`, naming the operator behind the action.
 */
describe('impersonation tokens', () => {
  const IMP = { operatorId: 'op-1', operatorTenantId: 'platform-1' };

  const contextFor = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  describe('NoImpersonationGuard', () => {
    const guard = new NoImpersonationGuard();

    it('refuses an impersonated caller with 403', () => {
      expect(() =>
        guard.canActivate(
          contextFor({ id: 'u1', tenantId: 't1', roles: [], impersonatedBy: IMP }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('admits the account holder themselves', () => {
      expect(
        guard.canActivate(contextFor({ id: 'u1', tenantId: 't1', roles: [] })),
      ).toBe(true);
    });

    it('fails closed with no authenticated user at all', () => {
      expect(() => guard.canActivate(contextFor(undefined))).toThrow(
        ForbiddenException,
      );
    });
  });

  /**
   * Every authenticated `IamController` route is the account holder's own
   * (`/auth/*`: sessions, MFA, sign-out), so every one refuses an
   * impersonation token unless it is named here with a reason.
   *
   * Enumerated by reflection, not listed by hand: a hand-written list passes
   * for a NEW account-security route that forgot the guard, which is exactly
   * the route this test exists to catch (Owen's gate).
   */
  const IMPERSONATION_ALLOWED: Record<string, string> = {
    // GET /auth/me — "who am I acting as" is what an impersonating operator
    // needs to see, and it changes nothing.
    getProfile: 'read-only identity of the impersonated user',
  };

  /** The memoised passport mixin — `AuthGuard('jwt') === AuthGuard('jwt')`. */
  const JWT_GUARD = AuthGuard('jwt');

  type Finding = { handler: string; problem: string };

  /** Route handlers on a controller, and whether each is authenticated. */
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
        // Authenticated if it names the JWT guard, or if it is not @Public —
        // `GlobalAuthGuard` (APP_GUARD) authenticates every non-public route.
        const authenticated = guards.includes(JWT_GUARD) || !isPublic;
        return { name, guards, authenticated };
      });
  }

  function impersonationGuardFindings(
    controller: new (...args: any[]) => unknown,
    allowed: Record<string, string>,
  ): Finding[] {
    const findings: Finding[] = [];
    const all = routes(controller);
    for (const r of all.filter((x) => x.authenticated)) {
      if (r.name in allowed) continue;
      const at = r.guards.indexOf(NoImpersonationGuard);
      if (at === -1) {
        findings.push({ handler: r.name, problem: 'missing NoImpersonationGuard' });
        continue;
      }
      const jwtAt = r.guards.indexOf(JWT_GUARD);
      if (jwtAt !== -1 && at < jwtAt) {
        // It reads `req.user`; before the JWT guard there is none, and it
        // would refuse every caller — or, worse, a later edit would make it
        // pass on an absent user.
        findings.push({ handler: r.name, problem: 'NoImpersonationGuard before AuthGuard(jwt)' });
      }
    }
    // A stale allowlist entry is a hole waiting to be reused.
    for (const name of Object.keys(allowed)) {
      if (!all.some((r) => r.name === name && r.authenticated)) {
        findings.push({ handler: name, problem: 'allowlisted but not an authenticated route' });
      }
    }
    return findings;
  }

  describe('is applied, after authentication, on every authenticated IamController route', () => {
    it('finds the authenticated routes at all (the check cannot pass vacuously)', () => {
      const names = routes(IamController)
        .filter((r) => r.authenticated)
        .map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          'getProfile',
          'setupMfa',
          'verifyMfaSetup',
          'disableMfa',
          'logoutAll',
          'revokeSession',
          'listSessions',
        ]),
      );
      // ...and does not count the public ones.
      expect(names).not.toContain('login');
      expect(names).not.toContain('verifyMfaLogin');
    });

    it('every one refuses an impersonation token, except the allowlist', () => {
      expect(impersonationGuardFindings(IamController, IMPERSONATION_ALLOWED)).toEqual([]);
    });

    describe('the check itself catches the failures it exists for', () => {
      @Controller('probe')
      class Probe {
        @Get('me')
        @UseGuards(JWT_GUARD, PolicyGuard)
        getProfile() {}

        @Post('guarded')
        @UseGuards(JWT_GUARD, NoImpersonationGuard, PolicyGuard)
        guarded() {}

        @Post('forgot-the-guard')
        @UseGuards(JWT_GUARD, PolicyGuard)
        newSecurityRoute() {}

        @Post('global-auth-only')
        globalAuthOnly() {}

        @Post('wrong-order')
        @UseGuards(NoImpersonationGuard, JWT_GUARD)
        wrongOrder() {}

        @Post('public')
        @Public()
        open() {}
      }

      it('flags a JWT-guarded route without the guard, a route authenticated only globally, and wrong order', () => {
        expect(
          impersonationGuardFindings(Probe, { getProfile: 'probe' }),
        ).toEqual([
          { handler: 'newSecurityRoute', problem: 'missing NoImpersonationGuard' },
          { handler: 'globalAuthOnly', problem: 'missing NoImpersonationGuard' },
          { handler: 'wrongOrder', problem: 'NoImpersonationGuard before AuthGuard(jwt)' },
        ]);
      });

      it('flags an allowlist entry that names no authenticated route', () => {
        expect(
          impersonationGuardFindings(Probe, { getProfile: 'probe', gone: 'stale', open: 'public' }),
        ).toEqual(
          expect.arrayContaining([
            { handler: 'gone', problem: 'allowlisted but not an authenticated route' },
            { handler: 'open', problem: 'allowlisted but not an authenticated route' },
          ]),
        );
      });
    });
  });

  describe('IAM audit entries name the operator', () => {
    const T = 'tenant-1';
    const ADMIN = {
      id: 'admin-1',
      roles: [PlatformRole.FIRM_ADMIN],
      email: 'admin@acme.test',
    };

    function build() {
      const auditEvents: Array<Record<string, any>> = [];
      const users: Record<string, any>[] = [
        {
          id: 'u1',
          tenantId: T,
          email: 'u1@acme.test',
          roles: [PlatformRole.STAFF],
          status: UserStatus.INVITED,
          attributes: {},
        },
      ];
      const userRepo = {
        findOne: jest.fn(async ({ where }: any) => {
          if (where.email !== undefined) {
            return users.find((u) => u.email === where.email) ?? null;
          }
          const u = users.find((x) => x.id === where.id);
          return u ? { ...u } : null;
        }),
        create: jest.fn((x: any) => ({ id: 'new-1', ...x })),
        save: jest.fn(async (u: any) => u),
      };
      const authTokenRepo = {
        update: jest.fn(async () => ({ affected: 0 })),
        create: jest.fn((x: any) => ({ id: 'tok-1', ...x })),
        save: jest.fn(async (t: any) => t),
      };
      const auditService = {
        logEvent: jest.fn(async (dto: Record<string, any>) => {
          auditEvents.push(dto);
          return { id: 'a' };
        }),
      };
      const service = new IamService(
        userRepo as any,
        { findOne: jest.fn(async () => ({ id: T, name: 'Acme' })) } as any,
        {} as any,
        {} as any,
        {} as any,
        authTokenRepo as any,
        {} as any,
        {
          sendInvite: jest.fn(async () => ({ delivered: true })),
          appUrl: 'https://app.immistack.com',
        } as any,
        auditService as any,
      );
      return { service, auditEvents };
    }

    it('invite issue', async () => {
      const { service, auditEvents } = build();
      await service.inviteUser(
        T,
        { email: 'new@acme.test', role: PlatformRole.STAFF },
        { id: ADMIN.id, name: ADMIN.email, impersonatedBy: IMP },
        ADMIN.roles,
      );
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].context).toMatchObject({ impersonatedBy: IMP });
    });

    it('invite resend', async () => {
      const { service, auditEvents } = build();
      await service.resendInvite(T, 'u1', {
        id: ADMIN.id,
        name: ADMIN.email,
        impersonatedBy: IMP,
      });
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].context).toMatchObject({ impersonatedBy: IMP });
    });

    it('role and status change', async () => {
      const { service, auditEvents } = build();
      await service.updateUser(
        T,
        'u1',
        { role: PlatformRole.FIRM_ADMIN, status: UserStatus.ACTIVE },
        { ...ADMIN, impersonatedBy: IMP },
      );
      // Request rows before the save, outcome rows after (auditedChange) —
      // every one of them names the operator.
      expect(auditEvents.map((e) => e.context?.event)).toEqual([
        'role.change.requested',
        'status.change.requested',
        'role.changed',
        'status.changed',
      ]);
      for (const e of auditEvents) {
        expect(e.context).toMatchObject({ impersonatedBy: IMP });
      }
    });

    it('carries nothing when the caller is not impersonating', async () => {
      const { service, auditEvents } = build();
      await service.resendInvite(T, 'u1', { id: ADMIN.id, name: ADMIN.email });
      expect(auditEvents[0].context?.impersonatedBy).toBeUndefined();
    });
  });

  describe('UsersController passes the claim from the validated token through', () => {
    const IMPERSONATED_REQ = {
      user: {
        id: 'admin-1',
        email: 'admin@acme.test',
        tenantId: 'tenant-1',
        roles: [PlatformRole.FIRM_ADMIN],
        impersonatedBy: IMP,
      },
    } as any;

    function build() {
      const iam = {
        inviteUser: jest.fn(async () => ({})),
        resendInvite: jest.fn(async () => ({})),
        updateUser: jest.fn(async () => ({})),
      };
      return { iam, controller: new UsersController(iam as any) };
    }

    it('invite', async () => {
      const { iam, controller } = build();
      await controller.invite(IMPERSONATED_REQ, { email: 'x@acme.test' } as any);
      expect(iam.inviteUser).toHaveBeenCalledWith(
        'tenant-1',
        expect.anything(),
        expect.objectContaining({ impersonatedBy: IMP }),
        expect.anything(),
      );
    });

    it('resend invite', async () => {
      const { iam, controller } = build();
      await controller.resendInvite(IMPERSONATED_REQ, 'u1');
      expect(iam.resendInvite).toHaveBeenCalledWith(
        'tenant-1',
        'u1',
        expect.objectContaining({ impersonatedBy: IMP }),
      );
    });

    it('update', async () => {
      const { iam, controller } = build();
      await controller.update(IMPERSONATED_REQ, 'u1', {} as any);
      expect(iam.updateUser).toHaveBeenCalledWith(
        'tenant-1',
        'u1',
        {},
        expect.objectContaining({ impersonatedBy: IMP }),
      );
    });
  });
});
