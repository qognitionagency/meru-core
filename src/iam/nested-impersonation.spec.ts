import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtService } from '@nestjs/jwt';
import { OperatorController } from './operator.controller';
import { IamService } from './iam.service';
import { NoImpersonationGuard } from './guards/no-impersonation.guard';
import { PlatformRole } from './enums/platform-role.enum';
import { UserStatus } from './entities/user.entity';
import type { AuthenticatedRequest, UserPayload } from '../common/types';

/**
 * Anton: nested impersonation launders attribution.
 *
 * `POST /tenants/:id/impersonate` had no `NoImpersonationGuard`, did not
 * refuse the operator's own tenant, and `issueImpersonationToken` took the
 * tenant's earliest active user whatever their role. So an operator could
 * impersonate into the platform tenant, land on a `platform_admin`, and
 * impersonate again. The second token's `imp` names the impersonated admin;
 * the real operator is gone from the trail.
 *
 * Closed three ways, each sufficient on its own for the two-step attack:
 *   (a) the route refuses an impersonation token (NoImpersonationGuard);
 *   (b) the route refuses the operator's own tenant;
 *   (c) the token is never minted for a user holding platform_admin.
 */
describe('nested impersonation', () => {
  const PLATFORM = 'platform-tenant';
  const FIRM = 'firm-tenant';
  const SECRET = 'test-secret-not-a-real-one';

  const operatorReq = (over: Partial<UserPayload> = {}) =>
    ({
      user: {
        id: 'operator-1',
        email: 'op@meru.internal',
        tenantId: PLATFORM,
        roles: [PlatformRole.PLATFORM_ADMIN],
        ...over,
      },
    }) as AuthenticatedRequest;

  const contextFor = (user: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  /** `users` is ordered as `createdAt ASC` would order it. */
  function buildIam(users: Array<Record<string, any>>) {
    const userRepo = {
      find: jest.fn(async ({ where, skip = 0, take }: any) =>
        users
          .filter(
            (u) => u.tenantId === where.tenantId && u.status === where.status,
          )
          .slice(skip, take === undefined ? undefined : skip + take)
          .map((u) => ({ ...u })),
      ),
      findOne: jest.fn(async ({ where }: any) => {
        const u = users.find(
          (x) => x.tenantId === where.tenantId && x.status === where.status,
        );
        return u ? { ...u } : null;
      }),
    };
    const jwtService = new JwtService({ secret: SECRET });
    const iam = new IamService(
      userRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      jwtService,
      {} as any,
      {} as any,
    );
    return { iam, jwtService, userRepo };
  }

  function buildController(iam: Partial<IamService>) {
    const runAsGod = jest.fn(
      async (_a: string, _t: string, _r: string, work: () => Promise<unknown>) =>
        work(),
    );
    const controller = new OperatorController(
      {} as any,
      {} as any,
      {} as any,
      { runAsGod } as any,
      iam as any,
    );
    return { controller, runAsGod };
  }

  const reason = { reason: 'Ticket MER-1234 — investigating a report' } as any;

  describe('(b) the impersonate route refuses the operator\'s own tenant', () => {
    it('403, and neither runAsGod nor the token mint runs', async () => {
      const issueImpersonationToken = jest.fn();
      const { controller, runAsGod } = buildController({ issueImpersonationToken });

      await expect(
        controller.impersonate(operatorReq(), PLATFORM, reason),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(runAsGod).not.toHaveBeenCalled();
      expect(issueImpersonationToken).not.toHaveBeenCalled();
    });

    it('another tenant still proceeds', async () => {
      const issueImpersonationToken = jest.fn().mockResolvedValue({});
      const { controller } = buildController({ issueImpersonationToken });

      await controller.impersonate(operatorReq(), FIRM, reason);

      expect(issueImpersonationToken).toHaveBeenCalledWith(FIRM, {
        id: 'operator-1',
        tenantId: PLATFORM,
      });
    });
  });

  describe('(c) issueImpersonationToken never targets a platform_admin', () => {
    const OPERATOR = { id: 'operator-1', tenantId: PLATFORM };

    it('skips an earlier platform_admin and takes the first user without it', async () => {
      const { iam, jwtService } = buildIam([
        { id: 'admin-old', tenantId: FIRM, email: 'a@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.PLATFORM_ADMIN] },
        { id: 'firm-admin', tenantId: FIRM, email: 'f@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.FIRM_ADMIN] },
      ]);

      const result = await iam.issueImpersonationToken(FIRM, OPERATOR);

      expect(result.impersonating.userId).toBe('firm-admin');
      const payload = jwtService.verify(result.access_token);
      expect(payload.roles).not.toContain(PlatformRole.PLATFORM_ADMIN);
    });

    it('skips a platform_admin holding it among other roles', async () => {
      const { iam } = buildIam([
        { id: 'dual', tenantId: FIRM, email: 'd@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.FIRM_ADMIN, PlatformRole.PLATFORM_ADMIN] },
        { id: 'staff', tenantId: FIRM, email: 's@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.STAFF] },
      ]);

      const result = await iam.issueImpersonationToken(FIRM, OPERATOR);

      expect(result.impersonating.userId).toBe('staff');
    });

    it('finds the eligible user past the first page of platform_admins', async () => {
      const admins = Array.from({ length: 120 }, (_, i) => ({
        id: `admin-${i}`,
        tenantId: FIRM,
        email: `a${i}@firm.test`,
        status: UserStatus.ACTIVE,
        roles: [PlatformRole.PLATFORM_ADMIN],
      }));
      const { iam } = buildIam([
        ...admins,
        { id: 'late-staff', tenantId: FIRM, email: 'l@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.STAFF] },
      ]);

      const result = await iam.issueImpersonationToken(FIRM, OPERATOR);

      expect(result.impersonating.userId).toBe('late-staff');
    });

    it('refuses when every active user holds platform_admin — never falls back to one', async () => {
      const { iam } = buildIam([
        { id: 'admin-1', tenantId: FIRM, email: 'a@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.PLATFORM_ADMIN] },
      ]);

      await expect(iam.issueImpersonationToken(FIRM, OPERATOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses the operator\'s own tenant at the service too', async () => {
      const { iam, userRepo } = buildIam([
        { id: 'staff', tenantId: PLATFORM, email: 's@meru.internal', status: UserStatus.ACTIVE, roles: [PlatformRole.STAFF] },
      ]);

      await expect(
        iam.issueImpersonationToken(PLATFORM, OPERATOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(userRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('(a) an impersonation session cannot impersonate again', () => {
    it('the impersonate route carries NoImpersonationGuard', () => {
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, OperatorController.prototype.impersonate) ?? [];
      expect(guards).toContain(NoImpersonationGuard);
    });
  });

  /**
   * The attack as Anton described it, end to end, against a real
   * `IamService` + `JwtService`: step 1 mints a real token, step 2 presents
   * what `JwtStrategy.validate` would build from it (`roles` from the token,
   * `impersonatedBy` from `imp`).
   */
  describe('the two-step attempt', () => {
    const PLATFORM_USERS = [
      { id: 'platform-admin-2', tenantId: PLATFORM, email: 'p2@meru.internal', status: UserStatus.ACTIVE, roles: [PlatformRole.PLATFORM_ADMIN] },
    ];

    it('step 1 into the platform tenant is refused outright', async () => {
      const { iam } = buildIam(PLATFORM_USERS);
      const { controller } = buildController(iam);

      await expect(
        controller.impersonate(operatorReq(), PLATFORM, reason),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('step 1 into a tenant whose first user is a platform_admin yields no platform_admin, and step 2 is refused', async () => {
      const { iam, jwtService } = buildIam([
        { id: 'admin-in-firm', tenantId: FIRM, email: 'x@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.PLATFORM_ADMIN] },
        { id: 'firm-admin', tenantId: FIRM, email: 'f@firm.test', status: UserStatus.ACTIVE, roles: [PlatformRole.FIRM_ADMIN] },
      ]);
      const { controller } = buildController(iam);

      const step1 = (await controller.impersonate(operatorReq(), FIRM, reason)) as {
        access_token: string;
      };
      const claims = jwtService.verify(step1.access_token);
      expect(claims.roles).not.toContain(PlatformRole.PLATFORM_ADMIN);
      expect(claims.imp).toEqual({ operatorId: 'operator-1', operatorTenantId: PLATFORM });

      // What JwtStrategy.validate builds from that token.
      const impersonatedUser: UserPayload = {
        id: claims.sub,
        email: claims.email,
        tenantId: claims.tenantId,
        roles: claims.roles,
        impersonatedBy: claims.imp,
      } as UserPayload;

      // Step 2: the guard on the route refuses before the handler runs.
      expect(() =>
        new NoImpersonationGuard().canActivate(contextFor(impersonatedUser)),
      ).toThrow(ForbiddenException);
    });
  });

  /**
   * The other runAsGod path in this controller: `forTenant`'s cross-tenant
   * branch passes `req.user.id` as the God-View actor. Under impersonation
   * that id is the impersonated user, so the CRITICAL row would name them,
   * not the operator — the same laundering on a read. Own-tenant reads stay
   * open: they are what the impersonated user could already see.
   */
  describe('forTenant refuses a cross-tenant read under impersonation', () => {
    const impersonated = operatorReq({
      id: 'firm-admin',
      tenantId: FIRM,
      // A token minted before (c) could still carry platform_admin.
      roles: [PlatformRole.PLATFORM_ADMIN],
      impersonatedBy: { operatorId: 'operator-1', operatorTenantId: PLATFORM },
    });

    function build() {
      const getEntitlements = jest.fn().mockResolvedValue({ modules: [] });
      const runAsGod = jest.fn(async (_a: string, _t: string, _r: string, w: () => Promise<unknown>) => w());
      const controller = new OperatorController(
        { getEntitlements } as any,
        {} as any,
        {} as any,
        { runAsGod } as any,
        {} as any,
      );
      return { controller, runAsGod, getEntitlements };
    }

    it('another tenant: 403, no God-View audit row, no read', async () => {
      const { controller, runAsGod, getEntitlements } = build();

      await expect(
        controller.entitlements(impersonated, 'third-tenant'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(runAsGod).not.toHaveBeenCalled();
      expect(getEntitlements).not.toHaveBeenCalled();
    });

    it('own tenant: unchanged', async () => {
      const { controller, getEntitlements } = build();

      await controller.entitlements(impersonated, FIRM);

      expect(getEntitlements).toHaveBeenCalledWith(FIRM);
    });
  });
});
