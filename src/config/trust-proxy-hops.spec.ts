import { readFileSync } from 'fs';
import { join } from 'path';
import { configuration, validationSchema } from './configuration';

/**
 * `TRUST_PROXY_HOPS` (Anton, second gate): how many proxies in front of the
 * API append to `X-Forwarded-For`. Vercel appends one; a Render deployment
 * behind another proxy may need more. `req.ip` — and so the rate limiter and
 * the sign-in attempt limiter's source key — reads the address that many hops
 * back. Too high and a caller's own `X-Forwarded-For` entry becomes their
 * source; so a bounded integer, validated at boot, default 1 (unchanged).
 */
const validate = (env: Record<string, unknown>) =>
  validationSchema.validate(env, { abortEarly: true, allowUnknown: true });

describe('TRUST_PROXY_HOPS', () => {
  const base = { JWT_SECRET: 'test-secret-that-is-at-least-32-characters' };
  const saved = process.env.TRUST_PROXY_HOPS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = saved;
  });

  it('defaults to 1 when unset or empty', () => {
    expect(validate(base).value.TRUST_PROXY_HOPS).toBe(1);
    expect(validate({ ...base, TRUST_PROXY_HOPS: '' }).value.TRUST_PROXY_HOPS).toBe(1);
  });

  it.each(['1', '2', '3'])('accepts %s', (v) => {
    const { error, value } = validate({ ...base, TRUST_PROXY_HOPS: v });
    expect(error).toBeUndefined();
    expect(value.TRUST_PROXY_HOPS).toBe(Number(v));
  });

  it.each(['0', '4', '1.5', 'true', '-1', 'all'])('refuses boot on %p', (v) => {
    expect(validate({ ...base, TRUST_PROXY_HOPS: v }).error?.message).toMatch(
      /TRUST_PROXY_HOPS/,
    );
  });

  it('configuration().trustProxyHops is 1 by default and reads the variable', () => {
    delete process.env.TRUST_PROXY_HOPS;
    expect(configuration().trustProxyHops).toBe(1);
    process.env.TRUST_PROXY_HOPS = '2';
    expect(configuration().trustProxyHops).toBe(2);
  });

  it('src/main.ts sets trust proxy from trustProxyHops, never a literal true', () => {
    const src = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(src).toMatch(/\.set\(\s*['"]trust proxy['"]\s*,\s*trustProxyHops\s*\)/);
    expect(src).toMatch(/get<number>\(\s*['"]trustProxyHops['"]\s*\)/);
    expect(src).not.toMatch(/\.set\(\s*['"]trust proxy['"]\s*,\s*true\s*\)/);
  });
});
