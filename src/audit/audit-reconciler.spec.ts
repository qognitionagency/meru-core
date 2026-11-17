import * as fs from 'fs';
import * as path from 'path';
import { TenantContext } from '../core/tenancy/tenant-context';
import {
  APPLIED_EVENT_BY_FAMILY,
  AuditReconcilerService,
  AuditStateReader,
  reconcileAfterMinutes,
} from './audit-reconciler.service';
import { AuditAction, AuditLog, AuditSeverity } from './entities/audit-log.entity';

/**
 * ADR 0023 D15 item 2 (Anton, AC.C2): every `<x>.requested` row older than N
 * minutes with no outcome sharing its `changeId` is closed by a
 * `<x>.reconciled` row whose `context.outcome` is `applied`, `not_applied` or
 * `indeterminate` — and the reconciler NEVER assumes `applied`.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-17T12:00:00.000Z');
const OLD = new Date('2026-11-17T11:00:00.000Z'); // 60 min before NOW

let seq = 0;
function auditRow(
  tenantId: string,
  event: string,
  changeId: string,
  extra: Partial<AuditLog> = {},
  context: Record<string, unknown> = {},
): AuditLog {
  return {
    id: `row-${++seq}`,
    tenantId,
    timestamp: OLD,
    userId: 'actor-1',
    action: AuditAction.UPDATE,
    entityType: 'user',
    entityId: `user-of-${tenantId.slice(0, 1)}`,
    severity: AuditSeverity.INFO,
    context: { event, changeId, ...context },
    ...extra,
  } as unknown as AuditLog;
}

/**
 * An in-memory store with the reconciler's three reads. `leaky` makes
 * `findByChangeIds` and `findLaterRequests` ignore the tenant (and the
 * latter its `excludeChangeId`) — a store bug the
 * service must survive, because the tenant predicate is checked twice.
 */
function store(rows: AuditLog[], opts: { leaky?: boolean } = {}) {
  const bypassSeen: boolean[] = [];
  const ev = (r: AuditLog) => (r.context as any)?.event as string | undefined;
  const cid = (r: AuditLog) => (r.context as any)?.changeId as string | undefined;
  const s = {
    bypassSeen,
    pageStaleRequests: jest.fn(
      async (cutoff: Date, after: { timestamp: Date; id: string } | null, limit: number) => {
        bypassSeen.push(TenantContext.isBypassed());
        return rows
          .filter((r) => ev(r)?.endsWith('.requested') && cid(r))
          .filter((r) => r.timestamp < cutoff)
          .sort((x, y) => x.timestamp.getTime() - y.timestamp.getTime() || x.id.localeCompare(y.id))
          .filter(
            (r) =>
              !after ||
              r.timestamp > after.timestamp ||
              (r.timestamp.getTime() === after.timestamp.getTime() && r.id > after.id),
          )
          .slice(0, limit);
      },
    ),
    findByChangeIds: jest.fn(async (tenantId: string, ids: string[]) => {
      bypassSeen.push(TenantContext.isBypassed());
      return rows.filter(
        (r) => (opts.leaky || r.tenantId === tenantId) && ids.includes(cid(r)!),
      );
    }),
    findLaterRequests: jest.fn(
      async (tenantId: string, entityType: string, entityId: string, after: Date, excludeChangeId: string) => {
        bypassSeen.push(TenantContext.isBypassed());
        return rows.filter(
          (r) =>
            (opts.leaky || r.tenantId === tenantId) &&
            r.entityType === entityType &&
            r.entityId === entityId &&
            ev(r)?.endsWith('.requested') &&
            r.timestamp > after &&
            (opts.leaky || cid(r) !== excludeChangeId),
        );
      },
    ),
  };
  return s;
}

function build(
  rows: AuditLog[],
  opts: { leaky?: boolean; readers?: AuditStateReader[]; failWrite?: boolean } = {},
) {
  const s = store(rows, opts);
  const written: any[] = [];
  const audit = {
    logEvent: jest.fn(async (dto: any) => {
      if (opts.failWrite) throw new Error('audit store down');
      written.push(dto);
      rows.push(
        auditRow(dto.tenantId, dto.context.event, dto.context.changeId, {
          timestamp: NOW,
          entityType: dto.entityType,
          entityId: dto.entityId,
        }),
      );
      return dto;
    }),
  };
  const service = new AuditReconcilerService(s as any, audit as any, opts.readers);
  const alert = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
  return { service, store: s, audit, written, alert };
}

