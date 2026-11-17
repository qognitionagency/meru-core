import { IamService } from './iam.service';
import { AuditService } from '../audit/audit.service';
import { PlatformRole } from './enums/platform-role.enum';
import { UserStatus } from './entities/user.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';

/**
 * Owen's FIX on `IamService.auditedChange` (commit 6).
 *
 * 1. The `*.requested` and `*.not_applied` rows used to spread the step's
 *    `beforeState`/`afterState`. `AuditService.logEvent` computes `changes`
 *    from exactly those two, so a request row — and a row saying the change
 *    did NOT happen — each stored `changes: [{ field: 'role', … }]`, and
 *    ImmiStack's `settings/audit` page renders `changes` as "Changed fields".
 *    The trail showed a change that never took effect. Only the applied row
 *    may carry before/after; the other two name the target in
 *    `context.requested` instead.
 *
 * 2. One `context.changeId` per `auditedChange` call ties its request row to
 *    its outcome, so a later reconciler can find a request with no outcome.
 *
 * `changes` is read off a REAL `AuditService.logEvent` (repository stubbed),
 * not recomputed here — the defect was in what that method derives from the
 * row, so that is what the assertion has to exercise.
 */
describe('IamService.auditedChange — request and not_applied rows state no change', () => {
  const T = 'tenant-1';
  const ADMIN = {
    id: 'admin-1',
    roles: [PlatformRole.FIRM_ADMIN],
    email: 'admin@acme.test',
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function build() {
    const users: Array<Record<string, any>> = [
      {
        id: 'u1',
        tenantId: T,
        email: 'u1@acme.test',
        roles: [PlatformRole.STAFF],
        status: UserStatus.ACTIVE,
        attributes: {},
        mfaEnabled: false,
        mfaSecret: 'SECRET',
      },
    ];
    const userRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        const u = users.find(
          (x) =>
            x.id === where.id &&
            (where.tenantId === undefined || x.tenantId === where.tenantId),
        );
        return u ? { ...u } : null;
      }),
      save: jest.fn(async (u: any) => {
        const i = users.findIndex((x) => x.id === u.id);
        users[i] = { ...u };
        return u;
      }),
    };

    // A real AuditService over a stub repository: `stored` holds exactly
    // what `logEvent` would have persisted, `changes` included.
    const stored: Array<Record<string, any>> = [];
    const auditRepo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => {
        stored.push(x);
        return { id: `audit-${stored.length}`, ...x };
      }),
    };
    const auditService = new AuditService(auditRepo as any);
    const logEvent = jest.spyOn(auditService, 'logEvent');

    const service = new IamService(
      userRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      auditService,
    );
    return { service, users, userRepo, stored, logEvent, auditRepo };
  }

  const byEvent = (rows: Array<Record<string, any>>, event: string) => {
    const row = rows.find((r) => r.context?.event === event);
    if (!row) throw new Error(`no row with context.event=${event}`);
    return row;
  };

  describe('fix 1 — before/after only on the applied row', () => {
    it('a role change: the request row carries no before/after and logEvent computes no changes', async () => {
      const { service, stored } = build();

      await service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN);

      const requested = byEvent(stored, 'role.change.requested');
      expect(requested.beforeState).toBeNull();
      expect(requested.afterState).toBeNull();
      expect(requested.changes).toEqual([]);
      // The target is still recorded — as a request, in context.
      expect(requested.context.requested).toEqual({
        field: 'role',
        from: PlatformRole.STAFF,
        to: PlatformRole.FIRM_ADMIN,
      });
    });

    it('a role change: the applied ROLE_CHANGED row keeps before/after, so its changes are real', async () => {
      const { service, stored } = build();

      await service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN);

      const applied = byEvent(stored, 'role.changed');
      expect(applied.action).toBe(AuditAction.ROLE_CHANGED);
      expect(applied.beforeState).toEqual({ role: PlatformRole.STAFF });
      expect(applied.afterState).toEqual({ role: PlatformRole.FIRM_ADMIN });
      expect(applied.changes).toEqual([
        { field: 'role', oldValue: PlatformRole.STAFF, newValue: PlatformRole.FIRM_ADMIN },
      ]);
    });

    it('a failed role save: the not_applied row carries no before/after and logEvent computes no changes', async () => {
      const { service, stored, userRepo } = build();
      userRepo.save.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

      await expect(
        service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN),
      ).rejects.toThrow('Connection terminated unexpectedly');

      expect(stored.map((r) => r.context?.event)).toEqual([
        'role.change.requested',
        'role.change.not_applied',
      ]);
      for (const row of stored) {
        expect(row.beforeState).toBeNull();
        expect(row.afterState).toBeNull();
        expect(row.changes).toEqual([]);
      }
      expect(byEvent(stored, 'role.change.not_applied').context.requested).toEqual({
        field: 'role',
        from: PlatformRole.STAFF,
        to: PlatformRole.FIRM_ADMIN,
      });
    });

    it('a failed role+status save: neither request nor not_applied row of either step states a change', async () => {
      const { service, stored, userRepo } = build();
      userRepo.save.mockRejectedValueOnce(new Error('Query read timeout'));

      await expect(
        service.updateUser(
          T,
          'u1',
          { role: PlatformRole.FIRM_ADMIN, status: UserStatus.INACTIVE },
          ADMIN,
        ),
      ).rejects.toThrow('Query read timeout');

      expect(stored.map((r) => r.context?.event)).toEqual([
        'role.change.requested',
        'status.change.requested',
        'role.change.not_applied',
        'status.change.not_applied',
      ]);
      for (const row of stored) {
        expect(row.beforeState).toBeNull();
        expect(row.afterState).toBeNull();
        expect(row.changes).toEqual([]);
      }
      expect(byEvent(stored, 'status.change.requested').context.requested).toEqual({
        field: 'status',
        from: UserStatus.ACTIVE,
        to: UserStatus.INACTIVE,
      });
    });

    it('the dto handed to logEvent for a request row has no beforeState/afterState keys at all', async () => {
      const { service, logEvent } = build();

      await service.updateUser(T, 'u1', { status: UserStatus.INACTIVE }, ADMIN);

      const requestDto = logEvent.mock.calls
        .map(([dto]) => dto)
        .find((dto) => dto.context?.event === 'status.change.requested')!;
      expect(requestDto).not.toHaveProperty('beforeState');
      expect(requestDto).not.toHaveProperty('afterState');
    });

    it('an MFA change (no field target) writes no context.requested', async () => {
      const { service, stored, userRepo } = build();
      userRepo.save.mockRejectedValueOnce(new Error('write failed'));
      jest
        .spyOn(require('otplib').authenticator, 'check')
        .mockReturnValueOnce(true);

      await expect(service.verifyMfaSetup('u1', '123456')).rejects.toThrow('write failed');

      for (const row of stored) {
        expect(row.context).not.toHaveProperty('requested');
        expect(row.changes).toEqual([]);
      }
    });
  });

  describe('fix 2 — one changeId per auditedChange call', () => {
    it('the requested and applied rows share one UUID changeId', async () => {
      const { service, stored } = build();

      await service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN);

      const ids = stored.map((r) => r.context?.changeId);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toMatch(UUID);
      expect(new Set(ids).size).toBe(1);
    });

    it('the not_applied row carries the same changeId as its request', async () => {
      const { service, stored, userRepo } = build();
      userRepo.save.mockRejectedValueOnce(new Error('write failed'));

      await expect(
        service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN),
      ).rejects.toThrow('write failed');

      const [req, notApplied] = stored;
      expect(req.context.changeId).toMatch(UUID);
      expect(notApplied.context.changeId).toBe(req.context.changeId);
    });

    it('two separate calls get two different changeIds', async () => {
      const { service, stored } = build();

      await service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN);
      await service.updateUser(T, 'u1', { status: UserStatus.INACTIVE }, ADMIN);

      const first = byEvent(stored, 'role.change.requested').context.changeId;
      const second = byEvent(stored, 'status.change.requested').context.changeId;
      expect(first).toMatch(UUID);
      expect(second).toMatch(UUID);
      expect(first).not.toBe(second);
    });

    it('a failed completion write is logged with the changeId', async () => {
      const { service, stored, logEvent } = build();
      // Request row written for real; the ROLE_CHANGED completion row fails.
      const real = AuditService.prototype.logEvent;
      logEvent
        .mockImplementationOnce(function (this: AuditService, dto) {
          return real.call(this, dto);
        })
        .mockRejectedValueOnce(new Error('audit table unavailable'));
      const errorLog = jest
        .spyOn((service as any).logger, 'error')
        .mockImplementation(() => undefined);

      await service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN);

      const changeId = byEvent(stored, 'role.change.requested').context.changeId;
      expect(changeId).toMatch(UUID);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(changeId));
    });
  });
});
