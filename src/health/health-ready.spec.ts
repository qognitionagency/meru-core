import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { IS_PUBLIC_KEY } from '../iam/decorators/public.decorator';
import { HealthController } from './health.controller';

/**
 * `GET /health/ready` — a readiness probe that fails when the database does.
 *
 * `GET /health` answers 200 with `database: "down"` (render.yaml and
 * docs/runbooks/render-deploy.md §8 record why that cannot be pointed at as a
 * database check). It is deliberately left as it is: turning it into a 503
 * would make Render restart the instance after 60 s of failed checks on any
 * database blip, and that is a decision for the blueprint owner, not a side
 * effect of this change. This route exists so the blueprint can choose.
 */
describe('HealthController.ready', () => {
  const capabilities = {
    summary: jest.fn(async () => ({ live: 1, degraded: 0, unconfigured: 0 })),
  };
  const build = (query: () => Promise<unknown>) =>
    new HealthController(
      { query: jest.fn(query) } as unknown as DataSource,
      capabilities as any,
    );

  it('answers ready when SELECT 1 succeeds', async () => {
    const body = await build(async () => [{ '?column?': 1 }]).ready();
    expect(body).toEqual({ status: 'ready', database: 'up' });
  });

  it('answers 503 when the database is unreachable', async () => {
    const controller = build(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const err = await controller.ready().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('never repeats the driver error to an anonymous caller (it can name the host)', async () => {
    const controller = build(async () => {
      throw new Error(
        'getaddrinfo ENOTFOUND ep-example-123456.us-east-2.aws.neon.tech',
      );
    });

    const err = await controller.ready().catch((e) => e);
    expect(JSON.stringify(err.getResponse())).not.toContain('neon.tech');
    expect(JSON.stringify(err.getResponse())).not.toContain('ENOTFOUND');
  });

  it('is public and carries no tenant data and no capability report', async () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, HealthController.prototype.ready),
    ).toBe(true);

    const body = await build(async () => [{}]).ready();
    expect(Object.keys(body).sort()).toEqual(['database', 'status']);
    expect(capabilities.summary).not.toHaveBeenCalled();
  });

  it('leaves GET /health as it was: 200 with database "down", not a throw', async () => {
    const body = await build(async () => {
      throw new Error('connect ECONNREFUSED');
    }).check();
    expect(body.database).toBe('down');
    expect(body.status).toBe('degraded');
  });
});
