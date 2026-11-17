import { UnauthorizedException } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import {
  ATTEMPT_LIMITS,
  AuthAttemptLimiter,
} from './services/auth-attempt-limiter.service';
import { LocalStrategy } from './strategies/local.strategy';
import { MfaAttemptLimitInterceptor } from './interceptors/mfa-attempt-limit.interceptor';
import { IamController } from './iam.controller';

/**
 * Anton, second gate (HIGH): the flow was read count → verify secret → write
 * failure, so a parallel burst read the count before any of its own writes
 * landed, and one source got ~100 guesses instead of 10.
 *
 * These run the REAL limiter, strategy and interceptor against an in-memory
 * store that behaves like the table under concurrency: every statement
 * yields to the event loop, a committed insert is visible to every later
 * read, and the order of interleaving is randomised. The assertion is the
 * one that matters — how many times the secret was actually compared.
 */
describe('attempt limiting under a concurrent burst', () => {
  const BURST = 30;
  const account = { id: 'u1', tenantId: 't1', email: 'a@example.test', status: 'active' };

  type Row = {
    id: string;
    tenantId: string;
    userId: string;
    kind: string;
    outcome: string;
    source: string;
    createdAt: Date;
  };

  function store() {
    const rows: Row[] = [];
    let seq = 0;
    const jitter = () =>
      new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3)));
    const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // SQL LIKE with backslash escapes, as Postgres reads it.
    const like = (pattern: string) => {
      let re = '^';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '\\') {
          re += escapeRe(pattern[++i] ?? '');
          continue;
        }
        re += c === '%' ? '.*' : c === '_' ? '.' : escapeRe(c);
      }
      return new RegExp(re + '$');
    };

    async function run(sql: string, p: any[] = []): Promise<any> {
      await jitter();
      if (/^\s*SET LOCAL/.test(sql)) return [];
      if (/^\s*INSERT INTO "auth_attempts"/.test(sql)) {
        const row: Row = {
          id: `r${++seq}`,
          tenantId: p[0],
          userId: p[1],
          kind: p[2],
          outcome: p[3],
          source: p[4],
          createdAt: new Date(),
        };
        rows.push(row);
        return [{ id: row.id }];
      }
      if (/^\s*DELETE FROM "auth_attempts"\s+WHERE "id" = \$1/.test(sql)) {
        const i = rows.findIndex((r) => r.id === p[0] && r.tenantId === p[1]);
        if (i >= 0) rows.splice(i, 1);
        return [[], i >= 0 ? 1 : 0];
      }
      if (/^\s*SELECT/.test(sql) && /FROM "auth_attempts" a/.test(sql)) {
        const [tenantId, userId, kind, source, since, floor, wide] = p;
        const mine = rows.filter(
          (r) =>
            r.tenantId === tenantId &&
            r.userId === userId &&
            r.kind === kind &&
            r.createdAt > (floor ?? since),
        );
        const failed = mine.filter((r) => r.outcome === 'failed');
        const inWindow = failed.filter((r) => r.createdAt > since);
        return [
          {
            account_failures: String(inWindow.length),
            source_failures: String(inWindow.filter((r) => r.source === source).length),
            wide_source_failures: String(
              wide ? inWindow.filter((r) => like(wide).test(r.source)).length : 0,
            ),
            hard_failures: String(failed.length),
            last_refusal: null,
          },
        ];
      }
      throw new Error(`fake store: unexpected statement ${sql}`);
    }

    const dataSource = {
      query: (sql: string, p?: any[]) => run(sql, p),
      transaction: async (fn: (em: any) => Promise<unknown>) =>
        fn({ query: (sql: string, p?: any[]) => run(sql, p) }),
    };
    return { rows, dataSource };
  }

  function limiterOn(s: ReturnType<typeof store>) {
    return new AuthAttemptLimiter(
      s.dataSource as any,
      { findOne: async () => account } as any,
      { logEvent: async () => undefined } as any,
    );
  }

  it(`${BURST} concurrent wrong passwords from one source reach at most ${ATTEMPT_LIMITS.login.perSource} password comparisons`, async () => {
    const s = store();
    const limiter = limiterOn(s);
    jest.spyOn(limiter, 'burnTime').mockResolvedValue(undefined);
    let compared = 0;
    const iam = {
      validateUser: jest.fn(async () => {
        compared++;
        await new Promise((r) => setTimeout(r, 2));
        return null;
      }),
    };
    const strategy = new LocalStrategy(iam as any, limiter);

    const results = await Promise.allSettled(
      Array.from({ length: BURST }, () =>
        strategy.validate({ ip: '203.0.113.9' }, 'a@example.test', 'wrong'),
      ),
    );

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // May be fewer — a burst that lands all at once can see itself over the
    // cap and be refused whole. Never more.
    expect(compared).toBeLessThanOrEqual(ATTEMPT_LIMITS.login.perSource);
    // Exactly the compared attempts are on record as failures; the refused
    // ones were released (and leave at most one rate-limited trace).
    expect(s.rows.filter((r) => r.outcome === 'failed')).toHaveLength(compared);
  });

  it('not vacuous: one after another, exactly the cap is compared and the rest refused', async () => {
    const s = store();
    const limiter = limiterOn(s);
    jest.spyOn(limiter, 'burnTime').mockResolvedValue(undefined);
    let compared = 0;
    const strategy = new LocalStrategy(
      { validateUser: async () => (compared++, null) } as any,
      limiter,
    );
    for (let i = 0; i < ATTEMPT_LIMITS.login.perSource + 5; i++) {
      await strategy
        .validate({ ip: '203.0.113.9' }, 'a@example.test', 'wrong')
        .catch(() => undefined);
    }
    expect(compared).toBe(ATTEMPT_LIMITS.login.perSource);
  });

  it('a correct password leaves no failure behind, and a clean source still gets in after the burst', async () => {
    const s = store();
    const limiter = limiterOn(s);
    jest.spyOn(limiter, 'burnTime').mockResolvedValue(undefined);
    const user = { id: 'u1', tenantId: 't1' };
    const iam = {
      validateUser: jest.fn(async (_e: string, pw: string) => (pw === 'right' ? user : null)),
    };
    const strategy = new LocalStrategy(iam as any, limiter);

    await Promise.allSettled(
      Array.from({ length: BURST }, () =>
        strategy.validate({ ip: '203.0.113.9' }, 'a@example.test', 'wrong'),
      ),
    );
    const before = s.rows.filter((r) => r.outcome === 'failed').length;

    await expect(
      strategy.validate({ ip: '198.51.100.7' }, 'a@example.test', 'right'),
    ).resolves.toBe(user);
    expect(s.rows.filter((r) => r.outcome === 'failed')).toHaveLength(before);
    expect(s.rows.some((r) => r.source === '198.51.100.7')).toBe(false);
  });

  it(`${BURST} concurrent wrong MFA codes from one source reach at most ${ATTEMPT_LIMITS.mfa.perSource} code comparisons`, async () => {
    const s = store();
    const limiter = limiterOn(s);
    const iam = { mfaChallengeSubject: () => 'u1' };
    const interceptor = new MfaAttemptLimitInterceptor(limiter, iam as any);
    let compared = 0;
    const ctx = {
      getHandler: () => IamController.prototype.verifyMfaLogin,
      switchToHttp: () => ({
        getRequest: () => ({ ip: '203.0.113.9', body: { temporaryToken: 'tt' } }),
      }),
    } as any;
    const handler = {
      handle: () =>
        defer(async () => {
          compared++;
          await new Promise((r) => setTimeout(r, 2));
          throw new UnauthorizedException('Invalid MFA token');
        }),
    };

    const results = await Promise.allSettled(
      Array.from({ length: BURST }, () =>
        lastValueFrom(interceptor.intercept(ctx, handler as any)),
      ),
    );

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(compared).toBeLessThanOrEqual(ATTEMPT_LIMITS.mfa.perSource);
    expect(s.rows.filter((r) => r.outcome === 'failed')).toHaveLength(compared);
  });
});
