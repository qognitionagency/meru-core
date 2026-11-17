import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
// IsNull() is mandatory for "column IS NULL" in find options. A bare
// `revokedAt: null` is NOT an error and NOT a null comparison — TypeORM 0.3
// treats it like `undefined` and drops the condition from the WHERE clause
// entirely. Every revocation check in this file was written that way (and cast
// with `as any`, which hid the type error that would have caught it), so
// `revokedAt` was never actually tested: revoked sessions still refreshed and
// revoked API keys still authenticated. Verified against the generated SQL.
import { IsNull, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { User, AuthProvider, UserStatus } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { Role } from './entities/role.entity';
import { Session } from './entities/session.entity';
import { ApiKey } from './entities/api-key.entity';
import { AuthToken, AuthTokenType } from './entities/auth-token.entity';
import { UserPayload, DirectoryUser } from '../common/types';
import { TenantContext } from '../core/tenancy/tenant-context';
import {
  PlatformRole,
  ROLE_PRECEDENCE,
  canGrantRole,
} from './enums/platform-role.enum';
import type { Actor } from '../common/access';
import { MailService, inviteUrlFor } from '../core/mail/mail.service';
import { resolveMailBrand } from '../core/mail/mail-brand';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditSeverity } from '../audit/entities/audit-log.entity';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
// otplib is pinned to v12 deliberately. v13 pulls in @scure/base and
// @noble/hashes, which are ESM-only; Vercel's serverless loader cannot
// require() an ES module at all, so merely importing this file crashed the
// function on every request with ERR_REQUIRE_ESM. v12's tree (thirty-two +
// node:crypto) is plain CommonJS. See scripts/check-cjs-deps.js.
import { authenticator } from 'otplib';
import { databaseNowUtc } from './services/auth-attempt-limiter.service';
import * as QRCode from 'qrcode';

/**
 * Where a sign-in came from.
 *
 * Recorded on the session so a user can tell their three portals apart in the
 * session list — ImmiStack on a laptop and GovernanceX on a phone are two
 * legitimate concurrent sessions, and they have to be distinguishable before
 * "revoke that one" means anything.
 */
export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
  /** Which product opened it: `immistack`, `meru-dashboard`, `governancex`. */
  client?: string;
}

/** The operator behind an impersonation token — `UserPayload.impersonatedBy`. */
type ImpersonatedBy = NonNullable<UserPayload['impersonatedBy']>;

/** An entry for `IamService.audit` / `auditStrict`. */
type IamAuditEntry = Omit<
  Parameters<AuditService['logEvent']>[0],
  'severity'
> & {
  severity?: AuditSeverity;
  /** Set when the caller holds an impersonation token; lands in `context`. */
  impersonatedBy?: ImpersonatedBy;
};

/**
 * One change recorded by `IamService.auditedChange`: the fields its three
 * possible rows share, and what each row says. `event` lands in
 * `context.event` — `AuditAction` is a Postgres enum, and a value per phase
 * would need a migration for no query that `context.event` cannot serve.
 */
interface AuditedStep {
  /**
   * Tenant, actor, entity, severity — shared by every phase. Deliberately
   * cannot carry `beforeState`/`afterState`: `AuditService.logEvent` derives
   * `changes` from those two, and ImmiStack's audit page renders `changes`
   * as "Changed fields". On a request or not_applied row that showed a
   * change that had not happened. The field being changed goes in `target`.
   */
  base: Omit<
    IamAuditEntry,
    'action' | 'description' | 'beforeState' | 'afterState'
  >;
  /**
   * The field this step changes, if it is a field change (role, status).
   * The applied row states it as `beforeState`/`afterState`; the request
   * and not_applied rows state it as `context.requested` — a target, not a
   * change.
   */
  target?: { field: string; from: unknown; to: unknown };
  /** Written strictly BEFORE the change. Worded as a request, never a fact. */
  requested: { event: string; description: string };
  /** Written after the change succeeded. The only row that states a fact. */
  applied: { event: string; description: string; action?: AuditAction };
  /** Written if the change failed after its request row was written. */
  notApplied: { event: string; description: string };
}

/** Why a requested change did not take effect — `context.reason`. */
type NotAppliedReason = 'audit_unavailable' | 'no_row_updated' | 'write_failed';

/**
 * FR-1.2 — the practitioner credential is a PAIR: a number and the register it
 * is on. This is the one place that decides what a partial pair means.
 *
 * Both present → stored, trimmed. Both absent (or blank) → cleared to null.
 * One without the other → 400, because neither half means anything alone: a
 * bare "1234567" is unattributable, and a bare "marn" would render on a
 * practitioner register as though someone held a credential whose number
 * nobody recorded — unknown presented as settled (CLAUDE.md §5.2).
 *
 * The database CHECK constraint
 * (`CHK_users_practitioner_credential_paired`) enforces the same rule for any
 * writer that never reaches this function; this turns it into a 400 with a
 * usable message rather than a 500 on a constraint violation.
 */
function normalisePractitionerCredential(input: {
  practitionerCredential?: string | null;
  practitionerCredentialType?: string | null;
}): { number: string | null; type: string | null } {
  const number = input.practitionerCredential?.trim() || null;
  const type = input.practitionerCredentialType?.trim().toLowerCase() || null;

  if (number === null && type === null) return { number: null, type: null };
  if (number === null || type === null) {
    throw new BadRequestException(
      'A practitioner credential needs both a number ' +
        '(`practitionerCredential`) and the register it is on ' +
        '(`practitionerCredentialType`, e.g. `marn`). Send both, or send ' +
        'neither to clear it.',
    );
  }
  return { number, type };
}

