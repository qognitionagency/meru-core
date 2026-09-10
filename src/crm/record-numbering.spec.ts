import { CrmService } from './crm.service';
import { EntityType } from './entities/universal-entity.entity';
import { CrmAccessService } from './crm-access.service';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import {
  claimRecordNumber,
  formatRecordNumber,
  seriesFor,
} from './record-identity';

/**
 * ADR 0010 — client and case numbering.
 *
 * The concurrency requirement is the whole job, so most of this file is about
 * one property: two simultaneous creates for the same tenant and type can
 * never take the same number.
 *
 * **What the fake below actually models, and what it therefore proves.**
 * `FakeCounterDb` gives one guarantee and only one: *a single `query()` call
 * runs to completion without yielding the event loop; anything between two
 * `query()` calls may interleave arbitrarily.* That is precisely Postgres's
 * own guarantee for a single statement, and it is the guarantee ADR 0010 §2.2
 * relies on.
 *
 * So a service that computes its number inside ONE statement cannot collide
 * under this fake, and a service that needs two (read the max, then write it —
 * `BillingService.generateInvoiceNumber`'s shape) collides immediately. The
 * `it('has teeth')` control below demonstrates exactly that against the same
 * fake, so a green result here is not the fake being permissive.
 *
 * **What it does NOT prove:** that Postgres takes the row lock ADR 0010 §2.2
 * describes. Nothing in-process can prove that. The SQL-shape test pins the
 * statement that asks for it, and Owen's review plus `npm run rls:verify`
 * against a real database is where that half is confirmed.
 */

const STAFF_ACTOR = { id: 'staff-1', roles: [PlatformRole.FIRM_ADMIN] };
const TENANT = 't1';

/**
 * An in-memory stand-in for `tenant_record_counters` that honours the one
 * property that matters: a statement is atomic, the gaps between statements
 * are not.
 */
class FakeCounterDb {
  /** `${tenantId}:${series}` → last issued value. */
  private readonly counters = new Map<string, number>();
  /** Every SQL string this "database" was asked to run, in order. */
  readonly statements: string[] = [];

  /**
   * Atomic by construction: no `await` between reading and writing the map, so
   * the event loop cannot interleave another caller inside it — the same
   * indivisibility Postgres gives a single `INSERT … ON CONFLICT`.
   */
  query = (sql: string, params?: unknown[]): Promise<Array<{ value: string }>> => {
    this.statements.push(sql);

    if (/INSERT INTO "tenant_record_counters"/.test(sql)) {
      const [tenantId, series] = (params ?? []) as string[];
      const key = `${tenantId}:${series}`;
      const next = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, next);
      return Promise.resolve([{ value: String(next) }]);
    }

    throw new Error(`FakeCounterDb: unexpected statement — ${sql}`);
  };

  /** Undo one increment, the way a rolled-back transaction would. */
  rollbackOne(tenantId: string, series: string) {
    const key = `${tenantId}:${series}`;
    this.counters.set(key, (this.counters.get(key) ?? 1) - 1);
  }

  valueOf(tenantId: string, series: string) {
    return this.counters.get(`${tenantId}:${series}`) ?? 0;
  }
}

/**
 * A `DataSource` whose `QueryRunner` runs against `FakeCounterDb` and saves
 * into `rows`, yielding the event loop between the counter claim and the
 * insert. That yield is the point: it is where a second concurrent invocation
 * gets to run, and where a read-then-write implementation would lose.
 */
function buildDataSource(db: FakeCounterDb, rows: Record<string, any>[]) {
  let idSeq = 0;
  const claimedSeries: Array<{ tenantId: string; series: string }> = [];

  return {
    rows,
    claimedSeries,
    createQueryRunner: () => {
      let committed = false;
      return {
        connect: async () => undefined,
        startTransaction: async () => undefined,
        commitTransaction: async () => {
          committed = true;
        },
        rollbackTransaction: async () => {
          // Unwind the counter, exactly as a real ROLLBACK does — this is what
          // makes "no number is burned on a record that was never created"
          // testable rather than merely asserted in a comment.
          if (!committed) {
            const last = claimedSeries[claimedSeries.length - 1];
            if (last) db.rollbackOne(last.tenantId, last.series);
          }
        },
        release: async () => undefined,
        query: async (sql: string, params?: unknown[]) => {
          const result = await db.query(sql, params);
          const [tenantId, series] = (params ?? []) as string[];
          claimedSeries.push({ tenantId, series });
          // Yield. Between two statements, anything may run.
          await new Promise((r) => setImmediate(r));
          return result;
        },
        manager: {
          create: (_target: unknown, data: any) => ({ ...data }),
          save: async (a: any, b?: any) => {
            const entity = b ?? a;
            await new Promise((r) => setImmediate(r));
            const saved = { id: `e${++idSeq}`, ...entity };
            rows.push(saved);
            return saved;
          },
        },
      };
    },
  };
}

