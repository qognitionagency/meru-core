import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The rate-limit key must never contain client-supplied input.
 *
 * Both entrypoints keyed on `` `${ip}::${req.headers['x-tenant-id']}` ``.
 * `X-Tenant-Id` is unauthenticated attacker input on `/auth/*`, so varying it
 * minted unlimited independent buckets from one address and made the limiter
 * — added specifically to protect login, refresh, forgot-password and
 * reset-password — evadable for credential stuffing.
 *
 * Both files are checked because `api/index.js` is what Vercel actually serves
 * and `src/main.ts` is what runs locally. A limiter fixed in one and not the
 * other is a limiter that is not fixed: this repo has already shipped exactly
 * that asymmetry once, when `main.ts` had a limiter and the Vercel entrypoint
 * had none at all.
 */
describe('rate-limit key cannot be forged', () => {
  const ROOT = join(__dirname, '..', '..');
  const entrypoints = [
    join(ROOT, 'api', 'index.js'),
    join(ROOT, 'src', 'main.ts'),
  ];

  it.each(entrypoints)('%s does not read a header into the key', (file) => {
    const src = readFileSync(file, 'utf8');
    const keyGen = src.match(/keyGenerator:\s*\(req\)\s*=>\s*\{([\s\S]*?)\n\s{4,6}\},/);
    expect(keyGen).not.toBeNull();
    const body = keyGen![1];
    // Comments legitimately mention the header to explain why it is absent.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/req\.headers/);
    expect(code).not.toMatch(/x-tenant-id/i);
  });

  /**
   * Keying on `req.ip` is only per-caller if Express is told to trust the
   * proxy. Vercel terminates TLS at its edge, so without this the socket peer
   * address is the platform's own proxy — identical for every caller — and the
   * limiter silently becomes ONE GLOBAL BUCKET. That is strictly worse than the
   * forgeable-header version it replaced: one client can then exhaust the
   * allowance for every tenant, which converts a credential-stuffing control
   * into a denial-of-service lever.
   *
   * The assertion below that the key contains `req.ip` proves the identifier is
   * present. It does not prove it varies. This is the test that does.
   *
   * `1`, not `true`: Vercel appends exactly one hop and puts the originating
   * client first. Trusting the whole chain lets a caller prepend their own
   * `X-Forwarded-For` and pick their own bucket — the same evasion in a new
   * costume.
   */
  it.each(entrypoints)('%s sets trust proxy to exactly one hop', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/\.set\(\s*['"]trust proxy['"]\s*,\s*1\s*\)/);
    // `true` would trust a caller-supplied chain.
    expect(src).not.toMatch(/\.set\(\s*['"]trust proxy['"]\s*,\s*true\s*\)/);
  });

  it.each(entrypoints)('%s still keys on something', (file) => {
    const src = readFileSync(file, 'utf8');
    const keyGen = src.match(/keyGenerator:\s*\(req\)\s*=>\s*\{([\s\S]*?)\n\s{4,6}\},/);
    // A keyGenerator returning a constant would rate-limit the whole world
    // into one bucket — safe against evasion, useless against everything else.
    expect(keyGen![1]).toMatch(/req\.ip/);
  });
});
