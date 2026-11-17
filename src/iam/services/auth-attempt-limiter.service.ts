import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { isIPv4, isIPv6 } from 'node:net';
import { User } from '../entities/user.entity';
import { AuditService } from '../../audit/audit.service';
import {
  AuditAction,
  AuditSeverity,
} from '../../audit/entities/audit-log.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

export type AttemptKind = 'login' | 'mfa';
export type AttemptOutcome = 'failed' | 'refused_locked';

export interface AttemptAccount {
  id: string;
  tenantId: string;
  email?: string;
  status?: string;
}

/**
 * Limits, per kind, inside one sliding window. [NEEDS DATA: every number
 * here is a proposal for Anton/the operator, not measured against support
 * load or attack traffic.]
 *
 * - `perSource` — failures one (account, source) pair may make before that
 *   source is refused for the account. Keyed on the source so a guesser
 *   cannot lock the account holder out from their own address.
 * - `accountBackstop` — failures across all sources at which the account is
 *   under attack. It does NOT lock the account: it tightens every source to
 *   `perSourceUnderBackstop`, so each further source gets one guess per
 *   window, and a clean source — the account holder's — still gets in.
 *
 * MFA is the tighter one: a six-digit code is a million-value space, and the
 * password leg has already been passed.
 */
export const ATTEMPT_LIMITS: Record<
  AttemptKind,
  {
    perSource: number;
    accountBackstop: number;
    perSourceUnderBackstop: number;
    windowMs: number;
  }
> = {
  login: {
    perSource: 10,
    accountBackstop: 50,
    perSourceUnderBackstop: 1,
    windowMs: 15 * 60 * 1000,
  },
  mfa: {
    perSource: 5,
    // 10, down from 25 (Anton, second gate): an MFA failure means the
    // password is already known.
    accountBackstop: 10,
    perSourceUnderBackstop: 1,
    windowMs: 15 * 60 * 1000,
  },
};

/**
 * MFA hard cap (Anton, second gate). An MFA failure means the password has
 * already been passed, so the argument that made the login limit
 * source-keyed — a guesser must not be able to lock the holder out — does not
 * apply: whoever is failing here holds the password. Past this many MFA
 * failures for one account in 24 hours, from any source, MFA is refused from
 * every source until a platform operator unlocks the account (the same
 * audited `auth.login.unlocked` row as a login unlock) or the password is
 * reset (the `token_redeemed` audit row, `context.credentialSetAt`).
 *
 * Inside 15 minutes the hard cap and the MFA backstop are both 10, so the
 * hard cap is what fires; the backstop matters only for a slower spread.
 * [NEEDS DATA: 10/24h is Anton's proposal, not measured.] Telling the user or
 * the firm admin is a follow-up: mail is not deliverable today.
 */
export const MFA_HARD_CAP = { failures: 10, windowMs: 24 * 60 * 60 * 1000 };

/**
 * `auth_attempts` rows older than this are deleted by the daily
 * `auth-attempts-prune` job. [NEEDS DATA: 30 days is a proposal, not a
 * retention decision — it must outlive the 24-hour MFA hard-cap window, and
 * the regulatory record of a lock is the audit chain, not this table.]
 */
export const AUTH_ATTEMPT_RETENTION_DAYS = 30;
const PRUNE_BATCH = 5000;
const PRUNE_MAX_BATCHES = 20;

/** The nil UUID: the boot self-test's account and tenant, matching no row. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** At most one `refused_locked` row per (account, source, kind) this often. */
const REFUSAL_RECORD_INTERVAL_MS = 60 * 1000;

/**
 * Bounds on one attempt write. `auth_attempts` has no chain lock and no
 * unique index, so a plain insert should never wait on a lock at all; the
 * bound is there so that, if one ever does, an unauthenticated request holds
 * its pool connection for half a second, not five.
 */
