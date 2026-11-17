import { AuditService } from './audit.service';
import { AuditAction, AuditSeverity } from './entities/audit-log.entity';

/**
 * ADR 0023 D13/D15: the facts that make a strict-change row readable live in
 * `context` — `changeId` ties a request to its outcome, `event` says which
 * phase the row is, `reason` says why a change did not take effect, and
 * `impersonatedBy` names the operator behind an impersonated action. The CSV
 * and XML exports dropped `context` entirely, so an exported trail could not
 * answer "did this change happen" or "who really did it". JSON already carried
 * the whole row.
 */

const T = '11111111-1111-4111-8111-111111111111';

function row(context: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    tenantId: T,
    timestamp: new Date('2026-11-17T10:00:00.000Z'),
    userId: 'user-1',
    action: AuditAction.UPDATE,
    entityType: 'user',
    entityId: 'user-2',
    severity: AuditSeverity.WARNING,
    description: 'Role change for x did not take effect',
    context,
    ...extra,
  };
}

function serviceReturning(rows: unknown[]) {
  const repo = {
    findAndCount: jest.fn(async () => [rows, rows.length]),
  };
  return new AuditService(repo as any);
}

const FROM = new Date('2026-11-01');
const TO = new Date('2026-11-30');

describe('AuditService.exportLogs — context fields', () => {
  const context = {
    event: 'role.change.not_applied',
    changeId: '9b2c7c1e-1d1a-4f0e-9a51-3f1f3f0b6a10',
    reason: 'no_row_updated',
    impersonatedBy: 'operator-7',
    ipAddress: '203.0.113.9',
  };

  it('CSV carries changeId, event, reason and impersonatedBy as their own columns', async () => {
    const { data } = await serviceReturning([row(context)]).exportLogs(
      T, FROM, TO, 'csv',
    );
    const [header, line] = data.split('\r\n');
    const cols = header.split(',');
    const cells = line.split(',');
    const at = (name: string) => cells[cols.indexOf(name)];

    expect(cols).toEqual(
      expect.arrayContaining(['changeId', 'event', 'reason', 'impersonatedBy']),
    );
    expect(at('changeId')).toBe(context.changeId);
    expect(at('event')).toBe(context.event);
    expect(at('reason')).toBe(context.reason);
    expect(at('impersonatedBy')).toBe(context.impersonatedBy);
  });

  it('CSV leaves the cells empty, not "undefined", for a row with no context', async () => {
    const { data } = await serviceReturning([row({})]).exportLogs(
      T, FROM, TO, 'csv',
    );
    expect(data).not.toContain('undefined');
    expect(data).not.toContain('null');
  });

  it('CSV keeps the existing columns in their existing order, so a reconciling spreadsheet does not shift', async () => {
    const { data } = await serviceReturning([row(context)]).exportLogs(
      T, FROM, TO, 'csv',
    );
    expect(data.split('\r\n')[0]).toBe(
      'timestamp,userId,action,entityType,entityId,severity,description,' +
        'changeId,event,reason,impersonatedBy',
    );
  });

  it('XML carries the four context fields', async () => {
    const { data } = await serviceReturning([row(context)]).exportLogs(
      T, FROM, TO, 'xml',
    );
    expect(data).toContain(`<changeId>${context.changeId}</changeId>`);
    expect(data).toContain(`<event>${context.event}</event>`);
    expect(data).toContain(`<reason>${context.reason}</reason>`);
    expect(data).toContain(
      `<impersonatedBy>${context.impersonatedBy}</impersonatedBy>`,
    );
  });

  it('XML escapes values, so a reason containing markup cannot forge an element', async () => {
    const { data } = await serviceReturning([
      row({ ...context, reason: '</reason><impersonatedBy>nobody' }),
    ]).exportLogs(T, FROM, TO, 'xml');

    expect(data).toContain(
      '<reason>&lt;/reason&gt;&lt;impersonatedBy&gt;nobody</reason>',
    );
    expect(data.match(/<impersonatedBy>/g)).toHaveLength(1);
  });

  it('XML omits nothing silently: an absent field is an empty element', async () => {
    const { data } = await serviceReturning([row({})]).exportLogs(
      T, FROM, TO, 'xml',
    );
    expect(data).toContain('<changeId></changeId>');
    expect(data).toContain('<impersonatedBy></impersonatedBy>');
    expect(data).not.toContain('undefined');
  });

  it('a structured reason is written as JSON rather than "[object Object]"', async () => {
    const reason = { verificationMethod: 'video_call', ticketRef: 'T-1' };
    const svc = serviceReturning([row({ ...context, reason })]);

    const csv = (await svc.exportLogs(T, FROM, TO, 'csv')).data;
    const xml = (await svc.exportLogs(T, FROM, TO, 'xml')).data;

    expect(csv).not.toContain('[object Object]');
    expect(xml).not.toContain('[object Object]');
    expect(xml).toContain('&quot;verificationMethod&quot;:&quot;video_call&quot;');
  });
});
