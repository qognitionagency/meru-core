import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { authenticator } from 'otplib';
import { IamService } from './iam.service';
import { AllExceptionsFilter } from '../core/filters/http-exception.filter';

/**
 * Anton's sign-off: switching MFA on or off wrote its audit entry AFTER the
 * change, through `IamService.audit`, which logs and swallows a failed write.
 * So a second factor could be removed — the exact move an attacker holding a
 * token makes first — with no `audit_logs` row and a `{success: true}`.
 *
 * Owen's gate then found the fix's own hole: the strict row written first
 * said "MFA disabled for …" as a FACT, and the compensating entry fired only
 * when zero rows were affected. If the update itself threw — a dropped
 * connection, a timeout — the log asserted a change that never happened.
 *
 * The contract now, for both directions:
 *   1. `mfa.*.requested`  — strict, BEFORE the change, worded as a request.
 *      If it cannot be written: 503, and the MFA state does not move.
 *   2. the change.
 *   3a. success → `mfa.enabled` / `mfa.disabled`, the completion fact.
 *   3b. ANY failure (throw, or no row updated) → `mfa.*.not_applied`,
 *       best-effort, and the original error is rethrown.
 *
 * The shared best-effort helper keeps swallowing for its other callers.
 */
describe('IamService — MFA changes record intent first, then the outcome', () => {
  const T = 'tenant-1';
  const SECRET = authenticator.generateSecret();

  function build(opts: {
    user: Record<string, any>;
    /** Fail the audit write whose `context.event` is this (or every one). */
    auditFailsOn?: string | 'all';
    updateResult?: { affected?: number };
    updateRejects?: Error;
    saveRejects?: Error;
  }) {
    const calls: string[] = [];
    const auditEvents: Array<Record<string, any>> = [];
    const userRepo = {
      findOne: jest.fn(async () => ({ ...opts.user })),
      update: jest.fn(async () => {
        calls.push('update');
        if (opts.updateRejects) throw opts.updateRejects;
        return opts.updateResult ?? { affected: 1 };
      }),
      save: jest.fn(async (u: any) => {
        calls.push('save');
        if (opts.saveRejects) throw opts.saveRejects;
        return u;
      }),
    };
    const sessionRepo = {
      update: jest.fn(async () => ({ affected: 1 })),
    };
    const auditService = {
      logEvent: jest.fn(async (dto: Record<string, any>) => {
        const event = dto.context?.event ?? dto.action;
        calls.push(`audit:${event}`);
        if (opts.auditFailsOn === 'all' || opts.auditFailsOn === event) {
          throw new Error('audit_logs unavailable');
        }
        auditEvents.push(dto);
        return { id: 'audit-1' };
      }),
    };
    const service = new IamService(
      userRepo as any,
      {} as any,
      {} as any,
      sessionRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      auditService as any,
    );
    return { service, userRepo, sessionRepo, calls, auditEvents };
  }

  const enrolled = () => ({
    id: 'u1',
    tenantId: T,
    email: 'u1@example.test',
    mfaEnabled: true,
    mfaSecret: SECRET,
  });
  const pending = () => ({ ...enrolled(), mfaEnabled: false });
  const code = () => authenticator.generate(SECRET);

  describe('disableMfa', () => {
    it('records the request, then the change, then the completed fact', async () => {
      const { service, calls } = build({ user: enrolled() });
      await expect(service.disableMfa(T, 'u1', code())).resolves.toEqual({
        success: true,
      });
      expect(calls).toEqual([
        'audit:mfa.disable.requested',
        'update',
        'audit:mfa.disabled',
      ]);
    });

    it('words the pre-change row as a request, not as a completed fact', async () => {
      const { service, auditEvents } = build({ user: enrolled() });
      await service.disableMfa(T, 'u1', code());
      const [requested, done] = auditEvents;
      expect(requested.description).toMatch(/requested/i);
      expect(requested.description).not.toMatch(/^MFA disabled/);
      expect(done.description).toMatch(/^MFA disabled for u1@example\.test/);
    });

    it('if the intent row cannot be written: 503, MFA stays on, nothing else is written', async () => {
      const { service, userRepo, auditEvents } = build({
        user: enrolled(),
        auditFailsOn: 'mfa.disable.requested',
      });
      const err = await service.disableMfa(T, 'u1', code()).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.message).toMatch(/audit log unavailable.*change refused/i);
      expect(userRepo.update).not.toHaveBeenCalled();
      expect(auditEvents).toEqual([]);
    });

    it('if the update THROWS, records not_applied and rethrows the original error', async () => {
      const dropped = new Error('Connection terminated unexpectedly');
      const { service, auditEvents } = build({
        user: enrolled(),
        updateRejects: dropped,
      });
      await expect(service.disableMfa(T, 'u1', code())).rejects.toBe(dropped);
      expect(auditEvents.map((e) => e.context?.event)).toEqual([
        'mfa.disable.requested',
        'mfa.disable.not_applied',
      ]);
      expect(auditEvents[1].context).toMatchObject({ reason: 'write_failed' });
    });

    it('if the update affects no row, records not_applied and answers 404', async () => {
      const { service, auditEvents } = build({
        user: enrolled(),
        updateResult: { affected: 0 },
      });
      await expect(service.disableMfa(T, 'u1', code())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(auditEvents.map((e) => e.context?.event)).toEqual([
        'mfa.disable.requested',
        'mfa.disable.not_applied',
      ]);
      expect(auditEvents[1].context).toMatchObject({ reason: 'no_row_updated' });
    });

    it('a failed not_applied write does not mask the real error', async () => {
      const dropped = new Error('Connection terminated unexpectedly');
      const { service } = build({
        user: enrolled(),
        updateRejects: dropped,
        auditFailsOn: 'mfa.disable.not_applied',
      });
      await expect(service.disableMfa(T, 'u1', code())).rejects.toBe(dropped);
    });

    it('a failed completion write does not turn a real change into an error', async () => {
      // MFA IS off at this point; answering 5xx would tell the user it is not.
      // The intent row already exists, so the change is not unrecorded.
      const { service, userRepo } = build({
        user: enrolled(),
        auditFailsOn: 'mfa.disabled',
      });
      await expect(service.disableMfa(T, 'u1', code())).resolves.toEqual({
        success: true,
      });
      expect(userRepo.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('verifyMfaSetup', () => {
    it('records the request, then the change, then the completed fact', async () => {
      const { service, calls } = build({ user: pending() });
      await service.verifyMfaSetup('u1', code());
      expect(calls).toEqual([
        'audit:mfa.enable.requested',
        'save',
        'audit:mfa.enabled',
      ]);
    });

    it('if the intent row cannot be written: 503 and MFA stays off', async () => {
      const { service, userRepo } = build({
        user: pending(),
        auditFailsOn: 'mfa.enable.requested',
      });
      const err = await service
        .verifyMfaSetup('u1', code())
        .catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(userRepo.save).not.toHaveBeenCalled();
    });

    it('if the save THROWS, records not_applied and rethrows the original error', async () => {
      const timeout = new Error('Query read timeout');
      const { service, auditEvents } = build({
        user: pending(),
        saveRejects: timeout,
      });
      await expect(service.verifyMfaSetup('u1', code())).rejects.toBe(timeout);
      expect(auditEvents.map((e) => e.context?.event)).toEqual([
        'mfa.enable.requested',
        'mfa.enable.not_applied',
      ]);
    });
  });

  describe('what the client receives when the audit log is down', () => {
    /** Run an error through the real global filter; return status and body. */
    function envelope(exception: unknown) {
      const json = jest.fn();
      const res = { status: jest.fn().mockReturnValue({ json }) };
      const host: any = {
        switchToHttp: () => ({
          getResponse: () => res,
          getRequest: () => ({ method: 'POST', url: '/auth/mfa/disable', headers: {} }),
        }),
      };
      const filter = new AllExceptionsFilter();
      (filter as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
      filter.catch(exception, host);
      return { status: res.status.mock.calls[0][0], body: json.mock.calls[0][0] };
    }

    it('is a 503 MER-SRV-0002 saying the change was refused — not an opaque 500, and no driver text', async () => {
      const { service } = build({
        user: enrolled(),
        auditFailsOn: 'mfa.disable.requested',
      });
      const err = await service.disableMfa(T, 'u1', code()).catch((e) => e);
      const { status, body } = envelope(err);
      expect(status).toBe(503);
      expect(body.error.code).toBe('MER-SRV-0002');
      expect(body.error.message).toBe('Audit log unavailable — change refused');
      expect(JSON.stringify(body)).not.toContain('audit_logs unavailable');
    });
  });

  describe('the shared best-effort helper is unchanged for its other callers', () => {
    it('a session revocation still succeeds when its audit write fails', async () => {
      const { service, sessionRepo } = build({
        user: enrolled(),
        auditFailsOn: 'all',
      });
      await expect(
        service.revokeSessionById(T, 'u1', 's1'),
      ).resolves.toEqual({ revoked: true, sessionId: 's1' });
      expect(sessionRepo.update).toHaveBeenCalled();
    });
  });
});