const WRITE_LOCK_TIMEOUT = '500ms';
const WRITE_STATEMENT_TIMEOUT = '2s';
/** The count read gets the same bounds (Anton): it, too, runs pre-auth. */
const READ_LOCK_TIMEOUT = WRITE_LOCK_TIMEOUT;
const READ_STATEMENT_TIMEOUT = WRITE_STATEMENT_TIMEOUT;

/** In-process ledger caps, so a flood cannot grow memory without bound. */
const LEDGER_MAX_ACCOUNTS = 10_000;
const LEDGER_MAX_PER_ACCOUNT = 200;

export interface AttemptStanding {
  /** This source is refused for this account, right password or not. */
  locked: boolean;
  /**
   * Failures from this source before this attempt — from its /24 or /48
   * block once the backstop is engaged.
   */
  sourceFailures: number;
  accountFailures: number;
  /** The account-wide backstop is engaged. */
  backstop: boolean;
  /** MFA only: past `MFA_HARD_CAP`, refused from every source. */
  hardLocked: boolean;
  /** Newest `refused_locked` row for this source, for rate-limiting the next. */
  lastRefusalAt: Date | null;
  /** The store could not be read; the decision used this process's ledger. */
  degraded: boolean;
}

/**
 * The address an attempt is counted against.
 *
 * `req.ip` honours `trust proxy` (`TRUST_PROXY_HOPS` in main.ts, default 1;
 * a literal 1 in api/index.js), so it is the
 * address the platform's proxy saw, not a client-chosen `X-Forwarded-For`
 * entry. IPv4-mapped IPv6 is folded to IPv4, and IPv6 is reduced to its /64:
 * one subscriber is routinely handed a whole /64, and every address in it is
 * a fresh source to a limiter that keys on the full address. No address at
 * all is one shared `unknown` bucket — the conservative choice.
 */
export function attemptSource(ip?: string | null): string {
  let addr = String(ip ?? '').trim();
  if (!addr) return 'unknown';
  if (addr.toLowerCase().startsWith('::ffff:') && isIPv4(addr.slice(7))) {
    addr = addr.slice(7);
  }
  if (isIPv4(addr)) return addr;
  const bare = addr.split('%')[0];
  if (isIPv6(bare)) {
    const [head, tail = ''] = bare.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = bare.includes('::') && tail ? tail.split(':') : [];
    const fill = bare.includes('::') ? 8 - left.length - right.length : 0;
    const groups = [...left, ...Array(Math.max(fill, 0)).fill('0'), ...right];
    const prefix = groups
      .slice(0, 4)
      .map((g) => g.replace(/^0+(?=.)/, ''))
      .join(':');
    return `${prefix}::/64`;
  }
  return addr.slice(0, 64);
}

/**
 * The database's `now()` as a UTC ISO instant with microseconds, e.g.
 * `2026-11-17T08:30:00.123456Z` — the boundary an unlock or a password reset
 * writes into its audit row. The DATABASE clock, because it is the clock that
 * stamps `auth_attempts."createdAt"`: Node's can be skewed against it (Owen's
 * ruling). Formatted in SQL, not via a JS Date, which would drop the
 * microseconds. Independent of the session TimeZone. Throws if it cannot
 * read, so the caller writes no boundary at all rather than a guessed one.
 */
export async function databaseNowUtc(db: {
  query: (sql: string) => Promise<any>;
}): Promise<string> {
  const rows = await db.query(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
  );
  const at = rows?.[0]?.at;
  if (typeof at !== 'string' || !at) {
    throw new Error('database clock read returned no value');
  }
  return at;
}

/**
 * The block a source is counted under once the account backstop is engaged
 * (Anton, second gate): an IPv4 /24 or an IPv6 /48, as a string prefix of the
 * keys `attemptSource` produces. Under the backstop each source gets one
 * failure, and keyed on a /64 that is one guess per /64 — a /48 holds 65,536
 * of them. `null` for a key that is not an address (`unknown`, anything
 * else): counted exactly.
 */
