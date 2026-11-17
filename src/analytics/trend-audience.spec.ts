import { NotFoundException } from '@nestjs/common';
import { PackDashboardService } from './pack-dashboard.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { CrmAccessService } from '../crm/crm-access.service';
import { AnalyticsController } from './analytics.controller';

/**
 * `GET /analytics/trends/:kpiKey` had no audience filter (Anton, 2026-11-17,
 * #8). It scans the whole tenant, so a `client` token read firm-wide KPI
 * series — active cases, grant rate, on GRC `sar_filed` — while the two
 * dashboard routes beside it filter by portal, role and entitlement.
 *
 * KPIs carry no audience of their own; dashboards do. So:
 *  - tenant staff (staff, firm_admin) may trend any pack KPI, as before;
 *  - anyone else may trend a KPI only if a CLIENT-portal dashboard visible to
 *    them (roles + entitlement, via PackUiService) shows it as a `kpi`
 *    widget. A pack author who put that figure in front of clients decided
 *    they see it. Otherwise 404, never 403, the same rule as dashboards.
 */
const CLIENT_ACTOR = { id: 'client-1', roles: ['client'], email: 'c@example.test' };
const STAFF_ACTOR = { id: 'staff-1', roles: ['staff'] };

describe('PackDashboardService.trend — audience', () => {
  const kpis = [
    { key: 'grant_rate', label: 'Grant rate', metric: { source: 'case', aggregate: 'count' } },
    { key: 'my_progress', label: 'Progress', metric: { source: 'case', aggregate: 'count' } },
  ];

  function build(clientDashboards: any[] = []) {
    const qb: any = {
      where: () => qb,
      andWhere: () => qb,
      orderBy: () => qb,
      take: () => qb,
      getMany: async () => [],
    };
    const entities = { createQueryBuilder: jest.fn(() => qb) };
    const ui = { dashboardsFor: jest.fn(async () => clientDashboards), dashboardFor: jest.fn() };
    const packs = { list: jest.fn(async (_v: string, k: string) => (k === 'kpis' ? kpis : [])) };
    const service = new PackDashboardService(
      entities as any,
      ui as any,
      packs as any,
      new RuleEvaluatorService(),
      new CrmAccessService(),
    );
    return { service, ui, entities };
  }

  const client = { roles: ['client'], modules: null, portal: null };
  const staff = { roles: ['staff'], modules: null, portal: null };
  const opts = { kpiKey: 'grant_rate' };

  it('refuses a client a KPI no client dashboard shows — 404, and scans nothing', async () => {
    const b = build([]);

    await expect(b.service.trend('t1', 'immigration', opts, client, CLIENT_ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(b.entities.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('asks for client-portal dashboards for a non-staff caller, whatever portal they claimed', async () => {
    const b = build([]);
    await b.service
      .trend('t1', 'immigration', opts, { ...client, portal: 'staff' as any }, CLIENT_ACTOR)
      .catch(() => undefined);

    expect(b.ui.dashboardsFor).toHaveBeenCalledWith(
      'immigration',
      expect.objectContaining({ roles: ['client'], portal: 'client' }),
    );
  });

  it('refuses a client when the KPI is on a visible dashboard but not as a kpi widget', async () => {
    const b = build([{ key: 'c', widgets: [{ key: 'w', type: 'count', source: 'grant_rate' }] }]);

    await expect(b.service.trend('t1', 'immigration', opts, client, CLIENT_ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('allows a client a KPI that a client dashboard visible to them shows', async () => {
    const b = build([{ key: 'c', widgets: [{ key: 'w', type: 'kpi', source: 'my_progress' }] }]);

    await expect(
      b.service.trend('t1', 'immigration', { kpiKey: 'my_progress' }, client, CLIENT_ACTOR),
    ).resolves.toMatchObject({ kpi: 'my_progress' });
  });

  it('keeps tenant staff on every pack KPI without consulting dashboards', async () => {
    const b = build([]);

    await expect(b.service.trend('t1', 'immigration', opts, staff, STAFF_ACTOR)).resolves.toMatchObject({
      kpi: 'grant_rate',
    });
    expect(b.ui.dashboardsFor).not.toHaveBeenCalled();
  });

  it('the controller derives the audience from the token, not the query', async () => {
    const trend = jest.fn(async () => ({}));
    const audienceFor = jest.fn(async () => client);
    const controller = new AnalyticsController(
      {} as any,
      { trend } as any,
      { audienceFor } as any,
    );

    await controller.getTrend(
      { user: { id: 'u-1', email: 'c@example.test', tenantId: 't1', roles: ['client'] }, tenantVertical: 'immigration' } as any,
      'grant_rate',
      {} as any,
    );

    expect(audienceFor).toHaveBeenCalledWith('t1', ['client'], null);
    expect(trend).toHaveBeenCalledWith(
      't1',
      'immigration',
      expect.objectContaining({ kpiKey: 'grant_rate' }),
      client,
      // The actor the series is own-scoped to, also from the token.
      { id: 'u-1', roles: ['client'], email: 'c@example.test' },
    );
  });
});
