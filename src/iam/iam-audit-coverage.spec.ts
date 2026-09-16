import { IamService } from './iam.service';
import { PlatformRole } from './enums/platform-role.enum';
import { UserStatus } from './entities/user.entity';
import { AuthTokenType } from './entities/auth-token.entity';
import { AuditAction, AuditSeverity } from '../audit/entities/audit-log.entity';
import * as crypto from 'crypto';

/**
 * Seven IAM events wrote nothing to `audit_logs` before this: invite issue,
 * invite resend, password-reset request, credential-token redemption,
 * session revocation, role change and status change. A `firm_admin` minting
 * a password-set credential — or promoting a colleague to `platform_admin` —
 * left no trace to investigate.
 *
 * These tests assert the `action` and the entity each event is filed under —
 * not the full row shape — because `AuditService.logEvent` computes the hash
 * chain and checksum itself and is exercised on its own terms elsewhere
 * (`src/audit/`). What belongs here is "did IamService call it, with the
 * right event and the right tenant", the part IAM is actually responsible
 * for getting right.
 */
describe('IamService — IAM audit coverage', () => {
  const T = 'tenant-1';
  const ADMIN = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN], email: 'admin@acme.test' };

  function build() {
    const users: Array<Record<string, any>> = [];
    const authTokens: Array<Record<string, any>> = [];
    const sessions: Array<Record<string, any>> = [];
    const auditEvents: Array<Record<string, any>> = [];

    const userRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.email !== undefined) {
          const match = users.find((u) => u.email === where.email);
          return match ? { ...match } : null;
        }
        const match = users.find(
          (u) =>
            u.id === where.id &&
            (where.tenantId === undefined || u.tenantId === where.tenantId),
        );
        return match ? { ...match } : null;
      }),
      create: jest.fn((x: any) => ({ id: `new-${users.length + 1}`, ...x })),
      save: jest.fn(async (u: any) => {
        const idx = users.findIndex((x) => x.id === u.id);
        if (idx === -1) users.push({ ...u });
        else users[idx] = { ...u };
        return u;
      }),
    };

    const tenantRepo = { findOne: jest.fn(async () => ({ id: T, name: 'Acme' })) };

    const authTokenRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        const match = authTokens.find((t) => t.tokenHash === where.tokenHash);
        return match ? { ...match } : null;
      }),
      update: jest.fn(async (where: any, patch: any) => {
        let affected = 0;
        for (const t of authTokens) {
          const idMatches = where.id === undefined || t.id === where.id;
          const userMatches = where.userId === undefined || t.userId === where.userId;
          const typeMatches = where.type === undefined || t.type === where.type;
          const usedAtMatches =
            where.usedAt === undefined || (where.usedAt === null ? t.usedAt == null : true);
          if (idMatches && userMatches && typeMatches && usedAtMatches && t.usedAt == null) {
            Object.assign(t, patch);
            affected++;
          }
        }
        return { affected };
      }),
      save: jest.fn(async (t: any) => {
        authTokens.push(t);
        return t;
      }),
      create: jest.fn((x: any) => ({ id: `tok-${authTokens.length + 1}`, ...x })),
    };

    const sessionRepo = {
      find: jest.fn(async () => sessions.filter((s) => !s.revokedAt)),
      update: jest.fn(async (where: any, patch: any) => {
        let affected = 0;
        for (const s of sessions) {
          const idMatches = where.id === undefined || s.id === where.id;
          const userMatches = where.userId === undefined || s.userId === where.userId;
          const revokedMatches = where.revokedAt === undefined || s.revokedAt == null;
          if (idMatches && userMatches && revokedMatches && s.revokedAt == null) {
            Object.assign(s, patch);
            affected++;
          }
        }
        return { affected };
      }),
    };

    const mailService = {
      sendInvite: jest.fn(async () => ({ delivered: true })),
      sendPasswordReset: jest.fn(async () => ({ delivered: true })),
      appUrl: 'https://app.immistack.com',
    };

    const auditService = {
      logEvent: jest.fn(async (dto: Record<string, any>) => {
        auditEvents.push(dto);
        return { id: `audit-${auditEvents.length}` };
      }),
    };

    const service = new IamService(
      userRepo as any,
      tenantRepo as any,
      {} as any,
      sessionRepo as any,
      {} as any,
      authTokenRepo as any,
      {} as any,
      mailService as any,
      auditService as any,
    );

    return {
      service,
      users,
      authTokens,
      sessions,
      auditEvents,
      auditService,
      userRepo,
    };
  }

  function seed(users: Array<Record<string, any>>, over: Record<string, any>) {
    users.push({
      tenantId: T,
      email: `${over.id}@acme.test`,
      firstName: 'Layla',
      lastName: 'Rashid',
      roles: [PlatformRole.STAFF],
      attributes: {},
      status: UserStatus.ACTIVE,
      ...over,
    });
  }

  it('invite issue writes an audit row', async () => {
    const { service, auditEvents } = build();

    await service.inviteUser(
      T,
      { email: 'new@acme.test', role: PlatformRole.STAFF },
      { id: ADMIN.id, name: ADMIN.email },
      ADMIN.roles,
    );

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      tenantId: T,
      action: AuditAction.INVITE_ISSUED,
      entityType: 'user',
      userId: ADMIN.id,
    });
  });

  it('invite resend writes an audit row', async () => {
    const { service, users, auditEvents } = build();
    seed(users, { id: 'u1', status: UserStatus.INVITED });

    await service.resendInvite(T, 'u1', { id: ADMIN.id, name: ADMIN.email });

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        tenantId: T,
        action: AuditAction.INVITE_RESENT,
        entityType: 'user',
        entityId: 'u1',
      }),
    );
  });

  /**
   * On the same-tenant route (`UsersController.resendInvite`), `name` IS the
   * caller's email — `req.user.email`, passed straight through — so the audit
   * row's `userEmail` has always matched. This pins that unchanged.
   */
  it('invite resend audits the caller\'s email when no auditEmail is given (same-tenant route, unchanged)', async () => {
    const { service, users, auditEvents } = build();
    seed(users, { id: 'u1', status: UserStatus.INVITED });

    await service.resendInvite(T, 'u1', { id: ADMIN.id, name: ADMIN.email });

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: AuditAction.INVITE_RESENT,
        userEmail: ADMIN.email,
      }),
    );
  });

  /**
   * The God View admin-invite-resend route (`TenantProvisioningController`)
   * names the mail sender "Meru Platform" — the recipient has never heard of
   * the individual operator — but the audit trail must still name the REAL
   * operator. `auditEmail` is the seam: when given, it overrides `name` for
   * the audit row only; the mail body still gets `name`. Found by Anton's
   * review: `name` was previously the only source for both, so the audit row
   * would have recorded "Meru Platform" as the actor, not the operator who
   * actually triggered the resend.
   */
  it('invite resend audits auditEmail, not the mail display name, when the two diverge', async () => {
    const { service, users, auditEvents } = build();
    seed(users, { id: 'u1', status: UserStatus.INVITED });

    await service.resendInvite(T, 'u1', {
      id: ADMIN.id,
      name: 'Meru Platform',
      auditEmail: ADMIN.email,
    });

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: AuditAction.INVITE_RESENT,
        userEmail: ADMIN.email,
      }),
    );
    expect(auditEvents).not.toContainEqual(
      expect.objectContaining({
        action: AuditAction.INVITE_RESENT,
        userEmail: 'Meru Platform',
      }),
    );
  });

  it('a password-reset request writes an audit row scoped to the account holder', async () => {
    const { service, users, auditEvents } = build();
    seed(users, { id: 'u1' });

    await service.requestPasswordReset('u1@acme.test');

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        tenantId: T,
        userId: 'u1',
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        entityType: 'user',
        entityId: 'u1',
      }),
    );
  });

  it('a password-reset request against a locked account is audited at WARNING, refused', async () => {
    const { service, users, auditEvents } = build();
    seed(users, { id: 'u1', status: UserStatus.LOCKED });

    await service.requestPasswordReset('u1@acme.test');

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        severity: AuditSeverity.WARNING,
        context: expect.objectContaining({ refused: true }),
      }),
    );
  });

  it('a password-reset request for an unknown address writes nothing (no tenant to scope it to)', async () => {
    const { service, auditEvents } = build();

    await service.requestPasswordReset('nobody@acme.test');

    expect(auditEvents).toHaveLength(0);
  });

  it('redeeming an invite token writes a TOKEN_REDEEMED row naming the token type', async () => {
    const { service, users, authTokens, auditEvents } = build();
    seed(users, { id: 'u1', status: UserStatus.INVITED });
    const rawToken = 'raw-invite-token';
    authTokens.push({
      id: 'tok-1',
      tenantId: T,
      userId: 'u1',
      type: AuthTokenType.INVITE,
      tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    await service.resetPassword(rawToken, 'a-new-password-123');

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        tenantId: T,
        userId: 'u1',
        action: AuditAction.TOKEN_REDEEMED,
        entityType: 'user',
        entityId: 'u1',
        context: expect.objectContaining({ tokenType: AuthTokenType.INVITE }),
      }),
    );
  });

  it('redeeming a password-reset token writes a TOKEN_REDEEMED row naming the token type', async () => {
    const { service, users, authTokens, auditEvents } = build();
    seed(users, { id: 'u1' });
    const rawToken = 'raw-reset-token';
    authTokens.push({
      id: 'tok-1',
      tenantId: T,
      userId: 'u1',
      type: AuthTokenType.PASSWORD_RESET,
      tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });

    await service.resetPassword(rawToken, 'a-new-password-123');

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: AuditAction.TOKEN_REDEEMED,
        context: expect.objectContaining({ tokenType: AuthTokenType.PASSWORD_RESET }),
      }),
    );
  });

  it('revoking one session writes a SESSION_REVOKED row scoped "single"', async () => {
    const { service, sessions, auditEvents } = build();
    sessions.push({ id: 's1', userId: 'u1', revokedAt: null });

    await service.revokeSessionById(T, 'u1', 's1');

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        tenantId: T,
        userId: 'u1',
        action: AuditAction.SESSION_REVOKED,
        entityType: 'session',
        entityId: 's1',
        context: expect.objectContaining({ scope: 'single' }),
      }),
    );
  });

  it('signing out everywhere writes one SESSION_REVOKED row scoped "all"', async () => {
    const { service, sessions, auditEvents } = build();
    sessions.push({ id: 's1', userId: 'u1', revokedAt: null });
    sessions.push({ id: 's2', userId: 'u1', revokedAt: null });

    await service.revokeAllSessions(T, 'u1');

    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        action: AuditAction.SESSION_REVOKED,
        entityType: 'user',
        entityId: 'u1',
        context: expect.objectContaining({ scope: 'all', sessionCount: 2 }),
      }),
    );
    // One row for the whole sign-out-everywhere action, not one per session.
    expect(
      auditEvents.filter((e) => e.action === AuditAction.SESSION_REVOKED),
    ).toHaveLength(1);
  });

  describe('updateUser', () => {
    it('a role change writes a ROLE_CHANGED row with before/after', async () => {
      const { service, users, auditEvents } = build();
      seed(users, { id: 'u1', roles: [PlatformRole.STAFF] });

      await service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN);

      expect(auditEvents).toContainEqual(
        expect.objectContaining({
          tenantId: T,
          userId: ADMIN.id,
          action: AuditAction.ROLE_CHANGED,
          entityType: 'user',
          entityId: 'u1',
          beforeState: { role: PlatformRole.STAFF },
          afterState: { role: PlatformRole.FIRM_ADMIN },
        }),
      );
    });

    it('a status change writes a STATUS_CHANGED row with before/after', async () => {
      const { service, users, auditEvents } = build();
      seed(users, { id: 'u1', status: UserStatus.ACTIVE });

      await service.updateUser(T, 'u1', { status: UserStatus.INACTIVE }, ADMIN);

      expect(auditEvents).toContainEqual(
        expect.objectContaining({
          action: AuditAction.STATUS_CHANGED,
          beforeState: { status: UserStatus.ACTIVE },
          afterState: { status: UserStatus.INACTIVE },
        }),
      );
    });

    it('setting a role to its current value writes nothing — this is a CHANGE log, not a write log', async () => {
      const { service, users, auditEvents } = build();
      seed(users, { id: 'u1', roles: [PlatformRole.STAFF] });

      await service.updateUser(T, 'u1', { role: PlatformRole.STAFF }, ADMIN);

      expect(
        auditEvents.filter((e) => e.action === AuditAction.ROLE_CHANGED),
      ).toHaveLength(0);
    });

    it('editing only firstName writes neither a role nor a status event', async () => {
      const { service, users, auditEvents } = build();
      seed(users, { id: 'u1' });

      await service.updateUser(T, 'u1', { firstName: 'Renamed' }, ADMIN);

      expect(auditEvents).toHaveLength(0);
    });

    /**
     * ROLE_CHANGED / STATUS_CHANGED are the two IAM audit events that are NOT
     * best-effort (see `IamService.updateUser`'s own comment at the two
     * `auditService.logEvent` calls). A failed audit write for a privilege or
     * account-standing change must roll the change back — proven here by
     * asserting `userRepo.save` was never called and the error propagates,
     * not by inspecting a database transaction this test harness has none of.
     */
    it('TRANSACTIONAL: a role-change audit failure leaves the role unchanged and propagates', async () => {
      const { service, users, auditService, userRepo } = build();
      seed(users, { id: 'u1', roles: [PlatformRole.STAFF] });
      auditService.logEvent.mockRejectedValueOnce(
        new Error('audit table unavailable'),
      );

      await expect(
        service.updateUser(T, 'u1', { role: PlatformRole.FIRM_ADMIN }, ADMIN),
      ).rejects.toThrow('audit table unavailable');

      // Nothing persisted — the audit write happens BEFORE the save.
      expect(userRepo.save).not.toHaveBeenCalled();
      expect(users[0].roles).toEqual([PlatformRole.STAFF]);
    });

    it('TRANSACTIONAL: a status-change audit failure leaves the status unchanged and propagates', async () => {
      const { service, users, auditService, userRepo } = build();
      seed(users, { id: 'u1', status: UserStatus.ACTIVE });
      auditService.logEvent.mockRejectedValueOnce(
        new Error('audit table unavailable'),
      );

      await expect(
        service.updateUser(T, 'u1', { status: UserStatus.INACTIVE }, ADMIN),
      ).rejects.toThrow('audit table unavailable');

      expect(userRepo.save).not.toHaveBeenCalled();
      expect(users[0].status).toBe(UserStatus.ACTIVE);
    });

    it('TRANSACTIONAL: a role-change audit failure also blocks an unrelated firstName change in the same request', async () => {
      // The "all or nothing" consequence this method's own comment names: a
      // request touching a privilege field cannot partially succeed.
      const { service, users, auditService, userRepo } = build();
      seed(users, { id: 'u1', roles: [PlatformRole.STAFF], firstName: 'Original' });
      auditService.logEvent.mockRejectedValueOnce(
        new Error('audit table unavailable'),
      );

      await expect(
        service.updateUser(
          T,
          'u1',
          { role: PlatformRole.FIRM_ADMIN, firstName: 'Renamed' },
          ADMIN,
        ),
      ).rejects.toThrow('audit table unavailable');

      expect(userRepo.save).not.toHaveBeenCalled();
      expect(users[0].firstName).toBe('Original');
    });

    it('a status-change audit failure does not block a SEPARATE, later request from succeeding', async () => {
      // Proves the failure is per-call, not a stuck lock on the mock.
      const { service, users, auditEvents, auditService, userRepo } = build();
      seed(users, { id: 'u1', status: UserStatus.ACTIVE });
      auditService.logEvent.mockRejectedValueOnce(
        new Error('audit table unavailable'),
      );

      await expect(
        service.updateUser(T, 'u1', { status: UserStatus.INACTIVE }, ADMIN),
      ).rejects.toThrow('audit table unavailable');
      expect(userRepo.save).not.toHaveBeenCalled();

      await service.updateUser(T, 'u1', { status: UserStatus.INACTIVE }, ADMIN);

      expect(userRepo.save).toHaveBeenCalledTimes(1);
      expect(users[0].status).toBe(UserStatus.INACTIVE);
      expect(
        auditEvents.filter((e) => e.action === AuditAction.STATUS_CHANGED),
      ).toHaveLength(1);
    });
  });

  it('an audit-write failure never fails the primary action — best-effort, not blocking', async () => {
    const { service, users, auditService } = build();
    auditService.logEvent.mockRejectedValueOnce(new Error('audit table unavailable'));

    // inviteUser must still succeed even though its audit write throws.
    const result = await service.inviteUser(
      T,
      { email: 'resilient@acme.test' },
      { id: ADMIN.id, name: ADMIN.email },
      ADMIN.roles,
    );

    expect(result.inviteSent).toBe(true);
    expect(users.some((u) => u.email === 'resilient@acme.test')).toBe(true);
  });
});
