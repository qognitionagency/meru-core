import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import * as crypto from 'crypto';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantSignupInvite } from './entities/tenant-signup-invite.entity';
import { Tenant, TenantPlan, VerticalType } from './entities/tenant.entity';
import { MeruErrorCode } from '../common/types';

/**
 * DEF-1 — `POST /tenants/signup` no longer accepts an unauthenticated caller
 * with no invite. Unauthenticated `POST /tenants/signup` with `{}` used to
 * clear auth entirely and reach DTO validation (`MER-VAL-0001`), proving
 * anyone could self-provision a TRIAL tenant and a `firm_admin` login with a
 * caller-supplied password — the same defect class `POST /auth/register` was
 * removed for on 2026-09-04, one controller over.
 *
 * `TenantProvisioningService.createTenant` runs the whole redemption +
 * tenant-creation flow inside one DB transaction via a hand-rolled
 * `QueryRunner`, so these tests fake that runner rather than a repository —
 * the property under test is the atomic
 * `UPDATE ... WHERE "usedAt" IS NULL ... RETURNING *`, which a plain
 * find-then-save mock cannot exercise honestly.
 */
describe('TenantProvisioningService — signup invite gate (DEF-1)', () => {
  const hash = (token: string) =>
    crypto.createHash('sha256').update(token).digest('hex');

  const RAW_TOKEN = 'a-raw-invite-token';

  function makeInviteRow(
    over: Partial<TenantSignupInvite> = {},
  ): TenantSignupInvite {
    return {
      id: 'invite-1',
      email: 'owner@newfirm.example',
      tokenHash: hash(RAW_TOKEN),
      allowedSlug: null,
      allowedVertical: null,
      allowedPlan: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      usedAt: null,
      issuedBy: 'platform-admin-1',
      createdAt: new Date(),
      ...over,
    };
  }

  /**
   * Fakes `DataSource.createQueryRunner()` closely enough to exercise the
   * real redemption SQL shape: a WHERE/andWhere-accumulated params object
   * matched against one in-memory invite row, mutated in place by `.set()`
   * only when the row still qualifies — the same semantics an atomic
   * `UPDATE ... WHERE usedAt IS NULL ... RETURNING *` has in Postgres.
   */
  function makeDataSource(invite: TenantSignupInvite | null, existingTenant: unknown = null) {
    let params: Record<string, unknown> = {};
    let setPatch: Record<string, unknown> = {};

    const qb: any = {
      update: jest.fn(() => qb),
      set: jest.fn((patch: Record<string, unknown>) => {
        setPatch = patch;
        return qb;
      }),
      where: jest.fn((_sql: string, p: Record<string, unknown> = {}) => {
        Object.assign(params, p);
        return qb;
      }),
      andWhere: jest.fn((_sql: string, p: Record<string, unknown> = {}) => {
        Object.assign(params, p);
        return qb;
      }),
      returning: jest.fn(() => qb),
      execute: jest.fn(async () => {
        if (
          !invite ||
          invite.tokenHash !== params.tokenHash ||
          invite.usedAt ||
          invite.expiresAt <= (params.now as Date)
        ) {
          return { raw: [] };
        }
        Object.assign(invite, setPatch);
        return { raw: [{ ...invite }] };
      }),
    };

    const manager = {
      findOne: jest.fn(async (entity: unknown) =>
        entity === Tenant ? existingTenant : null,
      ),
      create: jest.fn((_entity: unknown, data: unknown) => ({ ...(data as object) })),
      save: jest.fn(async (_entity: unknown) => _entity),
      createQueryBuilder: jest.fn(() => qb),
    };

    const queryRunner = {
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      manager,
    };

    return {
      dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
      queryRunner,
    };
  }

  function makeService(opts: {
    invite: TenantSignupInvite | null;
    existingTenant?: unknown;
    inviteRepoSave?: jest.Mock;
  }) {
    const { dataSource, queryRunner } = makeDataSource(
      opts.invite,
      opts.existingTenant,
    );
    const mailService = {
      sendWelcome: jest.fn().mockResolvedValue({ delivered: true }),
      sendTenantSignupInvite: jest.fn().mockResolvedValue({ delivered: true }),
      signupInviteUrl: jest.fn(
        (t: string) => `https://app.immistack.com/onboarding?token=${t}`,
      ),
    };
    const auditService = { logEvent: jest.fn().mockResolvedValue(undefined) };
    const tenantSignupInviteRepo = {
      create: jest.fn((data: unknown) => data),
      save: opts.inviteRepoSave ?? jest.fn().mockResolvedValue(undefined),
    };

    const service = new TenantProvisioningService(
      undefined as never, // tenantRepo — unused; queryRunner.manager stands in
      undefined as never, // userRepo
      undefined as never, // tenantSettingRepo
      tenantSignupInviteRepo as never,
      dataSource as never,
      undefined as never, // configService
      mailService as never,
      auditService as never,
    );

    return { service, queryRunner, mailService, auditService, tenantSignupInviteRepo };
  }

  const baseDto = {
    name: 'New Firm',
    slug: 'newfirm',
    vertical: VerticalType.IMMIGRATION,
    plan: TenantPlan.FREE,
    firstName: 'Owner',
    lastName: 'Person',
    email: 'owner@newfirm.example',
    password: 'a-strong-password',
    token: RAW_TOKEN,
  };

  describe('mintSignupInvite', () => {
    it('stores only the SHA-256 of the token, and emails the raw token', async () => {
      const { service, tenantSignupInviteRepo, mailService } = makeService({
        invite: null,
      });

      await service.mintSignupInvite(
        { email: 'owner@newfirm.example' } as never,
        'platform-admin-1',
      );

      const saved = tenantSignupInviteRepo.create.mock.calls[0][0];
      expect(saved.tokenHash).toHaveLength(64); // hex sha256
      expect(saved.tokenHash).not.toContain(' ');
      expect(saved.issuedBy).toBe('platform-admin-1');

      const mailed = mailService.sendTenantSignupInvite.mock.calls[0][0];
      // The raw token mailed to the invitee must hash to what was stored —
      // proving it is the same token, without the test ever seeing a second
      // raw copy persisted anywhere.
      expect(hash(mailed.token)).toBe(saved.tokenHash);
    });

    it('returns the raw token and its link to the platform_admin caller', async () => {
      // The operator recovery path. Without this the token exists in exactly
      // one place — the body of an email nobody in this system can read back —
      // so a message that is slow, filtered or misrouted leaves the recipient
      // permanently unable to onboard and the operator with nothing to resend.
      // The caller is already platform_admin and already through runAsGod with
      // a CRITICAL audit entry written first; they could simply mint another.
      const { service, tenantSignupInviteRepo } = makeService({ invite: null });

      const result = await service.mintSignupInvite(
        { email: 'owner@newfirm.example' } as never,
        'platform-admin-1',
      );

      const saved = tenantSignupInviteRepo.create.mock.calls[0][0] as {
        tokenHash: string;
      };
      // Same token as the one that was stored, hashed — not a second one.
      expect(hash(result.token)).toBe(saved.tokenHash);
      expect(result.inviteUrl).toContain(result.token);
      // …and the link goes to a route that exists. `/signup` does not exist in
      // the ImmiStack app; the wizard is at `app/(auth)/onboarding`, so every
      // invite built against `/signup` was a 404 the operator saw reported as
      // `delivered: true`.
      expect(result.inviteUrl).toContain('/onboarding?token=');
      expect(result.inviteUrl).not.toContain('/signup?');
    });

    it('reports whether the email actually went out, rather than assuming', async () => {
      const { service, mailService } = makeService({ invite: null });
      mailService.sendTenantSignupInvite.mockResolvedValueOnce({
        delivered: false,
      });

      const result = await service.mintSignupInvite(
        { email: 'owner@newfirm.example' } as never,
        'platform-admin-1',
      );

      // The invite is valid either way; the operator needs to know whether to
      // hand over the link themselves. Same reporting `IamService.inviteUser`
      // already does with `inviteSent`.
      expect(result.delivered).toBe(false);
      expect(result.token).toBeTruthy();
    });
  });

  describe('redemption via createTenant', () => {
    it('refuses an unknown token with one generic code, not a distinguishing message', async () => {
      const { service, queryRunner } = makeService({ invite: null });

      const attempt = service.createTenant({ ...baseDto, token: 'nope' } as never);

      await expect(attempt).rejects.toBeInstanceOf(HttpException);
      await expect(attempt.catch((e) => e)).resolves.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        response: expect.objectContaining({
          code: MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID,
        }),
      });
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.manager.save).not.toHaveBeenCalled();
    });

    it('refuses an already-used token — the atomic burn, not a second read', async () => {
      const invite = makeInviteRow({ usedAt: new Date() });
      const { service } = makeService({ invite });

      await expect(service.createTenant({ ...baseDto } as never)).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            code: MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID,
          }),
        },
      );
    });

    it('refuses an expired token', async () => {
      const invite = makeInviteRow({ expiresAt: new Date(Date.now() - 1000) });
      const { service } = makeService({ invite });

      await expect(service.createTenant({ ...baseDto } as never)).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            code: MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID,
          }),
        },
      );
    });

    it('refuses when the request email does not match the invite — and the burn rolls back', async () => {
      const invite = makeInviteRow({ email: 'someone-else@example.test' });
      const { service, queryRunner } = makeService({ invite });

      await expect(
        service.createTenant({ ...baseDto } as never),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID,
        }),
      });

      // A real Postgres ROLLBACK undoes the UPDATE along with everything
      // else in the transaction, so the token is NOT actually spent by a
      // caller who mistyped the request email — they can retry with the
      // same link. This fake queryRunner does not model rollback undoing an
      // in-memory mutation (there is no real transaction to revert), so the
      // property under test here is only that the service calls
      // `rollbackTransaction` rather than `commitTransaction` on this path.
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });

    it('matches the invite email case-insensitively', async () => {
      const invite = makeInviteRow({ email: 'Owner@NewFirm.example' });
      const { service } = makeService({ invite });

      await expect(
        service.createTenant({ ...baseDto } as never),
      ).resolves.toMatchObject({ workspaceUrl: expect.any(String) });
    });

    it('rejects a request slug that disagrees with a pinned allowedSlug', async () => {
      const invite = makeInviteRow({ allowedSlug: 'pinned-slug' });
      const { service } = makeService({ invite });

      await expect(
        service.createTenant({ ...baseDto, slug: 'not-the-pinned-slug' } as never),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID,
        }),
      });
    });

    it('rejects a request vertical that disagrees with a pinned allowedVertical', async () => {
      const invite = makeInviteRow({ allowedVertical: VerticalType.GRC });
      const { service } = makeService({ invite });

      await expect(
        service.createTenant({
          ...baseDto,
          vertical: VerticalType.IMMIGRATION,
        } as never),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID,
        }),
      });
    });

    it('rejects a request plan that disagrees with a pinned allowedPlan', async () => {
      const invite = makeInviteRow({ allowedPlan: TenantPlan.ENTERPRISE });
      const { service } = makeService({ invite });

      await expect(
        service.createTenant({ ...baseDto, plan: TenantPlan.FREE } as never),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: MeruErrorCode.TENANT_SIGNUP_INVITE_INVALID,
        }),
      });
    });

    it('takes the slug/vertical/plan from the invite when pinned, not from the client', async () => {
      const invite = makeInviteRow({
        allowedSlug: 'pinned-slug',
        allowedVertical: VerticalType.GRC,
        allowedPlan: TenantPlan.ENTERPRISE,
      });
      const { service, queryRunner } = makeService({ invite });

      await service.createTenant({
        ...baseDto,
        slug: 'pinned-slug',
        vertical: VerticalType.GRC,
        plan: TenantPlan.ENTERPRISE,
      } as never);

      const savedTenant = queryRunner.manager.save.mock.calls[0][0];
      expect(savedTenant.slug).toBe('pinned-slug');
      expect(savedTenant.vertical).toBe(VerticalType.GRC);
      expect(savedTenant.plan).toBe(TenantPlan.ENTERPRISE);
    });

    it('falls back to the client-chosen slug/vertical/plan when the invite pins none', async () => {
      const invite = makeInviteRow();
      const { service, queryRunner } = makeService({ invite });

      await service.createTenant({ ...baseDto } as never);

      const savedTenant = queryRunner.manager.save.mock.calls[0][0];
      expect(savedTenant.slug).toBe(baseDto.slug);
      expect(savedTenant.vertical).toBe(baseDto.vertical);
      expect(savedTenant.plan).toBe(baseDto.plan);
    });

    it('still refuses a taken slug with the existing (unchanged) message, not the invite-invalid code', async () => {
      const invite = makeInviteRow();
      const { service } = makeService({
        invite,
        existingTenant: { id: 'existing', slug: baseDto.slug },
      });

      const attempt = service.createTenant({ ...baseDto } as never);
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt.catch((e) => e)).resolves.toMatchObject({
        message: expect.stringContaining('already taken'),
      });
    });

    it('burns the token and commits the tenant in the same transaction', async () => {
      const invite = makeInviteRow();
      const { service, queryRunner } = makeService({ invite });

      await service.createTenant({ ...baseDto } as never);

      expect(invite.usedAt).not.toBeNull();
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });

    it('writes a redemption audit entry attributed to the invite issuer, not an anonymous actor', async () => {
      const invite = makeInviteRow({ issuedBy: 'platform-admin-7' });
      const { service, auditService } = makeService({ invite });

      await service.createTenant({ ...baseDto } as never);

      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'platform-admin-7',
          entityType: 'tenant',
          context: expect.objectContaining({ signupInviteId: invite.id }),
        }),
      );
    });
  });
});
