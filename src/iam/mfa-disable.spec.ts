import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { authenticator } from 'otplib';
import { IamService } from './iam.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/**
 * `POST /auth/mfa/disable` used to take no code, write no audit entry, and
 * answer `{success: true}` whether or not a row changed. So any holder of an
 * access token — stolen, or reachable through XSS — could permanently remove
 * the second factor with no trace, and under `meru_app` with no tenant bound
 * the route reported a success that had not happened.
 *
 * Now: a valid current TOTP code is required, zero rows affected is a 404 and
 * not a false success, and both switching MFA off and switching it on leave an
 * `audit_logs` row.
 */
describe('IamService — MFA disable and enable', () => {
  const T = 'tenant-1';
  const SECRET = authenticator.generateSecret();

  function build(
    user: Record<string, any> | null,
    updateResult: { affected?: number } = { affected: 1 },
  ) {
    const auditEvents: Array<Record<string, any>> = [];
    const userRepo = {
      findOne: jest.fn(async () => (user ? { ...user } : null)),
      update: jest.fn(async () => updateResult),
      save: jest.fn(async (u: any) => u),
    };
    const auditService = {
      logEvent: jest.fn(async (dto: Record<string, any>) => {
        auditEvents.push(dto);
        return { id: 'audit-1' };
      }),
    };
    const service = new IamService(
      userRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      auditService as any,
    );
    return { service, userRepo, auditEvents };
  }

  const enrolled = () => ({
    id: 'u1',
    tenantId: T,
    email: 'u1@example.test',
    mfaEnabled: true,
    mfaSecret: SECRET,
  });

  describe('disableMfa', () => {
    it('refuses a wrong code and changes nothing', async () => {
      const { service, userRepo, auditEvents } = build(enrolled());
      // A fixed code that is not the current one for SECRET.
      const wrong =
        authenticator.generate(SECRET) === '000000' ? '111111' : '000000';
      await expect(service.disableMfa(T, 'u1', wrong)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(userRepo.update).not.toHaveBeenCalled();
      expect(auditEvents).toEqual([]);
    });

    it('with a valid code, switches MFA off for that user in that tenant, and audits it', async () => {
      const { service, userRepo, auditEvents } = build(enrolled());
      await expect(
        service.disableMfa(T, 'u1', authenticator.generate(SECRET)),
      ).resolves.toEqual({ success: true });

      expect(userRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1', tenantId: T } }),
      );
      expect(userRepo.update).toHaveBeenCalledWith(
        { id: 'u1', tenantId: T },
        expect.objectContaining({ mfaEnabled: false, mfaSecret: null }),
      );
      // Intent first, completion after (mfa-audit-ordering.spec.ts); both
      // filed against this user in this tenant.
      expect(auditEvents.map((e) => e.context?.event)).toEqual([
        'mfa.disable.requested',
        'mfa.disabled',
      ]);
      for (const e of auditEvents) {
        expect(e).toMatchObject({
          tenantId: T,
          userId: 'u1',
          entityType: 'user',
          entityId: 'u1',
          action: AuditAction.UPDATE,
        });
      }
    });

    it('reports zero rows affected as NotFound, never as success', async () => {
      const { service, auditEvents } = build(enrolled(), { affected: 0 });
      await expect(
        service.disableMfa(T, 'u1', authenticator.generate(SECRET)),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Audit-first (mfa-audit-ordering.spec.ts) means the intent row is
      // already written; a second row records that it did not take effect,
      // and no row ever claims MFA was disabled.
      expect(auditEvents.map((e) => e.context?.event)).toEqual([
        'mfa.disable.requested',
        'mfa.disable.not_applied',
      ]);
    });

    it('refuses when MFA is not enabled', async () => {
      const { service, userRepo } = build({
        ...enrolled(),
        mfaEnabled: false,
      });
      await expect(
        service.disableMfa(T, 'u1', authenticator.generate(SECRET)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(userRepo.update).not.toHaveBeenCalled();
    });

    it('refuses an unknown user', async () => {
      const { service } = build(null);
      await expect(
        service.disableMfa(T, 'u1', '123456'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('verifyMfaSetup', () => {
    it('audits MFA being switched on', async () => {
      const { service, auditEvents } = build({
        ...enrolled(),
        mfaEnabled: false,
      });
      await expect(
        service.verifyMfaSetup('u1', authenticator.generate(SECRET)),
      ).resolves.toEqual({ success: true });
      expect(auditEvents.map((e) => e.context?.event)).toEqual([
        'mfa.enable.requested',
        'mfa.enabled',
      ]);
      for (const e of auditEvents) {
        expect(e).toMatchObject({
          tenantId: T,
          userId: 'u1',
          entityType: 'user',
          entityId: 'u1',
          action: AuditAction.UPDATE,
        });
      }
    });
  });
});