const run = (service: AuditReconcilerService) =>
  service.reconcile({ now: NOW, afterMinutes: 15 });

describe('AuditReconcilerService.reconcile — what counts as answered', () => {
  it('leaves a request alone when its applied row exists', async () => {
    const { service, written } = build([
      auditRow(A, 'role.change.requested', 'c1'),
      auditRow(A, 'role.changed', 'c1'),
    ]);
    await run(service);
    expect(written).toHaveLength(0);
  });

  it('leaves a request alone when its not_applied row exists', async () => {
    const { service, written } = build([
      auditRow(A, 'mfa.disable.requested', 'c1'),
      auditRow(A, 'mfa.disable.not_applied', 'c1'),
    ]);
    await run(service);
    expect(written).toHaveLength(0);
  });

  it('leaves a request alone when it has already been reconciled (idempotent across runs)', async () => {
    const rows = [auditRow(A, 'mfa.enable.requested', 'c1')];
    const { service, written } = build(rows);
    await run(service);
    await run(service);
    expect(written).toHaveLength(1);
  });

  it('in a two-step call, one step answered does not answer the other', async () => {
    // updateUser with role AND status: both requests share the changeId. The
    // process died after role.changed was written.
    const { service, written } = build([
      auditRow(A, 'role.change.requested', 'c1'),
      auditRow(A, 'status.change.requested', 'c1'),
      auditRow(A, 'role.changed', 'c1'),
    ]);
    await run(service);
    expect(written).toHaveLength(1);
    expect(written[0].context.event).toBe('status.change.reconciled');
  });

  it('in a two-step call, both applied rows answer both requests', async () => {
    const { service, written } = build([
      auditRow(A, 'role.change.requested', 'c1'),
      auditRow(A, 'status.change.requested', 'c1'),
      auditRow(A, 'role.changed', 'c1'),
      auditRow(A, 'status.changed', 'c1'),
    ]);
    await run(service);
    expect(written).toHaveLength(0);
  });

  it('a single-step call in a family it has no applied name for is answered by any outcome row', async () => {
    const { service, written } = build([
      auditRow(A, 'mfa.reset.requested', 'c1'),
      auditRow(A, 'mfa.reset', 'c1'),
    ]);
    await run(service);
    expect(written).toHaveLength(0);
  });

  it('asks only for requests older than the cutoff', async () => {
    const { service, store: s } = build([]);
    await service.reconcile({ now: NOW, afterMinutes: 15 });
    expect(s.pageStaleRequests.mock.calls[0][0]).toEqual(
      new Date(NOW.getTime() - 15 * 60_000),
    );
  });
});

