import { BadRequestException } from '@nestjs/common';
import { AllExceptionsFilter } from './http-exception.filter';

/**
 * The envelope used to drop every key on an exception body except `message` and
 * `code`, so a thrower had no way to hand a client structured data it must act
 * on — the ambiguous-admin 400 on POST /tenants/:id/admin-invite/resend carried
 * candidate ids nobody ever received. Only an explicit `details` object passes
 * through; any other extra key stays internal.
 */
function run(exception: unknown) {
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnValue({ json }) };
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'POST', url: '/x', headers: {} }),
    }),
  };
  const filter = new AllExceptionsFilter();
  (filter as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
  filter.catch(exception, host);
  return json.mock.calls[0][0];
}

describe('AllExceptionsFilter — error.details', () => {
  it('passes an explicit details object through to the envelope', () => {
    const body = run(
      new BadRequestException({
        message: 'ambiguous — pass userId',
        details: { userIds: ['a', 'b'] },
      }),
    );
    expect(body.error.details).toEqual({ userIds: ['a', 'b'] });
    expect(body.error.message).toBe('ambiguous — pass userId');
  });

  it('drops any other extra key on the exception body', () => {
    const body = run(
      new BadRequestException({ message: 'nope', internalNote: 'secret' }),
    );
    expect(body.error.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('keeps class-validator arrays as field-level details (unchanged)', () => {
    const body = run(
      new BadRequestException({ message: ['email - must be an email'] }),
    );
    expect(body.error.details).toEqual([
      { field: 'email', message: 'must be an email', code: 'VALIDATION' },
    ]);
  });
});
