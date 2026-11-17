import { AnalyticsController } from './analytics.controller';

// Owen's gate r6: pins the only production entry into PackDashboardService.resolve.
// Mutating the controller to hand resolve() a staff actor passed the whole suite.
describe('GET /analytics/dashboards/:key — the actor comes from the token', () => {
  it('passes id, roles and email from req.user as the fifth argument', async () => {
    const resolve = jest.fn(async () => ({}));
    const audience = { roles: ['client'], modules: null, portal: 'client' };
    const controller = new AnalyticsController(
      {} as any,
      { resolve } as any,
      { audienceFor: jest.fn(async () => audience) } as any,
    );

    await controller.getPackDashboard(
      { user: { id: 'u-1', email: 'c@example.test', tenantId: 't1', roles: ['client'] }, tenantVertical: 'immigration' } as any,
      'client_home',
    );

    expect(resolve).toHaveBeenCalledWith('t1', 'immigration', 'client_home', audience, {
      id: 'u-1',
      roles: ['client'],
      email: 'c@example.test',
    });
  });
});
