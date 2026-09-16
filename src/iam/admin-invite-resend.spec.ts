import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyGuard } from './guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { TenantProvisioningController } from './tenant-provisioning.controller';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenancyService } from '../core/tenancy/tenancy.service';
import { PlatformRole } from './enums/platform-role.enum';
import { UserStatus } from './entities/user.entity';
import type { AuthenticatedRequest } from '../common/types';

/**
 * `POST /tenants/:tenantId/admin-invite/resend` — the operator recovery path
 * for a lost or expired provisioning invite (`provisionTenant`'s own
 * `inviteUrl` doc comment: production once created a tenant nobody could
 * ever sign into). `POST /iam/users/:id/resend-invite` cannot reach this
 * case — it is scoped to `req.user.tenantId`, and the platform operator who
 * provisioned the tenant is not a member of it.
 *
 * Three layers, matching how this codebase already tests the other God View
 * routes on this controller:
 *   1. `PolicyGuard` — platform_admin only, real `Reflector` against the
 *      real controller method (`tenant-delete-authz.spec.ts`'s pattern).
 *   2. `TenantProvisioningService.resolveAdminInviteTarget` — which user a
 *      resend targets, and the 404/409/400 shapes.
 *   3. The controller — `runAsGod` audits the TARGET tenant (not the
 *      operator's), and if that audit write fails nothing downstream runs
 *      (`run-as-god-target.spec.ts`'s pattern, applied to this route).
 */