function buildService(db: FakeCounterDb, rows: Record<string, any>[] = []) {
  const entityRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((e: any) => Promise.resolve(e)),
    create: (x: any) => ({ ...x }),
  };
  const dataSource = buildDataSource(db, rows);
  const service = new CrmService(
    entityRepo as any,
    { getSettings: async () => ({ fields: [] }) } as any,
    { indexEntityData: async () => undefined } as any,
    {} as any,
    {} as any,
    new CrmAccessService(),
    {} as any,
    {} as any,
    dataSource as any,
  );
  return { service, entityRepo, dataSource, rows };
}

describe('seriesFor — which types are numbered (ADR 0010 §2.3)', () => {
  it('gives a person and an organization the client series', () => {
    expect(seriesFor(EntityType.PERSON)).toBe('CL');
    expect(seriesFor(EntityType.ORGANIZATION)).toBe('CL');
  });

  it('gives a case the case series, in either vertical', () => {
    // `case` is not immigration vocabulary — grc.json's
    // `aml-customer-onboarding` workflow uses it too. A GovX case gets a CS
    // number, which is a consequence of the type already being shared.
    expect(seriesFor(EntityType.CASE)).toBe('CS');
  });

  it('does not number a lead — a lead is not yet a client', () => {
    expect(seriesFor(EntityType.LEAD)).toBeNull();
  });

  it('numbers none of the structural or GovX module types', () => {
    for (const type of [
      EntityType.NOTE,
      EntityType.TAG,
      EntityType.ASSET,
      EntityType.OBLIGATION,
      EntityType.BREACH,
      EntityType.VENDOR,
      EntityType.SAR,
      EntityType.TRADE_INSTRUMENT,
    ]) {
      expect(seriesFor(type)).toBeNull();
    }
  });
});

describe('formatRecordNumber', () => {
  it('pads to six', () => {
    expect(formatRecordNumber('CL', 1)).toBe('CL-000001');
    expect(formatRecordNumber('CS', 42)).toBe('CS-000042');
  });

  it('treats the padding as a minimum, never a cap', () => {
    // A seventh digit must widen the number, not truncate or wrap it. No
    // tenant is realistically here, but the format must not misbehave at the
    // boundary and no future code change should be needed at it.
    expect(formatRecordNumber('CL', 1234567)).toBe('CL-1234567');
  });

  it('accepts the string a bigint column actually returns', () => {
    // `pg` does not narrow a bigint to a JS number. A implementation that
    // assumed a number would produce `CL-NaN`.
    expect(formatRecordNumber('CS', '7')).toBe('CS-000007');
  });
});

