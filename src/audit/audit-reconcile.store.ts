import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

export interface ReconcileCursor {
  timestamp: Date;
  id: string;
}

/**
 * The three reads `AuditReconcilerService` makes against `audit_logs`.
 *
 * **Tenancy.** The reconciler runs under `TenantContext.runAsSystem` because
 * it sweeps every tenant, so RLS is bypassed on these connections and is not
 * what scopes them. `pageStaleRequests` is the one deliberately cross-tenant
 * read (it finds candidates in every tenant). The other two take the request
 * row's `tenantId` and put it in the `WHERE` clause; the service then checks
 * the tenant of every row they return a second time, so a mistake here cannot
 * answer one tenant's request with another tenant's row.
 *
 * `[UNVERIFIED: these query-builder statements have not been run against
 * Postgres — no database was touched in this change. The service logic is
 * covered by audit-reconciler.spec.ts over an in-memory store.]`
 *
 * Cost: `context` is jsonb with no index on `event` or `changeId`, so
 * `pageStaleRequests` scans the `audit_logs` rows older than the cutoff on
 * every run, and answered requests are re-read daily. Fine at today's volume;
 * an expression index on `(context->>'changeId')` is the fix when it is not,
 * and that is a migration (Kyle).
 */
@Injectable()
export class AuditReconcileStore {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  /**
   * `*.requested` rows carrying a `changeId`, older than `cutoff`, keyset-paged,
   * that do NOT already have an outcome row for their own family.
   *
   * The exclusion (Owen's gate): without it every run re-read the whole
   * answered history from the oldest row, so a long history could exhaust the
   * time budget before reaching a newer orphan, run after run. A request is
   * excluded when another row in the SAME tenant with the SAME `changeId`
   * carries `<family>.not_applied`, `<family>.reconciled` or the family's
   * applied event (`appliedByFamily`, passed in by the service, which owns
   * it). Those are the three outcomes `isAnswered` checks, so this only drops
   * rows the service would skip anyway; the service still checks each row.
   * Requests answered only by `isAnswered`'s single-step fallback are not
   * excluded here and are still re-read.
   */
  pageStaleRequests(
    cutoff: Date,
    after: ReconcileCursor | null,
    limit: number,
    appliedByFamily: Readonly<Record<string, string>> = {},
  ): Promise<AuditLog[]> {
    // `family` = the request event minus '.requested' (10 characters).
    const family = `left(a.context ->> 'event', -10)`;
    const appliedCase = Object.entries(appliedByFamily)
      .map(([, ], i) => `WHEN :reqEvent${i} THEN :appliedEvent${i}`)
      .join(' ');
    const appliedParams = Object.entries(appliedByFamily).reduce(
      (acc, [fam, applied], i) => ({
        ...acc,
        [`reqEvent${i}`]: `${fam}.requested`,
        [`appliedEvent${i}`]: applied,
      }),
      {} as Record<string, string>,
    );

    // Cross-tenant by design (see class comment). The NOT EXISTS correlates
    // on the candidate's own "tenantId", so it never reads across tenants.
    const qb = this.auditRepo
      .createQueryBuilder('a')
      .where(`a.context ->> 'event' LIKE :suffix`, { suffix: '%.requested' })
      .andWhere(`a.context ->> 'changeId' IS NOT NULL`)
      .andWhere('a.timestamp < :cutoff', { cutoff })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM audit_logs o
          WHERE o."tenantId" = a."tenantId"
            AND o.context ->> 'changeId' = a.context ->> 'changeId'
            AND o.id <> a.id
            AND o.context ->> 'event' IN (
              ${family} || '.not_applied',
              ${family} || '.reconciled'` +
          (appliedCase
            ? `,
              CASE a.context ->> 'event' ${appliedCase} END`
            : '') +
          `))`,
        appliedParams,
      );
    if (after) {
      qb.andWhere(
        '(a.timestamp > :afterTs OR (a.timestamp = :afterTs AND a.id > :afterId))',
        { afterTs: after.timestamp, afterId: after.id },
      );
    }
    return qb
      .orderBy('a.timestamp', 'ASC')
      .addOrderBy('a.id', 'ASC')
      .limit(limit)
      .getMany();
  }

  /** Every row in one tenant carrying one of these `changeId`s. */
  findByChangeIds(tenantId: string, changeIds: string[]): Promise<AuditLog[]> {
    if (changeIds.length === 0) return Promise.resolve([]);
    // Tenant scope: explicit "tenantId" predicate (RLS is bypassed here).
    return this.auditRepo
      .createQueryBuilder('a')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere(`a.context ->> 'changeId' IN (:...changeIds)`, { changeIds })
      .getMany();
  }

  /**
   * Requests for the same entity in the same tenant, stamped after `after`,
   * from a different call. At most a handful are needed: one is enough.
   */
  findLaterRequests(
    tenantId: string,
    entityType: string,
    entityId: string,
    after: Date,
    excludeChangeId: string,
  ): Promise<AuditLog[]> {
    // Tenant scope: explicit "tenantId" predicate (RLS is bypassed here).
    return this.auditRepo
      .createQueryBuilder('a')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere('a.entityType = :entityType', { entityType })
      .andWhere('a.entityId = :entityId', { entityId })
      .andWhere(`a.context ->> 'event' LIKE :suffix`, { suffix: '%.requested' })
      .andWhere('a.timestamp > :after', { after })
      .andWhere(
        `(a.context ->> 'changeId' IS NULL OR a.context ->> 'changeId' <> :excludeChangeId)`,
        { excludeChangeId },
      )
      .limit(5)
      .getMany();
  }
}
