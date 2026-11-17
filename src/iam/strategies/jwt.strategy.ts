import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { JwtPayload } from '../../common/types';
import { Session } from '../entities/session.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  /**
   * How long a revocation may take to bite.
   *
   * Checking the session on every request is one round trip per API call on a
   * serverless deployment; never checking it means logout does not stop the
   * access token until it expires an hour later, which is what
   * `POST /auth/logout-all` was being recommended for. A minute of cache is the
   * honest middle: revocation is effective in ~60s rather than ~60min, at one
   * database read per session per minute.
   */
  private static readonly REVOCATION_TTL_MS = 60_000;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // getOrThrow, not a literal fallback. JWT_SECRET is `.required()` in the
      // Joi schema, so a fallback here was unreachable through ConfigModule —
      // and if it were ever reached, every token would be forgeable by anyone
      // who has read this file.
      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
      passReqToCallback: false,
    });
  }

  async validate(payload: JwtPayload & { mfaPending?: boolean }) {
    // The MFA challenge from `IamService.login` is signed with this same key.
    // It proves the password leg only; it is good for exactly one thing,
    // `POST /auth/mfa/verify` (@Public, verified in IamService.verifyMfaLogin),
    // and must never be accepted as a Bearer credential.
    if (payload.mfaPending) {
      throw new UnauthorizedException('MFA challenge is not an access token');
    }

    // `issueSession` always sets `sid`. The only token minted without one by
    // design is an impersonation token, which carries `imp` instead and has no
    // Session row (IamService.issueImpersonationToken). Anything else that is
    // sid-less — the MFA challenge, the SAML token — is not a session token.
    //
    // RESIDUAL RISK, named rather than hidden: an impersonation token cannot
    // be revoked. It lives 15 minutes and nothing below checks it.
    if (!payload.sid && !payload.imp) {
      throw new UnauthorizedException('Token is not bound to a session');
    }

    await this.assertSessionLive(payload.sid);

    // Payload is attached to request.user
    return {
      id: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId,
      roles: payload.roles,
      // The session this token was issued against. Lets `GET /auth/sessions`
      // mark which row is the caller's current device, and is why the session
      // is created before the token is signed. Absent on tokens issued before
      // that change — treated as "unknown", never as a match.
      sessionId: payload.sid,
      // Only ever set from the signed token, never from a header or body: an
      // attacker who could assert impersonation would be able to launder their
      // own actions under someone else's name in the audit log.
      impersonatedBy: payload.imp,
    };
  }

  /**
   * Reject an access token whose session has been revoked.
   *
   * Only reached with no `sid` for an impersonation token; `validate` refuses
   * every other sid-less token before this runs. (The old "predates session
   * binding" exemption is void: access tokens live an hour, and every token
   * from before session binding expired long ago.)
   *
   * A session row that cannot be read fails CLOSED with a 503, not a 401: a
   * revoked token must not work just because the database blinked, and a 503
   * tells the portals to retry rather than log the user out. The 60s cache of
   * `true` still carries already-verified sessions through a short blip.
   */
  private async assertSessionLive(sessionId?: string): Promise<void> {
    if (!sessionId) return;

    const cacheKey = `session-live:${sessionId}`;
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached === true) return;
    if (cached === false) {
      throw new UnauthorizedException('Session has been revoked');
    }

    let live = true;
    try {
      // Bootstrap lookup: the token's tenant has not been bound yet, and the
      // session row is what authorises binding it.
      const session = await TenantContext.runAsSystem(
        'verify session not revoked',
        () =>
          this.sessionRepo.findOne({
            where: { id: sessionId, revokedAt: IsNull() },
            select: ['id', 'expiresAt'],
          }),
      );
      live = !!session && session.expiresAt > new Date();
    } catch (err) {
      this.logger.warn(
        `session check failed for sid=${sessionId}: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException('Session could not be verified');
    }

    await this.cache.set(cacheKey, live, JwtStrategy.REVOCATION_TTL_MS);
    if (!live) {
      throw new UnauthorizedException('Session has been revoked');
    }
  }
}