export function attemptSourceBlock(source: string): string | null {
  if (isIPv4(source)) return source.slice(0, source.lastIndexOf('.') + 1);
  const v6 = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:)[0-9a-f]{1,4}::\/64$/.exec(
    source,
  );
  return v6 ? v6[1] : null;
}

/** `attemptSourceBlock` as a LIKE pattern, metacharacters escaped. */
function blockPattern(source: string): string {
  const esc = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);
  const block = attemptSourceBlock(source);
  return block ? `${esc(block)}%` : esc(source);
}

function inBlock(entrySource: string, source: string): boolean {
  const block = attemptSourceBlock(source);
  return block ? entrySource.startsWith(block) : entrySource === source;
}

/**
 * One attempt in flight: its row is already written (`begin`) and counted,
 * so a concurrent attempt sees it. Settle it with `release` (not a failure),
 * `refuse` (refused unchecked), or leave it — a wrong secret IS the row.
 */
export interface AttemptTicket {
  account: AttemptAccount;
  kind: AttemptKind;
  source: string;
  /** Standing of the attempts BEFORE this one (its own row excluded). */
  standing: AttemptStanding;
  /** @internal */ rowId: string | null;
  /** @internal */ entry: LedgerEntry;
  /** @internal */ settled: boolean;
}

interface LedgerEntry {
  at: number;
  source: string;
  persisted: boolean;
}

interface AttemptCounts {
  account: number;
  source: number;
  block: number;
  hard: number;
  lastRefusalAt: Date | null;
}

/**
 * Attempt limiting for password and MFA checks.
 *
 * History: Anton's #6 added a per-account cap stored in `audit_logs`. Owen's
 * gate found that it was itself a denial of service — ten wrong passwords
 * from anywhere locked the account holder out, forever if repeated, with no
 * undo — and that every unauthenticated failure took the tenant's audit
 * chain lock, so a burst could starve the pool and make strict audited
 * writes in that tenant answer 503.
 *
 * **Storage is `auth_attempts`** (migration 1757500000000), a plain
 * tenant-scoped table outside the hash chain: an attempt write is one insert
 * that waits on nobody. The regulatory chain still records the one decision
 * that needs it — an operator's unlock — and nothing an anonymous caller can
 * generate at will.
 *
 * **Written before the secret is checked** (Anton, second gate). The flow
 * was read count → check secret → write failure, so a parallel burst read
 * the count before any of its own failures landed and one source got ~100
 * guesses instead of 10. `begin` now inserts the attempt as `failed` first
 * and counts with it included, so concurrent attempts see each other; a
 * correct secret `release`s (deletes) it. Marking it `succeeded` instead
 * would need a new `outcome` value, which the table's CHECK constraint
 * refuses — a schema change, so deleted, not marked.
 *
 * **The count query is real SQL against two column types that disagree**
 * (Owen's second gate): `audit_logs."tenantId"` is varchar and
 * `auth_attempts."tenantId"` uuid, so the audit predicate casts `$1::text`;
 * and `audit_logs."timestamp"` is timestamp WITHOUT time zone written from a
 * JS Date, so the unlock boundary is read from the ISO `unlockedAt` the
 * unlock row carries, never from that column. Both were invisible to specs
 * that mock the data source, so the query is also run once at boot
 * (`selfTest`) and production refuses to start if it cannot run.
 *
 * **How it fails.** Nothing on a sign-in path throws:
 * - a failure that cannot be written is kept in this process's ledger and
 *   counted as if it had been, so a guesser whose writes are failing still
 *   reaches the cap (per process);
 * - a count that cannot be read is answered from that ledger alone, so a
 *   correct password from a source this process has not seen failing still
 *   gets in. That is a deliberate degradation, logged at error: refusing
 *   every known account on a read error would turn a store fault into a
 *   total sign-in outage that reads to every user as "wrong password".
 *
 * Tenant scope: every read and write runs inside `TenantContext.run` bound to
 * the ACCOUNT's own tenant (resolved server-side from the user row, never
 * from the request), so RLS applies, and each statement also filters on or
 * writes `"tenantId"` explicitly. The two account lookups are bootstrap reads
 * under `runAsSystem`, the same as `IamService.validateUser`: the tenant is
 * what they discover. `unlock` runs inside the caller's `runAsGod`. `prune`
 * is a cross-tenant retention sweep under `runAsSystem`.
 */
