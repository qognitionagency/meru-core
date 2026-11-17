import { PackDashboardService } from './pack-dashboard.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { CrmAccessService } from '../crm/crm-access.service';
import type { Actor } from '../common/access';

const immigration = require('../../packages/config-packs/verticals/immigration.json');
const grc = require('../../packages/config-packs/verticals/grc.json');

/**
 * Seventh within-tenant leak (Owen's gate, 2026-11-17).
 *
 * `scan` filtered on tenant and type only, so a `client` token resolving the
 * immigration pack's `client_home` received the firm's most recently updated
 * cases in the `my_cases` list — other applicants' names, statuses and due
 * dates. Every widget kind that reads records (list, count, chart, kpi) and
 * the trend route now confine a caller without tenant-wide reach to the
 * records `CrmAccessService.applyScope` says they own — the same rule as
 * `/crm/entities/:id` — and staff are unchanged.
 *
 * The query-builder stub below interprets the predicates the service adds by
 * their bound parameters: `tenantId`, `type`, and the two CrmAccessService
 * binds (`crmActorId`, `crmActorEmail`). It does not know which rule is "right";
 * it only applies whatever narrowing the service asked for.
 */
type Row = Record<string, any>;

const now = new Date('2026-11-10T00:00:00Z');
const rows: Row[] = [
  // Two applicants in one tenant, both worked by the same staff member.
  { id: 'case-A', tenantId: 't1', type: 'case', firstName: 'Ann', lastName: 'Caller', subjectEmail: 'ann@example.test', assignedTo: 'staff-1', status: 'open', verticalAttributes: { outcome: 'granted' }, createdAt: now, updatedAt: new Date('2026-11-09T00:00:00Z') },
  { id: 'case-B', tenantId: 't1', type: 'case', firstName: 'Bea', lastName: 'Other', subjectEmail: 'bea@example.test', assignedTo: 'staff-1', status: 'lodged', verticalAttributes: { outcome: 'refused' }, createdAt: now, updatedAt: new Date('2026-11-10T00:00:00Z') },
  { id: 'case-C', tenantId: 't1', type: 'case', firstName: 'Cy', lastName: 'Third', subjectEmail: 'cy@example.test', assignedTo: 'staff-2', status: 'lodged', verticalAttributes: { outcome: 'refused' }, createdAt: now, updatedAt: new Date('2026-11-08T00:00:00Z') },
  // Another tenant's row, which the tenant predicate must always drop.
  { id: 'case-X', tenantId: 't2', type: 'case', firstName: 'Xen', lastName: 'Foreign', subjectEmail: 'ann@example.test', assignedTo: 'staff-9', status: 'open', verticalAttributes: {}, createdAt: now, updatedAt: now },
  // GRC records for the stacking check.
  { id: 'm-1', tenantId: 't1', type: 'screening_match', status: 'blocked', verticalAttributes: {}, assignedTo: 'staff-1', createdAt: now, updatedAt: now },
  { id: 'm-2', tenantId: 't1', type: 'screening_match', status: 'blocked', verticalAttributes: {}, assignedTo: 'staff-2', createdAt: now, updatedAt: now },
];

function fakeEntities() {
  const count = jest.fn(async ({ where }: any) =>
    rows.filter((r) => r.tenantId === where.tenantId && r.type === where.type).length,
  );
  const createQueryBuilder = jest.fn(() => {
    const params: Record<string, any> = {};
    const qb: any = {
      where: (_sql: string, p: Record<string, any> = {}) => (Object.assign(params, p), qb),
      andWhere: (_sql: string, p: Record<string, any> = {}) => (Object.assign(params, p), qb),
      orderBy: () => qb,
      take: () => qb,
      getMany: async () =>
        rows
          .filter((r) => r.tenantId === params.tenantId && r.type === params.type)
          .filter((r) => {
            if (!('crmActorId' in params)) return true;
            const byAssignee = r.assignedTo === params.crmActorId;
            const bySubject =
              'crmActorEmail' in params &&
              String(r.subjectEmail ?? '').trim().toLowerCase() === params.crmActorEmail;
            return byAssignee || bySubject;
          })
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    };
    return qb;
  });
  return { count, createQueryBuilder };
}

/** A client-portal dashboard with every record-reading widget kind on it. */
const everyKind = {
  key: 'client_everything',
  label: 'Client everything',
  portal: 'client',
  roles: ['client'],
  widgets: [
    { key: 'w_list', label: 'list', type: 'list', source: 'case', limit: 50 },
    { key: 'w_count_all', label: 'count', type: 'count', source: 'case' },
    { key: 'w_count_when', label: 'count when', type: 'count', source: 'case', when: { '==': [{ var: 'status' }, 'lodged'] } },
    { key: 'w_chart', label: 'chart', type: 'chart', source: 'case' },
    { key: 'w_kpi', label: 'kpi', type: 'kpi', source: 'case_total' },
  ],
};
const kpis = [
  { key: 'case_total', label: 'Cases', unit: 'count', metric: { source: 'case', aggregate: 'count' } },
];