@Injectable()
export class IamService {
  private readonly logger = new Logger(IamService.name);
  private readonly REFRESH_TOKEN_TTL_DAYS = 30;
  private readonly PASSWORD_RESET_TTL_MINUTES = 60;
  private readonly INVITE_TTL_DAYS = 7;
  private readonly API_KEY_PREFIX = 'meru_';

  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Tenant) private tenantRepo: Repository<Tenant>,
    @InjectRepository(Role) private roleRepo: Repository<Role>,
    @InjectRepository(Session) private sessionRepo: Repository<Session>,
    @InjectRepository(ApiKey) private apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(AuthToken)
    private authTokenRepo: Repository<AuthToken>,
    private jwtService: JwtService,
    private mailService: MailService,
    private auditService: AuditService,
  ) {}

  /**
   * Best-effort audit write for five of the seven IAM events that produced no
   * `audit_logs` row at all before this pass: invite issue, invite resend,
   * password-reset request, credential-token redemption, session revocation.
   *
   * Logged and swallowed, not rethrown: the primary action (the invite sent,
   * the password changed) has already succeeded by the time this runs, and
   * turning a working request into a 500 because the audit table had a
   * transient failure would be strictly worse than an under-audited one.
   * This is the same posture `TenantProvisioningService` already uses for its
   * own post-commit audit write (`tenant-provisioning.service.ts`).
   *
   * **Role change and status change are the other two, and they do NOT use
   * this helper for their pre-change row.** They are privilege and
   * account-standing changes, recorded through `auditedChange`: a strict
   * request row BEFORE the save, never swallowed — `TenancyService.runAsGod`'s
   * write-before-and-rethrow discipline (CLAUDE.md §5.4) — and this helper
   * only for the outcome row written after it.
   */
  private async audit(entry: IamAuditEntry): Promise<void> {
    try {
      await this.auditService.logEvent(this.toAuditEvent(entry));
    } catch (err: unknown) {
      // `changeId` is set on `auditedChange`'s outcome rows; naming it here
      // lets an operator find the request row this outcome was meant to close.
      const changeId = entry.context?.changeId;
      this.logger.error(
        `Failed to write audit entry (${String(entry.context?.event ?? entry.action)} on ${entry.entityType} ${entry.entityId}` +
          (changeId ? `, changeId ${String(changeId)}` : '') +
          '): ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Strict audit write: call BEFORE the state change; a failure refuses it.
   *
   * Answers **503** "Audit log unavailable — change refused" rather than
   * letting the driver error surface as an opaque 500 `MER-SRV-0001`: the
   * request was valid, the dependency was not there, and the client should
   * retry. The underlying error is logged, never returned.
   *
   * Only `auditedChange` calls this.
   */
  private async auditStrict(entry: IamAuditEntry): Promise<void> {
    try {
      await this.auditService.logEvent(this.toAuditEvent(entry));
    } catch (err: unknown) {
      this.logger.error(
        `Strict audit write failed (${String(entry.context?.event ?? entry.action)} ` +
          `on ${entry.entityType} ${entry.entityId}); change refused: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      throw new ServiceUnavailableException(
        'Audit log unavailable — change refused',
      );
    }
  }

  /**
   * Record a security-posture change as request → change → outcome.
   *
   * For changes where an unrecorded change is worse than a refused one: MFA
   * on, MFA off (removing the second factor is the first thing a stolen token
   * is used for), role and status (privilege and account standing).
   *
   * 1. Each step's `requested` row is written strictly, BEFORE the change.
   *    If any cannot be written: 503, nothing changes, and any request rows
   *    already written are answered with `not_applied` (best-effort).
   * 2. `change()` runs.
   * 3. Success → each step's `applied` row, best-effort. The change has
   *    happened; failing the request now would tell the caller it had not.
   *    The request row already exists, so it is not unrecorded.
   *    Any failure → each step's `notApplied` row, best-effort, then the
   *    ORIGINAL error is rethrown. A `NotFoundException` from `change()` is
   *    read as "matched no row"; anything else as "write failed".
   *
   * So no row ever states as fact a change that did not happen: a request
   * row with neither outcome after it means the process died mid-change, and
   * the user's current state is the answer.
   *
   * Only the applied row carries `beforeState`/`afterState` (from
   * `step.target`). The request and not_applied rows name the target in
   * `context.requested` instead, so `AuditService.logEvent` computes no
   * `changes` for them and no audit view can render one as a changed field.
   *
   * Every row of one call carries the same `context.changeId` (a fresh
   * UUID), so a request row can be matched to its outcome — or found to
   * have none. Two steps in one call share it; `context.event` tells them
   * apart.
   *
   * Not one SQL transaction: `AuditService.logEvent` uses its own injected
   * repository and accepts no caller `EntityManager`, and widening that for
   * every module that audits is a larger change than this one.
   */
  private async auditedChange<T>(
    steps: AuditedStep[],
    change: () => Promise<T>,
  ): Promise<T> {
    const changeId = crypto.randomUUID();
    const requested: AuditedStep[] = [];
    for (const step of steps) {
      try {
        await this.auditStrict({
          ...step.base,
          action: AuditAction.UPDATE,
          description: step.requested.description,
          context: {
            ...(step.base.context ?? {}),
            event: step.requested.event,
            changeId,
            ...(step.target ? { requested: step.target } : {}),
          },
        });
      } catch (err) {
        await this.recordNotApplied(requested, changeId, 'audit_unavailable');
        throw err;
      }
      requested.push(step);
    }

    let result: T;
    try {
      result = await change();
    } catch (err) {
      await this.recordNotApplied(
        steps,
        changeId,
        err instanceof NotFoundException ? 'no_row_updated' : 'write_failed',
      );
      throw err;
    }

    for (const step of steps) {
      await this.audit({
        ...step.base,
        action: step.applied.action ?? AuditAction.UPDATE,
        description: step.applied.description,
        ...(step.target
          ? {
              beforeState: { [step.target.field]: step.target.from },
              afterState: { [step.target.field]: step.target.to },
            }
          : {}),
        context: {
          ...(step.base.context ?? {}),
          event: step.applied.event,
          changeId,
        },
      });
    }
    return result;
  }

  /**
   * Best-effort `not_applied` rows for `auditedChange`. Never throws.
   * No `beforeState`/`afterState`: nothing changed, so nothing may read as
   * a changed field. The target goes in `context.requested`.
   */
  private async recordNotApplied(
    steps: AuditedStep[],
    changeId: string,
    reason: NotAppliedReason,
  ): Promise<void> {
    for (const step of steps) {
      await this.audit({
        ...step.base,
        action: AuditAction.UPDATE,
        severity: AuditSeverity.WARNING,
        description: step.notApplied.description,
        context: {
          ...(step.base.context ?? {}),
          event: step.notApplied.event,
          changeId,
          reason,
          ...(step.target ? { requested: step.target } : {}),
        },
      });
    }
  }

  /**
   * Shape an IAM entry for `AuditService.logEvent`. An impersonated caller's
   * operator goes into `context.impersonatedBy`: the row's `userId` is the
   * user being impersonated, so without this the log would say the customer
   * did what a platform operator did (CLAUDE.md §5.4). Only ever sourced from
   * `req.user.impersonatedBy`, which `JwtStrategy` sets from the signed `imp`
   * claim and never from request input.
   */
  private toAuditEvent({
    impersonatedBy,
    ...entry
  }: IamAuditEntry): Parameters<AuditService['logEvent']>[0] {
    return {
      severity: AuditSeverity.INFO,
      ...entry,
      ...(impersonatedBy
        ? { context: { ...(entry.context ?? {}), impersonatedBy } }
        : {}),
    };
  }

  // ─── Authentication ──────────────────────────────────────────────

  async validateUser(
    email: string,
    password: string,
  ): Promise<UserPayload | null> {
    // Bootstrap lookup: the tenant is what this query *discovers*, so there is
    // no tenant bound yet and RLS would filter the row away. See
    // TenantContext.runAsSystem — scoped to this one query on purpose.
    const user = await TenantContext.runAsSystem(
      'resolve user by email during login',
      () =>
        this.userRepo.findOne({
          where: { email },
          relations: ['tenant'],
          select: [
            'id',
            'email',
            'password',
            'tenantId',
            'status',
            'mfaEnabled',
            'roles',
          ],
        }),
    );

    if (
      !user ||
      user.status === UserStatus.LOCKED ||
      user.status === UserStatus.INACTIVE
    ) {
      return null;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return null;

    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
      mfaEnabled: user.mfaEnabled,
    };
  }

  async login(user: UserPayload, context: SessionContext = {}) {
    // If MFA is enabled but not yet verified, return temporary token
    if (user.mfaEnabled) {
      return {
        requiresMfa: true,
        userId: user.id,
        temporaryToken: this.jwtService.sign(
          { sub: user.id, mfaPending: true },
          { expiresIn: '5m' },
        ),
      };
    }

    // Login is a public route, so TenantBindingInterceptor has nothing to bind
    // from: the tenant only becomes known once validateUser() has run. Bind it
    // here so the session writes below execute against the right tenant instead
    // of an unbound (zero-row) connection.
    TenantContext.setTenantId(user.tenantId);

    // Concurrent sessions are allowed. This used to revoke every other active
    // session on each login, but the `revokedAt` predicate was silently dropped
    // (see the IsNull import note) so it never actually took effect. Now that
    // the predicate works, reinstating it would mean signing into ImmiStack
    // silently signs you out of the Meru Dashboard and GovernanceX — one user
    // legitimately uses several portals against this one API at the same time,
    // and on separate devices.
    //
    // Explicit revocation is still available and now genuinely works:
    // `logoutSession(refreshToken)` drops one session, `logout(userId)` drops
    // all of them, and refresh tokens are single-use (see refreshTokens).

    const tokens = await this.issueSession(user, context);

    // Enrich the response with the user profile + tenant so front-end portals
    // (Meru Dashboard / ImmiStack / GovernanceX) can hydrate their auth store
    // without a second round-trip.
    return {
      ...tokens,
      tenant_id: user.tenantId,
      user: await this.buildAuthUser(user),
    };
  }

  /**
   * Builds the client-facing user object returned by login. Maps the internal
   * User entity / UserPayload onto the shape the front-end auth stores expect
   * ({ id, tenant_id, email, role, permissions, profile }).
   */
  private async buildAuthUser(payload: UserPayload) {
    const user = await this.userRepo.findOne({
      where: { id: payload.id },
    });

    const roles = payload.roles ?? [];

    return {
      id: payload.id,
      tenant_id: payload.tenantId,
      email: payload.email,
      role: this.resolvePrimaryRole(roles),
      permissions: roles,
      profile: {
        first_name: user?.firstName ?? '',
        last_name: user?.lastName ?? '',
        avatar_url: user?.avatarUrl ?? undefined,
        title: undefined,
      },
    };
  }

  /**
   * Collapses the user's role list into the single primary role the portals
   * switch on. Prefers the most-privileged known platform role when present.
   */
  private resolvePrimaryRole(roles: string[]): string {
    for (const role of ROLE_PRECEDENCE) {
      if (roles.includes(role)) return role;
    }
    // A user holding only unknown roles gets the least-privileged default
    // rather than their first arbitrary role — the portals switch on this
    // value, and an unrecognised one routes nowhere.
    return PlatformRole.STAFF;
  }

  async refreshTokens(refreshToken: string, context: SessionContext = {}) {
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    // Bootstrap lookup: an opaque refresh token carries no tenant, so this
    // query is what establishes identity. Scoped to the lookup only — the
    // session/token writes below run tenant-bound.
    const session = await TenantContext.runAsSystem(
      'resolve session by refresh token',
      () =>
        this.sessionRepo.findOne({
          where: { refreshTokenHash, revokedAt: IsNull() },
          relations: ['user'],
        }),
    );

    if (!session || new Date() > session.expiresAt) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = session.user;

    // As in login(): the tenant is only known once the token has been resolved,
    // so bind it before the session rotation writes below.
    TenantContext.setTenantId(user.tenantId);

    // Retire the old session with a conditional UPDATE rather than a read-then-
    // save. `revokedAt IS NULL` in the WHERE makes the rotation atomic: if two
    // requests present the same refresh token concurrently, exactly one gets
    // affected=1 and the loser is rejected instead of both being issued a fresh
    // token pair. A refresh token is single-use, and this is what enforces it.
    const revoked = await this.sessionRepo.update(
      { id: session.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    if (!revoked.affected) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const payload: UserPayload = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
    };

    // The rotated session inherits the original's client/device identity when
    // the caller does not re-supply it, so a silent refresh does not turn one
    // device into an anonymous new entry in the user's session list.
    const tokens = await this.issueSession(payload, {
      ipAddress: context.ipAddress ?? session.ipAddress,
      userAgent: context.userAgent ?? session.userAgent,
      client: context.client ?? session.client ?? undefined,
    });

    // Mirror the login() payload so the front-end can re-hydrate its auth
    // store from a silent refresh without a second round-trip.
    return {
      ...tokens,
      tenant_id: payload.tenantId,
      user: await this.buildAuthUser(payload),
    };
  }

  /**
   * Revokes the single session identified by an opaque refresh token.
   * Idempotent — an unknown or already-revoked token is a no-op, so a client
   * clearing stale credentials never sees an error.
   */
  async logoutSession(refreshToken: string) {
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    // Same bootstrap case as refreshTokens(): logout is reachable with only an
    // opaque token, so the row has to be found before any tenant is known.
    await TenantContext.runAsSystem(
      'revoke session by refresh token',
      async () => {
        const session = await this.sessionRepo.findOne({
          where: { refreshTokenHash, revokedAt: IsNull() },
        });

        if (session) {
          session.revokedAt = new Date();
          await this.sessionRepo.save(session);
        }
      },
    );

    return { success: true };
  }

  async logout(userId: string) {
    // Revoke all active sessions
    const activeSessions = await this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
    });
    for (const s of activeSessions) {
      s.revokedAt = new Date();
    }
    if (activeSessions.length > 0) {
      await this.sessionRepo.save(activeSessions);
    }
    return { success: true };
  }

  // ─── MFA ──────────────────────────────────────────────────────────

  async setupMfa(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled');
    }

    const secret = authenticator.generateSecret();
    user.mfaSecret = secret;
    await this.userRepo.save(user);

    const otpauthUrl = authenticator.keyuri(
      user.email,
      'Meru Platform',
      secret,
    );
    const qrCode = await QRCode.toDataURL(otpauthUrl);

    return { secret, qrCode, otpauthUrl };
  }

  async verifyMfaSetup(userId: string, token: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'tenantId', 'email', 'mfaSecret', 'mfaEnabled'],
    });

    if (!user || !user.mfaSecret)
      throw new NotFoundException('MFA not initialized');

    // Already on: there is nothing to confirm, and checking a code here would
    // be an unthrottled oracle against the live secret — this route's wrong
    // code is a 400, which the MFA attempt limiter does not count (Owen's
    // gate, 2026-11-17). Same refusal `setupMfa` gives.
    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled');
    }

    const isValid = authenticator.check(token, user.mfaSecret);
    if (!isValid) throw new BadRequestException('Invalid verification code');

    // Request row strictly before the save; outcome row after (auditedChange).
    // Tenant scope of the audit rows: the user row's own `tenantId`, which RLS
    // (TenantBindingInterceptor) already confined the lookup above to.
    await this.auditedChange(
      [
        {
          base: {
            tenantId: user.tenantId,
            userId: user.id,
            userEmail: user.email,
            entityType: 'user',
            entityId: user.id,
          },
          requested: {
            event: 'mfa.enable.requested',
            description: `MFA enable requested for ${user.email}`,
          },
          applied: {
            event: 'mfa.enabled',
            description: `MFA enabled for ${user.email}`,
          },
          notApplied: {
            event: 'mfa.enable.not_applied',
            description: `MFA enable for ${user.email} did not take effect`,
          },
        },
      ],
      async () => {
        user.mfaEnabled = true;
        await this.userRepo.save(user);
      },
    );
    return { success: true };
  }

  /**
   * Second leg of an MFA login.
   *
   * Takes the `temporaryToken` issued by `login()`, **not** a bare user id. The
   * temporary token is what proves the password leg already succeeded; keying
   * this off an id supplied by the caller would let anyone skip the password
   * entirely and brute-force a six-digit code against any account they could
   * name. The token is single-purpose (`mfaPending`) and expires in 5 minutes.
   */
  async verifyMfaLogin(
    temporaryToken: string,
    token: string,
    context: SessionContext = {},
  ) {
    let challenge: { sub?: string; mfaPending?: boolean };
    try {
      challenge = this.jwtService.verify(temporaryToken);
    } catch {
      throw new UnauthorizedException('MFA challenge is invalid or expired');
    }

    // An ordinary access token must not be accepted here — it would turn this
    // route into a way to mint a full session from a half-scoped credential.
    if (!challenge?.mfaPending || !challenge.sub) {
      throw new UnauthorizedException('MFA challenge is invalid or expired');
    }

    // Bootstrap lookup, same as login(): the tenant is what this resolves, so
    // there is nothing bound yet and RLS would filter the row away.
    const user = await TenantContext.runAsSystem(
      'resolve user for MFA challenge',
      () =>
        this.userRepo.findOne({
          where: { id: challenge.sub },
          select: [
            'id',
            'email',
            'tenantId',
            'mfaSecret',
            'mfaEnabled',
            'roles',
          ],
        }),
    );

    if (!user || !user.mfaSecret || !user.mfaEnabled) {
      throw new BadRequestException('MFA not configured');
    }

    const isValid = authenticator.check(token, user.mfaSecret);
    if (!isValid) throw new UnauthorizedException('Invalid MFA token');

    const payload: UserPayload = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
    };

    // Bind before the session/stat writes below, as login() does.
    TenantContext.setTenantId(user.tenantId);

    const tokens = await this.issueSession(payload, context);

    await this.userRepo.increment({ id: user.id }, 'loginCount', 1);
    await this.userRepo.update(user.id, { lastLoginAt: new Date() });

    // Same envelope as login() so the portals hydrate their auth store
    // identically whichever leg completed the sign-in.
    return {
      ...tokens,
      tenant_id: payload.tenantId,
      user: await this.buildAuthUser(payload),
    };
  }

  /**
   * Turn MFA off — only with a valid current TOTP code.
   *
   * Without the code, any holder of an access token (stolen, or reachable
   * through XSS) could strip the second factor permanently and silently.
   * Tenant scope: the caller's own `tenantId` from the validated token, in the
   * WHERE clause as well as through RLS (bound by TenantBindingInterceptor).
   * Zero rows affected is a 404, never a `{success: true}` that did not happen.
   */
  async disableMfa(tenantId: string, userId: string, token: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
      select: ['id', 'tenantId', 'email', 'mfaSecret', 'mfaEnabled'],
    });
    if (!user) throw new NotFoundException('User not found');
    if (!user.mfaEnabled || !user.mfaSecret) {
      throw new BadRequestException('MFA is not enabled');
    }
    if (!authenticator.check(token, user.mfaSecret)) {
      throw new UnauthorizedException('Invalid MFA token');
    }

    // Request row strictly before the update — if it cannot be written the
    // second factor stays on — and the outcome row after (auditedChange).
    await this.auditedChange(
      [
        {
          base: {
            tenantId,
            userId: user.id,
            userEmail: user.email,
            entityType: 'user',
            entityId: user.id,
            severity: AuditSeverity.WARNING,
          },
          requested: {
            event: 'mfa.disable.requested',
            description: `MFA disable requested for ${user.email}`,
          },
          applied: {
            event: 'mfa.disabled',
            description: `MFA disabled for ${user.email}`,
          },
          notApplied: {
            event: 'mfa.disable.not_applied',
            description: `MFA disable for ${user.email} did not take effect`,
          },
        },
      ],
      async () => {
        // Tenant scope: `{ id, tenantId }` in the WHERE clause, and RLS.
        const res = await this.userRepo.update(
          { id: user.id, tenantId },
          { mfaEnabled: false, mfaSecret: null as any },
        );
        // Zero rows is a 404, never a `{success: true}` that did not happen.
        if (res.affected !== 1) throw new NotFoundException('User not found');
      },
    );
    return { success: true };
  }

  // ─── RBAC / Role Management ──────────────────────────────────────

  async getRoles(tenantId: string) {
    return this.roleRepo.find({ where: { tenantId } });
  }

  async createRole(
    tenantId: string,
    name: string,
    permissions: string[],
    description?: string,
  ) {
    const existing = await this.roleRepo.findOne({ where: { tenantId, name } });
    if (existing) throw new ConflictException('Role already exists');

    return this.roleRepo.save(
      this.roleRepo.create({
        tenantId,
        name,
        permissions,
        description,
        isSystem: false,
      }),
    );
  }

  async updateRolePermissions(roleId: string, permissions: string[]) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    role.permissions = permissions;
    return this.roleRepo.save(role);
  }

  async deleteRole(roleId: string) {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem)
      throw new BadRequestException('Cannot delete system roles');
    return this.roleRepo.remove(role);
  }

  // ─── API Key Management ──────────────────────────────────────────

  // ── API keys — DEAD CODE, see api-key.entity.ts ──────────────────────────
  // No route calls createApiKey/listApiKeys/revokeApiKey and no strategy or
  // guard calls validateApiKey. Left in place until the api_keys table is
  // dropped by migration; do not expose these without building the guard.
  async createApiKey(
    userId: string,
    tenantId: string,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ) {
    const rawKey = this.API_KEY_PREFIX + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const prefix = rawKey.slice(0, 12);

    const apiKey = this.apiKeyRepo.create({
      tenantId,
      name,
      keyHash,
      prefix,
      scopes,
      expiresAt,
      createdBy: userId,
    });

    const saved = await this.apiKeyRepo.save(apiKey);

    return {
      id: saved.id,
      name: saved.name,
      key: `meru_${saved.id.slice(0, 8)}_${rawKey}`,
      scopes: saved.scopes,
      expiresAt: saved.expiresAt,
    };
  }

  async listApiKeys(tenantId: string) {
    return this.apiKeyRepo.find({
      where: { tenantId, revokedAt: IsNull() },
      select: [
        'id',
        'name',
        'scopes',
        'lastUsedAt',
        'createdAt',
        'expiresAt',
        'prefix',
      ],
    });
  }

  async revokeApiKey(keyId: string) {
    await this.apiKeyRepo.update(keyId, { revokedAt: new Date() });
    return { success: true };
  }

  async validateApiKey(rawKey: string): Promise<UserPayload | null> {
    // Extract the hash-able portion
    const parts = rawKey.split('_');
    if (parts.length < 3) return null;

    const keyMaterial = parts.slice(2).join('_');
    const keyHash = crypto
      .createHash('sha256')
      .update(keyMaterial)
      .digest('hex');

    // Bootstrap lookup: an API key is presented before any tenant is known —
    // validating it is what determines the tenant.
    const apiKey = await TenantContext.runAsSystem(
      'validate API key hash',
      () =>
        this.apiKeyRepo.findOne({
          where: { keyHash, revokedAt: IsNull() },
          relations: ['creator'],
        }),
    );

    if (!apiKey) return null;
    if (apiKey.expiresAt && new Date() > apiKey.expiresAt) return null;

    // Still pre-authentication, so this write also needs the system context.
    await TenantContext.runAsSystem('stamp API key last-used', () =>
      this.apiKeyRepo.update(apiKey.id, { lastUsedAt: new Date() }),
    );

    const user = apiKey.creator;
    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles ?? [],
      apiKeyId: apiKey.id,
    };
  }

  // ─── User Profile & Password ─────────────────────────────────────

  async getProfile(userId: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      relations: ['tenant'],
    });
    if (!user) throw new NotFoundException('User not found');

    const { password, mfaSecret, ...profile } = user;
    return profile;
  }

  async updateProfile(
    userId: string,
    updates: Partial<
      Pick<
        User,
        | 'firstName'
        | 'lastName'
        | 'avatarUrl'
        | 'phone'
        | 'timezone'
        | 'preferences'
      >
    >,
  ) {
    await this.userRepo.update(userId, updates);
    return this.getProfile(userId);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'password'],
    });

    if (!user) throw new NotFoundException('User not found');
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new BadRequestException('Current password is incorrect');

    user.password = await bcrypt.hash(newPassword, 10);
    await this.userRepo.save(user);

    // Revoke all existing sessions for security
    const activeSessions = await this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
    });
    for (const s of activeSessions) {
      s.revokedAt = new Date();
    }
    if (activeSessions.length > 0) {
      await this.sessionRepo.save(activeSessions);
    }

    return { success: true };
  }

  // ─── Tenant User Management ──────────────────────────────────────

  /**
   * The tenant's user directory.
   *
   * Returns a stable shape rather than raw entities: the portals render a
   * single primary role, and `roles` is a simple-array column that would
   * otherwise leak as a comma-joined string.
   */
  async listUsers(tenantId: string): Promise<DirectoryUser[]> {
    const users = await this.userRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });

    return users.map((u) => this.toDirectoryUser(u));
  }

  /**
   * The names behind the ids, for staff.
   *
   * `listUsers` is `firm_admin`+, which is right — it carries email addresses,
   * MFA state, invite status and last-login times. But it meant the `staff` role
   * could not resolve the author of a comment or choose an assignee, so the staff
   * client page rendered file notes with no author at all.
   *
   * A deliberately narrow projection rather than `?fields=` on the full route: a
   * field selector is one careless addition away from leaking the thing it was
   * introduced to avoid, and there is no request here that wants "some of the
   * sensitive fields". Id, display name and primary role are what a mention
   * chip and an assignee picker need, and nothing else is returned.
   */
  async listDirectoryNames(
    tenantId: string,
  ): Promise<Array<{ id: string; name: string; role: string | null }>> {
    const users = await this.userRepo.find({
      where: { tenantId },
      select: ['id', 'firstName', 'lastName', 'roles'],
      order: { createdAt: 'DESC' },
    });

    return users.map((u) => ({
      id: u.id,
      // Falls back to something rather than an empty chip: a comment attributed
      // to "" reads as a rendering fault.
      name:
        [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
        'Unnamed user',
      role: (u.roles ?? [])[0] ?? null,
    }));
  }

  async getUser(tenantId: string, userId: string): Promise<DirectoryUser> {
    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.toDirectoryUser(user);
  }

  /**
   * Invite a user into the tenant.
   *
   * The generated password is a placeholder so the row satisfies the NOT NULL
   * password column — it is never returned. This previously handed the
   * plaintext temp password back to any caller, which meant anyone who could
   * invite could also immediately authenticate as the invitee. The invitee
   * gets in via a password reset, or via SSO once that is wired.
   *
   * Note on uniqueness: `users.email` is globally unique by design, not per
   * tenant, because `validateUser()` resolves a login by email alone with no
   * tenant hint. Scoping this check per tenant would make logins ambiguous, so
   * the global check stays — only the error message is clearer.
   *
   * `actorRoles` is required, not optional, on purpose: `POST
   * /iam/users/invite` is reachable by `firm_admin`, and `InviteUserDto.role`
   * validates only `@IsEnum(PlatformRole)` — which accepts `platform_admin`.
   * Without a ceiling check here, any `firm_admin` could invite themselves a
   * `platform_admin` colleague and hand them God View. Checked before the
   * uniqueness lookup so a caller cannot even discover whether a
   * `platform_admin` email is taken.
   */
  async inviteUser(
    tenantId: string,
    dto: {
      email: string;
      role?: string;
      firstName?: string;
      lastName?: string;
      department?: string;
      practitionerCredential?: string;
      practitionerCredentialType?: string;
    },
    invitedBy:
      | { id: string; name: string; impersonatedBy?: ImpersonatedBy }
      | undefined,
    actorRoles: string[],
  ): Promise<
    DirectoryUser & { inviteSent: boolean; inviteUrl: string }
  > {
    const requestedRole = dto.role ?? PlatformRole.STAFF;
    // FR-1.2 — both halves or neither, refused here as a 400 rather than left
    // to the database CHECK constraint to turn into a 500. A number with no
    // register is unattributable; a register with no number is a half-filled
    // form that would read on a practitioner list as if someone were
    // credentialed.
    const credential = normalisePractitionerCredential(dto);
    if (!canGrantRole(actorRoles, requestedRole)) {
      throw new ForbiddenException(
        `Cannot invite a user as '${requestedRole}': outranks the caller`,
      );
    }

    const existing = await TenantContext.runAsSystem(
      'check global email uniqueness before invite',
      () => this.userRepo.findOne({ where: { email: dto.email } }),
    );

    if (existing) {
      throw new ConflictException(
        existing.tenantId === tenantId
          ? 'A user with that email already exists in this tenant'
          : 'That email is already registered on the platform',
      );
    }

    // Unusable by construction: never returned, never sent anywhere. It exists
    // only because `password` is NOT NULL.
    const placeholderPassword = await bcrypt.hash(
      crypto.randomBytes(32).toString('hex'),
      10,
    );

    const user = this.userRepo.create({
      email: dto.email,
      password: placeholderPassword,
      tenantId,
      firstName: dto.firstName,
      lastName: dto.lastName,
      status: UserStatus.INVITED,
      provider: AuthProvider.LOCAL,
      roles: [requestedRole],
      attributes: dto.department ? { department: dto.department } : {},
      practitionerCredential: credential.number,
      practitionerCredentialType: credential.type,
    });

    await this.userRepo.save(user);

    // Issue the acceptance link. Without this the invite is a dead end: the
    // placeholder password above is unusable by construction and is never
    // returned, so an invited user previously had no route in at all.
    const { token, expiresAt } = await this.issueAuthToken(
      user,
      AuthTokenType.INVITE,
      this.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      invitedBy?.id,
    );

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });

    const { delivered } = await this.mailService.sendInvite({
      to: user.email,
      inviterName: invitedBy?.name ?? 'A colleague',
      tenantName: tenant?.name ?? 'your workspace',
      // The invitee's own tenant — the row loaded by `tenantId` immediately
      // above, which came from the caller's JWT, never from the request body.
      // The firm is who this invitation is from; Meru is not a name the
      // recipient has ever seen.
      brand: resolveMailBrand(tenant),
      token,
      expiresAt,
    });

    // Reported rather than assumed. The user exists either way, but an admin
    // needs to know whether to expect the invitee to receive anything — when
    // mail is unconfigured the link is only in the server log.
    this.logger.log(
      `Invited ${dto.email} to tenant ${tenantId} (email delivered: ${delivered})`,
    );

    // Never the token: the token itself is stored SHA-256-only (see
    // `issueAuthToken`) and must not exist anywhere else, logs included.
    await this.audit({
      tenantId,
      userId: invitedBy?.id ?? user.id,
      // `invitedBy.name` carries the caller's EMAIL, not a display name — see
      // `UsersController.invite`'s call site (`{ id: req.user.id, name:
      // req.user.email }`), kept because `MailService.sendInvite` wants an
      // "inviterName" for the mail body and that is what the controller had.
      userEmail: invitedBy?.name,
      action: AuditAction.INVITE_ISSUED,
      entityType: 'user',
      entityId: user.id,
      description: `Invited ${user.email} as '${requestedRole}'`,
      afterState: { email: user.email, role: requestedRole, status: user.status },
      context: { inviteSent: delivered },
      impersonatedBy: invitedBy?.impersonatedBy,
    });

    // `inviteUrl` travels with the result for the same reason `resendInvite`
    // returns it: when mail fails there is otherwise NO way to complete
    // onboarding — the token is stored SHA-256-only, so it cannot be recovered
    // from the database, and `resendInvite` is scoped to the caller's own
    // tenant, which the operator provisioning a NEW tenant is not a member of.
    // Observed on production 2026-09-10: a tenant was created that nobody
    // could ever sign into.
    return {
      ...this.toDirectoryUser(user),
      inviteSent: delivered,
      inviteUrl: inviteUrlFor(this.mailService.appUrl, token),
    };
  }

  /**
   * Re-send an invitation, issuing a fresh link.
   *
   * Needed because delivery genuinely fails — SES misconfigured, a typo'd
   * address, a mailbox that bounced. Without this the only recovery was to
   * delete the user and invite them again, and `users.email` is globally
   * unique so that is not even reliably possible. Issuing a new token
   * invalidates the previous one, so a resend also revokes a link sent to the
   * wrong place.
   */
  /**
   * Re-issue a pending invitation, and hand the link back to the operator.
   *
   * `inviteUrl` is returned deliberately, over TLS, to a caller who is already
   * authorised to trigger this — it grants no privilege they did not have one
   * line earlier. Withholding it only meant the operator also needed access to
   * the invitee's mailbox, which is exactly the case that fails.
   *
   * That case is not hypothetical: on 2026-09-10 a tenant was provisioned on
   * production with `inviteSent: false`, and there was no way to complete
   * onboarding at all — the token exists only as a SHA-256 hash in
   * `auth_tokens`, so it could not be recovered from the database either. Mail
   * had failed, and the product could not onboard anybody, with no fallback.
   * ADR 0006 proposed exactly this and it had only ever been built for tenant
   * *signup* invites, not for user invites.
   *
   * Same posture as `mintSignupInvite`. It is not a way to reach an active
   * account: the guard below refuses anyone who is not still `INVITED`.
   *
   * `invitedBy.name` is what the recipient sees in the mail body
   * (`inviterName`) and, by the same-tenant convention this codebase already
   * follows (see `inviteUser` above), doubles as the audit row's `userEmail`
   * when nothing else is given — because on that route the caller's display
   * name IS their email (`UsersController` passes `req.user.email` as `name`).
   * `auditEmail` is additive, for the one caller where those two now diverge:
   * the God View admin-invite-resend route names the mail sender "Meru
   * Platform" (the recipient has never heard of the individual operator) but
   * must still audit the REAL operator, so it passes `req.user.email` here
   * separately. Optional and defaults to `name`, so the same-tenant route's
   * behaviour is unchanged byte-for-byte.
   */
  async resendInvite(
    tenantId: string,
    userId: string,
    invitedBy?: {
      id: string;
      name: string;
      auditEmail?: string;
      impersonatedBy?: ImpersonatedBy;
    },
  ): Promise<{
    email: string;
    inviteSent: boolean;
    expiresAt: Date;
    inviteUrl: string;
  }> {
    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');

    // Only pending invitations. Re-inviting an active user would be a way to
    // force a password-set link onto somebody who already has credentials.
    if (user.status !== UserStatus.INVITED) {
      throw new BadRequestException(
        'That user has already accepted their invitation. Use password reset instead.',
      );
    }

    const { token, expiresAt } = await this.issueAuthToken(
      user,
      AuthTokenType.INVITE,
      this.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      invitedBy?.id,
    );

    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });

    const { delivered } = await this.mailService.sendInvite({
      to: user.email,
      inviterName: invitedBy?.name ?? 'A colleague',
      tenantName: tenant?.name ?? 'your workspace',
      // The invitee's own tenant — the row loaded by `tenantId` immediately
      // above, which came from the caller's JWT, never from the request body.
      // The firm is who this invitation is from; Meru is not a name the
      // recipient has ever seen.
      brand: resolveMailBrand(tenant),
      token,
      expiresAt,
    });

    this.logger.log(`Re-invited ${user.email} (email delivered: ${delivered})`);

    // Issuing a fresh token also revokes the previous one (see this method's
    // own doc comment) — worth a row in its own right if a resend is ever
    // used to recover from a link sent to the wrong address.
    await this.audit({
      tenantId,
      userId: invitedBy?.id ?? user.id,
      // The real operator, not the mail's display name — see this method's
      // doc comment. `auditEmail` falls back to `name` so a caller that only
      // ever passed `{id, name}` (the same-tenant route) audits exactly as
      // it always has.
      userEmail: invitedBy?.auditEmail ?? invitedBy?.name,
      action: AuditAction.INVITE_RESENT,
      entityType: 'user',
      entityId: user.id,
      description: `Re-invited ${user.email}`,
      context: { inviteSent: delivered },
      impersonatedBy: invitedBy?.impersonatedBy,
    });

    return {
      email: user.email,
      inviteSent: delivered,
      expiresAt,
      inviteUrl: inviteUrlFor(this.mailService.appUrl, token),
    };
  }

  /**
   * Update a directory user. Deliberately narrow — this cannot touch password,
   * email, tenantId or MFA state, so it can never be used for takeover.
   *
   * Two callers reach this, with different rights:
   *
   * - `platform_admin` / `firm_admin` managing someone else's row (or their
   *   own) — full directory management, including `role` and `status`.
   * - anyone else, but ONLY on their own `userId`. `PATCH /iam/users/:id` has
   *   no `@Roles` guard at all, on purpose — every portal's `ProfileView`
   *   calls this route against the caller's own id, and a plain `staff` or
   *   `client` user previously got a flat 403 editing their own name. That
   *   authorisation decision ("is this my own row") belongs here, not on the
   *   controller, the same as `own` scope elsewhere in this codebase. A
   *   non-admin self-caller may change `firstName` / `lastName` /
   *   `department` only: `role` and `status` are refused even on their own
   *   row, because those are privilege and account-standing fields, not
   *   profile fields.
   *
   * `role` is additionally ceiling-checked for EVERY caller via
   * `canGrantRole`, admin or not, self or not — this is what stops a
   * `firm_admin` from PATCHing their own id to `platform_admin`. The old
   * `@Roles(PLATFORM_ADMIN, FIRM_ADMIN)` guard admitted `firm_admin`, and
   * nothing before this checked the requested role against the caller's own.
   *
   * `status` is ceiling-checked the same way, against the target user's
   * *existing* role rather than any requested one — status has no "requested
   * rank" the way `role` does. Without this, only `role` went through
   * `canGrantRole` and a `firm_admin` could suspend or deactivate a
   * `platform_admin` colleague's account in their own tenant: account
   * standing tampered with across the exact privilege boundary the role
   * check already closed.
   */
  async updateUser(
    tenantId: string,
    userId: string,
    updates: {
      firstName?: string;
      lastName?: string;
      role?: string;
      department?: string;
      status?: UserStatus;
      practitionerCredential?: string;
      practitionerCredentialType?: string;
    },
    actor: Actor & { impersonatedBy?: ImpersonatedBy },
  ): Promise<DirectoryUser> {
    const isSelf = actor.id === userId;
    const isAdmin = actor.roles.some(
      (r) =>
        r === PlatformRole.PLATFORM_ADMIN || r === PlatformRole.FIRM_ADMIN,
    );

    if (!isAdmin && !isSelf) {
      // Stands in for the removed `@Roles(PLATFORM_ADMIN, FIRM_ADMIN)` guard
      // for every case except "editing my own row" — a plain staff or client
      // caller still cannot reach anyone else's user record through here.
      throw new ForbiddenException('You can only update your own profile');
    }

    if (
      !isAdmin &&
      (updates.role !== undefined || updates.status !== undefined)
    ) {
      throw new ForbiddenException('You cannot change your own role or status');
    }

    // FR-1.2. Same ceiling as `role`/`status`, and for the same reason: a
    // credential is what a sign-off gate will check, so a user who could edit
    // their own could self-authorise advice or lodgement. Only an admin may
    // write a firm's practitioner register.
    const credentialRequested =
      updates.practitionerCredential !== undefined ||
      updates.practitionerCredentialType !== undefined;
    if (!isAdmin && credentialRequested) {
      throw new ForbiddenException(
        'You cannot change your own practitioner credential',
      );
    }

    const user = await this.userRepo.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) throw new NotFoundException('User not found');

    if (
      updates.role !== undefined &&
      !canGrantRole(actor.roles, updates.role)
    ) {
      throw new ForbiddenException(
        `Cannot grant role '${updates.role}': outranks the caller`,
      );
    }

    if (
      updates.status !== undefined &&
      !canGrantRole(actor.roles, this.resolvePrimaryRole(user.roles ?? []))
    ) {
      // Same ceiling, keyed on the role the target already holds — a caller
      // may not change the standing of a user who outranks them, even though
      // nobody is asking to change that user's role here.
      throw new ForbiddenException(
        `Cannot change status of a user outranking the caller`,
      );
    }

    // Captured before mutation — role/status are privilege and account-standing
    // fields (this method's own doc comment), and a compliance review needs
    // to see exactly what changed, not just that `updateUser` ran.
    const previousRole = this.resolvePrimaryRole(user.roles ?? []);
    const previousStatus = user.status;

    if (updates.firstName !== undefined) user.firstName = updates.firstName;
    if (updates.lastName !== undefined) user.lastName = updates.lastName;
    if (updates.status !== undefined) user.status = updates.status;
    if (updates.role !== undefined) user.roles = [updates.role];
    if (updates.department !== undefined) {
      user.attributes = { ...user.attributes, department: updates.department };
    }
    if (credentialRequested) {
      // Written as a pair, always. Clearing one clears both — a firm removing
      // someone from its register removes the whole credential, never leaving
      // an orphaned registry name that reads as "credentialed, number
      // missing".
      const credential = normalisePractitionerCredential({
        practitionerCredential:
          updates.practitionerCredential ?? user.practitionerCredential ?? '',
        practitionerCredentialType:
          updates.practitionerCredentialType ??
          user.practitionerCredentialType ??
          '',
      });
      user.practitionerCredential = credential.number;
      user.practitionerCredentialType = credential.type;
    }

    // ROLE_CHANGED / STATUS_CHANGED are NOT best-effort, unlike the other
    // five IAM audit events (`this.audit`, above). They are privilege and
    // account-standing changes — this method's own doc comment — and a
    // `firm_admin` silently promoting a colleague to `platform_admin` with no
    // recoverable trace is worse than refusing the promotion outright.
    //
    // So each is recorded through `auditedChange`: a strict request row
    // (`role.change.requested` / `status.change.requested`, on UPDATE)
    // BEFORE `userRepo.save`, never swallowed — if it cannot be written the
    // change does not happen (503). This is `TenancyService.runAsGod`'s own
    // discipline (audit first, rethrow on failure). ROLE_CHANGED /
    // STATUS_CHANGED themselves are written only AFTER the save succeeds, so a
    // compliance query on those actions returns changes that happened; a
    // failed save leaves `*.not_applied` instead. `auditedChange`'s own
    // comment says why this is not one SQL transaction.
    //
    // A consequence worth stating plainly: if this request ALSO changed
    // `firstName`/`department`/the practitioner credential in the same call,
    // those are mutated on `user` in memory above but not yet saved either,
    // so a failed role/status audit refuses the whole update, not just the
    // privilege change. That is the correct "all or nothing" shape for a
    // request that touches a privilege field — there is no partial-success
    // response that would be honest here.
    //
    // Tenant scope of every row: `tenantId` from the caller's validated token,
    // the same tenant `findOne({ id, tenantId })` above loaded the user from.
    const steps: AuditedStep[] = [];
    const actorFields = {
      tenantId,
      userId: actor.id,
      userEmail: actor.email,
      impersonatedBy: actor.impersonatedBy,
      entityType: 'user',
      entityId: user.id,
      severity: AuditSeverity.INFO,
    };
    if (updates.role !== undefined && updates.role !== previousRole) {
      const change = `${previousRole} → ${updates.role}`;
      steps.push({
        base: actorFields,
        target: { field: 'role', from: previousRole, to: updates.role },
        requested: {
          event: 'role.change.requested',
          description: `Role change requested for ${user.email}: ${change}`,
        },
        applied: {
          event: 'role.changed',
          action: AuditAction.ROLE_CHANGED,
          description: `Role changed for ${user.email}: ${change}`,
        },
        notApplied: {
          event: 'role.change.not_applied',
          description: `Role change for ${user.email} did not take effect: ${change}`,
        },
      });
    }

    if (updates.status !== undefined && updates.status !== previousStatus) {
      const change = `${previousStatus} → ${updates.status}`;
      steps.push({
        base: actorFields,
        target: { field: 'status', from: previousStatus, to: updates.status },
        requested: {
          event: 'status.change.requested',
          description: `Status change requested for ${user.email}: ${change}`,
        },
        applied: {
          event: 'status.changed',
          action: AuditAction.STATUS_CHANGED,
          description: `Status changed for ${user.email}: ${change}`,
        },
        notApplied: {
          event: 'status.change.not_applied',
          description: `Status change for ${user.email} did not take effect: ${change}`,
        },
      });
    }

    await this.auditedChange(steps, () => this.userRepo.save(user));

    return this.toDirectoryUser(user);
  }

  private toDirectoryUser(user: User): DirectoryUser {
    const roles = user.roles ?? [];
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      name,
      role: this.resolvePrimaryRole(roles),
      roles,
      department: (user.attributes?.department as string) ?? null,
      // FR-1.2. Returned as the pair it is stored as, plus an explicit
      // `practitionerCredentialVerified: false` — the value is self-asserted
      // and no register has been consulted (CLAUDE.md §13: every regulator
      // adapter is sandbox). Sending the flag rather than omitting it is the
      // point: a UI that has to read `false` cannot accidentally render a tick,
      // whereas an absent field invites one (§5.2).
      practitionerCredential: user.practitionerCredential ?? null,
      practitionerCredentialType: user.practitionerCredentialType ?? null,
      practitionerCredentialVerified: false,
      status: user.status,
      lastActiveAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
      avatarUrl: user.avatarUrl ?? null,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  // `generateTokens` was folded into `issueSession`. Signing the access token
  // separately from creating the session meant the token could not carry the
  // session's id, so nothing could map a live token back to the row that
  // authorises it — which is what "revoke this one device" requires.

  private async createSession(
    user: UserPayload,
    refreshToken: string,
    context: SessionContext = {},
  ) {
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshToken)
      .digest('hex');

    const session = this.sessionRepo.create({
      userId: user.id,
      tenantId: user.tenantId,
      // Both columns hold the same digest. `tokenHash` carries the UNIQUE
      // constraint, which is what makes a refresh token unrepeatable;
      // `refreshTokenHash` is what lookups filter on.
      tokenHash: refreshTokenHash,
      refreshTokenHash,
      // Recorded rather than blank. These were hardcoded to '', so the columns
      // existed but never held anything — there was no way to tell a user which
      // devices held a live session, let alone let them revoke one.
      ipAddress: context.ipAddress ?? '',
      userAgent: context.userAgent ?? '',
      client: context.client ?? null,
      expiresAt: new Date(
        Date.now() + this.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
    });

    return this.sessionRepo.save(session);
  }

  // ─── Credential Recovery ─────────────────────────────────────────
  //
  // Password reset and invite acceptance share one mechanism: a single-use,
  // time-limited token whose SHA-256 is all that is stored. The two differ only
  // in lifetime and in the email that carries them.

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Mint a credential token and persist only its digest.
   *
   * Any unused token of the same type for that user is burned first, so a
   * second "forgot password" click invalidates the first link rather than
   * leaving two live ways into the account.
   */
  private async issueAuthToken(
    user: User,
    type: AuthTokenType,
    ttlMs: number,
    issuedBy?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlMs);

    await this.authTokenRepo.update(
      { userId: user.id, type, usedAt: IsNull() },
      { usedAt: new Date() },
    );

    await this.authTokenRepo.save(
      this.authTokenRepo.create({
        tenantId: user.tenantId,
        userId: user.id,
        type,
        tokenHash: this.hashToken(token),
        expiresAt,
        issuedBy: issuedBy ?? null,
      }),
    );

    return { token, expiresAt };
  }

  /**
   * The user an MFA challenge token belongs to, or null.
   *
   * For the per-account MFA attempt limit (Anton, 2026-11-17, #6;
   * `MfaAttemptLimitInterceptor`). Here because this file is the one
   * sanctioned verifier of a challenge token (`one-jwt-verifier.spec.ts`), and
   * with the same rule as `verifyMfaLogin`: only a token carrying
   * `mfaPending` names anyone. Never throws; an invalid token is null.
   */
  mfaChallengeSubject(temporaryToken: string): string | null {
    if (!temporaryToken) return null;
    let challenge: { sub?: string; mfaPending?: boolean };
    try {
      challenge = this.jwtService.verify(temporaryToken);
    } catch {
      return null;
    }
    return challenge?.mfaPending && challenge.sub ? challenge.sub : null;
  }

  /**
   * Begin a password reset.
   *
   * Always resolves the same way regardless of whether the address exists.
   * Reporting "no such user" would turn this endpoint into a free membership
   * oracle for anyone with a list of email addresses, and the response is
   * public. The work is identical either way; only the email differs.
   */
  async requestPasswordReset(email: string): Promise<{ ok: true }> {
    // Bootstrap lookup: an unauthenticated caller supplies only an email, so
    // the tenant is what this discovers.
    const user = await TenantContext.runAsSystem(
      'resolve user by email for password reset',
      () => this.userRepo.findOne({ where: { email } }),
    );

    if (!user) {
      this.logger.log(`Password reset requested for unknown address ${email}`);
      return { ok: true };
    }

    if (user.status === UserStatus.LOCKED) {
      // A locked account must not be recoverable by self-service; that is the
      // point of locking it. Audited at WARNING — an attempt against a locked
      // account is exactly the kind of event a security review wants to find.
      this.logger.warn(`Password reset refused for locked account ${email}`);
      await TenantContext.runAsSystem(
        'audit refused password-reset request on locked account',
        () =>
          this.audit({
            tenantId: user.tenantId,
            userId: user.id,
            userEmail: user.email,
            action: AuditAction.PASSWORD_RESET_REQUESTED,
            entityType: 'user',
            entityId: user.id,
            description: `Password reset requested for ${user.email} — refused, account locked`,
            severity: AuditSeverity.WARNING,
            context: { refused: true, reason: 'account_locked' },
          }),
      );
      return { ok: true };
    }

    const { token, expiresAt } = await TenantContext.runAsSystem(
      'issue password reset token',
      () =>
        this.issueAuthToken(
          user,
          AuthTokenType.PASSWORD_RESET,
          this.PASSWORD_RESET_TTL_MINUTES * 60 * 1000,
        ),
    );

    // The brand belongs to the account holder's own tenant, and this route is
    // public: there is no ambient tenant on the connection, so the lookup runs
    // in the same system context as the user lookup above and is filtered to
    // `user.tenantId` — the tenant of the row that matched the address, never
    // anything the caller supplied. A user with no tenant resolves unbranded
    // rather than to a house name.
    const tenant = user.tenantId
      ? await TenantContext.runAsSystem(
          'resolve tenant brand for password reset',
          () => this.tenantRepo.findOne({ where: { id: user.tenantId } }),
        )
      : null;

    await this.mailService.sendPasswordReset({
      to: user.email,
      firstName: user.firstName,
      brand: resolveMailBrand(tenant),
      token,
      expiresAt,
    });

    // Never the token — stored SHA-256-only, same discipline as the invite
    // flow. This route is public and unauthenticated, so the "actor" and the
    // audited subject are the same person: whoever holds this email address.
    await TenantContext.runAsSystem('audit password-reset request', () =>
      this.audit({
        tenantId: user.tenantId,
        userId: user.id,
        userEmail: user.email,
        action: AuditAction.PASSWORD_RESET_REQUESTED,
        entityType: 'user',
        entityId: user.id,
        description: `Password reset requested for ${user.email}`,
      }),
    );

    return { ok: true };
  }

  /**
   * Redeem a reset or invite token and set a password.
   *
   * One handler for both types because the security-relevant steps are
   * identical. Every session the user holds is revoked afterwards: a password
   * change is the standard response to a suspected compromise, and leaving the
   * attacker's existing refresh token alive would defeat it.
   */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ ok: true; email: string }> {
    const tokenHash = this.hashToken(token);

    // Whoever presents a reset link has no session, so nothing is bound and
    // RLS would filter the row away.
    return TenantContext.runAsSystem('redeem credential token', async () => {
      const record = await this.authTokenRepo.findOne({
        where: { tokenHash },
      });

      // Deliberately one message for missing, used and expired. Distinguishing
      // them tells an attacker probing tokens which guesses were once real.
      const invalid = new BadRequestException(
        'This link is invalid or has expired. Request a new one.',
      );

      if (!record || record.usedAt || record.expiresAt < new Date()) {
        throw invalid;
      }

      const user = await this.userRepo.findOne({
        where: { id: record.userId },
      });
      if (!user) throw invalid;

      // Burn the token first. If the password write fails afterwards the link
      // is still spent, which is the safe direction to fail in.
      const burned = await this.authTokenRepo.update(
        { id: record.id, usedAt: IsNull() },
        { usedAt: new Date() },
      );

      // Lost the race with a concurrent redemption of the same link.
      if (!burned.affected) throw invalid;

      user.password = await bcrypt.hash(newPassword, 10);

      // An invited user becomes active by accepting; a reset leaves status be.
      if (user.status === UserStatus.INVITED) {
        user.status = UserStatus.ACTIVE;
      }

      await this.userRepo.save(user);

      await this.sessionRepo.update(
        { userId: user.id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );

      this.logger.log(`Password set for ${user.email} via ${record.type}`);

      // When the new credential took effect, on the DATABASE clock — the one
      // that stamps auth_attempts."createdAt" — so the MFA hard cap resets
      // from it whatever Node's clock says (AuthAttemptLimiter). The password
      // is already changed here, so a clock that cannot be read must not cost
      // the audit row below or fail the request (Owen's gate): the row is
      // written without the boundary, and this reset then does not lift the
      // MFA hard cap — fail closed; an operator unlock still does.
      let credentialSetAt: string | undefined;
      try {
        credentialSetAt = await databaseNowUtc(this.userRepo);
      } catch (err) {
        this.logger.error(
          `Database clock unreadable after a credential change for user ${user.id}; ` +
            `audited without credentialSetAt, so the MFA hard cap is not lifted: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      // The whole point of this event: someone set a credential using a
      // bearer token, with no session and no logged-in actor to attribute it
      // to otherwise. `context.tokenType` distinguishes an invite acceptance
      // from a reset completion — one handler serves both (see this method's
      // own doc comment) — and `sessionsRevoked` records the side effect this
      // redemption already had. Never the token itself.
      await this.audit({
        tenantId: user.tenantId,
        userId: user.id,
        userEmail: user.email,
        action: AuditAction.TOKEN_REDEEMED,
        entityType: 'user',
        entityId: user.id,
        description: `Credential set for ${user.email} via ${record.type} token`,
        context: {
          tokenType: record.type,
          allSessionsRevoked: true,
          // A new password lifts the MFA hard cap: AuthAttemptLimiter counts
          // MFA failures only after this instant. UTC ISO, because
          // `audit_logs."timestamp"` has no zone. Absent if the clock read
          // failed.
          ...(credentialSetAt ? { credentialSetAt } : {}),
        },
      });

      return { ok: true as const, email: user.email };
    });
  }

  // ─── Session Management ──────────────────────────────────────────
  //
  // ImmiStack, the Meru Dashboard and GovernanceX are three separate products
  // that one person legitimately holds open at once, on more than one device.
  // So concurrent sessions are allowed by design — but "allowed" is only safe
  // if they are also *visible* and individually revocable, which is what this
  // section provides. A blanket revoke-on-login would have been simpler and
  // wrong: it would silently sign you out of the other two products.

  /**
   * Issue a token pair and the session behind it.
   *
   * The session row is created *before* the access token is signed so the
   * token can carry its `sid`. Without that link an access token cannot be
   * traced to a session, and "which of these is the device I'm on right now?"
   * is unanswerable.
   */
  private async issueSession(user: UserPayload, context: SessionContext = {}) {
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const session = await this.createSession(user, refreshToken, context);

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      roles: user.roles,
      // `role` (singular) as well as `roles`. The portals decode this token in
      // Next.js middleware to pick a portal and gate the /platform, /admin,
      // /staff and /client prefixes, and they read `payload.role` — with only
      // `roles` present that guard silently passed everything through.
      // Authorisation on the server never uses this claim; PolicyGuard reads
      // `roles` off the validated user.
      role: this.resolvePrimaryRole(user.roles ?? []),
      sid: session.id,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600, // 1 hour
      token_type: 'Bearer',
    };
  }

  /**
   * Mint a short-lived token that lets a platform operator act inside another
   * tenant, for support ("the firm says this case will not open").
   *
   * Deliberately NOT `issueSession`, in three ways:
   *
   * - **No refresh token.** Impersonation must expire on its own. A refresh
   *   token would let a support session outlive the incident it was opened
   *   for, and nothing would show it was still alive.
   * - **No session row.** The impersonated user's own device list is theirs;
   *   an operator's support session appearing in it invites them to revoke
   *   something they do not understand, and makes "sessions" mean two things.
   * - **15 minutes, not an hour.** Long enough to diagnose, short enough that
   *   a forgotten browser tab is not standing access to a customer's data.
   *
   * The `imp` claim rides along so every action taken with this token names
   * the operator behind it. Caller MUST wrap this in `TenancyService.runAsGod`
   * — the user lookup below crosses a tenant boundary, and an unaudited
   * impersonation is exactly the thing CLAUDE.md §6.4 forbids.
   */
  async issueImpersonationToken(
    targetTenantId: string,
    operator: { id: string; tenantId: string },
  ): Promise<{
    access_token: string;
    expires_in: number;
    token_type: string;
    impersonating: { userId: string; email: string; tenantId: string };
  }> {
    // Nested impersonation (Anton). Impersonating a `platform_admin` hands
    // the session the right to impersonate again, and the second token's
    // `imp` would name the impersonated admin — the real operator drops out
    // of the trail. So: never the operator's own tenant (the controller
    // refuses it first; this is the second wall), and never a user holding
    // `platform_admin`, in any tenant.
    if (targetTenantId === operator.tenantId) {
      throw new ForbiddenException(
        'Cannot impersonate a user in your own tenant',
      );
    }

    // `roles` is a simple-array column (comma-joined text), not a relation,
    // so "does not hold platform_admin" is filtered here rather than in SQL.
    // Paged, earliest first, so a tenant with many active users is not read
    // whole to find one. Tenant scope: `tenantId` in the WHERE clause, and
    // only that. The caller wraps this in `runAsGod`, which BYPASSES RLS (it
    // does not bind the target tenant), so dropping that predicate would
    // read every tenant's users.
    const PAGE = 50;
    let target: User | undefined;
    for (let skip = 0; !target; skip += PAGE) {
      const page = await this.userRepo.find({
        where: { tenantId: targetTenantId, status: UserStatus.ACTIVE },
        order: { createdAt: 'ASC', id: 'ASC' },
        skip,
        take: PAGE,
      });
      target = page.find(
        (u) => !(u.roles ?? []).includes(PlatformRole.PLATFORM_ADMIN),
      );
      if (page.length < PAGE) break;
    }

    if (!target) {
      throw new BadRequestException(
        `Tenant ${targetTenantId} has no active user that may be impersonated ` +
          `(a platform_admin account is never impersonated)`,
      );
    }

    const roles = target.roles ?? [];

    const accessToken = this.jwtService.sign(
      {
        sub: target.id,
        email: target.email,
        tenantId: target.tenantId,
        roles,
        role: this.resolvePrimaryRole(roles),
        imp: { operatorId: operator.id, operatorTenantId: operator.tenantId },
      },
      { expiresIn: '15m' },
    );

    return {
      access_token: accessToken,
      expires_in: 900,
      token_type: 'Bearer',
      impersonating: {
        userId: target.id,
        email: target.email,
        tenantId: target.tenantId,
      },
    };
  }

  /**
   * The caller's own active sessions, newest first.
   *
   * Scoped to `userId` from the validated JWT — there is no parameter here a
   * caller could point at somebody else. Returns no token material of any
   * kind; a session is identified to the client only by its row id.
   */
  async listSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.sessionRepo.find({
      where: { userId, revokedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });

    const now = Date.now();

    return sessions
      .filter((s) => s.expiresAt.getTime() > now)
      .map((s) => ({
        id: s.id,
        client: s.client ?? 'unknown',
        ipAddress: s.ipAddress || null,
        userAgent: s.userAgent || null,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        /** True for the session this request is authenticated by. */
        current: !!currentSessionId && s.id === currentSessionId,
      }));
  }

  /**
   * Revoke one of the caller's own sessions.
   *
   * The `userId` predicate is the security boundary: without it a session id —
   * which the list endpoint hands out freely — would be enough to sign any
   * other user out.
   */
  async revokeSessionById(tenantId: string, userId: string, sessionId: string) {
    const result = await this.sessionRepo.update(
      { id: sessionId, userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    if (!result.affected) {
      throw new NotFoundException('Session not found or already revoked');
    }

    await this.audit({
      tenantId,
      userId,
      action: AuditAction.SESSION_REVOKED,
      entityType: 'session',
      entityId: sessionId,
      description: 'Session revoked by its own holder',
      context: { scope: 'single' },
    });

    return { revoked: true, sessionId };
  }

  /**
   * Revoke every session the caller holds, across all three portals and every
   * device. This is the "sign me out everywhere" button, and the right response
   * to a suspected compromise.
   */
  async revokeAllSessions(tenantId: string, userId: string) {
    const result = await this.sessionRepo.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    await this.audit({
      tenantId,
      userId,
      action: AuditAction.SESSION_REVOKED,
      entityType: 'user',
      entityId: userId,
      description: `All sessions revoked (${result.affected ?? 0})`,
      context: { scope: 'all', sessionCount: result.affected ?? 0 },
    });

    return { revoked: true, sessionCount: result.affected ?? 0 };
  }
}
