import { AuditService, auditChainLockKey } from './audit.service';
import { AuditAction, AuditLog } from './entities/audit-log.entity';

/**
 * ADR 0023 D15 item 3 (Anton, AC.C3): the audit hash chain must not fork.
 *
 * `logEvent` used to read the tenant's chain tip with a plain `findOne` and
 * then `save` on a separate connection, with no lock between them. Two
 * concurrent writes in one tenant could both read the same tip, both link to
 * it, and `verifyChain` would then report legitimate data as tampered.
 *
 * The fix is one transaction holding `pg_advisory_xact_lock` on a per-tenant
 * key, taken BEFORE the tip is read, with the tip read and the insert on that
 * same transaction. These specs pin all three properties, and the last one
 * proves the property itself: concurrent writers against a store that honours
 * the lock produce a chain `verifyChain` accepts.
 */

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function event(tenantId: string, n = 0) {
  return {
    tenantId,
    userId: `user-${n}`,
    action: AuditAction.UPDATE,
    entityType: 'user',
    entityId: `entity-${n}`,
  };
}

/**
 * A recording fake of the TypeORM surface `logEvent` touches. `calls` is the
 * order things happened in, across the injected repository and the
 * transaction's manager, so a spec can say "lock before tip".
 */
function recordingRepo(tip: Partial<AuditLog> | null = null) {
  const calls: string[] = [];
  const txRepo = {
    findOne: jest.fn(async () => {
      calls.push('tx.findOne');
      return tip;
    }),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => {
      calls.push('tx.save');
      return { id: 'saved', ...x };
    }),
  };
  const em = {
    // <any, any[]>: the lock call's bound parameters are read at index 1.
    query: jest.fn<any, any[]>(async (sql: string) => {
      calls.push(
        /pg_advisory_xact_lock/.test(sql)
          ? 'tx.lock'
          : /^SET LOCAL /.test(sql)
            ? 'tx.timeout'
            : 'tx.query',
      );
      return [];
    }),
    getRepository: jest.fn(() => txRepo),
  };
  const repo = {
    findOne: jest.fn(async () => {
      calls.push('repo.findOne');
      return tip;
    }),
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => {
      calls.push('repo.save');
      return x;
    }),
    manager: {
      transaction: jest.fn(async (fn: (m: any) => Promise<unknown>) => {
        calls.push('tx.begin');
        const result = await fn(em);
        calls.push('tx.commit');
        return result;
      }),
    },
  };
  return { repo, em, txRepo, calls };
}

describe('AuditService.logEvent — per-tenant chain lock (D15 item 3)', () => {
  it('takes the advisory lock before reading the chain tip, then inserts, all inside one transaction', async () => {
    const { repo, calls } = recordingRepo();
    await new AuditService(repo as any).logEvent(event(T1));

    expect(calls).toEqual([
      'tx.begin',
      'tx.timeout', // lock_timeout   (audit-chain-lock-timeout.spec.ts)
      'tx.timeout', // statement_timeout
      'tx.lock',
      'tx.findOne',
      'tx.save',
      'tx.commit',
    ]);
    expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
  });

  it('never reads the tip or writes through the injected repository, which would be a second connection', async () => {
    const { repo } = recordingRepo();
    await new AuditService(repo as any).logEvent(event(T1));

    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('locks on the key derived from the row tenant, as a bound parameter', async () => {
    const { repo, em } = recordingRepo();
    await new AuditService(repo as any).logEvent(event(T1));

    const lockCall = em.query.mock.calls.find(([sql]) =>
      /pg_advisory_xact_lock/.test(sql),
    );
    expect(lockCall).toBeDefined();
    // The tenant id never enters the SQL text.
    expect(lockCall![0]).not.toContain(T1);
    expect(lockCall![1]).toEqual([auditChainLockKey(T1)]);
  });

  it('reads the tip of the row tenant only (tenantId predicate, not RLS alone)', async () => {
    const { repo, txRepo } = recordingRepo();
    await new AuditService(repo as any).logEvent(event(T1));

    expect(txRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: T1 } }),
    );
  });

  it('links to the tip it read under the lock', async () => {
    const tip = {
      chainHash: 'a'.repeat(64),
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    };
    const { repo, txRepo } = recordingRepo(tip);
    await new AuditService(repo as any).logEvent(event(T1));

    expect(txRepo.save.mock.calls[0][0].previousChainHash).toBe(tip.chainHash);
  });

  it('stamps the row strictly after the tip, so verifyChain orders it after the row it links to', async () => {
    // A tip stamped in the future relative to this writer (clock skew, or a
    // writer that computed its timestamp before waiting on the lock) must not
    // produce a row that sorts BEFORE the row it links to.
    const tip = {
      chainHash: 'b'.repeat(64),
      timestamp: new Date(Date.now() + 60_000),
    };
    const { repo, txRepo } = recordingRepo(tip);
    await new AuditService(repo as any).logEvent(event(T1));

    const saved = txRepo.save.mock.calls[0][0];
    expect(saved.timestamp.getTime()).toBe(tip.timestamp.getTime() + 1);
  });

  it('fails closed: if the lock cannot be taken, nothing is written and the error reaches the caller', async () => {
    const { repo, em, txRepo } = recordingRepo();
    em.query.mockRejectedValueOnce(new Error('canceling statement due to lock timeout'));

    await expect(
      new AuditService(repo as any).logEvent(event(T1)),
    ).rejects.toThrow('lock timeout');
    expect(txRepo.findOne).not.toHaveBeenCalled();
    expect(txRepo.save).not.toHaveBeenCalled();
  });
});

