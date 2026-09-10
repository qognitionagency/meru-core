import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per `(tenantId, series)`: the last number issued in that series.
 * ADR 0010 §2.2.
 *
 * Registered in `src/config/entities.ts` even though every read and write goes
 * through the single raw `INSERT … ON CONFLICT … RETURNING` in
 * `src/crm/record-identity.ts` rather than this repository. That catalogue is
 * what the control-plane and the two vertical DataSources both load, and its
 * own comment says why a table missing from it is a schema drift waiting to
 * happen: the meru/govx/immistack schemas must not diverge.
 *
 * Deliberately NOT reachable through a repository in application code. The
 * only safe way to advance a counter is the atomic upsert; a `find`-then-`save`
 * pair through TypeORM would reintroduce exactly the read-then-write race the
 * ADR exists to avoid, and leaving no repository injected anywhere makes that
 * hard to do by accident.
 *
 * No `createdAt`: the row is created by the same statement that claims number
 * 1, so "when did this tenant's series start" is answerable from the first
 * numbered record's own `createdAt` and does not need a second column.
 */
@Entity('tenant_record_counters')
@Index(['tenantId'])
@Index(['tenantId', 'series'], { unique: true })
export class TenantRecordCounter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  /** `'CL'` (client) or `'CS'` (case) today. Additive — see `seriesFor`. */
  @Column({ type: 'varchar', length: 8 })
  series: string;

  /**
   * `bigint`, and therefore a **string** in JS: `pg` does not narrow a bigint
   * to a JS number because it cannot always do so losslessly. Every consumer
   * goes through `formatRecordNumber`, which normalises.
   */
  @Column({ type: 'bigint', default: 0 })
  value: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
