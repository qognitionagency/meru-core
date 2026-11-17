import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { MfaAttemptLimitInterceptor } from './mfa-attempt-limit.interceptor';
import { IamController } from '../iam.controller';

/**
 * `POST /auth/mfa/verify` and `POST /auth/mfa/disable` attempt limit
 * (Anton #6; keyed on account AND source after Owen's gate, 2026-11-17).
 * Registered globally from IamModule and acting only on those two handlers,
 * matched by reference, so neither route's own decorators change. A locked
 * source gets 429 (and a rate-limited refusal trace) until its failures age
 * out; other sources are unaffected. The limiter never throws — it degrades
 * to an in-process count — so a guard that does throw is a 503.
 *
 * Second gate (Anton): the attempt is begun — written — before the handler
 * checks the code (race: `attempt-race.spec.ts`), and past `MFA_HARD_CAP`
 * the account is refused from every source until an unlock or a reset.
 */
describe('MfaAttemptLimitInterceptor', () => {
  const account = { id: 'u1', tenantId: 't1', email: 'a@example.test' };

  function build(o: {
    locked?: boolean;
    hardLocked?: boolean;
    lockReadFails?: boolean;
    challenge?: any;
  } = {}) {
    const standing = {
      locked: !!o.locked || !!o.hardLocked,
      hardLocked: !!o.hardLocked,
      lastRefusalAt: null,
    };
    const ticket = { standing };
    const limiter = {
      findAccountById: jest.fn(async () => account),
      begin: jest.fn(async () => {
        if (o.lockReadFails) throw new Error('unexpected');
        return ticket;
      }),
      release: jest.fn(async () => undefined),
      refuse: jest.fn(async () => undefined),
    };
    // IamService.mfaChallengeSubject's contract (mfa-challenge-subject.spec.ts):
    // the subject of a valid mfaPending challenge, else null.
    const iam = {
      mfaChallengeSubject: jest.fn(() => {
        const c = o.challenge === 'invalid' ? null : (o.challenge ?? { sub: 'u1', mfaPending: true });
        return c?.mfaPending && c.sub ? c.sub : null;
      }),
    };
    return {
      interceptor: new MfaAttemptLimitInterceptor(limiter as any, iam as any),
      limiter,
      iam,
      ticket,
    };
  }

  function ctx(handler: unknown, req: any) {
    return {
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => req }),
    } as any;
  }
  const disableReq = { user: { id: 'u1', tenantId: 't1', email: 'a@example.test' }, ip: '198.51.100.7', body: { token: '000000' } };
  const verifyReq = { ip: '198.51.100.7', body: { temporaryToken: 'tt', token: '000000' } };
  const disable = IamController.prototype.disableMfa;
  const verify = IamController.prototype.verifyMfaLogin;

  const run = (i: MfaAttemptLimitInterceptor, c: any, result: () => any) =>
    lastValueFrom(i.intercept(c, { handle: result } as any));

  it('answers 429 for a locked source, never runs the handler, and leaves a refusal trace', async () => {
    const b = build({ locked: true });
    const handle = jest.fn(() => of('ok'));

    const err = await run(b.interceptor, ctx(disable, disableReq), handle).catch((e) => e);

    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(handle).not.toHaveBeenCalled();
    expect(b.limiter.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'mfa',
      '198.51.100.7',
    );
    expect(b.limiter.refuse).toHaveBeenCalledWith(b.ticket);
    expect((err as HttpException).message).toBe('Too many failed MFA attempts — try again later');
  });

  it('past the hard cap: 429 from every source, saying what lifts it, handler not run', async () => {
    const b = build({ hardLocked: true });
    const handle = jest.fn(() => of('ok'));

    const err = await run(b.interceptor, ctx(verify, verifyReq), handle).catch((e) => e);

    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((err as HttpException).message).toMatch(/password is reset or .*unlock/i);
    expect(handle).not.toHaveBeenCalled();
    expect(b.limiter.refuse).toHaveBeenCalledWith(b.ticket);
  });

  it('answers 503 if the standing check throws despite its contract, and never runs the handler', async () => {
    const b = build({ lockReadFails: true });
    const handle = jest.fn(() => of('ok'));

    await expect(run(b.interceptor, ctx(disable, disableReq), handle)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it('a wrong code on disable keeps the attempt begun against the authenticated user, and rethrows the 401', async () => {
    const b = build();

    await expect(
      run(b.interceptor, ctx(disable, disableReq), () =>
        throwError(() => new UnauthorizedException('Invalid MFA token')),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(b.limiter.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1', tenantId: 't1' }),
      'mfa',
      '198.51.100.7',
    );
    expect(b.limiter.release).not.toHaveBeenCalled();
  });

  it('an error that is not a wrong code releases the attempt, and is rethrown', async () => {
    const b = build();
    const boom = new Error('handler fault');
    await expect(
      run(b.interceptor, ctx(disable, disableReq), () => throwError(() => boom)),
    ).rejects.toBe(boom);
    expect(b.limiter.release).toHaveBeenCalledWith(b.ticket);
  });

  it('keys verify and disable on the source, normalised the same way as login', async () => {
    const b = build();
    await run(b.interceptor, ctx(disable, { ...disableReq, ip: '2001:db8:1:2::77' }), () => of('ok'));
    expect(b.limiter.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'mfa',
      '2001:db8:1:2::/64',
    );
  });

  it('resolves the verify account from the challenge token, and counts against it', async () => {
    const b = build();

    await expect(
      run(b.interceptor, ctx(verify, verifyReq), () =>
        throwError(() => new UnauthorizedException('Invalid MFA token')),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(b.iam.mfaChallengeSubject).toHaveBeenCalledWith('tt');
    expect(b.limiter.findAccountById).toHaveBeenCalledWith('u1');
    expect(b.limiter.begin).toHaveBeenCalledWith(account, 'mfa', '198.51.100.7');
    expect(b.limiter.release).not.toHaveBeenCalled();
  });

  it('passes an invalid or non-MFA challenge straight to the handler — nothing to count against', async () => {
    for (const challenge of ['invalid', { sub: 'u1' }]) {
      const b = build({ challenge });
      const err = await run(b.interceptor, ctx(verify, verifyReq), () =>
        throwError(() => new UnauthorizedException('MFA challenge is invalid or expired')),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(b.limiter.begin).not.toHaveBeenCalled();
    }
  });

  it('releases the attempt on success', async () => {
    const b = build();
    await expect(run(b.interceptor, ctx(verify, verifyReq), () => of({ ok: true }))).resolves.toEqual({ ok: true });
    expect(b.limiter.release).toHaveBeenCalledWith(b.ticket);
  });

  it('leaves every other handler alone', async () => {
    const b = build({ locked: true });
    await expect(
      run(b.interceptor, ctx(IamController.prototype.login, {}), () => of('ok')),
    ).resolves.toBe('ok');
    expect(b.limiter.begin).not.toHaveBeenCalled();
  });
});
