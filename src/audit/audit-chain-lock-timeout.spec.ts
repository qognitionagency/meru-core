import { ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditAction } from './entities/audit-log.entity';

/**
 * Owen's gate on the per-tenant audit chain lock: with no `lock_timeout`
 * anywhere in `src`, one stalled lock holder made every audit write in that
 * tenant wait indefinitely — strict IAM changes and `runAsGod` included —
 * where they should fail closed.
 *
 * Now the transaction bounds itself with `SET LOCAL` (transaction-scoped, so
 * nothing outlives the commit or leaks to the next user of the connection)
 * before it asks for the lock, and a lock or statement timeout surfaces as a
 * 503, the "dependency unavailable, retry" answer the strict callers already
 * give.
 */
describe('AuditService.logEvent — bounded wait on the chain lock', () => {
  const T = '11111111-1111-4111-8111-111111111111';
  const event = {
    tenantId: T,
    userId: 'u1',
    action: AuditAction.UPDATE,
    entityType: 'user',
    entityId: 'u1',
  };

  function build(lockError?: unknown) {
    const sql: string[] = [];
    const txRepo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((x: any) => x),
      save: jest.fn(async (x: any) => ({ id: 'saved', ...x })),
    };
    const em = {
      query: jest.fn(async (q: string) => {
        sql.push(q);
        if (lockError && /pg_advisory_xact_lock/.test(q)) throw lockError;
        return [];
      }),
      getRepository: () => txRepo,
    };
    const repo = { manager: { transaction: async (fn: any) => fn(em) } };
    return { service: new AuditService(repo as any), sql, txRepo };
  }

  it('sets a transaction-local lock_timeout and statement_timeout before taking the lock', async () => {
    const { service, sql } = build();

    await service.logEvent(event);

    const lockAt = sql.findIndex((q) => /pg_advisory_xact_lock/.test(q));
    const lockTimeoutAt = sql.findIndex((q) => /^SET LOCAL lock_timeout = '\d+s'$/.test(q));
    const stmtTimeoutAt = sql.findIndex((q) => /^SET LOCAL statement_timeout = '\d+s'$/.test(q));
    expect(lockTimeoutAt).toBeGreaterThanOrEqual(0);
    expect(stmtTimeoutAt).toBeGreaterThanOrEqual(0);
    expect(lockTimeoutAt).toBeLessThan(lockAt);
    expect(stmtTimeoutAt).toBeLessThan(lockAt);
  });

  it.each([
    ['lock_timeout (55P03)', '55P03'],
    ['statement_timeout (57014)', '57014'],
  ])('a %s is a 503, and nothing is written', async (_l, code) => {
    const { service, txRepo } = build(
      Object.assign(new Error('canceling statement due to lock timeout'), { code }),
    );

    await expect(service.logEvent(event)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(txRepo.save).not.toHaveBeenCalled();
  });

  it('any other lock error still propagates as itself', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: '08006' });
    const { service } = build(boom);

    await expect(service.logEvent(event)).rejects.toBe(boom);
  });
});
