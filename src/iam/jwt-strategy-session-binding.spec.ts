import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { readFileSync } from 'fs';
import { join } from 'path';
import { JwtStrategy } from './strategies/jwt.strategy';
import { IamService } from './iam.service';

/**
 * `JwtStrategy.validate` is the one verifier (`one-jwt-verifier.spec.ts`), so
 * every claim it fails to check is a claim no route checks.
 *
 * Three holes closed here, all confirmed by Anton against the code:
 *
 *  1. The MFA challenge (`{sub, mfaPending: true}`) is signed with the same
 *     key as a session token. `validate` never looked at `mfaPending`, so a
 *     holder of only a password could present the challenge as a Bearer
 *     token for its five minutes. Only RLS stood in the way, by accident.
 *  2. A token with no `sid` skipped the revocation check entirely. Every
 *     token `issueSession` mints carries a `sid`; only impersonation tokens
 *     are sid-less by design (they carry `imp`). Everything else sid-less —
 *     the challenge, the SAML token — is not a session token.
 *  3. A session read that threw was treated as "live", so a revoked token
 *     worked whenever the database blinked.
 */
describe('JwtStrategy — session binding', () => {
  const SECRET = 'test-secret-that-is-at-least-32-characters-long';

  function build(sessionFindOne: jest.Mock = jest.fn()) {
    const config = {
      get: jest.fn(() => SECRET),
      getOrThrow: jest.fn(() => SECRET),
    };
    const sessionRepo = { findOne: sessionFindOne };
    const cache = {
      get: jest.fn(async () => undefined),
      set: jest.fn(async () => undefined),
    };
    const strategy = new JwtStrategy(
      config as any,
      sessionRepo as any,
      cache as any,
    );
    return { strategy, sessionRepo, cache };
  }

  const liveSession = () =>
    jest.fn(async () => ({
      id: 'sid-1',
      expiresAt: new Date(Date.now() + 60_000),
    }));

  it('refuses an MFA challenge token', async () => {
    const { strategy, sessionRepo } = build();
    await expect(
      strategy.validate({ sub: 'u1', mfaPending: true } as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessionRepo.findOne).not.toHaveBeenCalled();
  });

  it('refuses the exact challenge IamService.login signs — signer and verifier agree on the claim', async () => {
    // Ties the signer to the verifier: if the claim is ever renamed in
    // login(), this goes red instead of the bypass silently reopening.
    const jwtService = new JwtService({ secret: SECRET });
    const iam = new IamService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      jwtService,
      {} as any,
      {} as any,
    );
    const res: any = await iam.login({
      id: 'u1',
      email: 'u1@example.test',
      tenantId: 't1',
      roles: ['staff'],
      mfaEnabled: true,
    });
    expect(res.requiresMfa).toBe(true);

    const decoded = jwtService.verify(res.temporaryToken);
    const { strategy } = build();
    await expect(strategy.validate(decoded)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a token with neither sid nor imp, without reading the session table', async () => {
    const { strategy, sessionRepo } = build();
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'u1@example.test',
        tenantId: 't1',
        roles: ['staff'],
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessionRepo.findOne).not.toHaveBeenCalled();
  });

  it('refuses a SAML-shaped token (roles: [], no sid, no imp)', async () => {
    const { strategy } = build();
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'u1@example.test',
        tenantId: 't1',
        roles: [],
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still admits an impersonation token (imp, no sid) — the one sid-less token by design', async () => {
    const { strategy, sessionRepo } = build();
    const user = await strategy.validate({
      sub: 'u1',
      email: 'u1@example.test',
      tenantId: 't1',
      roles: ['firm_admin'],
      imp: { operatorId: 'o1', operatorTenantId: 'p1' },
    });
    expect(user).toMatchObject({
      id: 'u1',
      tenantId: 't1',
      impersonatedBy: { operatorId: 'o1', operatorTenantId: 'p1' },
    });
    expect(sessionRepo.findOne).not.toHaveBeenCalled();
  });

  it('admits a token bound to a live session', async () => {
    const { strategy } = build(liveSession());
    const user = await strategy.validate({
      sub: 'u1',
      email: 'u1@example.test',
      tenantId: 't1',
      roles: ['staff'],
      sid: 'sid-1',
    });
    expect(user).toMatchObject({ id: 'u1', sessionId: 'sid-1' });
  });

  it('refuses a token whose session is revoked', async () => {
    const { strategy } = build(jest.fn(async () => null));
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'u1@example.test',
        tenantId: 't1',
        roles: ['staff'],
        sid: 'sid-gone',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails CLOSED with a 503 when the session cannot be read, and caches nothing', async () => {
    const { strategy, cache } = build(
      jest.fn(async () => {
        throw new Error('connection terminated');
      }),
    );
    await expect(
      strategy.validate({
        sub: 'u1',
        email: 'u1@example.test',
        tenantId: 't1',
        roles: ['staff'],
        sid: 'sid-1',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("carries no 'default-secret' fallback in either the verifier or the signer", () => {
    const strategySrc = readFileSync(
      join(__dirname, 'strategies', 'jwt.strategy.ts'),
      'utf8',
    );
    const moduleSrc = readFileSync(join(__dirname, 'iam.module.ts'), 'utf8');
    expect(strategySrc).not.toMatch(/'default-secret'/);
    expect(moduleSrc).not.toMatch(/'default-secret'/);
  });

  it('reads the signing secret with getOrThrow, so a missing secret refuses to construct', () => {
    const config = {
      get: jest.fn(() => undefined),
      getOrThrow: jest.fn(() => {
        throw new TypeError('Configuration key "jwt.secret" does not exist');
      }),
    };
    expect(
      () =>
        new JwtStrategy(
          config as any,
          { findOne: jest.fn() } as any,
          { get: jest.fn(), set: jest.fn() } as any,
        ),
    ).toThrow();
  });
});