describe('AuditReconcilerService.reconcile — the outcome it writes', () => {
  it('writes <family>.reconciled in the request tenant, same changeId and entity, as the system actor', async () => {
    const { service, written } = build([
      auditRow(A, 'role.change.requested', 'c1', {}, {
        requested: { field: 'role', from: 'staff', to: 'firm_admin' },
      }),
    ]);
    await run(service);

    expect(written).toHaveLength(1);
    const dto = written[0];
    expect(dto.tenantId).toBe(A);
    expect(dto.userId).toBe('system');
    expect(dto.entityType).toBe('user');
    expect(dto.entityId).toBe('user-of-a');
    expect(dto.context).toEqual(
      expect.objectContaining({
        event: 'role.change.reconciled',
        changeId: 'c1',
        requestedEvent: 'role.change.requested',
        requested: { field: 'role', from: 'staff', to: 'firm_admin' },
      }),
    );
  });

  it('never states a change: no beforeState/afterState, and never copies impersonatedBy', async () => {
    const { service, written } = build([
      auditRow(A, 'role.change.requested', 'c1', {}, { impersonatedBy: 'op-1' }),
    ]);
    await run(service);
    expect(written[0].beforeState).toBeUndefined();
    expect(written[0].afterState).toBeUndefined();
    expect(written[0].context.impersonatedBy).toBeUndefined();
  });

  it('with no state reader for the family: indeterminate, never applied', async () => {
    const { service, written } = build([auditRow(A, 'mfa.enable.requested', 'c1')]);
    await run(service);
    expect(written[0].context.outcome).toBe('indeterminate');
    expect(written[0].context.outcomeReason).toBe('no_state_reader');
  });

  it('a later request for the same entity makes it indeterminate, even if the reader says applied', async () => {
    const reader: AuditStateReader = {
      families: ['role.change'],
      read: jest.fn(async () => 'applied' as const),
    };
    const { service, written } = build(
      [
        auditRow(A, 'role.change.requested', 'c1'),
        auditRow(A, 'role.change.requested', 'c2', {
          timestamp: new Date(OLD.getTime() + 1000),
        }),
        auditRow(A, 'role.changed', 'c2'),
      ],
      { readers: [reader] },
    );
    await run(service);
    expect(written).toHaveLength(1);
    expect(written[0].context.outcome).toBe('indeterminate');
    expect(written[0].context.outcomeReason).toBe('later_request');
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('a second step of the SAME call is not a "later request"', async () => {
    const reader: AuditStateReader = {
      families: ['role.change', 'status.change'],
      read: jest.fn(async () => 'not_applied' as const),
    };
    const { service, written } = build(
      [
        auditRow(A, 'role.change.requested', 'c1'),
        auditRow(A, 'status.change.requested', 'c1', {
          timestamp: new Date(OLD.getTime() + 1),
        }),
      ],
      { leaky: true, readers: [reader] },
    );
    await run(service);
    expect(written.map((w) => w.context.outcome)).toEqual([
      'not_applied',
      'not_applied',
    ]);
  });

  it('applied only when the reader says the current state matches', async () => {
    const reader: AuditStateReader = {
      families: ['role.change'],
      read: jest.fn(async () => 'applied' as const),
    };
    const { service, written } = build(
      [auditRow(A, 'role.change.requested', 'c1')],
      { readers: [reader] },
    );
    await run(service);
    expect(written[0].context.outcome).toBe('applied');
  });

  it('a reader that throws or cannot tell yields indeterminate, never applied', async () => {
    const throwing: AuditStateReader = {
      families: ['role.change'],
      read: jest.fn(async () => {
        throw new Error('users table unreadable');
      }),
    };
    const unsure: AuditStateReader = {
      families: ['status.change'],
      read: jest.fn(async () => 'unknown' as const),
    };
    const { service, written } = build(
      [
        auditRow(A, 'role.change.requested', 'c1'),
        auditRow(A, 'status.change.requested', 'c2', { entityId: 'other-user' }),
      ],
      { readers: [throwing, unsure] },
    );
    await run(service);
    expect(written.map((w) => w.context.outcome)).toEqual([
      'indeterminate',
      'indeterminate',
    ]);
  });

  it('an entity that is gone is indeterminate', async () => {
    const reader: AuditStateReader = {
      families: ['role.change'],
      read: jest.fn(async () => 'entity_gone' as const),
    };
    const { service, written } = build(
      [auditRow(A, 'role.change.requested', 'c1')],
      { readers: [reader] },
    );
    await run(service);
    expect(written[0].context.outcome).toBe('indeterminate');
    expect(written[0].context.outcomeReason).toBe('entity_gone');
  });

  it('raises an alert (error log) for every reconciled row, naming no email', async () => {
    const { service, alert } = build([
      auditRow(A, 'role.change.requested', 'c1', {
        description: 'Role change requested for person@example.com',
        userEmail: 'person@example.com',
      } as any),
    ]);
    await run(service);
    expect(alert).toHaveBeenCalledTimes(1);
    const message = String(alert.mock.calls[0][0]);
    expect(message).toContain('c1');
    expect(message).toContain('indeterminate');
    expect(message).not.toContain('@example.com');
  });

  it('a failed write is reported and the run continues; the request stays open for the next run', async () => {
    const { service } = build([auditRow(A, 'role.change.requested', 'c1')], {
      failWrite: true,
    });
    const result = await run(service);
    expect(result.reconciled).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toEqual(
      expect.objectContaining({ tenantId: A, changeId: 'c1' }),
    );
  });
});

describe('AuditReconcilerService.reconcile — tenancy', () => {
  it('runs every read under runAsSystem (it crosses tenants by design)', async () => {
    const { service, store: s } = build([auditRow(A, 'role.change.requested', 'c1')]);
    await run(service);
    expect(s.bypassSeen.length).toBeGreaterThan(0);
    expect(s.bypassSeen.every(Boolean)).toBe(true);
  });

  it("neither tenant's request is answered by, or reconciled against, the other tenant's rows", async () => {
    // Same changeId and same entity id in both tenants: B's applied row must
    // not close A's request, and B's later request must not make A's
    // indeterminate. The store is leaky on purpose.
    const reader: AuditStateReader = {
      families: ['role.change'],
      read: jest.fn(async ({ tenantId }) =>
        tenantId === A ? ('not_applied' as const) : ('applied' as const),
      ),
    };
    const { service, written } = build(
      [
        auditRow(A, 'role.change.requested', 'shared', { entityId: 'same-id' }),
        auditRow(B, 'role.changed', 'shared', { entityId: 'same-id' }),
        auditRow(B, 'role.change.requested', 'later-in-b', {
          entityId: 'same-id',
          timestamp: new Date(OLD.getTime() + 5000),
        }),
        auditRow(B, 'role.changed', 'later-in-b', { entityId: 'same-id' }),
      ],
      { leaky: true, readers: [reader] },
    );
    await run(service);

    expect(written).toHaveLength(1);
    expect(written[0].tenantId).toBe(A);
    expect(written[0].context.outcome).toBe('not_applied');
    expect(reader.read).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: A, entityId: 'same-id' }),
    );
  });
});

