import { readFileSync } from 'fs';
import { join } from 'path';
import { internalSchedulerEnabled, validationSchema } from './configuration';

/**
 * Two boot-time decisions that matter the moment the API runs as one
 * long-lived process (Render) rather than per-request functions (Vercel).
 */
// The options ConfigModule actually validates with (config.module.ts sets
// abortEarly; @nestjs/config adds allowUnknown: true when it is unset), so an
// unknown key cannot make a test pass for the wrong reason.
const validate = (env: Record<string, unknown>) =>
  validationSchema.validate(env, { abortEarly: true, allowUnknown: true });

describe('boot guards in configuration.ts', () => {
  const base = { JWT_SECRET: 'test-secret-that-is-at-least-32-characters' };
  const KEYS = {
    DOCUMENT_ENCRYPTION_KEY: 'doc-key-doc-key-doc-key-doc-key-doc',
    CREDENTIALS_ENCRYPTION_KEY: 'cred-key-cred-key-cred-key-cred-key',
  };

  /**
   * `DOCUMENT_ENCRYPTION_KEY` used to default to a constant committed in this
   * repo. In production that meant "encrypted" documents were encrypted with a
   * public key. Production now refuses to boot without both keys; development
   * and test keep working without them.
   */
  describe('encryption keys', () => {
    it('refuses production boot with no DOCUMENT_ENCRYPTION_KEY', () => {
      const { error } = validate({
        ...base,
        NODE_ENV: 'production',
        CREDENTIALS_ENCRYPTION_KEY: KEYS.CREDENTIALS_ENCRYPTION_KEY,
      });
      expect(error?.message).toMatch(/DOCUMENT_ENCRYPTION_KEY/);
    });

    it('refuses production boot with an empty DOCUMENT_ENCRYPTION_KEY', () => {
      const { error } = validate({
        ...base,
        NODE_ENV: 'production',
        DOCUMENT_ENCRYPTION_KEY: '',
        CREDENTIALS_ENCRYPTION_KEY: KEYS.CREDENTIALS_ENCRYPTION_KEY,
      });
      expect(error?.message).toMatch(/DOCUMENT_ENCRYPTION_KEY/);
    });

    it('refuses production boot with no CREDENTIALS_ENCRYPTION_KEY', () => {
      const { error } = validate({
        ...base,
        NODE_ENV: 'production',
        DOCUMENT_ENCRYPTION_KEY: KEYS.DOCUMENT_ENCRYPTION_KEY,
      });
      expect(error?.message).toMatch(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    /**
     * credential-cipher.ts `key()` throws under 32 characters. A boot guard
     * that accepts a shorter key lets production start and then fail on the
     * first connector-credential write or read — the mid-request failure the
     * guard exists to move to boot.
     */
    it('refuses production boot with a CREDENTIALS_ENCRYPTION_KEY under 32 characters', () => {
      const { error } = validate({
        ...base,
        NODE_ENV: 'production',
        DOCUMENT_ENCRYPTION_KEY: KEYS.DOCUMENT_ENCRYPTION_KEY,
        CREDENTIALS_ENCRYPTION_KEY: 'x'.repeat(31),
      });
      expect(error?.message).toMatch(/CREDENTIALS_ENCRYPTION_KEY/);
    });

    it('boots in production with a CREDENTIALS_ENCRYPTION_KEY of exactly 32 characters', () => {
      const { error } = validate({
        ...base,
        NODE_ENV: 'production',
        DOCUMENT_ENCRYPTION_KEY: KEYS.DOCUMENT_ENCRYPTION_KEY,
        CREDENTIALS_ENCRYPTION_KEY: 'x'.repeat(32),
      });
      expect(error).toBeUndefined();
    });

    /**
     * Deliberately NO length floor on DOCUMENT_ENCRYPTION_KEY. The guard
     * mirrors what the runtime requires, and the runtime requires only a
     * non-empty string: documents.service.ts `encryptFile` derives the AES key
     * with `scryptSync(secret, 'salt', 32)`, which accepts any length. A floor
     * here would be policy, not mechanics — and imposing one blind would stop
     * production booting if its existing key is shorter (its length is not
     * known to this repo; see docs/runbooks/render-deploy.md §1).
     */
    it('accepts any non-empty DOCUMENT_ENCRYPTION_KEY in production, because encryptFile sets no floor', () => {
      const { error } = validate({
        ...base,
        NODE_ENV: 'production',
        DOCUMENT_ENCRYPTION_KEY: 'k',
        CREDENTIALS_ENCRYPTION_KEY: KEYS.CREDENTIALS_ENCRYPTION_KEY,
      });
      expect(error).toBeUndefined();
    });

    it('boots in production with both keys, and never substitutes the public default', () => {
      const { error, value } = validate({
        ...base,
        NODE_ENV: 'production',
        ...KEYS,
      });
      expect(error).toBeUndefined();
      expect(value.DOCUMENT_ENCRYPTION_KEY).toBe(KEYS.DOCUMENT_ENCRYPTION_KEY);
    });

    it('still boots in development without either key (dev default applies)', () => {
      const { error, value } = validate({
        ...base,
        NODE_ENV: 'development',
      });
      expect(error).toBeUndefined();
      expect(typeof value.DOCUMENT_ENCRYPTION_KEY).toBe('string');
    });
  });

  /**
   * INTERNAL_SCHEDULER decides whether the in-process @Cron handlers and the
   * queue polling loop run. Default OFF: on Render the platform crons call
   * /api/v1/jobs/tick, and running the in-process scheduler as well would do
   * every minute-level job twice.
   */
  describe('INTERNAL_SCHEDULER', () => {
    it.each([
      [undefined, false],
      ['', false],
      ['off', false],
      ['true', false],
      ['on', true],
      [' ON ', true],
    ])('INTERNAL_SCHEDULER=%p → enabled=%p', (value, expected) => {
      const env: NodeJS.ProcessEnv = {};
      if (value !== undefined) env.INTERNAL_SCHEDULER = value;
      expect(internalSchedulerEnabled(env)).toBe(expected);
    });

    it('rejects a value that is neither on nor off at boot, rather than silently meaning off', () => {
      const { error } = validate({
        ...base,
        INTERNAL_SCHEDULER: 'true',
      });
      expect(error?.message).toMatch(/INTERNAL_SCHEDULER/);
    });

    it('defaults to off', () => {
      const { value } = validate(base);
      expect(value.INTERNAL_SCHEDULER).toBe('off');
    });

    it('app.module registers ScheduleModule only behind the flag', () => {
      const src = readFileSync(join(__dirname, '..', 'app.module.ts'), 'utf8');
      const calls = src.match(/ScheduleModule\.forRoot\(\)/g) ?? [];
      expect(calls).toHaveLength(1);
      expect(src).toMatch(
        /internalSchedulerEnabled\(\)\s*\?\s*\[\s*ScheduleModule\.forRoot\(\)\s*\]/,
      );
    });
  });
});