describe('auditChainLockKey', () => {
  it('is deterministic per tenant and differs between tenants', () => {
    expect(auditChainLockKey(T1)).toBe(auditChainLockKey(T1));
    expect(auditChainLockKey(T1)).not.toBe(auditChainLockKey(T2));
  });

  it('is a signed 64-bit integer, the argument type of pg_advisory_xact_lock(bigint)', () => {
    for (const t of [T1, T2]) {
      const key = BigInt(auditChainLockKey(t));
      expect(key).toBeGreaterThanOrEqual(-(2n ** 63n));
      expect(key).toBeLessThan(2n ** 63n);
    }
  });
});

/**
 * The property, not the mechanism: an in-memory store whose transactions
 * honour `pg_advisory_xact_lock` the way Postgres does (block until the holder
 * commits). Many concurrent writers in one tenant must yield a chain
 * `verifyChain` reports as valid.
 */
describe('AuditService — concurrent writers in one tenant', () => {
  function lockingStore() {
    const rows: AuditLog[] = [];
    let seq = 0;
    const held = new Map<string, Promise<void>>();

    const tipOf = (tenantId: string) =>
      rows
        .filter((r) => r.tenantId === tenantId)
        .sort(
          (a, b) =>
            b.timestamp.getTime() - a.timestamp.getTime() ||
            b.createdAt.getTime() - a.createdAt.getTime(),
        )[0] ?? null;

    const txRepo = {
      // Yield before answering, as a real round trip would: without the lock,
      // every writer reads the same tip.
      findOne: async ({ where }: any) => {
        await new Promise((r) => setImmediate(r));
        return tipOf(where.tenantId);
      },
      create: (x: any) => x,
      save: async (x: any) => {
        await new Promise((r) => setImmediate(r));
        const row = { ...x, id: `row-${++seq}`, createdAt: new Date(seq) };
        rows.push(row);
        return row;
      },
    };

    const repo = {
      create: (x: any) => x,
      find: async ({ where }: any) =>
        rows
          .filter((r) => r.tenantId === where.tenantId)
          .sort(
            (a, b) =>
              a.timestamp.getTime() - b.timestamp.getTime() ||
              a.createdAt.getTime() - b.createdAt.getTime(),
          ),
      manager: {
        transaction: async (fn: (m: any) => Promise<unknown>) => {
          const mine: string[] = [];
          let releaseAll = () => {};
          const em = {
            query: async (sql: string, params: unknown[]) => {
              if (!/pg_advisory_xact_lock/.test(sql)) return [];
              const key = String(params[0]);
              while (held.has(key)) await held.get(key);
              let release!: () => void;
              held.set(key, new Promise<void>((r) => (release = r)));
              mine.push(key);
              const prev = releaseAll;
              releaseAll = () => {
                prev();
                held.delete(key);
                release();
              };
              return [];
            },
            getRepository: () => txRepo,
          };
          try {
            return await fn(em);
          } finally {
            // Transaction-scoped: released at commit or rollback.
            releaseAll();
          }
        },
      },
    };
    return { repo, rows };
  }

  it('twenty concurrent writes produce one unbroken chain', async () => {
    const { repo, rows } = lockingStore();
    const service = new AuditService(repo as any);

    await Promise.all(
      Array.from({ length: 20 }, (_, n) => service.logEvent(event(T1, n))),
    );

    expect(rows).toHaveLength(20);
    const result = await service.verifyChain(T1);
    expect(result.status).toBe('valid');
    expect(result.valid).toBe(20);
  });

  it('writers in different tenants do not wait on each other and each chain is intact', async () => {
    const { repo } = lockingStore();
    const service = new AuditService(repo as any);

    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        service.logEvent(event(n % 2 ? T1 : T2, n)),
      ),
    );

    expect((await service.verifyChain(T1)).status).toBe('valid');
    expect((await service.verifyChain(T2)).status).toBe('valid');
  });
});
