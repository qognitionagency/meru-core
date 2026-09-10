import type { EntityManager, QueryRunner } from 'typeorm';
import { EntityType } from './entities/universal-entity.entity';

/**
 * Record identity — ADR 0010 (client/case numbering) and ADR 0011 (the
 * record-identity contract).
 *
 * A leaf file on purpose. `ImportService` is a third producer of
 * `person`/`organization`/`lead` rows and needs the same counter mechanism
 * `CrmService` uses; importing `crm.service.ts` from `src/integrations/` would
 * drag the whole CRM provider graph (documents, search, rules) across a module
 * boundary for two pure functions. Nothing here injects anything.
 */

/**
 * The types a vertical's configured field list actually describes — the
 * "Client"/"Applicant"/"Patient" that `VerticalConfig.entityName` names.
 * Structural records (note, tag) and workable ones (case, obligation, breach)
 * carry their own attributes and are not held to the subject's schema.
 *
 * Lives here rather than in `crm.service.ts` so `seriesFor` below and the
 * required-field check in `createEntity` read the SAME definition of "what
 * counts as a client" (ADR 0010 §2.3). Two lists would drift, and the drift
 * would be silent: a type numbered `CL-` but not held to the subject schema,
 * or the reverse.
 */
export const SUBJECT_TYPES: ReadonlySet<EntityType> = new Set([
  EntityType.PERSON,
  EntityType.ORGANIZATION,
]);

/** The counter series a record number is drawn from. Additive. */
export type RecordSeries = 'CL' | 'CS';

/**
 * Which series, if any, a type draws from — ADR 0010 §2.3.
 *
 * `EntityType.CASE` is core-neutral, not immigration vocabulary: GRC's own
 * base pack uses it (`packages/config-packs/verticals/grc.json`, the
 * `aml-customer-onboarding` workflow's `entityType: "case"`). A GRC case gets
 * a `CS-` number, which is a consequence of the type already being shared.
 *
 * `EntityType.LEAD` is deliberately absent: a lead is prospective, not yet a
 * client. It is given a number at the moment it converts (§2.4).
 *
 * A third series (an obligation number, a SAR number) is one more branch here
 * and no migration — the counter table is keyed on the series string.
 */
export function seriesFor(type: EntityType): RecordSeries | null {
  if (SUBJECT_TYPES.has(type)) return 'CL';
  if (type === EntityType.CASE) return 'CS';
  return null;
}

/**
 * Render a claimed counter value. Padding is a MINIMUM, not a cap: 1234567
 * renders `CL-1234567`, not a truncated or wrapped value.
 *
 * `value` arrives as a string from `pg` (the column is `bigint`, which the
 * driver does not narrow to a JS number because it cannot always), so this
 * takes `string | number` and normalises rather than assuming either.
 */
export function formatRecordNumber(
  series: RecordSeries,
  value: string | number,
): string {
  return `${series}-${String(value).padStart(6, '0')}`;
}

/**
 * Claim the next number in a tenant's series — ADR 0010 §2.2.
 *
 * ONE statement. Postgres takes a row lock on the conflicting
 * `("tenantId", "series")` row as part of evaluating `ON CONFLICT`, so a
 * second concurrent session blocks until the first commits or rolls back and
 * then reads the now-current value. There is no window between a read and a
 * write for a second invocation to fit into.
 *
 * That window is exactly what `BillingService.generateInvoiceNumber`
 * (`billing.service.ts:626-630`) has — `count()` then `+1` — and under Vercel,
 * where every request is its own function instance with its own pool of
 * `max: 1`, two callers routinely land inside it. This is deliberately not
 * that shape. (Backporting this onto invoices is its own ticket; it is not
 * done here.)
 *
 * Contention is scoped to one `(tenantId, series)` row, so two tenants — or
 * one tenant's client-numbering and case-numbering writers — never block each
 * other.
 *
 * **Tenant scope:** the `tenantId` written here is always the server-derived
 * one from the caller's JWT (`req.user.tenantId`), never a body field, and
 * `tenant_record_counters` carries ENABLE + FORCE RLS with a `tenant_isolation`
 * policy whose `WITH CHECK` refuses an insert for any other tenant. Both
 * layers, per CLAUDE.md §8.
 *
 * @param runner The `QueryRunner` (or `EntityManager`) whose transaction the
 *   claim must share with the entity insert. Rolling that transaction back
 *   rolls the increment back too, so no number is burned on a record that was
 *   never created.
 */
export async function claimRecordNumber(
  runner: QueryRunner | EntityManager,
  tenantId: string,
  series: RecordSeries,
): Promise<string> {
  const rows = (await runner.query(
    `INSERT INTO "tenant_record_counters" ("tenantId", "series", "value", "updatedAt")
     VALUES ($1, $2, 1, now())
     ON CONFLICT ("tenantId", "series")
     DO UPDATE SET "value" = "tenant_record_counters"."value" + 1, "updatedAt" = now()
     RETURNING "value"`,
    [tenantId, series],
  )) as Array<{ value: string | number }>;

  const value = rows?.[0]?.value;
  if (value === undefined || value === null) {
    // Never fabricate a number. A counter that did not return a value means
    // the write did not land — most likely filtered by RLS on an unbound
    // connection — and a record numbered from a guess is worse than a record
    // that failed to create (CLAUDE.md §5.2).
    throw new Error(
      `Record numbering: the counter upsert for tenant ${tenantId} series ` +
        `'${series}' returned no value — refusing to assign a number.`,
    );
  }

  return formatRecordNumber(series, value);
}