function build(dashboard: any, pack: any = immigration) {
  const entities = fakeEntities();
  const ui = {
    dashboardFor: jest.fn(async () => dashboard),
    dashboardsFor: jest.fn(async () => [dashboard]),
  };
  const packs = {
    list: jest.fn(async (_v: string, key: string) =>
      key === 'kpis' ? kpis : key === 'documentTypes' ? pack.documentTypes ?? [] : [],
    ),
  };
  const service = new PackDashboardService(
    entities as any,
    ui as any,
    packs as any,
    new RuleEvaluatorService(),
    new CrmAccessService(),
  );
  return { service, entities };
}

const ann: Actor = { id: 'user-ann', roles: ['client'], email: 'Ann@Example.test ' };
const bea: Actor = { id: 'user-bea', roles: ['client'], email: 'bea@example.test' };
const staff: Actor = { id: 'staff-1', roles: ['staff'], email: 'staff1@firm.test' };
const audience = (a: Actor) => ({ roles: a.roles, modules: null, portal: null });
const widget = (out: any, key: string) => out.widgets.find((w: any) => w.key === key);
const ids = (w: any) => (w.items ?? []).map((i: any) => i.id);

describe('PackDashboardService — client own-scope on every record-reading widget', () => {
  it("the shipped client_home my_cases list returns only the caller's own case", async () => {
    const clientHome = immigration.dashboards.find((d: any) => d.key === 'client_home');
    const { service } = build(clientHome);

    const forAnn = await service.resolve('t1', 'immigration', 'client_home', audience(ann), ann);
    const forBea = await service.resolve('t1', 'immigration', 'client_home', audience(bea), bea);

    expect(ids(widget(forAnn, 'my_cases'))).toEqual(['case-A']);
    expect(ids(widget(forBea, 'my_cases'))).toEqual(['case-B']);
  });

  it('list, count, chart and kpi all see one record for client A and never case-B', async () => {
    const { service, entities } = build(everyKind);
    const out = await service.resolve('t1', 'immigration', 'client_everything', audience(ann), ann);

    expect(ids(widget(out, 'w_list'))).toEqual(['case-A']);
    expect(widget(out, 'w_count_all').value).toBe(1);
    expect(widget(out, 'w_count_when').value).toBe(0); // case-A is open, not lodged
    expect(widget(out, 'w_chart').items).toEqual([{ bucket: 'open', count: 1 }]);
    expect(widget(out, 'w_kpi').value).toBe(1);
    // The unfiltered count must not take the firm-wide database count.
    expect(entities.count).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain('case-B');
    expect(JSON.stringify(out)).not.toContain('Bea');
  });

  it('a client with no email on the token sees nothing, not the firm', async () => {
    const noEmail: Actor = { id: 'user-q', roles: ['client'] };
    const { service } = build(everyKind);
    const out = await service.resolve('t1', 'immigration', 'client_everything', audience(noEmail), noEmail);
    expect(ids(widget(out, 'w_list'))).toEqual([]);
    expect(widget(out, 'w_count_all').value).toBe(0);
  });

  it('a role this file has never heard of is confined like a client', async () => {
    const partner: Actor = { id: 'p-1', roles: ['partner'], email: 'bea@example.test' };
    const { service } = build(everyKind);
    const out = await service.resolve('t1', 'immigration', 'client_everything', audience(partner), partner);
    expect(ids(widget(out, 'w_list'))).toEqual(['case-B']);
  });

  it('trend: a client trending a KPI shown on their dashboard is computed over their records only', async () => {
    const { service } = build(everyKind);
    const out = await service.trend(
      't1',
      'immigration',
      { kpiKey: 'case_total', interval: 'month', from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
      audience(ann),
      ann,
    );
    expect(out.scanned).toBe(1);
    expect(out.buckets.map((b) => b.value)).toEqual([1]);
  });

  it('staff are unchanged: the whole tenant, and the unfiltered count goes to the database', async () => {
    const { service, entities } = build(everyKind);
    const out = await service.resolve('t1', 'immigration', 'client_everything', audience(staff), staff);
    expect(ids(widget(out, 'w_list'))).toEqual(['case-B', 'case-A', 'case-C']);
    expect(widget(out, 'w_count_all').value).toBe(3);
    expect(entities.count).toHaveBeenCalled();
    expect(widget(out, 'w_kpi').value).toBe(3);

    const trend = await service.trend(
      't1',
      'immigration',
      { kpiKey: 'case_total', interval: 'month', from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
      audience(staff),
      staff,
    );
    expect(trend.scanned).toBe(3);
  });

  it('GRC staff are unchanged (stacking): compliance_home lists every escalated match in the tenant', async () => {
    const compliance = grc.dashboards.find((d: any) => d.key === 'compliance_home');
    const { service } = build(compliance, grc);
    const out = await service.resolve('t1', 'grc', 'compliance_home', audience(staff), staff);
    expect(ids(widget(out, 'escalated_matches')).sort()).toEqual(['m-1', 'm-2']);
  });
});
