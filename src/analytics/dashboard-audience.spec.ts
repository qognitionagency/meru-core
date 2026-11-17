import { PackDashboardService } from './pack-dashboard.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { CrmAccessService } from '../crm/crm-access.service';

/**
 * Found while fixing Anton's #8 (trends): the dashboard routes beside it were
 * thought to filter, but `GET /analytics/dashboards/:key` resolves with
 * `portal: null`, so the portal filter never applied, and `GET
 * /analytics/dashboards` takes the portal from a client-controlled query
 * parameter. The shipped immigration pack's `firm_home` is `portal: staff`
 * with no role restriction, so a `client` token could resolve the firm-wide
 * staff dashboard (active cases, grant rate). Same rule as trends now: a
 * caller who is not tenant staff sees client-portal dashboards only, whatever
 * portal they asked for. Staff behaviour is unchanged.
 */
const CLIENT_ACTOR = { id: 'client-1', roles: ['client'], email: 'c@example.test' };
const STAFF_ACTOR = { id: 'staff-1', roles: ['staff'] };

describe('PackDashboardService — non-staff callers see client-portal dashboards only', () => {
  function build() {
    const ui = {
      dashboardsFor: jest.fn<Promise<unknown[]>, any[]>(async () => []),
      dashboardFor: jest.fn<Promise<unknown>, any[]>(async () => ({
        key: 'd',
        widgets: [],
      })),
    };
    const packs = { list: jest.fn(async () => []) };
    const service = new PackDashboardService(
      { createQueryBuilder: jest.fn() } as any,
      ui as any,
      packs as any,
      new RuleEvaluatorService(),
      new CrmAccessService(),
    );
    return { service, ui };
  }
  const client = { roles: ['client'], modules: null, portal: null };

  it('resolve: forces the client portal for a client, even with no portal given', async () => {
    const { service, ui } = build();
    await service.resolve('t1', 'immigration', 'firm_home', client, CLIENT_ACTOR);
    expect(ui.dashboardFor).toHaveBeenCalledWith(
      'immigration',
      'firm_home',
      expect.objectContaining({ portal: 'client' }),
    );
  });

  it('list: ignores a client asking for the staff portal', async () => {
    const { service, ui } = build();
    await service.list('immigration', { ...client, portal: 'staff' as any });
    expect(ui.dashboardsFor).toHaveBeenCalledWith(
      'immigration',
      expect.objectContaining({ portal: 'client' }),
    );
  });

  it('staff keep the portal they asked for, including none', async () => {
    const { service, ui } = build();
    const staff = { roles: ['staff'], modules: null, portal: null };
    await service.resolve('t1', 'immigration', 'firm_home', staff, STAFF_ACTOR);
    await service.list('immigration', { ...staff, portal: 'admin' as any });
    expect(ui.dashboardFor.mock.calls[0][2]).toEqual(staff);
    expect(ui.dashboardsFor.mock.calls[0][1]).toEqual({ ...staff, portal: 'admin' });
  });
});
