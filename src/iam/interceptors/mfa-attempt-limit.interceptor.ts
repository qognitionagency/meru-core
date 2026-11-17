import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, catchError, concatMap, defer, mergeMap } from 'rxjs';
import { IamController } from '../iam.controller';
import { IamService } from '../iam.service';
import {
  AttemptAccount,
  AttemptTicket,
  AuthAttemptLimiter,
  attemptSource,
} from '../services/auth-attempt-limiter.service';

/**
 * MFA attempt limit on `POST /auth/mfa/verify` and `POST /auth/mfa/disable`
 * (Anton #6), keyed on account AND source like the login limit (Owen's gate,
 * 2026-11-17), so a guesser cannot lock the account holder's own device out.
 *
 * Registered globally (APP_INTERCEPTOR, IamModule) and acting only on those
 * two handlers, matched by reference. That keeps both routes' own decorators
 * and IamService untouched. Interceptors run after guards, so on disable
 * `req.user` is the authenticated caller; on verify the account comes from the
 * signed `mfaPending` challenge, never from a client-supplied id.
 *
 * - The attempt is begun — written as a failure — BEFORE the handler checks
 *   the code, so concurrent attempts see each other (Anton, second gate).
 * - Source locked (`ATTEMPT_LIMITS.mfa`): 429, handler not run, and a
 *   rate-limited `refused_locked` row. Counted per account and source, not
 *   per challenge token, so reusing one 5-minute challenge does not help.
 * - Past `MFA_HARD_CAP` (any source, 24 h): 429 from every source until a
 *   password reset or an operator unlock. The caller already holds the
 *   password, so this lock cannot be used against the holder by a stranger.
 * - A 401 from the handler leaves the begun attempt as the failure; success
 *   or any other error releases it.
 * - The limiter never throws: an unreadable count or unwritable failure
 *   degrades to an in-process count (see `AuthAttemptLimiter`). If the
 *   standing check throws anyway, 503 — the caller already holds a
 *   password-verified challenge or a session, so it discloses nothing.
 */
@Injectable()
export class MfaAttemptLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MfaAttemptLimitInterceptor.name);

  private static readonly LIMITED: ReadonlySet<unknown> = new Set([
    IamController.prototype.verifyMfaLogin,
    IamController.prototype.disableMfa,
  ]);

  constructor(
    private readonly attempts: AuthAttemptLimiter,
    // The challenge is verified by IamService, the one sanctioned verifier
    // of an MFA challenge token (one-jwt-verifier.spec.ts), not here.
    private readonly iam: IamService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!MfaAttemptLimitInterceptor.LIMITED.has(context.getHandler())) {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest();

    const source = attemptSource(req?.ip);

    return defer(async () => {
      const account = await this.resolveAccount(req);
      return account ? this.beginOrRefuse(account, source) : null;
    }).pipe(
      mergeMap((ticket) =>
        next.handle().pipe(
          concatMap(async (value) => {
            if (ticket) await this.attempts.release(ticket);
            return value;
          }),
          catchError((err: unknown) =>
            defer(async () => {
              // A wrong code: the begun attempt IS the failure. Anything
              // else was not a guess. Neither call throws.
              if (ticket && !(err instanceof UnauthorizedException)) {
                await this.attempts.release(ticket);
              }
              throw err;
            }),
          ),
        ),
      ),
    );
  }

  private async resolveAccount(req: any): Promise<AttemptAccount | null> {
    if (req?.user?.id && req?.user?.tenantId) {
      return { id: req.user.id, tenantId: req.user.tenantId, email: req.user.email };
    }
    // verify: only a valid, unexpired MFA challenge names an account. An
    // invalid one is left for the handler to refuse; there is no one to count.
    const sub = this.iam.mfaChallengeSubject(
      String(req?.body?.temporaryToken ?? ''),
    );
    return sub ? this.attempts.findAccountById(sub) : null;
  }

  private async beginOrRefuse(
    account: AttemptAccount,
    source: string,
  ): Promise<AttemptTicket> {
    let ticket: AttemptTicket;
    try {
      ticket = await this.attempts.begin(account, 'mfa', source);
    } catch (err) {
      this.logger.error(
        `MFA attempt limit unreadable for user ${account.id}; refused: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      throw new ServiceUnavailableException(
        'Sign-in protection unavailable — try again shortly',
      );
    }
    const { standing } = ticket;
    if (standing.locked) {
      this.logger.warn(
        `MFA attempts ${standing.hardLocked ? 'hard-' : ''}locked for user ` +
          `${account.id} from ${source}`,
      );
      await this.attempts.refuse(ticket);
      throw new HttpException(
        standing.hardLocked
          ? 'Too many failed MFA attempts — locked until your password is ' +
              'reset or an operator unlocks the account'
          : 'Too many failed MFA attempts — try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return ticket;
  }
}
