import { UnauthorizedException } from '@nestjs/common';
import { LocalStrategy } from './local.strategy';

/**
 * `POST /auth/login` attempt limiting, enforced in the local strategy because
 * that is where the password is checked. Keyed on account AND source (Owen's
 * gate, 2026-11-17): a locked source is refused even with the right password,
 * and a different source — the account holder's — is not.
 *
 * Every refusal is the same 401 with the same body: unknown email, wrong
 * password, locked source. The unknown and locked paths spend a bcrypt
 * compare. Timing is narrowed, not closed: a known account also costs the
 * attempt write, the count and, unless the password was wrong, the release
 * (see the strategy's header).
 *
 * The attempt is begun — written — BEFORE the password is checked (Anton,
 * second gate), so concurrent attempts see each other; the race itself is
 * pinned against the real limiter in `attempt-race.spec.ts`.
 */
describe('LocalStrategy — login attempt limit, keyed on account and source', () => {
  const MESSAGE = 'Invalid email or password';
  const account = { id: 'u1', tenantId: 't1', email: 'a@example.test', status: 'active' };
  const user = { id: 'u1', tenantId: 't1', email: 'a@example.test', roles: [] };
  const req = { ip: '::ffff:203.0.113.9' } as any;

  function build(o: {
    account?: any;
    locked?: boolean;
    standingThrows?: boolean;
    validUser?: any;
  }) {
    const standing = { locked: !!o.locked, lastRefusalAt: null };
    const ticket = { standing };
    const limiter = {
      findAccountByEmail: jest.fn(async () => o.account ?? null),
      begin: jest.fn(async () => {
        if (o.standingThrows) throw new Error('unexpected');
        return ticket;
      }),
      release: jest.fn(async () => undefined),
      refuse: jest.fn(async () => undefined),
      burnTime: jest.fn(async () => undefined),
    };
    const iam = { validateUser: jest.fn(async () => o.validUser ?? null) };
    const strategy = new LocalStrategy(iam as any, limiter as any);
    return { strategy, limiter, iam, standing, ticket };
  }

  async function expect401(p: Promise<unknown>) {
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as Error).message).toBe(MESSAGE);
  }

  it('begins the attempt for this account from this source, normalised, before checking the password', async () => {
    const b = build({ account, validUser: user });
    await b.strategy.validate(req, 'a@example.test', 'right');
    expect(b.limiter.begin).toHaveBeenCalledWith(account, 'login', '203.0.113.9');
    expect(b.limiter.begin.mock.invocationCallOrder[0]).toBeLessThan(
      b.iam.validateUser.mock.invocationCallOrder[0],
    );
  });

  it('refuses a locked source even with the right password, without checking it, and leaves a trace', async () => {
    const b = build({ account, locked: true, validUser: user });

    await expect401(b.strategy.validate(req, 'a@example.test', 'right'));
    expect(b.iam.validateUser).not.toHaveBeenCalled();
    expect(b.limiter.burnTime).toHaveBeenCalled();
    expect(b.limiter.refuse).toHaveBeenCalledWith(b.ticket);
    expect(b.limiter.release).not.toHaveBeenCalled();
  });

  it('refuses, the same way, if the standing check itself throws — fails closed', async () => {
    const b = build({ account, standingThrows: true, validUser: user });

    await expect401(b.strategy.validate(req, 'a@example.test', 'right'));
    expect(b.iam.validateUser).not.toHaveBeenCalled();
  });

  it('a wrong password keeps the begun attempt: it is the failure', async () => {
    const b = build({ account });

    await expect401(b.strategy.validate(req, 'a@example.test', 'wrong'));
    expect(b.limiter.begin).toHaveBeenCalledWith(account, 'login', '203.0.113.9');
    expect(b.limiter.release).not.toHaveBeenCalled();
    expect(b.limiter.refuse).not.toHaveBeenCalled();
  });

  it('an unknown email gets the same 401, spends the same bcrypt time, and writes nothing', async () => {
    const b = build({ account: null });

    await expect401(b.strategy.validate(req, 'nobody@example.test', 'x'));
    expect(b.limiter.burnTime).toHaveBeenCalled();
    expect(b.limiter.begin).not.toHaveBeenCalled();
  });

  it('an account that cannot sign in anyway (locked/inactive) is not counted: the attempt is released', async () => {
    for (const status of ['locked', 'inactive']) {
      const b = build({ account: { ...account, status } });
      await expect401(b.strategy.validate(req, 'a@example.test', 'x'));
      expect(b.limiter.release).toHaveBeenCalledWith(b.ticket);
      expect(b.limiter.burnTime).toHaveBeenCalled();
    }
  });

  it('lets a correct password through from an unlocked source, and releases the attempt', async () => {
    const b = build({ account, validUser: user });

    await expect(b.strategy.validate(req, 'a@example.test', 'right')).resolves.toBe(user);
    expect(b.limiter.release).toHaveBeenCalledWith(b.ticket);
    expect(b.limiter.refuse).not.toHaveBeenCalled();
  });
});