@Injectable()
export class AuthAttemptLimiter implements OnModuleInit {
  private readonly logger = new Logger(AuthAttemptLimiter.name);

  /** Same cost as real hashes in IamService (`bcrypt.hash(…, 10)`). */
  private dummyHash?: Promise<string>;

  /** `${kind}|${userId}` → this process's attempts still counted. */
  private readonly ledger = new Map<string, LedgerEntry[]>();

  /** `${kind}|${userId}|${source}` → when this process last wrote a refusal. */
  private readonly lastRefusal = new Map<string, number>();

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Boot self-test (Owen's ruling), on the `TenancyModule.onModuleInit` /
   * `assertRlsEnforceable` precedent: under NODE_ENV=production a count
   * query that cannot run refuses the boot; anywhere else it is logged.
   * Deliberately not on `/health/ready`.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.selfTest();
    } catch (err) {
      const message =
        'Sign-in attempt count query cannot run, so attempt limiting would ' +
        'silently fall back to per-process counting: ' +
        (err instanceof Error ? err.message : String(err));
      if (process.env.NODE_ENV === 'production') throw new Error(message);
      this.logger.error(message);
    }
  }

  /**
   * Runs the real count queries — login, then MFA — the same SQL `standing`
   * runs, both tables, both casts, for the nil UUID, which matches no row.
   * Does not catch. A table-existence check would not have caught Owen's
   * `varchar = uuid`; only running the statement does. Both kinds, because
   * only the MFA query carries the password-reset subquery
   * (`action = 'token_redeemed'`): on a database whose enum lacks that value
   * (migration 1757100000000 not applied) the login query runs and every MFA
   * count fails — measured against a real Postgres (Owen's gate).
   */
  async selfTest(): Promise<void> {
    for (const kind of ['login', 'mfa'] as const) {
      await this.countAttempts(
        { id: NIL_UUID, tenantId: NIL_UUID },
        kind,
        'self-test',
      );
    }
  }

  findAccountByEmail(email: string): Promise<AttemptAccount | null> {
    return TenantContext.runAsSystem(
      'resolve account for login attempt limit',
      () =>
        this.userRepo.findOne({
          where: { email },
          select: ['id', 'tenantId', 'email', 'status'],
        }),
    );
  }

  findAccountById(id: string): Promise<AttemptAccount | null> {
    return TenantContext.runAsSystem(
      'resolve account for attempt limit',
      () =>
        this.userRepo.findOne({
          where: { id },
          select: ['id', 'tenantId', 'email', 'status'],
        }),
    );
  }

  /**
   * Where this (account, source) stands with no attempt of its own in
   * flight. Never throws.
   */
  standing(
    account: AttemptAccount,
    kind: AttemptKind,
    source: string,
  ): Promise<AttemptStanding> {
    return this.assess(account, kind, source, 0);
  }

  /**
   * Start an attempt: write it as `failed` BEFORE the secret is checked,
   * then count with it included, so every concurrent attempt sees it. The
   * returned standing excludes this attempt's own row. Never throws.
   */
  async begin(
    account: AttemptAccount,
    kind: AttemptKind,
    source: string,
  ): Promise<AttemptTicket> {
    // Synchronously, before any await: in-process concurrency is bounded
    // even when the store is unreachable.
    const entry = this.remember(kind, account.id, source);
    let rowId: string | null = null;
    try {
      rowId = await this.insert(account, kind, 'failed', source);
      entry.persisted = true;
    } catch (err) {
      this.logger.error(
        `${kind} attempt for user ${account.id} could not be written; ` +
          `counted in-process: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const standing = await this.assess(account, kind, source, 1);
    return { account, kind, source, standing, rowId, entry, settled: false };
  }

  /**
   * The attempt was not a failure — the secret was right, or the account
   * could not sign in anyway — so its row stops counting. Idempotent. Never
   * throws: a row that cannot be deleted stays as one failure, logged.
   */
  async release(ticket: AttemptTicket): Promise<void> {
    if (ticket.settled) return;
    ticket.settled = true;
    this.forget(ticket);
    if (!ticket.rowId) return;
    try {
      // Tenant scope: bound to the account's tenant (RLS) and the explicit
      // "tenantId" predicate; deletes the one row `begin` wrote.
      await TenantContext.run({ tenantId: ticket.account.tenantId }, () =>
        this.bounded(WRITE_LOCK_TIMEOUT, WRITE_STATEMENT_TIMEOUT, (em) =>
          em.query(
            `DELETE FROM "auth_attempts"
             WHERE "id" = $1 AND "tenantId" = $2`,
            [ticket.rowId, ticket.account.tenantId],
          ),
        ),
      );
    } catch (err) {
      this.logger.error(
        `${ticket.kind} attempt ${ticket.rowId} for user ${ticket.account.id} ` +
          `could not be released and counts as one failure: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * The attempt was refused without checking the secret: it is released,
   * and a rate-limited `refused_locked` trace is left instead. Never throws.
   */
  async refuse(ticket: AttemptTicket): Promise<void> {
    await this.release(ticket);
    await this.recordRefusal(
      ticket.account,
      ticket.kind,
      ticket.source,
      ticket.standing,
    );
  }

  /**
   * Leave a trace of an attempt refused because its source was locked, so a
   * victim's own refused sign-ins are visible. At most one row per
   * (account, source, kind) per minute — checked against the store's newest
   * row and against this process — so the trace cannot become a flood.
   * Never throws.
   */
  async recordRefusal(
    account: AttemptAccount,
    kind: AttemptKind,
    source: string,
    standing: Pick<AttemptStanding, 'lastRefusalAt'>,
  ): Promise<void> {
    const now = Date.now();
    const key = `${kind}|${account.id}|${source}`;
    const local = this.lastRefusal.get(key) ?? 0;
    const stored = standing.lastRefusalAt?.getTime() ?? 0;
    if (now - Math.max(local, stored) < REFUSAL_RECORD_INTERVAL_MS) return;

    if (this.lastRefusal.size >= LEDGER_MAX_ACCOUNTS) this.lastRefusal.clear();
    this.lastRefusal.set(key, now);
    try {
      await this.insert(account, kind, 'refused_locked', source);
    } catch (err) {
      this.logger.error(
        `Refused ${kind} attempt for user ${account.id} could not be written: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * An operator's unlock: one strict audit row, `auth.login.unlocked`, and
   * that row IS the unlock — `standing` counts only login AND MFA failures
   * newer than its `unlockedAt` (which also lifts the MFA hard cap). If the
   * row cannot be written this throws and nothing is unlocked. Callers run
   * it inside `TenancyService.runAsGod`, which has already written the
   * CRITICAL god-mode entry naming the operator and the reason.
   */
  async unlock(
    account: AttemptAccount,
    operator: { id: string; tenantId: string; email?: string },
    reason: string,
  ): Promise<void> {
    // The boundary comes from the DATABASE clock (Owen's ruling, 2026-11-17)
    // — the clock that stamps `auth_attempts."createdAt"` — so Node/database
    // skew cannot move it. Read before the audit row is written: a failure
    // that lands after this read always counts. If the read fails, nothing
    // is written and nothing is unlocked.
    const unlockedAt = await this.databaseNow();
    await this.auditService.logEvent({
      tenantId: account.tenantId,
      userId: operator.id,
      userEmail: operator.email,
      action: AuditAction.UPDATE,
      entityType: 'user',
      entityId: account.id,
      severity: AuditSeverity.CRITICAL,
      description: `Sign-in unlocked by a platform operator: ${reason}`,
      context: {
        event: 'auth.login.unlocked',
        reason,
        operatorTenantId: operator.tenantId,
        // The boundary `standing` reads, as a UTC ISO instant to the
        // microsecond: `audit_logs."timestamp"` has no zone (Owen's gate).
        unlockedAt,
      },
    });
    // This process's unpersisted failures predate the unlock too. Other
    // processes keep theirs until they age out of the window.
    this.ledger.delete(`login|${account.id}`);
    this.ledger.delete(`mfa|${account.id}`);
  }

  /**
   * Retention (daily job `auth-attempts-prune`): delete rows older than
   * `AUTH_ATTEMPT_RETENTION_DAYS`, in bounded batches so one run never holds
   * a long lock, stopping after `PRUNE_MAX_BATCHES` and saying so.
   *
   * Tenant scope: a cross-tenant retention sweep, so under
   * `TenantContext.runAsSystem` with an explicit reason, like the audit
   * reconciler. The predicate is age alone; no tenant's rows are read.
   */
  async prune(now: Date = new Date()): Promise<{
    cutoff: string;
    deleted: number;
    batches: number;
    complete: boolean;
    scope: { eligible: null; scanned: number };
  }> {
    const cutoff = new Date(
      now.getTime() - AUTH_ATTEMPT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    let deleted = 0;
    let batches = 0;
    let complete = false;
    await TenantContext.runAsSystem(
      `auth_attempts retention (${AUTH_ATTEMPT_RETENTION_DAYS} days)`,
      async () => {
        while (batches < PRUNE_MAX_BATCHES) {
          const result = await this.bounded('5s', '20s', (em) =>
            em.query(
              `DELETE FROM "auth_attempts" WHERE "id" IN (
                 SELECT a."id" FROM "auth_attempts" a
                 WHERE a."createdAt" < $1
                 LIMIT $2)`,
              [cutoff, PRUNE_BATCH],
            ),
          );
          batches++;
          const n = Number(Array.isArray(result) ? result[1] : 0) || 0;
          deleted += n;
          if (n < PRUNE_BATCH) {
            complete = true;
            break;
          }
        }
      },
    );
    if (!complete) {
      this.logger.warn(
        `auth_attempts prune stopped after ${batches} batches (${deleted} rows); ` +
          `the next run continues`,
      );
    }
    return {
      cutoff: cutoff.toISOString(),
      deleted,
      batches,
      complete,
      scope: { eligible: null, scanned: deleted },
    };
  }

  /**
   * One bcrypt compare against a throwaway hash, so a path that never
   * reaches the real compare (unknown account, locked source) is not faster
   * than one that does.
   */
  async burnTime(password: string): Promise<void> {
    this.dummyHash ??= bcrypt.hash('meru-attempt-limit-placeholder', 10);
    await bcrypt.compare(String(password ?? ''), await this.dummyHash);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private databaseNow(): Promise<string> {
    return databaseNowUtc(this.dataSource);
  }

  /**
   * The decision. `own` is how many of the counted rows are this caller's
   * own in-flight attempt (1 from `begin`, else 0); it is subtracted so the
   * caps mean "failures before this one", and every OTHER in-flight attempt
   * still counts. Never throws: an unreadable count degrades to the ledger.
   */
  private async assess(
    account: AttemptAccount,
    kind: AttemptKind,
    source: string,
    own: 0 | 1,
  ): Promise<AttemptStanding> {
    const limits = ATTEMPT_LIMITS[kind];
    const now = Date.now();
    const local = this.localCounts(kind, account.id, source, now);

    let counts: AttemptCounts;
    let degraded = false;
    try {
      const db = await this.countAttempts(account, kind, source);
      counts = {
        account: db.account + local.unpersisted.account,
        source: db.source + local.unpersisted.source,
        block: db.block + local.unpersisted.block,
        hard: db.hard + local.unpersisted.hard,
        lastRefusalAt: db.lastRefusalAt,
      };
    } catch (err) {
      degraded = true;
      counts = { ...local.all, lastRefusalAt: null };
      this.logger.error(
        `Attempt count unreadable for user ${account.id} (${kind}); deciding on ` +
          `this process's ledger only: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    const prior = (n: number) => Math.max(0, n - own);
    const accountFailures = prior(counts.account);
    const backstop = accountFailures >= limits.accountBackstop;
    // Once the account is under attack, a source is its /24 or /48.
    const sourceFailures = prior(backstop ? counts.block : counts.source);
    const allowed = backstop ? limits.perSourceUnderBackstop : limits.perSource;
    const hardLocked =
      kind === 'mfa' && prior(counts.hard) >= MFA_HARD_CAP.failures;
    return {
      locked: hardLocked || sourceFailures >= allowed,
      sourceFailures,
      accountFailures,
      backstop,
      hardLocked,
      lastRefusalAt: counts.lastRefusalAt,
      degraded,
    };
  }

  /**
   * The count query. Throws — `assess` catches, `selfTest` does not.
   *
   * Tenant scope: bound to account.tenantId (RLS on both tables) and the
   * explicit "tenantId" predicate on both. Failures at or before the latest
   * audited operator unlock do not count, for either kind; MFA failures
   * also stop counting at the latest password reset. Both boundaries are
   * written from the database clock (`databaseNow`), the clock that stamps
   * `createdAt`, so no LEAST(…, now()) cap: measured against a real Postgres,
   * that cap never stopped a future boundary anyway (every counted row is
   * older than the reading statement's now()). `a."tenantId" = $1` must stay
   * before the subqueries: it is what types $1 as uuid.
   */
  private async countAttempts(
    account: AttemptAccount,
    kind: AttemptKind,
    source: string,
  ): Promise<AttemptCounts> {
    const limits = ATTEMPT_LIMITS[kind];
    const now = Date.now();
    const since = new Date(now - limits.windowMs);
    // How far back any count reaches: 24 h for the MFA hard cap.
    const floor = kind === 'mfa' ? new Date(now - MFA_HARD_CAP.windowMs) : since;
    const credentialReset =
      kind === 'mfa'
        ? `,
             (SELECT MAX((l.context ->> 'credentialSetAt')::timestamptz) FROM "audit_logs" l
              WHERE l."tenantId" = $1::text
                AND l."entityType" = 'user'
                AND l."entityId" = $2::text
                AND l."action" = 'token_redeemed')`
        : '';
    const sql = `SELECT
             COUNT(*) FILTER (WHERE a."outcome" = 'failed' AND a."createdAt" > $5) AS account_failures,
             COUNT(*) FILTER (WHERE a."outcome" = 'failed' AND a."createdAt" > $5 AND a."source" = $4) AS source_failures,
             COUNT(*) FILTER (WHERE a."outcome" = 'failed' AND a."createdAt" > $5 AND a."source" LIKE $7) AS wide_source_failures,
             COUNT(*) FILTER (WHERE a."outcome" = 'failed') AS hard_failures,
             MAX(a."createdAt") FILTER (WHERE a."outcome" = 'refused_locked' AND a."source" = $4) AS last_refusal
           FROM "auth_attempts" a
           WHERE a."tenantId" = $1
             AND a."userId" = $2
             AND a."kind" = $3
             AND a."createdAt" > GREATEST($6::timestamptz, COALESCE(GREATEST((
               SELECT MAX((l.context ->> 'unlockedAt')::timestamptz) FROM "audit_logs" l
               WHERE l."tenantId" = $1::text
                 AND l."entityType" = 'user'
                 AND l."entityId" = $2::text
                 AND l.context ->> 'event' = 'auth.login.unlocked'
             )${credentialReset}), $6::timestamptz))`;
    const rows = await TenantContext.run({ tenantId: account.tenantId }, () =>
      this.bounded(READ_LOCK_TIMEOUT, READ_STATEMENT_TIMEOUT, (em) =>
        em.query(sql, [
          account.tenantId,
          account.id,
          kind,
          source,
          since,
          floor,
          blockPattern(source),
        ]),
      ),
    );
    const row = rows?.[0] ?? {};
    return {
      account: Number(row.account_failures ?? 0),
      source: Number(row.source_failures ?? 0),
      block: Number(row.wide_source_failures ?? 0),
      hard: Number(row.hard_failures ?? 0),
      lastRefusalAt: row.last_refusal ? new Date(row.last_refusal) : null,
    };
  }

  /** One transaction with `SET LOCAL` lock and statement bounds. */
  private bounded<T>(
    lockTimeout: string,
    statementTimeout: string,
    fn: (em: { query: (sql: string, params?: unknown[]) => Promise<any> }) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      await em.query(`SET LOCAL statement_timeout = '${statementTimeout}'`);
      return fn(em);
    });
  }

  private async insert(
    account: AttemptAccount,
    kind: AttemptKind,
    outcome: AttemptOutcome,
    source: string,
  ): Promise<string | null> {
    // Tenant scope: written into account.tenantId, bound for RLS WITH CHECK.
    const rows = await TenantContext.run({ tenantId: account.tenantId }, () =>
      this.bounded(WRITE_LOCK_TIMEOUT, WRITE_STATEMENT_TIMEOUT, (em) =>
        em.query(
          `INSERT INTO "auth_attempts" ("tenantId", "userId", "kind", "outcome", "source") VALUES ($1, $2, $3, $4, $5) RETURNING "id"`,
          [account.tenantId, account.id, kind, outcome, source],
        ),
      ),
    );
    return rows?.[0]?.id ?? null;
  }

  /** How long the ledger keeps an entry of this kind. */
  private ledgerWindow(kind: AttemptKind): number {
    return kind === 'mfa'
      ? Math.max(ATTEMPT_LIMITS.mfa.windowMs, MFA_HARD_CAP.windowMs)
      : ATTEMPT_LIMITS[kind].windowMs;
  }

  private remember(kind: AttemptKind, userId: string, source: string): LedgerEntry {
    const key = `${kind}|${userId}`;
    const cutoff = Date.now() - this.ledgerWindow(kind);
    const entries = (this.ledger.get(key) ?? []).filter((e) => e.at > cutoff);
    const entry: LedgerEntry = { at: Date.now(), source, persisted: false };
    entries.push(entry);
    if (entries.length > LEDGER_MAX_PER_ACCOUNT) entries.shift();
    if (!this.ledger.has(key) && this.ledger.size >= LEDGER_MAX_ACCOUNTS) {
      // Oldest-inserted account first; Map iteration order is insertion order.
      const oldest = this.ledger.keys().next().value;
      if (oldest !== undefined) this.ledger.delete(oldest);
    }
    this.ledger.set(key, entries);
    return entry;
  }

  private forget(ticket: AttemptTicket): void {
    const entries = this.ledger.get(`${ticket.kind}|${ticket.account.id}`);
    const i = entries?.indexOf(ticket.entry) ?? -1;
    if (i >= 0) entries!.splice(i, 1);
  }

  private localCounts(
    kind: AttemptKind,
    userId: string,
    source: string,
    now: number,
  ) {
    const since = now - ATTEMPT_LIMITS[kind].windowMs;
    const all = (this.ledger.get(`${kind}|${userId}`) ?? []).filter(
      (e) => e.at > now - this.ledgerWindow(kind),
    );
    const tally = (entries: LedgerEntry[]) => {
      const inWindow = entries.filter((e) => e.at > since);
      return {
        account: inWindow.length,
        source: inWindow.filter((e) => e.source === source).length,
        block: inWindow.filter((e) => inBlock(e.source, source)).length,
        hard: kind === 'mfa' ? entries.length : 0,
      };
    };
    return {
      all: tally(all),
      unpersisted: tally(all.filter((e) => !e.persisted)),
    };
  }
}
