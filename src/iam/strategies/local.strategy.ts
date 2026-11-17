import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { IamService } from '../iam.service';
import { UserPayload } from '../../common/types';
import {
  AttemptTicket,
  AuthAttemptLimiter,
  attemptSource,
} from '../services/auth-attempt-limiter.service';
import { UserStatus } from '../entities/user.entity';

/**
 * Passport "local" strategy used by `POST /auth/login`.
 *
 * Reads `email` + `password` from the request body (instead of the default
 * `username` field), delegates credential checking to IamService.validateUser,
 * and attaches the resulting UserPayload to `req.user` for the controller.
 *
 * Attempt limit, keyed on account AND source (Anton #6, redesigned after
 * Owen's gate 2026-11-17): after `ATTEMPT_LIMITS.login.perSource` wrong
 * passwords from one source inside the window, that source is refused for
 * that account, right password or not, until its failures age out or a
 * platform operator unlocks the account. Other sources are unaffected, so a
 * guesser cannot lock the account holder out; past the account-wide backstop
 * every source is held to one failure. A refused attempt leaves a
 * rate-limited `refused_locked` trace. Behaviour table: `AuthAttemptLimiter`.
 * Every refusal is the same 401 with the same message (unknown email, wrong
 * password, locked, limiter unreadable), and the paths that skip the real
 * compare spend a dummy one, so the body never says whether an account
 * exists. Timing still can: for a known account the strategy also writes
 * the attempt as a pending `auth_attempts` row, runs the attempt count (one
 * `auth_attempts` read joined to the latest `auth.login.unlocked` audit
 * row) and, unless the password was wrong, deletes that row again — round
 * trips an unknown email never makes. Narrowed, not closed.
 *
 * The attempt is written BEFORE the password is checked and counted with
 * itself included (Anton, second gate): read-then-check-then-write let a
 * parallel burst read the count before any of its own failures landed, so
 * one source got ~100 guesses instead of 10.
 */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(LocalStrategy.name);

  constructor(
    private iamService: IamService,
    private attempts: AuthAttemptLimiter,
  ) {
    super({
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
    });
  }

  async validate(
    req: { ip?: string },
    email: string,
    password: string,
  ): Promise<UserPayload> {
    const refuse = () => new UnauthorizedException('Invalid email or password');
    // From `req.ip` under `trust proxy` (TRUST_PROXY_HOPS, default 1) — the proxy's view, not a
    // client-chosen header. Normalised (IPv6 to its /64) by the limiter.
    const source = attemptSource(req?.ip);

    const account = await this.attempts.findAccountByEmail(email);
    let ticket: AttemptTicket | null = null;
    if (account) {
      try {
        // Written as a failure BEFORE the password is checked; never throws
        // by contract (it degrades instead), guarded anyway.
        ticket = await this.attempts.begin(account, 'login', source);
      } catch (err) {
        // Fail closed, and with the ordinary 401: a 503 here would tell the
        // caller the email exists.
        this.logger.error(
          `Login attempt limit unreadable for user ${account.id}; refused: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        await this.attempts.burnTime(password);
        throw refuse();
      }
      if (ticket.standing.locked) {
        await this.attempts.refuse(ticket);
        await this.attempts.burnTime(password);
        throw refuse();
      }
    }

    const user = await this.iamService.validateUser(email, password);
    if (user) {
      if (ticket) await this.attempts.release(ticket);
      return user;
    }

    if (
      !account ||
      account.status === UserStatus.LOCKED ||
      account.status === UserStatus.INACTIVE
    ) {
      // Not a guess at a password that could sign in: not counted.
      if (ticket) await this.attempts.release(ticket);
      // validateUser returned before its bcrypt compare; spend one here.
      await this.attempts.burnTime(password);
    }
    // Otherwise a wrong password: the begun attempt IS the failure.
    throw refuse();
  }

}
