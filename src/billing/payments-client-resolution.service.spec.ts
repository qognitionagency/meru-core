import { PaymentsService } from './payments.service';
import { PaymentDirection, PaymentStatus } from './entities/payment.entity';
import { User } from '../iam/entities/user.entity';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import {
  EntityType,
  UniversalEntity,
} from '../crm/entities/universal-entity.entity';

/**
 * An in-memory stand-in for the `payments` query builder that `list` and
 * `summary` use, interpreting the WHERE clauses rather than recording them —
 * so a test asserts on which rows come back, not on what SQL was written.
 *
 * Understands exactly two clause shapes, `p."col" = :param` and
 * `p."col" IN (:...param)`, and throws on anything else: a clause this fake
 * silently ignored would widen the result and let a scoping bug pass.
 */
function fakePaymentQb(rows: Array<Record<string, unknown>>) {
  const preds: Array<(r: Record<string, unknown>) => boolean> = [];
  let skip = 0;
  let take = Number.POSITIVE_INFINITY;

  const clause = (sql: string, params: Record<string, unknown> = {}) => {
    const m = /^p\.(?:"(\w+)"|(\w+)) (=|IN) \(?:(\.\.\.)?(\w+)\)?$/.exec(
      sql.trim(),
    );
    if (!m) throw new Error(`fake payments qb does not understand: ${sql}`);
    const col = m[1] ?? m[2];
    const value = params[m[5]];
    if (m[3] === 'IN') {
      if (!Array.isArray(value)) throw new Error(`IN needs an array: ${sql}`);
      preds.push((r) => value.includes(r[col]));
    } else {
      preds.push((r) => r[col] === value);
    }
  };

  const filtered = () => rows.filter((r) => preds.every((p) => p(r)));

  const qb: Record<string, (...a: any[]) => unknown> = {
    where: (sql: string, params?: Record<string, unknown>) => {
      clause(sql, params);
      return qb;
    },
    andWhere: (sql: string, params?: Record<string, unknown>) => {
      clause(sql, params);
      return qb;
    },
    orderBy: () => qb,
    select: () => qb,
    addSelect: () => qb,
    groupBy: () => qb,
    addGroupBy: () => qb,
    skip: (n: number) => {
      skip = n;
      return qb;
    },
    take: (n: number) => {
      take = n;
      return qb;
    },
    getManyAndCount: () => {
      const all = filtered();
      return Promise.resolve([all.slice(skip, skip + take), all.length]);
    },
    // Mirrors the GROUP BY currency, status, direction in `summary`; bigint
    // sums and counts come back as strings, as they do from Postgres.
    getRawMany: () => {
      const groups = new Map<string, Record<string, unknown>>();
      for (const r of filtered()) {
        const key = `${r.currency}|${r.status}|${r.direction}`;
        const g = groups.get(key) ?? {
          currency: r.currency,
          status: r.status,
          direction: r.direction,
          sum: '0',
          count: '0',
        };
        g.sum = String(Number(g.sum) + Number(r.amountMinor));
        g.count = String(Number(g.count) + 1);
        groups.set(key, g);
      }
      return Promise.resolve([...groups.values()]);
    },
  };
  return qb;
}

/**
 * The defect this spec closes: the only UI that raises a charge (ImmiStack's
 * `/clients/:id` page, via `RequestPaymentDialog`) knows a client only as a
 * CRM `universal_entities.id` — a client is a Universal Entity of
 * `type: 'person'` before they are ever a `users` row. `Payment.clientId` is
 * documented, and enforced by `clientScope` in `PaymentsController`, to be
 * `users.id`. Left unresolved, every charge staff wrote stored an id that
 * could never equal a real client's `req.user.id`, so `GET /payments` and
 * `/payments/summary` came back empty for every real client login — always,
 * and silently: an honest-looking "nothing recorded" hiding a broken join
 * (CLAUDE.md §5.2).
 *
 * These tests drive `PaymentsService.create` — the one place resolution
 * happens — through a fake `DataSource` standing in for `users` and
 * `universal_entities`, and a `paymentRepo` fake real enough to answer
 * `findOne` from what `create` actually wrote, so "visible to the resolved
 * client, invisible to anyone else" is proven end to end rather than assumed.
 */