describe('AuditReconcilerService.reconcile — paging', () => {
  it('walks every page, so answered requests cannot crowd out an unanswered one', async () => {
    const rows: AuditLog[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push(auditRow(A, 'role.change.requested', `ok-${i}`));
      rows.push(auditRow(A, 'role.changed', `ok-${i}`));
    }
    rows.push(auditRow(A, 'role.change.requested', 'open', {
      timestamp: new Date(OLD.getTime() + 1),
    }));
    const { service, written } = build(rows);
    const result = await service.reconcile({ now: NOW, afterMinutes: 15, pageSize: 2 });

    expect(written.map((w) => w.context.changeId)).toEqual(['open']);
    expect(result.complete).toBe(true);
    expect(result.examined).toBe(6);
  });
});

describe('reconcileAfterMinutes', () => {
  const saved = process.env.AUDIT_RECONCILE_AFTER_MINUTES;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUDIT_RECONCILE_AFTER_MINUTES;
    else process.env.AUDIT_RECONCILE_AFTER_MINUTES = saved;
  });

  it('defaults to 15 (ADR 0023 D15 proposal, Anton to set)', () => {
    delete process.env.AUDIT_RECONCILE_AFTER_MINUTES;
    expect(reconcileAfterMinutes()).toBe(15);
  });

  it('reads AUDIT_RECONCILE_AFTER_MINUTES', () => {
    process.env.AUDIT_RECONCILE_AFTER_MINUTES = '30';
    expect(reconcileAfterMinutes()).toBe(30);
  });

  it('refuses a value that is not a positive integer rather than reconciling in-flight changes', () => {
    for (const bad of ['0', '-5', 'abc', '1.5', '']) {
      process.env.AUDIT_RECONCILE_AFTER_MINUTES = bad;
      expect(reconcileAfterMinutes()).toBe(15);
    }
  });
});

/**
 * Drift guard. The reconciler must know each multi-step family's applied
 * event name, or a role+status change would be reconciled every day although
 * both steps applied. Those names are written in `IamService.auditedChange`
 * steps; this reads them from the source, the way
 * `capabilities-regulators.spec.ts` reads adapters.
 */
describe('APPLIED_EVENT_BY_FAMILY matches IamService.auditedChange steps', () => {
  it('has exactly the requested → applied pairs iam.service.ts declares', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'iam', 'iam.service.ts'),
      'utf8',
    );
    const pairs: Record<string, string> = {};
    const re =
      /requested:\s*\{\s*event:\s*'([^']+)\.requested'[\s\S]*?applied:\s*\{\s*event:\s*'([^']+)'/g;
    for (const m of src.matchAll(re)) pairs[m[1]] = m[2];

    expect(Object.keys(pairs).length).toBeGreaterThan(0);
    expect(APPLIED_EVENT_BY_FAMILY).toEqual(pairs);
  });
});