describe('POST /tenants/:tenantId/admin-invite/resend', () => {
  const TARGET_TENANT = 'target-tenant';
  const OPERATOR_TENANT = 'platform-tenant';

  describe('authz — platform_admin only, regardless of which tenant the caller belongs to', () => {
    function contextFor(user: unknown) {
      return {
        getHandler: () => TenantProvisioningController.prototype.resendAdminInvite,
        getClass: () => TenantProvisioningController,
        switchToHttp: () => ({
          getRequest: () => ({ user, ip: '203.0.113.15' }),
        }),
      } as any;
    }

    function buildGuard() {
      const verticalPolicyService = {
        getPolicy: jest.fn(),
      } as unknown as VerticalPolicyService;
      const dataSource = { query: jest.fn() } as unknown as DataSource;
      return new PolicyGuard(new Reflector(), verticalPolicyService, dataSource);
    }

    it('refuses a client token', async () => {
      await expect(
        buildGuard().canActivate(
          contextFor({ id: 'c-1', tenantId: TARGET_TENANT, roles: ['client'] }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses firm_admin of the tenant being targeted — a firm cannot self-serve this', async () => {
      await expect(
        buildGuard().canActivate(
          contextFor({
            id: 'fa-1',
            tenantId: TARGET_TENANT,
            roles: ['firm_admin'],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses firm_admin of a DIFFERENT tenant — the gate is the role, not tenant membership', async () => {
      await expect(
        buildGuard().canActivate(
          contextFor({
            id: 'fa-2',
            tenantId: 'some-other-tenant',
            roles: ['firm_admin'],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows platform_admin', async () => {
      await expect(
        buildGuard().canActivate(
          contextFor({ id: 'op-1', tenantId: OPERATOR_TENANT, roles: ['platform_admin'] }),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('TenantProvisioningService.resolveAdminInviteTarget', () => {
    function makeService(opts: {
      tenant?: { id: string } | null;
      users?: Array<{ id: string; tenantId: string; roles: string[]; status: UserStatus }>;
    }) {
      const tenantRepo = {
        findOne: jest.fn(async () => (opts.tenant === undefined ? { id: TARGET_TENANT } : opts.tenant)),
      };
      const users = opts.users ?? [];
      const userRepo = {
        findOne: jest.fn(async ({ where }: any) =>
          users.find(
            (u) =>
              u.id === where.id &&
              (where.tenantId === undefined || u.tenantId === where.tenantId),
          ) ?? null,
        ),
        find: jest.fn(async ({ where }: any) =>
          users.filter(
            (u) =>
              u.tenantId === where.tenantId &&
              (where.status === undefined || u.status === where.status),
          ),
        ),
      };

      return new TenantProvisioningService(
        tenantRepo as any,
        userRepo as any,
        {} as any, // tenantSettingRepo — unused by this method
        {} as any, // tenantSignupInviteRepo — unused by this method
        {} as any, // dataSource — unused by this method
        {} as any, // configService — unused by this method
        {} as any, // mailService — unused by this method
        {} as any, // auditService — unused by this method
      );
    }

    it('unknown tenant → 404', async () => {
      const service = makeService({ tenant: null });
      await expect(service.resolveAdminInviteTarget(TARGET_TENANT)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('userId names a user in a DIFFERENT tenant → 404, not the tenant that owns it', async () => {
      const service = makeService({
        users: [
          {
            id: 'u-1',
            tenantId: 'a-different-tenant',
            roles: [PlatformRole.FIRM_ADMIN],
            status: UserStatus.INVITED,
          },
        ],
      });
      await expect(
        service.resolveAdminInviteTarget(TARGET_TENANT, 'u-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('named user has already accepted (ACTIVE) → 409, never re-issued', async () => {
      const service = makeService({
        users: [
          {
            id: 'u-1',
            tenantId: TARGET_TENANT,
            roles: [PlatformRole.FIRM_ADMIN],
            status: UserStatus.ACTIVE,
          },
        ],
      });
      await expect(
        service.resolveAdminInviteTarget(TARGET_TENANT, 'u-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('no userId, exactly one pending firm admin → resolves it', async () => {
      const service = makeService({
        users: [
          {
            id: 'u-1',
            tenantId: TARGET_TENANT,
            roles: [PlatformRole.FIRM_ADMIN],
            status: UserStatus.INVITED,
          },
        ],
      });
      const target = await service.resolveAdminInviteTarget(TARGET_TENANT);
      expect(target.id).toBe('u-1');
    });

    it('no userId, more than one pending firm admin → 400 listing the candidate ids', async () => {
      const service = makeService({
        users: [
          {
            id: 'u-1',
            tenantId: TARGET_TENANT,
            roles: [PlatformRole.FIRM_ADMIN],
            status: UserStatus.INVITED,
          },
          {
            id: 'u-2',
            tenantId: TARGET_TENANT,
            roles: [PlatformRole.FIRM_ADMIN],
            status: UserStatus.INVITED,
          },
        ],
      });
      await expect(
        service.resolveAdminInviteTarget(TARGET_TENANT),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no userId, nobody pending → 404', async () => {
      const service = makeService({ users: [] });
      await expect(
        service.resolveAdminInviteTarget(TARGET_TENANT),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('controller — runAsGod wiring', () => {
    const operatorReq = {
      user: {
        id: 'operator-1',
        email: 'op@meru.internal',
        tenantId: OPERATOR_TENANT,
        roles: [PlatformRole.PLATFORM_ADMIN],
      },
    } as AuthenticatedRequest;

    it('audits the tenant whose invite is being resent, not the operator\'s, and returns the inviteUrl', async () => {
      const logEvent = jest.fn().mockResolvedValue({});
      const tenancyService = new TenancyService({ logEvent } as any);

      const resolveAdminInviteTarget = jest.fn().mockResolvedValue({ id: 'user-1' });
      const resendInvite = jest.fn().mockResolvedValue({
        email: 'priya@harbourline.example',
        inviteSent: true,
        expiresAt: new Date('2026-09-17T15:52:00Z'),
        inviteUrl: 'https://app.immistack.com/reset-password?token=fresh',
      });

      const controller = new TenantProvisioningController(
        { resolveAdminInviteTarget } as any,
        tenancyService,
        { resendInvite } as any,
      );

      const result = await controller.resendAdminInvite(operatorReq, TARGET_TENANT, {});

      expect(logEvent).toHaveBeenCalledTimes(1);
      expect(logEvent.mock.calls[0][0].tenantId).toBe(TARGET_TENANT);
      expect(logEvent.mock.calls[0][0].tenantId).not.toBe(OPERATOR_TENANT);

      // Never the operator's own tenant — passing it here is exactly what
      // would make `IamService.resendInvite`'s inner `findOne({id, tenantId})`
      // 404 on a user who actually belongs to the tenant just provisioned.
      expect(resolveAdminInviteTarget).toHaveBeenCalledWith(TARGET_TENANT, undefined);
      expect(resendInvite).toHaveBeenCalledWith(
        TARGET_TENANT,
        'user-1',
        expect.objectContaining({
          id: 'operator-1',
          name: 'Meru Platform',
          // The mail body says "Meru Platform"; the audit row must still name
          // the real operator. Anton's review (2026-09-17): `name` alone used
          // to feed both, so a resend through this route would have audited
          // "Meru Platform" as the actor rather than the operator who
          // triggered it. `req.user.email` is server-derived from the JWT,
          // never client input.
          auditEmail: 'op@meru.internal',
        }),
      );

      // `IamService.resendInvite` writes its own `INVITE_RESENT` audit row
      // under whichever `tenantId` it is called with — proven generically in
      // `iam-audit-coverage.spec.ts`, which also proves `auditEmail` (not
      // `name`) is what lands in that row's `userEmail`. Calling it with
      // `TARGET_TENANT` here (not `OPERATOR_TENANT`) is what makes that row
      // land under the tenant whose admin invite this actually was.
      expect(result).toEqual({
        tenantId: TARGET_TENANT,
        userId: 'user-1',
        email: 'priya@harbourline.example',
        inviteSent: true,
        expiresAt: new Date('2026-09-17T15:52:00Z'),
        inviteUrl: 'https://app.immistack.com/reset-password?token=fresh',
      });
    });

    it('passes userId through when the caller supplied one', async () => {
      const tenancyService = new TenancyService({
        logEvent: jest.fn().mockResolvedValue({}),
      } as any);
      const resolveAdminInviteTarget = jest.fn().mockResolvedValue({ id: 'user-2' });
      const resendInvite = jest.fn().mockResolvedValue({
        email: 'x@y.test',
        inviteSent: true,
        expiresAt: new Date(),
        inviteUrl: 'https://app.immistack.com/reset-password?token=z',
      });
      const controller = new TenantProvisioningController(
        { resolveAdminInviteTarget } as any,
        tenancyService,
        { resendInvite } as any,
      );

      await controller.resendAdminInvite(operatorReq, TARGET_TENANT, { userId: 'user-2' });

      expect(resolveAdminInviteTarget).toHaveBeenCalledWith(TARGET_TENANT, 'user-2');
    });

    it('if the god-mode audit write fails, nothing downstream runs — no resolve, no resend, no issue', async () => {
      const logEvent = jest.fn().mockRejectedValue(new Error('audit db unreachable'));
      const tenancyService = new TenancyService({ logEvent } as any);

      const resolveAdminInviteTarget = jest.fn();
      const resendInvite = jest.fn();

      const controller = new TenantProvisioningController(
        { resolveAdminInviteTarget } as any,
        tenancyService,
        { resendInvite } as any,
      );

      await expect(
        controller.resendAdminInvite(operatorReq, TARGET_TENANT, {}),
      ).rejects.toThrow('audit db unreachable');

      expect(resolveAdminInviteTarget).not.toHaveBeenCalled();
      expect(resendInvite).not.toHaveBeenCalled();
    });

    it('propagates a 409 from resolveAdminInviteTarget (active user) without calling resendInvite', async () => {
      const tenancyService = new TenancyService({
        logEvent: jest.fn().mockResolvedValue({}),
      } as any);
      const resolveAdminInviteTarget = jest
        .fn()
        .mockRejectedValue(new ConflictException('already accepted'));
      const resendInvite = jest.fn();

      const controller = new TenantProvisioningController(
        { resolveAdminInviteTarget } as any,
        tenancyService,
        { resendInvite } as any,
      );

      await expect(
        controller.resendAdminInvite(operatorReq, TARGET_TENANT, {}),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(resendInvite).not.toHaveBeenCalled();
    });

    it('propagates a 404 from resolveAdminInviteTarget (user in a different tenant) without calling resendInvite', async () => {
      const tenancyService = new TenancyService({
        logEvent: jest.fn().mockResolvedValue({}),
      } as any);
      const resolveAdminInviteTarget = jest
        .fn()
        .mockRejectedValue(new NotFoundException('No such user on this tenant'));
      const resendInvite = jest.fn();

      const controller = new TenantProvisioningController(
        { resolveAdminInviteTarget } as any,
        tenancyService,
        { resendInvite } as any,
      );

      await expect(
        controller.resendAdminInvite(operatorReq, TARGET_TENANT, { userId: 'someone-elses-user' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(resendInvite).not.toHaveBeenCalled();
    });
  });

  describe('malformed :tenantId — a clean 400, not a Postgres 22P02', () => {
    // Asserted against the controller's own source, following
    // `workflow-route-order.spec.ts`'s pattern: the property under test is
    // that THIS route's `tenantId` param carries `ParseUUIDPipe` — a runtime
    // HTTP test would need a full Nest bootstrap to observe the same thing,
    // and every other decorator-level property on this controller is already
    // tested this way in this file's authz block above.
    const source = readFileSync(join(__dirname, 'tenant-provisioning.controller.ts'), 'utf8');

    it("declares ParseUUIDPipe on this route's tenantId param", () => {
      const routeStart = source.indexOf("@Post(':tenantId/admin-invite/resend')");
      expect(routeStart).toBeGreaterThan(-1);

      const handlerStart = source.indexOf('async resendAdminInvite(', routeStart);
      expect(handlerStart).toBeGreaterThan(-1);
      const handlerEnd = source.indexOf(')', source.indexOf('@Body()', handlerStart));

      const paramList = source.slice(handlerStart, handlerEnd);
      expect(paramList).toContain("@Param('tenantId', ParseUUIDPipe)");
    });

    it('does NOT require this on the older, untouched routes on this controller (out of scope for this change)', () => {
      // Pinned so a future edit does not silently widen this beyond what was
      // asked — those routes take a plain string today.
      expect(source).toContain("@Param('id') id: string");
    });

    it("ParseUUIDPipe itself refuses a non-uuid tenantId with a 400, before any query runs", async () => {
      const pipe = new ParseUUIDPipe();
      await expect(
        pipe.transform('not-a-real-uuid', { type: 'param', data: 'tenantId' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ParseUUIDPipe accepts a well-formed uuid unchanged', async () => {
      const pipe = new ParseUUIDPipe();
      const uuid = '4b1f6e2a-2f2b-4a3e-9f3a-6b1a2c3d4e5f';
      await expect(
        pipe.transform(uuid, { type: 'param', data: 'tenantId' } as any),
      ).resolves.toBe(uuid);
    });
  });
});
