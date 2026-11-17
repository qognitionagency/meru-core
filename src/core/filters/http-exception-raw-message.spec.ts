import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AllExceptionsFilter } from './http-exception.filter';

/**
 * Any exception that was not an `HttpException` used to return its own
 * `message` to the caller (Anton, 2026-11-17, #5). A Postgres error names
 * columns, tables, constraint names and fragments of the failing statement;
 * an SDK error can carry an upstream response body. That is what turned the
 * ORDER BY injection (#1) into an error-based read, and reflected the
 * connector SSRF response (#4).
 *
 * Now: a generic message carrying the request id, and the detail in the
 * server log under the same id. Deliberate `HttpException` messages are
 * unchanged — those are written by this codebase for the caller to read.
 */
function run(exception: unknown, requestId = 'req-123') {
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({
        method: 'GET',
        url: '/documents',
        headers: { 'x-request-id': requestId },
      }),
    }),
  };
  const filter = new AllExceptionsFilter();
  const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  (filter as any).logger = logger;
  filter.catch(exception, host);
  return {
    status: res.status.mock.calls[0][0],
    body: json.mock.calls[0][0],
    logged: JSON.stringify(logger.error.mock.calls),
  };
}

describe('AllExceptionsFilter — raw error text never reaches the caller', () => {
  const driverText =
    'invalid input syntax for type integer: "SELECT passwordHash FROM users"';

  it('a database driver error is a generic 500 with the request id, not the driver text', () => {
    const err = new QueryFailedError(
      'SELECT * FROM documents ORDER BY x',
      [],
      new Error(driverText),
    );

    const { status, body } = run(err);

    expect(status).toBe(500);
    expect(body.error.code).toBe('MER-SRV-0001');
    expect(JSON.stringify(body)).not.toContain('passwordHash');
    expect(JSON.stringify(body)).not.toContain('SELECT');
    expect(body.error.message).toContain('req-123');
    expect(body.meta.requestId).toBe('req-123');
  });

  it('a plain Error (e.g. an SDK error carrying an upstream body) is generic too', () => {
    const { body } = run(new Error('upstream said: {"secret":"abc"}'));

    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.error.message).toContain('req-123');
  });

  it('a dependency-down error is still a 503, with no host or port in the message', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
    });

    const { status, body } = run(err);

    expect(status).toBe(503);
    expect(body.error.code).toBe('MER-SRV-0002');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
    expect(body.error.message).toContain('req-123');
  });

  it('logs the real detail server-side under the same request id', () => {
    const { logged } = run(new Error(driverText));

    expect(logged).toContain('req-123');
    expect(logged).toContain(driverText.slice(0, 30));
  });

  it('mints a request id when the caller sent none, and the message and meta agree', () => {
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) };
    const host: any = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method: 'GET', url: '/x', headers: {} }),
      }),
    };
    const filter = new AllExceptionsFilter();
    (filter as any).logger = { error: jest.fn() };
    filter.catch(new Error('boom'), host);
    const body = json.mock.calls[0][0];

    expect(body.meta.requestId).toBeTruthy();
    expect(body.error.message).toContain(body.meta.requestId);
    expect(body.error.message).not.toContain('boom');
  });

  it('leaves deliberate HttpException messages alone', () => {
    expect(run(new BadRequestException('Unsupported sort')).body.error.message).toBe(
      'Unsupported sort',
    );
    expect(
      run(
        new ServiceUnavailableException({
          code: 'MER-SRV-0002',
          message: 'Report builder disabled pending rewrite',
        }),
      ).body.error.message,
    ).toBe('Report builder disabled pending rewrite');
  });
});
