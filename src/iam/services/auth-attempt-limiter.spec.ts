import {
  AuthAttemptLimiter,
  ATTEMPT_LIMITS,
  MFA_HARD_CAP,
  AUTH_ATTEMPT_RETENTION_DAYS,
  attemptSource,
  attemptSourceBlock,
} from './auth-attempt-limiter.service';
import { TenantContext } from '../../core/tenancy/tenant-context';
import { AuditAction, AuditSeverity } from '../../audit/entities/audit-log.entity';

/**
 * Attempt limiting for `POST /auth/login`, `/auth/mfa/verify` and
 * `/auth/mfa/disable`, redesigned after Owen's gate (2026-11-17):
 *
 * - keyed on account AND source, so one attacker cannot lock an account for
 *   everyone (the per-account lock was a denial of service with no undo);
 * - an account-wide backstop that tightens every source to one failure
 *   rather than locking the account — and, once engaged, counts a source by
 *   its IPv4 /24 or IPv6 /48 rather than by one address;
 * - an MFA hard cap: past it, MFA is refused from every source until an
 *   operator unlock or a password reset (Anton, second gate);
 * - an audited operator unlock, after which only newer failures count;
 * - a refused attempt on a locked source leaves a rate-limited trace;
 * - storage in `auth_attempts`, a plain table outside the audit hash chain,
 *   so an unauthenticated burst never queues on the tenant's chain lock;
 * - an attempt is written BEFORE the secret is checked (`begin`), so
 *   concurrent attempts see each other (Anton, second gate).
 *
 * The fake data source answers the count query from canned numbers and
 * records every statement of every transaction, so the tests pin both the
 * decision and what was asked of the database. The SQL itself was run
 * against a real Postgres out of band (see the limiter's header); a mock
 * cannot tell `varchar = uuid` from a working predicate.
 */
