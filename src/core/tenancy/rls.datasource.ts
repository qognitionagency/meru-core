import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantContext } from './tenant-context';

const logger = new Logger('RlsDataSource');

/**
 * Matches the canonical UUID form. The tenant id is interpolated into a Postgres
 * session variable that RLS policies cast to uuid; a malformed value would make
 * every policy raise instead of filter. We reject it here so the failure is a
 * clear application error rather than a confusing 22P02 from deep inside a query.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Binds each pooled connection to the caller's tenant before it is used
 * (CLAUDE.md §6.4).
 *
 * Why patch the driver rather than run `SET` from middleware: a pooled
 * connection is only bound correctly if the session variable is set on *the same
 * physical connection* that then runs the query. The previous implementation
 * (`TenantContextMiddleware.setRLSContext`) created its own QueryRunner, set the
 * GUC on it, and released it straight back to the pool — so the setting landed on
 * an arbitrary connection and essentially never the one serving the request.
 *
 * `obtainMasterConnection()` is the one choke point every query, transaction and
 * repository call funnels through, which makes it the only place this can be
 * enforced without auditing every call site.
 *
 * The reset on the untenanted path is not optional: pooled connections are
 * reused, so a connection left holding the previous request's tenant is exactly
 * the cross-tenant read this whole layer exists to prevent. Every acquisition
 * writes both variables unconditionally.
 */
/**
 * Refuse a transaction-pooled connection string.
 *
 * Everything below rests on one assumption: that a connection checked out of
 * the pool is a single backend session for the life of the checkout. An
 * external *transaction* pooler — Neon's `-pooler` endpoint, PgBouncer in
 * transaction mode — breaks it. The backend is handed to the next client after
 * each transaction, and `set_config(..., false)` is **session**-scoped, so the
 * tenant binding travels with it.
 *
 * This is not theoretical. It was observed on 2026-09-10: a freshly opened
 * connection to a `-pooler` host reported `app.rls_bypassed() = true` and a
 * tenant id left behind by an earlier session. `npm run rls:verify` dropped
 * from 10/10 to 4/10 — every write-containment check failed — and the same
 * string on the direct host passed 10/10 immediately. A leaked
 * `app.bypass_rls = on` disables row-level security entirely for whichever
 * request inherits that connection.
 *
 * Throwing is the only safe response. The failure is silent by construction:
 * the app starts, queries succeed, and the only symptom is one tenant seeing
 * another's rows.
 *
 * If pooling is ever genuinely needed, the fix is not to relax this — it is to
 * make the binding transaction-scoped (`set_config(..., true)`) and prove every
 * query runs inside a transaction, which is a larger change than it sounds.
 */
function assertNotTransactionPooled(dataSource: DataSource): void {
  const opts = dataSource.options as { url?: string; host?: string };
  const target = opts.url ?? opts.host ?? '';
  if (!/-pooler\./.test(target)) return;

  const host = /@([^/?]+)/.exec(target)?.[1] ?? target;
  throw new Error(
    `Refusing to enable RLS binding against a transaction-pooled host (${host}). ` +
      `Tenant context is set with session-scoped set_config(), which leaks between ` +
      `clients through a transaction pooler — including app.bypass_rls, which turns ` +
      `RLS off for whoever inherits the connection. Use the direct endpoint: drop ` +
      `"-pooler" from the hostname.`,
  );
}

export function applyRlsToDataSource(dataSource: DataSource): DataSource {
  assertNotTransactionPooled(dataSource);

  const driver = dataSource.driver as unknown as {
    obtainMasterConnection: () => Promise<[any, () => void]>;
    __rlsPatched?: boolean;
  };

  if (driver.__rlsPatched) return dataSource;

  const original = driver.obtainMasterConnection.bind(driver);

  driver.obtainMasterConnection = async (): Promise<[any, () => void]> => {
    const [connection, release] = await original();

    const store = TenantContext.get();
    const bypass = store?.bypass;
    const tenantId = store?.tenantId;

    if (tenantId && !UUID_RE.test(tenantId)) {
      release();
      throw new Error(
        `Refusing to bind connection: tenant id "${tenantId}" is not a valid UUID.`,
      );
    }

    try {
      // set_config() is used rather than `SET` because SET cannot take bind
      // parameters — this keeps the tenant id out of the SQL text entirely.
      // `false` = session scope, so the binding survives for the duration of
      // this checkout (including multi-statement transactions).
      await connection.query(
        `SELECT set_config('app.current_tenant_id', $1, false),
                set_config('app.bypass_rls', $2, false)`,
        [tenantId ?? '', bypass ? 'on' : 'off'],
      );
    } catch (error) {
      // Fail closed. A connection we could not bind must never be handed to a
      // caller, or it would run queries under whatever tenant the previous
      // borrower left behind.
      release();
      throw error;
    }

    if (bypass?.kind === 'god') {
      logger.warn(
        `RLS bypassed (god) by actor=${bypass.actorId ?? 'unknown'}: ${bypass.reason}`,
      );
    }

    return [connection, release];
  };

  driver.__rlsPatched = true;
  logger.log('RLS tenant binding installed on DataSource');

  return dataSource;
}

/**
 * Verifies at boot that the connected role cannot ignore RLS.
 *
 * This exists because the failure it catches is silent and total: a role holding
 * BYPASSRLS (Neon's `neondb_owner` does, as do most managed-Postgres default
 * users) ignores every policy while `\d+` still shows them enabled, so the
 * schema looks isolated and isn't. Better to refuse to boot than to serve
 * traffic that only appears to be tenant-scoped.
 */
export async function assertRlsEnforceable(
  dataSource: DataSource,
): Promise<void> {
  const [role] = await dataSource.query(
    `SELECT current_user AS name, rolsuper, rolbypassrls
     FROM pg_roles WHERE rolname = current_user`,
  );

  if (!role) return;

  if (role.rolbypassrls || role.rolsuper) {
    const message =
      `Database role "${role.name}" has ` +
      `${role.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'}, so row-level security is ` +
      `not enforced and tenants are NOT isolated. Connect as the dedicated ` +
      `application role instead (see scripts/provision-rls-role.js).`;

    if (process.env.NODE_ENV === 'production') {
      throw new Error(message);
    }
    logger.error(message);
  }
}