describe('claimRecordNumber', () => {
  it('advances the counter and renders the number', async () => {
    const db = new FakeCounterDb();
    await expect(claimRecordNumber(db as any, TENANT, 'CL')).resolves.toBe(
      'CL-000001',
    );
    await expect(claimRecordNumber(db as any, TENANT, 'CL')).resolves.toBe(
      'CL-000002',
    );
  });

  it('keeps the two series independent within a tenant', async () => {
    const db = new FakeCounterDb();
    await claimRecordNumber(db as any, TENANT, 'CL');
    await claimRecordNumber(db as any, TENANT, 'CL');
    await expect(claimRecordNumber(db as any, TENANT, 'CS')).resolves.toBe(
      'CS-000001',
    );
  });

  it('keeps two tenants independent', async () => {
    const db = new FakeCounterDb();
    await claimRecordNumber(db as any, 'tenant-a', 'CL');
    await expect(claimRecordNumber(db as any, 'tenant-b', 'CL')).resolves.toBe(
      'CL-000001',
    );
  });

  it('claims in ONE statement — no read-then-write pair', async () => {
    const db = new FakeCounterDb();
    await claimRecordNumber(db as any, TENANT, 'CL');

    expect(db.statements).toHaveLength(1);
    const sql = db.statements[0];
    expect(sql).toMatch(/ON CONFLICT \("tenantId", "series"\)/);
    expect(sql).toMatch(/DO UPDATE SET "value" = "tenant_record_counters"\."value" \+ 1/);
    expect(sql).toMatch(/RETURNING "value"/);
    // The shapes this must never become. `generateInvoiceNumber`
    // (billing.service.ts:626-630) is the live instance of the first one; this
    // assertion is what stops it being copied here later.
    expect(sql).not.toMatch(/SELECT/i);
    expect(sql).not.toMatch(/\bMAX\s*\(/i);
    expect(sql).not.toMatch(/COUNT\s*\(/i);
  });

  it('refuses to fabricate a number when the upsert returns nothing', async () => {
    // An empty result means the write did not land — most likely filtered by
    // RLS on an unbound connection. A number guessed at that point would be a
    // duplicate waiting to happen, and CLAUDE.md §5.2 forbids answering with
    // an invented value rather than an error.
    const silent = { query: async () => [] };
    await expect(
      claimRecordNumber(silent as any, TENANT, 'CL'),
    ).rejects.toThrow(/refusing to assign a number/);
  });
});

describe('CrmService.createEntity — numbering', () => {
  it('assigns a client number to a person', async () => {
    const db = new FakeCounterDb();
    const { service } = buildService(db);
    const saved = await service.createEntity(TENANT, {
      type: EntityType.PERSON,
      firstName: 'Priya',
      lastName: 'Sharma',
    });
    expect(saved.recordNumber).toBe('CL-000001');
  });

  it('assigns a case number to a case, from its own series', async () => {
    const db = new FakeCounterDb();
    const { service } = buildService(db);
    await service.createEntity(TENANT, { type: EntityType.PERSON });
    const kase = await service.createEntity(TENANT, { type: EntityType.CASE });
    // Not CS-000002: the case series starts at one regardless of how many
    // clients exist.
    expect(kase.recordNumber).toBe('CS-000001');
  });

  it('leaves a lead unnumbered rather than giving it a placeholder', async () => {
    const db = new FakeCounterDb();
    const { service } = buildService(db);
    const lead = await service.createEntity(TENANT, { type: EntityType.LEAD });
    expect(lead.recordNumber).toBeNull();
    expect(db.statements).toHaveLength(0);
  });

  it('burns no number when the insert fails', async () => {
    const db = new FakeCounterDb();
    const { service, dataSource } = buildService(db);
    const realRunner = dataSource.createQueryRunner;
    dataSource.createQueryRunner = () => {
      const runner = realRunner();
      runner.manager.save = async () => {
        throw new Error('insert exploded');
      };
      return runner;
    };

    await expect(
      service.createEntity(TENANT, { type: EntityType.PERSON }),
    ).rejects.toThrow(/insert exploded/);

    // Rolled back with the transaction, so the next real create is still #1.
    expect(db.valueOf(TENANT, 'CL')).toBe(0);
  });
});

describe('CrmService.convertEntity — numbering (ADR 0010 §2.4)', () => {
  const buildConvert = (db: FakeCounterDb, entity: Record<string, any>) => {
    const entityRepo = {
      findOne: jest.fn().mockResolvedValue(entity),
      save: jest.fn((e: any) => Promise.resolve(e)),
    };
    const dataSource = buildDataSource(db, []);
    const service = new CrmService(
      entityRepo as any,
      {} as any,
      { indexEntityData: async () => undefined } as any,
      {} as any,
      {} as any,
      new CrmAccessService(),
      {} as any,
      {} as any,
      dataSource as any,
    );
    return { service, dataSource };
  };

  it('gives a converting lead the number it never had', async () => {
    const db = new FakeCounterDb();
    const { service } = buildConvert(db, {
      id: 'e1',
      tenantId: TENANT,
      type: EntityType.LEAD,
      recordNumber: null,
      verticalAttributes: {},
    });

    const saved = await service.convertEntity(
      'e1',
      TENANT,
      STAFF_ACTOR,
      EntityType.PERSON,
    );
    expect(saved.recordNumber).toBe('CL-000001');
  });

  it('does not claim a second number when a numbered record changes type', async () => {
    // PERSON → ORGANIZATION → PERSON must not walk the counter. A number, once
    // issued, belongs to the record for as long as the record exists.
    const db = new FakeCounterDb();
    const { service } = buildConvert(db, {
      id: 'e1',
      tenantId: TENANT,
      type: EntityType.PERSON,
      recordNumber: 'CL-000007',
      verticalAttributes: {},
    });

    const saved = await service.convertEntity(
      'e1',
      TENANT,
      STAFF_ACTOR,
      EntityType.ORGANIZATION,
    );
    expect(saved.recordNumber).toBe('CL-000007');
    expect(db.statements).toHaveLength(0);
  });

  it('never derives a name from verticalAttributes on the way through', async () => {
    // ADR 0011 §2.2's load-bearing NEGATIVE guarantee. The lead's intake form
    // put a name in `verticalAttributes.lead.fields`; core does not know that
    // is where it lives (it could equally be `lead.first_name` or
    // `applicant.name`), so it must not promote it. The producer populates the
    // promoted columns at creation — see leads.service.ts, Mira's half.
    const db = new FakeCounterDb();
    const { service } = buildConvert(db, {
      id: 'e1',
      tenantId: TENANT,
      type: EntityType.LEAD,
      recordNumber: null,
      firstName: null,
      lastName: null,
      verticalAttributes: {
        lead: { fields: { first_name: 'Priya', last_name: 'Sharma' } },
      },
    });

    const saved = await service.convertEntity(
      'e1',
      TENANT,
      STAFF_ACTOR,
      EntityType.PERSON,
    );
    expect(saved.firstName).toBeNull();
    expect(saved.lastName).toBeNull();
    // …and the record is still identifiable, which is the whole point of the
    // number anchoring ADR 0011's fallback chain.
    expect(saved.recordNumber).toBe('CL-000001');
  });

  it('hands back no number when the conversion write fails', async () => {
    const db = new FakeCounterDb();
    const entity = {
      id: 'e1',
      tenantId: TENANT,
      type: EntityType.LEAD,
      recordNumber: null,
      verticalAttributes: {},
    };
    const { service, dataSource } = buildConvert(db, entity);
    const realRunner = dataSource.createQueryRunner;
    dataSource.createQueryRunner = () => {
      const runner = realRunner();
      runner.manager.save = async () => {
        throw new Error('convert exploded');
      };
      return runner;
    };

    await expect(
      service.convertEntity('e1', TENANT, STAFF_ACTOR, EntityType.PERSON),
    ).rejects.toThrow(/convert exploded/);

    expect(db.valueOf(TENANT, 'CL')).toBe(0);
    // The in-memory row must not keep a number the database never issued.
    expect(entity.recordNumber).toBeNull();
  });
});

describe('concurrency — two simultaneous creates cannot take the same number', () => {
  it('issues 25 distinct, contiguous client numbers under full contention', async () => {
    const db = new FakeCounterDb();
    const { service } = buildService(db);

    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        service.createEntity(TENANT, { type: EntityType.PERSON }),
      ),
    );

    const numbers = results.map((r) => r.recordNumber);
    expect(new Set(numbers).size).toBe(25);
    expect([...numbers].sort()).toEqual(
      Array.from({ length: 25 }, (_, i) => formatRecordNumber('CL', i + 1)),
    );
  });

  it('does not let a tenant’s client and case writers block or collide with each other', async () => {
    const db = new FakeCounterDb();
    const { service } = buildService(db);

    const results = await Promise.all([
      ...Array.from({ length: 10 }, () =>
        service.createEntity(TENANT, { type: EntityType.PERSON }),
      ),
      ...Array.from({ length: 10 }, () =>
        service.createEntity(TENANT, { type: EntityType.CASE }),
      ),
    ]);

    const clients = results
      .map((r) => r.recordNumber!)
      .filter((n) => n.startsWith('CL-'));
    const cases = results
      .map((r) => r.recordNumber!)
      .filter((n) => n.startsWith('CS-'));

    expect(new Set(clients).size).toBe(10);
    expect(new Set(cases).size).toBe(10);
  });

  it('keeps two tenants’ concurrent creates entirely separate', async () => {
    const db = new FakeCounterDb();
    const { service } = buildService(db);

    const results = await Promise.all([
      ...Array.from({ length: 8 }, () =>
        service.createEntity('tenant-a', { type: EntityType.PERSON }),
      ),
      ...Array.from({ length: 8 }, () =>
        service.createEntity('tenant-b', { type: EntityType.PERSON }),
      ),
    ]);

    // Both tenants independently issue CL-000001..CL-000008. Sixteen records,
    // eight distinct numbers — that is correct, not a collision: uniqueness is
    // per tenant.
    expect(new Set(results.map((r) => r.recordNumber)).size).toBe(8);
    expect(db.valueOf('tenant-a', 'CL')).toBe(8);
    expect(db.valueOf('tenant-b', 'CL')).toBe(8);
  });

  it('has teeth: the count()+1 shape collides under the same conditions', async () => {
    // The control. Without this, a green suite above could just mean the fake
    // never interleaves. This is `BillingService.generateInvoiceNumber`'s
    // shape — read, await, write — run against the same event loop, and it
    // duplicates immediately.
    const counters = new Map<string, number>();
    const racyClaim = async (key: string) => {
      const current = counters.get(key) ?? 0;
      await new Promise((r) => setImmediate(r)); // the window
      const next = current + 1;
      counters.set(key, next);
      return formatRecordNumber('CL', next);
    };

    const racy = await Promise.all(
      Array.from({ length: 25 }, () => racyClaim(`${TENANT}:CL`)),
    );

    expect(new Set(racy).size).toBeLessThan(25);
  });
});