describe('AuthAttemptLimiter', () => {
  const account = { id: 'u1', tenantId: 'tenant-a', email: 'a@example.test' };
  const SRC_A = '203.0.113.9';
  const SRC_B = '198.51.100.7';

  type Tx = {
    statements: Array<{ sql: string; params?: any[] }>;
    tenant?: string;
    bypass?: string;
  };

  function build(o: {
    counts?: {
      source?: number;
      wide?: number;
      account?: number;
      hard?: number;
      lastRefusal?: Date | null;
    };
    readFails?: boolean;
    writeFails?: boolean;
    deleteFails?: boolean;
    auditFails?: boolean;
    pruneBatches?: number[];
  } = {}) {
    const txs: Tx[] = [];
    let rowSeq = 0;
    const prune = [...(o.pruneBatches ?? [])];
    const DB_NOW = '2026-11-17T08:30:00.123456Z';
    const dataSource = {
      // Only the database clock read is allowed outside a bounded transaction.
      query: jest.fn(async (sql: string) => {
        if (/^\s*SELECT to_char\(now\(\) AT TIME ZONE 'UTC'/.test(sql)) {
          return [{ at: DB_NOW }];
        }
        throw new Error('every statement must run inside a bounded transaction');
      }),
      transaction: jest.fn(async (fn: (em: any) => Promise<unknown>) => {
        const tx: Tx = {
          statements: [],
          tenant: TenantContext.getTenantId(),
          bypass: TenantContext.getBypass()?.reason,
        };
        txs.push(tx);
        const em = {
          query: jest.fn(async (sql: string, params?: any[]) => {
            tx.statements.push({ sql, params });
            if (/^\s*SET LOCAL/.test(sql)) return [];
            if (/^\s*SELECT/.test(sql)) {
              if (o.readFails) throw new Error('db down');
              return [
                {
                  source_failures: String(o.counts?.source ?? 0),
                  wide_source_failures: String(o.counts?.wide ?? o.counts?.source ?? 0),
                  account_failures: String(o.counts?.account ?? 0),
                  hard_failures: String(o.counts?.hard ?? o.counts?.account ?? 0),
                  last_refusal: o.counts?.lastRefusal ?? null,
                },
              ];
            }
            if (/^\s*INSERT/.test(sql)) {
              if (o.writeFails) throw new Error('write timeout');
              return [{ id: `row-${++rowSeq}` }];
            }
            if (/^\s*DELETE/.test(sql)) {
              if (/"createdAt" </.test(sql)) {
                // pg returns [rows, affected] for a DELETE through TypeORM.
                return [[], prune.shift() ?? 0];
              }
              if (o.deleteFails) throw new Error('delete timeout');
              return [[], 1];
            }
            throw new Error(`unexpected statement: ${sql}`);
          }),
        };
        return fn(em);
      }),
    };
    const audited: any[] = [];
    const auditService = {
      logEvent: jest.fn(async (e: any) => {
        if (o.auditFails) throw new Error('audit down');
        audited.push(e);
        return e;
      }),
    };
    const userRepo = { findOne: jest.fn(async () => account) };
    const limiter = new AuthAttemptLimiter(
      dataSource as any,
      userRepo as any,
      auditService as any,
    );
    const sqlOf = (re: RegExp) =>
      txs.filter((t) => t.statements.some((s) => re.test(s.sql)));
    const reads = () => sqlOf(/^\s*SELECT/);
    const inserts = () => sqlOf(/^\s*INSERT/);
    const deletes = () => sqlOf(/^\s*DELETE/);
    const last = (t: Tx) => t.statements[t.statements.length - 1];
    return {
      DB_NOW,
      limiter,
      txs,
      reads,
      inserts,
      deletes,
      last,
      audited,
      auditService,
      dataSource,
    };
  }

  describe('keyed on account and source', () => {
    it('locks one source at the per-source cap and leaves another source open', async () => {
      const L = ATTEMPT_LIMITS.login;
      const atCap = await build({ counts: { source: L.perSource, account: L.perSource } })
        .limiter.standing(account, 'login', SRC_A);
      const fresh = await build({ counts: { source: 0, account: L.perSource } })
        .limiter.standing(account, 'login', SRC_B);

      expect(atCap.locked).toBe(true);
      expect(fresh.locked).toBe(false);
    });

    it('below the backstop, a source one short of its cap is open', async () => {
      const L = ATTEMPT_LIMITS.login;
      const s = await build({ counts: { source: L.perSource - 1, account: L.accountBackstop - 1 } })
        .limiter.standing(account, 'login', SRC_A);
      expect(s).toMatchObject({ locked: false, backstop: false });
    });

    it('at the account-wide backstop, any source with a failure is refused — a clean source still is not', async () => {
      const L = ATTEMPT_LIMITS.login;
      const dirty = await build({ counts: { source: 1, account: L.accountBackstop } })
        .limiter.standing(account, 'login', SRC_A);
      const clean = await build({ counts: { source: 0, wide: 0, account: L.accountBackstop } })
        .limiter.standing(account, 'login', SRC_B);

      expect(dirty).toMatchObject({ locked: true, backstop: true });
      // The legitimate user, from their own address, with the right password,
      // is never locked out by somebody else's guesses.
      expect(clean).toMatchObject({ locked: false, backstop: true });
    });

    it('MFA uses the same keying, tighter, with a backstop of 10', async () => {
      const M = ATTEMPT_LIMITS.mfa;
      expect(M.perSource).toBeLessThanOrEqual(5);
      expect(M.perSource).toBeLessThan(ATTEMPT_LIMITS.login.perSource);
      expect(M.accountBackstop).toBe(10);
      expect((await build({ counts: { source: M.perSource, hard: 0 } }).limiter.standing(account, 'mfa', SRC_A)).locked).toBe(true);
      expect((await build({ counts: { source: 0, account: M.accountBackstop - 1, hard: 0 } }).limiter.standing(account, 'mfa', SRC_B)).locked).toBe(false);
      expect((await build({ counts: { source: 1, account: M.accountBackstop, hard: 0 } }).limiter.standing(account, 'mfa', SRC_A)).locked).toBe(true);
    });

    it("reads one account's attempts of one kind, by source, bound to the account's own tenant", async () => {
      const b = build();
      await b.limiter.standing(account, 'login', SRC_A);

      expect(b.reads()).toHaveLength(1);
      const tx = b.reads()[0];
      const { sql, params } = b.last(tx);
      expect(tx.tenant).toBe('tenant-a');
      expect(sql).toContain('"auth_attempts"');
      // Both predicates, separately: the audit_logs one alone would satisfy a
      // bare '"tenantId" = $1' if the auth_attempts one were dropped.
      expect(sql).toMatch(/a\."tenantId" = \$1\s/);
      expect(sql).toContain('l."tenantId" = $1::text');
      expect(params!.slice(0, 4)).toEqual(['tenant-a', 'u1', 'login', SRC_A]);
      const since: Date = params![4];
      expect(Date.now() - since.getTime()).toBeCloseTo(ATTEMPT_LIMITS.login.windowMs, -3);
    });

    it('bounds the count read with the same lock and statement timeouts as a write (Anton)', async () => {
      const b = build();
      await b.limiter.standing(account, 'login', SRC_A);

      const statements = b.reads()[0].statements.map((s) => s.sql);
      expect(statements[0]).toBe(`SET LOCAL lock_timeout = '500ms'`);
      expect(statements[1]).toBe(`SET LOCAL statement_timeout = '2s'`);
      expect(statements[2]).toMatch(/^\s*SELECT/);
      expect(b.dataSource.query).not.toHaveBeenCalled();
    });

    it('takes the unlock boundary from the unlockedAt the unlock row carries, as timestamptz, never from the timezone-less "timestamp" column', async () => {
      const b = build();
      await b.limiter.standing(account, 'login', SRC_A);
      const { sql } = b.last(b.reads()[0]);

      expect(sql).toContain('auth.login.unlocked');
      expect(sql).toContain('"audit_logs"');
      expect(sql).toContain(`MAX((l.context ->> 'unlockedAt')::timestamptz)`);
      expect(sql).not.toMatch(/MAX\(l\."timestamp"\)/);
    });

    it('has no LEAST(…, now()) cap: measured, it never stopped a future-skewed boundary, and the boundary is now on the database clock', async () => {
      const b = build();
      await b.limiter.standing(account, 'login', SRC_A);
      await b.limiter.standing(account, 'mfa', SRC_A);
      for (const tx of b.reads()) {
        expect(b.last(tx).sql).not.toMatch(/LEAST\(/);
        expect(b.last(tx).sql).toMatch(/GREATEST\(\$6::timestamptz, COALESCE\(/);
      }
    });

    it('the operator unlock covers MFA too; MFA additionally resets at a password reset', async () => {
      const b = build();
      await b.limiter.standing(account, 'login', SRC_A);
      await b.limiter.standing(account, 'mfa', SRC_A);
      const [login, mfa] = b.reads().map((t) => b.last(t).sql);

      expect(mfa).toContain('auth.login.unlocked');
      expect(mfa).toContain(`'token_redeemed'`);
      expect(mfa).toContain(`MAX((l.context ->> 'credentialSetAt')::timestamptz)`);
      expect(login).not.toContain('credentialSetAt');
    });
  });

  describe('begin: the attempt is written before the secret is checked', () => {
    it('inserts a failed row first, then counts with it included, and reports the standing of the attempts BEFORE this one', async () => {
      const L = ATTEMPT_LIMITS.login;
      // The store now holds this attempt too: perSource rows from SRC_A.
      const b = build({ counts: { source: L.perSource, account: L.perSource } });
      const ticket = await b.limiter.begin(account, 'login', SRC_A);

      expect(b.txs.map((t) => (b.inserts().includes(t) ? 'insert' : 'read'))).toEqual([
        'insert',
        'read',
      ]);
      const ins = b.last(b.inserts()[0]);
      expect(ins.sql).toContain('INSERT INTO "auth_attempts"');
      expect(ins.sql).toContain('RETURNING "id"');
      expect(ins.params).toEqual(['tenant-a', 'u1', 'login', 'failed', SRC_A]);
      // perSource rows including this one = perSource - 1 before it: open.
      expect(ticket.standing).toMatchObject({ locked: false, sourceFailures: L.perSource - 1 });
    });

    it('the attempt that would be one past the cap is locked', async () => {
      const L = ATTEMPT_LIMITS.login;
      const b = build({ counts: { source: L.perSource + 1, account: L.perSource + 1 } });
      expect((await b.limiter.begin(account, 'login', SRC_A)).standing.locked).toBe(true);
    });

    it('release deletes exactly the row begin wrote, in the account tenant, bounded', async () => {
      const b = build();
      const ticket = await b.limiter.begin(account, 'login', SRC_A);
      await b.limiter.release(ticket);

      expect(b.deletes()).toHaveLength(1);
      const tx = b.deletes()[0];
      expect(tx.tenant).toBe('tenant-a');
      expect(tx.statements[0].sql).toBe(`SET LOCAL lock_timeout = '500ms'`);
      expect(b.last(tx).sql).toMatch(/DELETE FROM "auth_attempts"\s+WHERE "id" = \$1 AND "tenantId" = \$2/);
      expect(b.last(tx).params).toEqual(['row-1', 'tenant-a']);
    });

    it('release is idempotent', async () => {
      const b = build();
      const ticket = await b.limiter.begin(account, 'login', SRC_A);
      await b.limiter.release(ticket);
      await b.limiter.release(ticket);
      expect(b.deletes()).toHaveLength(1);
    });

    it('a failed release is swallowed and logged — the stray row counts as one failure, never a 500', async () => {
      const b = build({ deleteFails: true });
      const ticket = await b.limiter.begin(account, 'login', SRC_A);
      await expect(b.limiter.release(ticket)).resolves.toBeUndefined();
    });

    it('refuse releases the attempt and leaves a refusal trace instead', async () => {
      const L = ATTEMPT_LIMITS.login;
      const b = build({ counts: { source: L.perSource + 1, account: L.perSource + 1 } });
      const ticket = await b.limiter.begin(account, 'login', SRC_A);
      await b.limiter.refuse(ticket);

      expect(b.deletes()).toHaveLength(1);
      const refusals = b.inserts().filter((t) => b.last(t).params?.[3] === 'refused_locked');
      expect(refusals).toHaveLength(1);
    });

    it('an unwritable attempt is counted in-process, and a released one stops counting', async () => {
      const b = build({ writeFails: true });
      for (let i = 0; i < ATTEMPT_LIMITS.login.perSource; i++) {
        await expect(b.limiter.begin(account, 'login', SRC_A)).resolves.toBeDefined();
      }
      // The database never saw one of them; the source is locked anyway.
      expect((await b.limiter.standing(account, 'login', SRC_A)).locked).toBe(true);
      // And only that source: the account holder elsewhere is untouched.
      expect((await b.limiter.standing(account, 'login', SRC_B)).locked).toBe(false);

      const c = build({ writeFails: true });
      for (let i = 0; i < ATTEMPT_LIMITS.login.perSource; i++) {
        await c.limiter.release(await c.limiter.begin(account, 'login', SRC_A));
      }
      expect((await c.limiter.standing(account, 'login', SRC_A)).locked).toBe(false);
    });

    it('a count that cannot be read does not throw and degrades to what this process has seen', async () => {
      const ok = build({ readFails: true });
      const t = await ok.limiter.begin(account, 'login', SRC_A);
      expect(t.standing).toMatchObject({ locked: false, degraded: true, sourceFailures: 0 });

      const guessed = build({ readFails: true, writeFails: true });
      for (let i = 0; i < ATTEMPT_LIMITS.login.perSource; i++) {
        await guessed.limiter.begin(account, 'login', SRC_A);
      }
      expect((await guessed.limiter.begin(account, 'login', SRC_A)).standing.locked).toBe(true);
    });
  });

  describe('MFA hard cap (Anton): the password is already known', () => {
    it(`is ${MFA_HARD_CAP.failures} failures per account per 24 hours, from any source`, () => {
      expect(MFA_HARD_CAP).toEqual({ failures: 10, windowMs: 24 * 60 * 60 * 1000 });
    });

    it('refuses a clean source too once the account has reached the cap in 24h', async () => {
      const s = await build({ counts: { source: 0, wide: 0, account: 0, hard: MFA_HARD_CAP.failures } })
        .limiter.standing(account, 'mfa', SRC_B);
      expect(s).toMatchObject({ locked: true, hardLocked: true });
    });

    it('one short of the cap is not hard-locked', async () => {
      const s = await build({ counts: { source: 0, account: 0, hard: MFA_HARD_CAP.failures - 1 } })
        .limiter.standing(account, 'mfa', SRC_B);
      expect(s).toMatchObject({ locked: false, hardLocked: false });
    });

    it('login has no hard cap', async () => {
      const s = await build({ counts: { source: 0, account: 0, hard: 1000 } })
        .limiter.standing(account, 'login', SRC_B);
      expect(s).toMatchObject({ locked: false, hardLocked: false });
    });

    it('counts the hard cap over 24 hours: the read reaches back that far for MFA, and only the window for login', async () => {
      const b = build();
      await b.limiter.standing(account, 'mfa', SRC_A);
      await b.limiter.standing(account, 'login', SRC_A);
      const [mfa, login] = b.reads().map((t) => b.last(t).params!);

      expect(Date.now() - (mfa[5] as Date).getTime()).toBeCloseTo(MFA_HARD_CAP.windowMs, -3);
      expect(login[5]).toEqual(login[4]);
    });

    it('in-process, too: a store that cannot be read still reaches the cap', async () => {
      const b = build({ readFails: true, writeFails: true });
      const sources = Array.from({ length: MFA_HARD_CAP.failures }, (_, i) => `192.0.${i}.1`);
      for (const src of sources) await b.limiter.begin(account, 'mfa', src);
      const s = await b.limiter.standing(account, 'mfa', '198.18.0.1');
      expect(s).toMatchObject({ locked: true, hardLocked: true, degraded: true });
    });
  });

  describe('source block once the backstop is engaged (Anton)', () => {
    it.each([
      ['203.0.113.9', '203.0.113.'],
      ['2001:db8:1:2::/64', '2001:db8:1:'],
      ['2001:db8:0:0::/64', '2001:db8:0:'],
      ['unknown', null],
    ])('%p is counted in block %p', (src, block) => {
      expect(attemptSourceBlock(src)).toBe(block);
    });

    it('under the backstop, a fresh /64 inside a /48 that already failed is refused', async () => {
      const L = ATTEMPT_LIMITS.login;
      const s = await build({ counts: { source: 0, wide: 1, account: L.accountBackstop } })
        .limiter.standing(account, 'login', '2001:db8:1:ffff::/64');
      expect(s).toMatchObject({ locked: true, backstop: true });
    });

    it('below the backstop, the block is not what is counted', async () => {
      const s = await build({ counts: { source: 0, wide: 500, account: 0 } })
        .limiter.standing(account, 'login', SRC_A);
      expect(s.locked).toBe(false);
    });

    it('passes the block to the count as an escaped LIKE prefix', async () => {
      const b = build();
      await b.limiter.standing(account, 'login', '2001:db8:1:2::/64');
      await b.limiter.standing(account, 'login', 'odd_value%');
      const [v6, odd] = b.reads().map((t) => b.last(t));
      expect(v6.sql).toContain('a."source" LIKE $7');
      expect(v6.params![6]).toBe('2001:db8:1:%');
      expect(odd.params![6]).toBe('odd\\_value\\%');
    });

    it('in-process, the block is honoured too', async () => {
      const L = ATTEMPT_LIMITS.login;
      const b = build({ readFails: true, writeFails: true });
      for (let i = 0; i < L.accountBackstop; i++) {
        await b.limiter.begin(account, 'login', `198.51.${i}.7`);
      }
      await b.limiter.begin(account, 'login', '203.0.113.1');
      expect((await b.limiter.standing(account, 'login', '203.0.113.200')).locked).toBe(true);
      expect((await b.limiter.standing(account, 'login', '203.0.114.200')).locked).toBe(false);
    });
  });

  describe('boot self-test (Owen)', () => {
    const ENV = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = ENV;
    });

    it('selfTest runs the real count query once, against the nil UUID, and does not catch', async () => {
      const b = build({ readFails: true });
      await expect(b.limiter.selfTest()).rejects.toThrow('db down');

      expect(b.reads()).toHaveLength(1);
      const { sql, params } = b.last(b.reads()[0]);
      expect(sql).toContain('FROM "auth_attempts" a');
      expect(sql).toContain('"audit_logs"');
      expect(params!.slice(0, 2)).toEqual([
        '00000000-0000-0000-0000-000000000000',
        '00000000-0000-0000-0000-000000000000',
      ]);
      expect(b.reads()[0].tenant).toBe('00000000-0000-0000-0000-000000000000');
    });

    it('selfTest runs the MFA count query too — only it reads the password-reset boundary', async () => {
      const b = build();
      await b.limiter.selfTest();

      const reads = b.reads().map((tx: any) => b.last(tx));
      expect(reads.map((r: any) => r.params[2])).toEqual(['login', 'mfa']);
      expect(reads.filter((r: any) => r.sql.includes("'token_redeemed'"))).toHaveLength(1);
      expect(reads[1].sql).toContain("'token_redeemed'");
    });

    it('selfTest resolves when the query runs', async () => {
      await expect(build().limiter.selfTest()).resolves.toBeUndefined();
    });

    it('refuses to boot under NODE_ENV=production when the count query cannot run', async () => {
      process.env.NODE_ENV = 'production';
      await expect(build({ readFails: true }).limiter.onModuleInit()).rejects.toThrow(
        /attempt count query cannot run/,
      );
    });

    it('outside production it only logs', async () => {
      process.env.NODE_ENV = 'development';
      const b = build({ readFails: true });
      const log = jest.spyOn((b.limiter as any).logger, 'error').mockImplementation(() => undefined);
      await expect(b.limiter.onModuleInit()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/attempt count query cannot run/));
    });

    it('boots quietly when the query runs, in production', async () => {
      process.env.NODE_ENV = 'production';
      await expect(build().limiter.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('writes stay off the audit hash chain', () => {
    it('records an attempt in auth_attempts with a 500 ms lock bound, in the account tenant, and never takes the chain lock', async () => {
      const b = build();
      await b.limiter.begin(account, 'login', SRC_A);

      expect(b.auditService.logEvent).not.toHaveBeenCalled();
      expect(b.inserts()).toHaveLength(1);
      const w = b.inserts()[0];
      expect(w.tenant).toBe('tenant-a');
      expect(w.statements[0].sql).toBe(`SET LOCAL lock_timeout = '500ms'`);
      expect(w.statements.some((s) => /statement_timeout/.test(s.sql))).toBe(true);
      expect(w.statements.some((s) => /pg_advisory/.test(s.sql))).toBe(false);
      expect(b.last(w).sql).toContain('INSERT INTO "auth_attempts"');
    });
  });

  describe('a refused attempt leaves a trace, rate-limited', () => {
    const refusalRows = (b: ReturnType<typeof build>) =>
      b.inserts().filter((t) => b.last(t).params?.[3] === 'refused_locked');

    it('records refused_locked when none was recorded for this source in the last minute', async () => {
      const b = build();
      await b.limiter.recordRefusal(account, 'login', SRC_A, { lastRefusalAt: null } as any);
      expect(b.last(refusalRows(b)[0]).params).toEqual(['tenant-a', 'u1', 'login', 'refused_locked', SRC_A]);
    });

    it('records nothing when a refusal for this source is already newer than a minute', async () => {
      const b = build();
      await b.limiter.recordRefusal(account, 'login', SRC_A, {
        lastRefusalAt: new Date(Date.now() - 10_000),
      } as any);
      expect(refusalRows(b)).toHaveLength(0);
    });

    it('rate-limits in-process too, so an unreadable store cannot be flooded either', async () => {
      const b = build();
      await b.limiter.recordRefusal(account, 'login', SRC_A, { lastRefusalAt: null } as any);
      await b.limiter.recordRefusal(account, 'login', SRC_A, { lastRefusalAt: null } as any);
      expect(refusalRows(b)).toHaveLength(1);
    });

    it('swallows a failed refusal write', async () => {
      const b = build({ writeFails: true });
      await expect(
        b.limiter.recordRefusal(account, 'login', SRC_A, { lastRefusalAt: null } as any),
      ).resolves.toBeUndefined();
    });
  });

  describe('operator unlock', () => {
    const operator = { id: 'op-1', tenantId: 'platform', email: 'op@meru.test' };

    it('writes one strict auth.login.unlocked audit row naming the account, the operator, the reason and when', async () => {
      const b = build();
      await b.limiter.unlock(account, operator, 'Customer called, verified by phone');

      expect(b.audited).toHaveLength(1);
      expect(b.audited[0]).toMatchObject({
        tenantId: 'tenant-a',
        userId: 'op-1',
        userEmail: 'op@meru.test',
        action: AuditAction.UPDATE,
        entityType: 'user',
        entityId: 'u1',
        severity: AuditSeverity.CRITICAL,
        context: {
          event: 'auth.login.unlocked',
          reason: 'Customer called, verified by phone',
          operatorTenantId: 'platform',
          unlockedAt: expect.any(String),
        },
      });
    });

    it("takes unlockedAt from the DATABASE clock, in UTC to the microsecond — never Node's (Owen's ruling)", async () => {
      const b = build();
      await b.limiter.unlock(account, operator, 'Customer called, verified by phone');

      // The same clock that stamps auth_attempts."createdAt", so app/DB skew
      // cannot move the boundary; read before the audit row is written, so a
      // failure that lands after the read always counts.
      expect(b.dataSource.query).toHaveBeenCalledTimes(1);
      expect(b.dataSource.query.mock.invocationCallOrder[0]).toBeLessThan(
        b.auditService.logEvent.mock.invocationCallOrder[0],
      );
      expect(b.audited[0].context.unlockedAt).toBe(b.DB_NOW);
    });

    it('the count query filters on the very event name the unlock row writes', async () => {
      const b = build();
      await b.limiter.unlock(account, operator, 'r');
      await b.limiter.standing(account, 'login', SRC_A);
      await b.limiter.standing(account, 'mfa', SRC_A);

      const event = b.audited[0].context.event;
      expect(b.reads()).toHaveLength(2);
      for (const tx of b.reads()) {
        expect(b.last(tx).sql).toContain(`l.context ->> 'event' = '${event}'`);
      }
    });

    it('no clock, no unlock: a failed clock read writes nothing', async () => {
      const b = build();
      b.dataSource.query.mockRejectedValueOnce(new Error('db down'));
      await expect(b.limiter.unlock(account, operator, 'r')).rejects.toThrow('db down');
      expect(b.auditService.logEvent).not.toHaveBeenCalled();
    });

    it('propagates a failed audit write — no row, no unlock', async () => {
      await expect(
        build({ auditFails: true }).limiter.unlock(account, operator, 'r'),
      ).rejects.toThrow('audit down');
    });

    it("clears this process's unrecorded login AND mfa failures for the account", async () => {
      const b = build({ writeFails: true });
      for (let i = 0; i < MFA_HARD_CAP.failures; i++) {
        await b.limiter.begin(account, 'login', SRC_A);
        await b.limiter.begin(account, 'mfa', SRC_A);
      }
      await b.limiter.unlock(account, operator, 'r');
      expect((await b.limiter.standing(account, 'login', SRC_A)).locked).toBe(false);
      expect((await b.limiter.standing(account, 'mfa', SRC_A)).locked).toBe(false);
    });
  });

  describe('retention (proposal: 30 days)', () => {
    it(`keeps ${AUTH_ATTEMPT_RETENTION_DAYS} days — longer than the 24-hour MFA hard-cap window`, () => {
      expect(AUTH_ATTEMPT_RETENTION_DAYS).toBe(30);
      expect(AUTH_ATTEMPT_RETENTION_DAYS * 86_400_000).toBeGreaterThan(MFA_HARD_CAP.windowMs);
    });

    it('deletes rows older than the cutoff in bounded batches, under runAsSystem with a reason, until a short batch', async () => {
      const b = build({ pruneBatches: [5000, 5000, 12] });
      const now = new Date('2026-11-17T00:00:00Z');
      const res = await b.limiter.prune(now);

      expect(res).toMatchObject({ deleted: 10_012, batches: 3, complete: true });
      expect(res.cutoff).toBe('2026-10-18T00:00:00.000Z');
      expect(b.deletes()).toHaveLength(3);
      for (const tx of b.deletes()) {
        expect(tx.bypass).toMatch(/auth_attempts retention/);
        expect(tx.statements[0].sql).toMatch(/^SET LOCAL lock_timeout/);
        expect(b.last(tx).sql).toMatch(/WHERE a\."createdAt" < \$1\s+LIMIT \$2/);
        expect(b.last(tx).params).toEqual([new Date('2026-10-18T00:00:00Z'), 5000]);
      }
    });

    it('stops at its batch ceiling and says the run is incomplete', async () => {
      const b = build({ pruneBatches: Array(100).fill(5000) });
      const res = await b.limiter.prune(new Date());
      expect(res.complete).toBe(false);
      expect(res.batches).toBeLessThan(100);
    });
  });

  describe('attemptSource', () => {
    it.each([
      [undefined, 'unknown'],
      ['', 'unknown'],
      ['203.0.113.9', '203.0.113.9'],
      ['::ffff:203.0.113.9', '203.0.113.9'],
      // One /64 is one subscriber; rotating inside it is not a new source.
      ['2001:db8:1:2:aaaa::1', '2001:db8:1:2::/64'],
      ['2001:db8:1:2:bbbb:cccc:dddd:eeee', '2001:db8:1:2::/64'],
      ['2001:db8::1', '2001:db8:0:0::/64'],
      ['::1', '0:0:0:0::/64'],
    ])('%p → %p', (ip, want) => {
      expect(attemptSource(ip as any)).toBe(want);
    });
  });

  it('burnTime runs a real bcrypt compare, so an unknown or locked account costs the same as a wrong password', async () => {
    const { limiter } = build();
    const t = Date.now();
    await limiter.burnTime('whatever');
    expect(Date.now() - t).toBeGreaterThan(5);
  });
});
