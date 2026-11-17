import * as Joi from 'joi';

/**
 * Every entry below is `.empty('')`, which converts an empty string to
 * undefined so the declared `.default()` applies.
 *
 * This is not cosmetic. Joi's `.default()` only fires for *undefined*; an env
 * var that exists but is empty is a defined empty string and fails
 * validation ("is not allowed to be empty", or the `.valid()` list for enums).
 * ConfigModule throws that at startup, Nest never finishes booting, and every
 * route — including /health — answers 500. A deployment platform writing an
 * empty value for an optional variable should degrade to its default, not
 * take the whole API down.
 *
 * JWT_SECRET deliberately keeps failing on empty: booting with no signing
 * secret is worse than not booting.
 */
export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().empty('')
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().empty('').default(3000),
  VERTICAL: Joi.string().empty('')
    .valid('core', 'immigration', 'grc', 'labour', 'fintech', 'legal')
    .default('core'),

  // CORS
  CORS_ALLOWED_ORIGINS: Joi.string().empty('').default(
    'http://localhost:3000,http://localhost:3001,http://localhost:3002',
  ),

  // Rate Limiting
  RATE_LIMIT_TTL_MS: Joi.number().empty('').default(60000),
  RATE_LIMIT_MAX_GLOBAL: Joi.number().empty('').default(100),
  RATE_LIMIT_MAX_IMMIGRATION: Joi.number().empty('').default(100),
  RATE_LIMIT_MAX_BANKING: Joi.number().empty('').default(50),

  // AWS Secrets Manager
  AWS_REGION: Joi.string().empty('').default('ap-south-1'),

  // Database — DATABASE_URL (Neon) takes precedence over the discrete vars.
  DATABASE_URL: Joi.string().empty('').optional(),
  DATABASE_HOST: Joi.string().empty('').optional(),
  DATABASE_PORT: Joi.number().empty('').default(5432),
  DATABASE_USERNAME: Joi.string().empty('').optional(),
  DATABASE_PASSWORD: Joi.string().empty('').optional(),
  DATABASE_NAME: Joi.string().empty('').optional(),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().empty('').default('1h'),
  CRON_SECRET: Joi.string().empty('').optional(),

  // Cache (Redis URL optional, falls back to memory)
  REDIS_HOST: Joi.string().empty('').optional(),
  REDIS_PORT: Joi.number().empty('').optional(),

  // AWS S3
  AWS_ACCESS_KEY_ID: Joi.string().empty('').optional().allow(''),
  AWS_SECRET_ACCESS_KEY: Joi.string().empty('').optional().allow(''),
  AWS_S3_BUCKET: Joi.string().empty('').default('meru-documents'),

  // Documents
  //
  // Production refuses to boot without a real key. The default below is a
  // constant committed to this repository, so a document "encrypted" under it
  // in production is encrypted with a public key. Development and test keep
  // the default so a fresh checkout still boots.
  //
  // No length floor, deliberately: documents.service.ts `encryptFile` derives
  // the AES key with scryptSync(secret, 'salt', 32), which accepts any
  // non-empty string, so non-empty is all the runtime requires. A floor would
  // be policy, and could refuse boot on a production key whose length this
  // repo does not know. Unlike CREDENTIALS_ENCRYPTION_KEY below.
  DOCUMENT_ENCRYPTION_KEY: Joi.string()
    .empty('')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.optional().default('default-encryption-key-32-chars!'),
    }),
  // Connector credentials (src/core/crypto/credential-cipher.ts). That module
  // already refuses to encrypt without it, but only at the moment a credential
  // is stored; production now says so at boot instead of mid-request.
  // `.min(32)` is the cipher's own floor (credential-cipher.ts `key()` throws
  // under 32 characters) — the guard must refuse exactly what the cipher
  // refuses, or a short key boots and fails on first use.
  CREDENTIALS_ENCRYPTION_KEY: Joi.string()
    .empty('')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().min(32).required(),
      otherwise: Joi.optional(),
    }),
  MAX_FILE_SIZE: Joi.number().empty('').default(52428800),

  // In-process scheduling: the @Cron handlers (ScheduleModule) and the queue
  // polling loop (JobProcessor). Off by default — the HTTP route
  // /api/v1/jobs/tick is the single driver, called by Vercel Cron or Render
  // cron. Turning it on while those crons also run does every job twice.
  // A value other than on/off is refused rather than silently meaning "off".
  INTERNAL_SCHEDULER: Joi.string()
    .empty('')
    .trim()
    .lowercase()
    .valid('on', 'off')
    .default('off'),
});

/**
 * Whether the in-process scheduler runs (see INTERNAL_SCHEDULER above).
 *
 * Read from the environment directly, not through ConfigService, because
 * `app.module.ts` must decide whether to import `ScheduleModule` while its
 * `@Module` decorator is being evaluated — before any provider exists.
 */
export const internalSchedulerEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => (env.INTERNAL_SCHEDULER ?? '').trim().toLowerCase() === 'on';

/**
 * Strip `sslmode` (and `channel_binding`) from a Postgres URL.
 *
 * `pg` now warns that it treats sslmode=require as **verify-full**, and under
 * verify-full the driver validates the server certificate chain itself —
 * overriding the explicit `ssl: { rejectUnauthorized: false }` the DataSource
 * passes. On a serverless runtime whose CA bundle does not satisfy the Neon
 * chain, every connection attempt then fails, TypeORM burns its retry budget,
 * and the function exits non-zero, so EVERY route answers 500 including
 * /health.
 *
 * Removing the parameter leaves TLS on (the explicit ssl option still
 * applies) while keeping verification behaviour in one place — the code —
 * instead of split between the code and a query string.
 */
const stripSslMode = (url?: string): string | undefined => {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    // Not a parsable URL (discrete-var setups); hand it back untouched.
    return url;
  }
};

export const configuration = () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  vertical: process.env.VERTICAL || 'core',
  database: {
    // Runtime connects as the non-BYPASSRLS `meru_app` role so tenant policies
    // are actually enforced; DATABASE_URL (owner) is reserved for migrations and
    // is only used at runtime as a fallback when the app role is not provisioned.
    // See scripts/provision-rls-role.js.
    url: stripSslMode(
      process.env.DATABASE_APP_URL || process.env.DATABASE_URL,
    ),
    migrationUrl: stripSslMode(process.env.DATABASE_URL),
    // Per-vertical databases (the three-DB split: `meru` control plane,
    // `govx`, `immistack` — CLAUDE.md §6 and §8.3).
    // Unset ⇒ that vertical shares the default (control-plane) database, so
    // the split can roll out one environment at a time without downtime.
    govxUrl: stripSslMode(
      process.env.GOVX_DB_APP_URL || process.env.GOVX_DB_URL,
    ),
    immistackUrl: stripSslMode(
      process.env.IMMISTACK_DB_APP_URL || process.env.IMMISTACK_DB_URL,
    ),
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    name: process.env.DATABASE_NAME,
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    s3Bucket: process.env.AWS_S3_BUCKET || 'meru-documents',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRATION,
  },
  cache: {
    store: process.env.REDIS_HOST ? 'redis' : 'memory',
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  documents: {
    // No `encryptionKey` here. Nothing ever read `documents.encryptionKey`,
    // and it carried its own committed literal fallback that bypassed the
    // production boot guard on DOCUMENT_ENCRYPTION_KEY above. The one read
    // path is `ConfigService.getOrThrow('DOCUMENT_ENCRYPTION_KEY')`
    // (documents.service.ts), which sees the Joi-validated value.
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10),
  },
});
