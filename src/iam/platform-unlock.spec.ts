import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlatformController } from './platform.controller';
import { NoImpersonationGuard } from './guards/no-impersonation.guard';
import { PolicyGuard } from './guards/policy.guard';
import { PlatformRole } from './enums/platform-role.enum';
import { UnlockUserDto } from './dto/unlock-user.dto';

/**
 * `POST /platform/users/:id/unlock` (Owen's gate, 2026-11-17). The attempt
 * lock had no undo; this is the undo, and it is an operator overriding a
 * security control on somebody else's account, so:
 *
 * - platform_admin only, and never from an impersonation session (the
 *   CRITICAL row would name the impersonated user);
 * - a written reason, required;
 * - `runAsGod` against the ACCOUNT's tenant, so the firm sees it in its own
 *   audit log, and the CRITICAL entry is written before the unlock;
 * - the unlock itself is one strict `auth.login.unlocked` row, and the
 *   counter ignores failures older than it.
 */
describe('PlatformController — POST /platform/users/:id/unlock', () => {
  const account = { id: 'victim-1', tenantId: 'firm-t', email: 'v@firm.test' };
  const operator = { id: 'op-1', tenantId: 'platform-t', email: 'op@meru.test', roles: ['platform_admin'] };

  function build(o: { account?: any; godFails?: boolean } = {}) {
    const calls: string[] = [];
    const limiter = {
      findAccountById: jest.fn(async () => (o.account === undefined ? account : o.account)),
      unlock: jest.fn(async () => {
        calls.push('unlock');
      }),
    };
    const tenancyService = {
      runAsGod: jest.fn(async (_a: string, _t: string, _r: string, fn: () => Promise<unknown>) => {
        calls.push('god-audit');
        if (o.godFails) throw new Error('audit down');
        return fn();
      }),
    };
    const controller = new PlatformController(
      {} as any,
      tenancyService as any,
      {} as any,
      limiter as any,
    );
    return { controller, limiter, tenancyService, calls };
  }

  it('is platform_admin only, behind jwt, policy and the impersonation refusal', () => {
    const handler = PlatformController.prototype.unlockUser;
    const roles = Reflect.getMetadata('roles', handler);
    expect(roles).toEqual([PlatformRole.PLATFORM_ADMIN]);
    const guards: any[] = Reflect.getMetadata(GUARDS_METADATA, handler);
    expect(guards).toContain(PolicyGuard);
    expect(guards).toContain(NoImpersonationGuard);
    // NoImpersonationGuard reads req.user, so it must run after the JWT guard.
    expect(guards.indexOf(NoImpersonationGuard)).toBeGreaterThan(guards.indexOf(PolicyGuard));
  });

  it('requires a reason', async () => {
    expect(await validate(plainToInstance(UnlockUserDto, {}))).not.toHaveLength(0);
    expect(await validate(plainToInstance(UnlockUserDto, { reason: 'x' }))).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(UnlockUserDto, { reason: 'Owner verified by phone, ticket 42' })),
    ).toHaveLength(0);
  });

  it("writes the CRITICAL entry against the account's tenant before unlocking, with the reason", async () => {
    const b = build();
    await b.controller.unlockUser({ user: operator } as any, 'victim-1', {
      reason: 'Owner verified by phone, ticket 42',
    });

    expect(b.calls).toEqual(['god-audit', 'unlock']);
    const [actorId, tenantId, reason] = b.tenancyService.runAsGod.mock.calls[0];
    expect(actorId).toBe('op-1');
    expect(tenantId).toBe('firm-t');
    expect(reason).toContain('victim-1');
    expect(reason).toContain('Owner verified by phone, ticket 42');
    expect(b.limiter.unlock).toHaveBeenCalledWith(
      account,
      { id: 'op-1', tenantId: 'platform-t', email: 'op@meru.test' },
      'Owner verified by phone, ticket 42',
    );
  });

  it('does not unlock when the CRITICAL entry cannot be written', async () => {
    const b = build({ godFails: true });
    await expect(
      b.controller.unlockUser({ user: operator } as any, 'victim-1', { reason: 'Owner verified by phone' }),
    ).rejects.toThrow('audit down');
    expect(b.limiter.unlock).not.toHaveBeenCalled();
  });

  it('404s an unknown user, before any audit row', async () => {
    const b = build({ account: null });
    await expect(
      b.controller.unlockUser({ user: operator } as any, 'nobody', { reason: 'Owner verified by phone' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(b.tenancyService.runAsGod).not.toHaveBeenCalled();
  });
});
