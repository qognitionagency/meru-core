import { ServiceUnavailableException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { MeruErrorCode } from '../common/types';

/**
 * The saved-report and saved-widget builders pasted their stored
 * configuration into raw SQL (Anton, 2026-11-17, #2): report `columns`,
 * `filters[].field/operator`, `groupBy`, `sort` and `limit`, and widget
 * `SELECT ${fields} FROM ${table}`. The DTOs only check `@IsObject()`, so any
 * `staff` or `firm_admin` could save a report and execute arbitrary SQL as
 * `meru_app`. Every builder also took its tenant filter from
 * `parameters.tenantId` in the request body.
 *
 * Until a fixed, allow-listed query builder replaces them, execution is
 * refused outright: 503 `MER-SRV-0002`, before any report, widget or database
 * connection is touched, on every caller — the HTTP routes, export, and the
 * scheduled sweep (which goes through `exportReport`).
 */
describe('AnalyticsService — report/widget execution is disabled pending rewrite', () => {
  const T = 'tenant-1';

  function build() {
    const dataSource = { createQueryRunner: jest.fn() };
    const reportRepo = {
      findOne: jest.fn(async () => ({
        id: 'r1',
        tenantId: T,
        dataSource: 'crm',
        configuration: {
          columns: [{ field: '(SELECT "passwordHash" FROM users LIMIT 1)' }],
        },
      })),
    };
    const widgetRepo = {
      findOne: jest.fn(async () => ({
        id: 'w1',
        tenantId: T,
        configuration: { query: { fields: ['*'], table: 'users' } },
      })),
    };
    const executionRepo = { save: jest.fn() };
    const service = new AnalyticsService(
      reportRepo as any,
      executionRepo as any,
      widgetRepo as any,
      dataSource as any,
      {} as any, // searchService
      {} as any, // aiService
      { emit: jest.fn() } as any,
    );
    return { service, dataSource, reportRepo, widgetRepo, executionRepo };
  }

  async function expectDisabled(p: Promise<unknown>) {
    const err = await p.then(
      () => {
        throw new Error('expected a refusal, got a result');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const body = (err as ServiceUnavailableException).getResponse() as any;
    expect(body.code).toBe(MeruErrorCode.SERVER_UNAVAILABLE);
    expect(body.message).toMatch(/report builder disabled pending rewrite/i);
  }

  it('POST /analytics/reports/:id/execute refuses before reading the report or opening a connection', async () => {
    const { service, dataSource, reportRepo, executionRepo } = build();

    await expectDisabled(
      service.executeReport(T, 'user-1', {
        reportId: 'r1',
        parameters: { tenantId: 'someone-elses-tenant' },
      }),
    );

    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(reportRepo.findOne).not.toHaveBeenCalled();
    // No `status: 'error'` execution row for a run that never started.
    expect(executionRepo.save).not.toHaveBeenCalled();
  });

  it('GET /analytics/widgets/:id/execute refuses before reading the widget or opening a connection', async () => {
    const { service, dataSource, widgetRepo } = build();

    await expectDisabled(service.executeWidget(T, 'w1'));

    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    expect(widgetRepo.findOne).not.toHaveBeenCalled();
  });

  it('POST /analytics/reports/:id/export (and the scheduled sweep that calls it) refuses the same way', async () => {
    const { service, dataSource } = build();

    await expectDisabled(service.exportReport(T, 'r1', 'csv'));

    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});