describe('PaymentsService — resolving clientId to a real user', () => {
  const TENANT = 't1';

  const build = (opts: {
    users?: Array<{
      id: string;
      tenantId: string;
      email: string;
      roles?: string[];
    }>;
    people?: Array<{
      id: string;
      tenantId: string;
      type: EntityType;
      email: string | null;
      firstName?: string;
    }>;
    /** Pre-existing ledger rows, for the read-path tests. */
    payments?: Array<Record<string, unknown>>;
  }) => {
    // Every fixture user is a client unless a test says otherwise — the
    // negative case (a staff/admin id passed as clientId) sets `roles`
    // explicitly.
    const users = (opts.users ?? []).map((u) => ({
      roles: [PlatformRole.CLIENT],
      ...u,
    }));
    const people = opts.people ?? [];

    // Real enough to answer `findOne({ where })` the way TypeORM would —
    // every key in `where` must match — which is what lets the "visible to
    // the resolved client" tests below read back what `create` wrote.
    const rows: Array<Record<string, unknown>> = [...(opts.payments ?? [])];
    let nextId = 1;
    const paymentRepo = {
      createQueryBuilder: () => fakePaymentQb(rows),
      create: (x: Record<string, unknown>) => x,
      save: (x: Record<string, unknown>) => {
        const row = { ...x, id: `p${nextId++}` };
        rows.push(row);
        return Promise.resolve(row);
      },
      findOne: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows.find((r) =>
            Object.entries(where).every(([k, v]) => r[k] === v),
          ) ?? null,
        ),
    };

    // Both lookups match on EVERY key in `where` and on nothing else, the way
    // TypeORM does — so a lookup that forgot `tenantId` really would reach
    // another tenant's row here, and the tenancy test below can see it.
    const matchesWhere = (row: object, where: Record<string, unknown>) =>
      Object.entries(where).every(
        ([k, v]) => (row as Record<string, unknown>)[k] === v,
      );

    const userRepo = {
      findOne: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(users.find((u) => matchesWhere(u, where)) ?? null),
      // Stands in for `.createQueryBuilder('u').where(...).andWhere('LOWER(u.email) = LOWER(:email)', ...)`
      // in resolveClientUserId — matches case-insensitively, same as the real
      // SQL, because neither side normalises email case on write.
      createQueryBuilder: () => {
        let tenantNeedle = '';
        let emailNeedle = '';
        const qb = {
          where: (_c: string, params: Record<string, unknown>) => {
            tenantNeedle = params.tenantId as string;
            return qb;
          },
          andWhere: (_c: string, params: Record<string, unknown>) => {
            emailNeedle = (params.email as string).toLowerCase();
            return qb;
          },
          getOne: () =>
            Promise.resolve(
              users.find(
                (u) =>
                  u.tenantId === tenantNeedle &&
                  u.email.toLowerCase() === emailNeedle,
              ) ?? null,
            ),
        };
        return qb;
      },
    };

    const personRepo = {
      findOne: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(people.find((p) => matchesWhere(p, where)) ?? null),
    };

    const dataSource = {
      getRepository: (entity: unknown) => {
        if (entity === User) return userRepo;
        if (entity === UniversalEntity) return personRepo;
        throw new Error(`unexpected repository requested in test: ${entity}`);
      },
    };

    const service = new PaymentsService(paymentRepo as any, dataSource as any);
    return { service, rows };
  };

  it('uses a real users.id as-is when that is what was sent', async () => {
    const { service, rows } = build({
      users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
    });

    await service.create(TENANT, {
      clientId: 'user-1',
      amountMinor: 45000,
      currency: 'AUD',
      description: 'Consultation',
    } as never);

    expect(rows[0].clientId).toBe('user-1');
  });

  it('resolves a CRM person id to the users row sharing its email', async () => {
    const { service, rows } = build({
      users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: 'ana@example.com',
          firstName: 'Ana',
        },
      ],
    });

    await service.create(TENANT, {
      clientId: 'person-1', // the id the client-detail page actually has
      amountMinor: 45000,
      currency: 'AUD',
      description: 'Application fee',
    } as never);

    // Stored under the REAL users.id, not the CRM entity id the caller sent —
    // this is the whole point: `clientScope` compares against `req.user.id`,
    // which is `user-1`, never `person-1`.
    expect(rows[0].clientId).toBe('user-1');
  });

  it('matches email case-insensitively — neither side normalises case on write', async () => {
    const { service, rows } = build({
      users: [{ id: 'user-1', tenantId: TENANT, email: 'Ana@Example.com' }],
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: 'ana@example.com',
        },
      ],
    });

    await service.create(TENANT, {
      clientId: 'person-1',
      amountMinor: 100,
      currency: 'AUD',
      description: 'Fee',
    } as never);

    expect(rows[0].clientId).toBe('user-1');
  });

  it('refuses the write when the person has never been invited, rather than storing an unresolvable id', async () => {
    const { service, rows } = build({
      users: [],
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: 'not-yet-invited@example.com',
          firstName: 'Bilal',
        },
      ],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/has not been invited yet/);

    // The earlier failure mode was a row saved with an id nothing could ever
    // match. The fix is not to save a different, still-wrong id — it is to
    // refuse the write. No row at all.
    expect(rows).toHaveLength(0);
  });

  it('404s a clientId that names neither a user nor a person record', async () => {
    const { service } = build({});

    await expect(
      service.create(TENANT, {
        clientId: 'nothing-here',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/no client with that id/i);
  });

  it('refuses a person record with no email — nothing to match a user by', async () => {
    const { service } = build({
      people: [
        {
          id: 'person-1',
          tenantId: TENANT,
          type: EntityType.PERSON,
          email: null,
        },
      ],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/no email on file/);
  });

  it('refuses a staff id passed as clientId rather than resolving it as-is', async () => {
    // The direct-`users.id` fast path used to accept ANY user in the tenant.
    // A charge raised against a colleague's id by typo would then appear in
    // that colleague's own `GET /payments` — `Payment.clientId` is the
    // authorisation key for a client's ledger, and a staff id defeats that
    // by construction.
    const { service, rows } = build({
      users: [{ id: 'staff-1', tenantId: TENANT, email: 'staff@example.com', roles: [PlatformRole.STAFF] }],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'staff-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/not a client/i);

    expect(rows).toHaveLength(0);
  });

  it('refuses a firm_admin id passed as clientId, same as staff', async () => {
    const { service, rows } = build({
      users: [
        {
          id: 'admin-1',
          tenantId: TENANT,
          email: 'admin@example.com',
          roles: [PlatformRole.FIRM_ADMIN],
        },
      ],
    });

    await expect(
      service.create(TENANT, {
        clientId: 'admin-1',
        amountMinor: 100,
        currency: 'AUD',
        description: 'Fee',
      } as never),
    ).rejects.toThrow(/not a client/i);

    expect(rows).toHaveLength(0);
  });

  describe('what each login can see, once the id resolves correctly', () => {
    it("a charge raised against a CRM person id is visible to that person's own client login", async () => {
      const { service, rows } = build({
        users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
        people: [
          {
            id: 'person-1',
            tenantId: TENANT,
            type: EntityType.PERSON,
            email: 'ana@example.com',
          },
        ],
      });

      const created = await service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 45000,
        currency: 'AUD',
        description: 'Application fee',
      } as never);

      // `clientScope` forces a client-role caller's own `req.user.id` in here
      // as `forceClientId` — reproduced directly rather than through the
      // controller, since the controller is not part of this defect.
      await expect(
        service.findOne(TENANT, created.id, 'user-1'),
      ).resolves.toMatchObject({ id: created.id });
      expect(rows).toHaveLength(1);
    });

    it('a client still cannot see another client\'s charge, even though the row resolved cleanly', async () => {
      const { service } = build({
        users: [
          { id: 'user-1', tenantId: TENANT, email: 'ana@example.com' },
          { id: 'user-2', tenantId: TENANT, email: 'ben@example.com' },
        ],
        people: [
          {
            id: 'person-1',
            tenantId: TENANT,
            type: EntityType.PERSON,
            email: 'ana@example.com',
          },
        ],
      });

      const created = await service.create(TENANT, {
        clientId: 'person-1',
        amountMinor: 45000,
        currency: 'AUD',
        description: 'Application fee',
      } as never);

      // Ben asking for Ana's payment gets 404, not 403 — same as before this
      // fix, and unaffected by where the id came from.
      await expect(
        service.findOne(TENANT, created.id, 'user-2'),
      ).rejects.toThrow(/not found/i);
    });

    it('a client still sees inbound only — a resolved clientId does not override the direction rule', async () => {
      const { service } = build({
        users: [{ id: 'user-1', tenantId: TENANT, email: 'ana@example.com' }],
        people: [
          {
            id: 'person-1',
            tenantId: TENANT,
            type: EntityType.PERSON,
            email: 'ana@example.com',
          },
        ],
      });

      // Not a realistic charge (outbound rows carry no client), but the point
      // is narrow: even if a resolved clientId ends up on an outbound row,
      // the direction check in findOne still applies to it.
      const created = await service.create(TENANT, {
        clientId: 'person-1',
        direction: PaymentDirection.OUTBOUND,
        payee: 'Department of Home Affairs',
        amountMinor: 305000,
        currency: 'AUD',
        description: 'Government charge forwarded',
      } as never);

      await expect(
        service.findOne(TENANT, created.id, 'user-1'),
      ).rejects.toThrow(/not found/i);

      // Staff, with no forced scope, still sees it.
      await expect(
        service.findOne(TENANT, created.id, null),
      ).resolves.toMatchObject({ id: created.id });
    });
  });

  /**
   * The read half of the same defect (Owen, 2026-11-17). Writes resolve a CRM
   * person id to the client's `users.id`; `list` and `summary` filtered on the
   * raw `?clientId=` instead. ImmiStack queries with the PERSON id (the
   * matter's `clientId`, the client page's route param), so every charge
   * raised since write-side resolution shipped read back as an empty,
   * complete ledger — the matter payment gate opened on a pending charge and
   * the client page said "Nothing owing".
   *
   * `forceClientId: null` below is a staff (tenant-wide) caller, exactly what
   * `PaymentsController.clientScope` passes for `firm_admin`/`staff`.
   */
  describe('reading by clientId — a person id and a users.id both find the ledger', () => {
    const OTHER_TENANT = 't2';

    const pay = (
      id: string,
      clientId: string,
      amountMinor: number,
      over: Record<string, unknown> = {},
    ) => ({
      id,
      tenantId: TENANT,
      clientId,
      entityId: 'matter-1',
      direction: PaymentDirection.INBOUND,
      status: PaymentStatus.PENDING,
      currency: 'AUD',
      amountMinor: String(amountMinor),
      createdAt: new Date('2026-11-01T00:00:00Z'),
      ...over,
    });

    const ana = { id: 'user-1', tenantId: TENANT, email: 'ana@example.com' };
    const ben = { id: 'user-2', tenantId: TENANT, email: 'ben@example.com' };
    const anaPerson = {
      id: 'person-1',
      tenantId: TENANT,
      type: EntityType.PERSON,
      email: 'Ana@Example.com',
    };

    const ids = (r: { items: Array<{ id: unknown }> }) =>
      r.items.map((p) => p.id).sort();

    it('list(?clientId=<person id>) returns the row stored under the resolved users.id', async () => {
      const { service } = build({
        users: [ana, ben],
        people: [anaPerson],
        payments: [pay('p-ana', 'user-1', 45000), pay('p-ben', 'user-2', 9900)],
      });

      const res = await service.list(TENANT, { clientId: 'person-1' }, null);

      expect(ids(res)).toEqual(['p-ana']);
      expect(res.total).toBe(1);
    });

    it('list(?clientId=<person id>) also returns a legacy row stored under the person id itself', async () => {
      const { service } = build({
        users: [ana],
        people: [anaPerson],
        payments: [
          pay('p-new', 'user-1', 45000),
          pay('p-legacy', 'person-1', 12000), // written before resolution shipped
        ],
      });

      const res = await service.list(TENANT, { clientId: 'person-1' }, null);

      expect(ids(res)).toEqual(['p-legacy', 'p-new']);
      expect(res.total).toBe(2);
    });

    it('list(?clientId=<users.id>) still works', async () => {
      const { service } = build({
        users: [ana, ben],
        people: [anaPerson],
        payments: [pay('p-ana', 'user-1', 45000), pay('p-ben', 'user-2', 9900)],
      });

      const res = await service.list(TENANT, { clientId: 'user-1' }, null);

      expect(ids(res)).toEqual(['p-ana']);
    });

    it('an id that names nobody returns an empty list — never a 404/400 the way the write path does', async () => {
      const { service } = build({
        users: [ana],
        people: [anaPerson],
        payments: [pay('p-ana', 'user-1', 45000)],
      });

      await expect(
        service.list(TENANT, { clientId: 'nobody-here' }, null),
      ).resolves.toMatchObject({ items: [], total: 0 });
      await expect(
        service.summary(TENANT, { clientId: 'nobody-here' }, null),
      ).resolves.toMatchObject({ byStatus: [], receivableMinor: {} });
    });

    it('a person with no invited user still finds their legacy rows, and does not throw', async () => {
      const { service } = build({
        users: [],
        people: [{ ...anaPerson, email: 'not-invited@example.com' }],
        payments: [pay('p-legacy', 'person-1', 12000)],
      });

      const res = await service.list(TENANT, { clientId: 'person-1' }, null);

      expect(ids(res)).toEqual(['p-legacy']);
    });

    it('summary(?clientId=<person id>) agrees with list over the same rows', async () => {
      const { service } = build({
        users: [ana, ben],
        people: [anaPerson],
        payments: [
          pay('p-new', 'user-1', 45000),
          pay('p-legacy', 'person-1', 12000),
          pay('p-paid', 'user-1', 5000, { status: PaymentStatus.PAID }),
          pay('p-ben', 'user-2', 9900),
        ],
      });

      const list = await service.list(TENANT, { clientId: 'person-1' }, null);
      const summary = await service.summary(
        TENANT,
        { clientId: 'person-1' },
        null,
      );

      const listTotal = list.items.reduce((s, p) => s + p.amountMinor, 0);
      expect(listTotal).toBe(62000);
      expect(summary.receivableMinor).toEqual({ AUD: listTotal });
      expect(
        summary.byStatus.find((r) => r.status === PaymentStatus.PENDING),
      ).toMatchObject({ amountMinor: 57000, count: 2 });
    });

    it("a client-role caller passing another person's id still sees only their own inbound rows", async () => {
      const { service } = build({
        users: [ana, ben],
        people: [anaPerson],
        payments: [
          pay('p-ana', 'user-1', 45000),
          pay('p-ana-legacy', 'person-1', 12000),
          pay('p-ben', 'user-2', 9900),
          pay('p-ben-out', 'user-2', 300, {
            direction: PaymentDirection.OUTBOUND,
          }),
        ],
      });

      // Ben (user-2) is forced to himself and asks for Ana's person id.
      const list = await service.list(
        TENANT,
        { clientId: 'person-1', direction: PaymentDirection.OUTBOUND },
        'user-2',
      );
      const summary = await service.summary(
        TENANT,
        { clientId: 'person-1' },
        'user-2',
      );

      expect(ids(list)).toEqual(['p-ben']);
      expect(summary.receivableMinor).toEqual({ AUD: 9900 });
      expect(summary.payableMinor).toEqual({});
    });

    it("does not resolve a person id from another tenant onto this tenant's client", async () => {
      // Same email in both tenants. A resolver that forgot `tenantId` on the
      // person lookup would find t2's person, then Ana's t1 login by email,
      // and hand a t1 staff caller Ana's rows for an id that is not theirs.
      const { service } = build({
        users: [ana],
        people: [
          anaPerson,
          {
            id: 'person-t2',
            tenantId: OTHER_TENANT,
            type: EntityType.PERSON,
            email: 'ana@example.com',
          },
        ],
        payments: [
          pay('p-ana', 'user-1', 45000),
          pay('p-t2', 'person-t2', 700, { tenantId: OTHER_TENANT }),
        ],
      });

      const res = await service.list(TENANT, { clientId: 'person-t2' }, null);
      const summary = await service.summary(
        TENANT,
        { clientId: 'person-t2' },
        null,
      );

      expect(res.items).toEqual([]);
      expect(summary.byStatus).toEqual([]);
    });
  });
});
