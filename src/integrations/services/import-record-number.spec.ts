import { ImportService } from './import.service';

/**
 * ADR 0010, extended to the third producer.
 *
 * The ADR names `CrmService.createEntity` and `convertEntity` and stops there.
 * `ImportService.commit` is the third path that creates `person`/`organization`
 * rows, and ADR 0011 §2.2 states a client record's number is the ONE thing
 * about its identity the server can always promise — a promise a firm's whole
 * client base arriving through the importer would falsify, for exactly the
 * records most likely to be cross-checked against a paper file.
 *
 * Flagged to Kyle as an extension beyond ADR 0010's text rather than assumed.
 */
describe('ImportService — record numbering', () => {
  function build(targetEntityType: string) {
    const mapping = {
      key: 'clients_csv',
      label: 'Clients',
      source: 'csv' as const,
      targetEntityType,
      fields: [
        { from: 'First Name', to: 'firstName', required: true },
        { from: 'Email', to: 'email', required: true },
      ],
      dedupeOn: [],
    };

    const saved: any[] = [];
    let counter = 0;
    const claims: Array<{ sql: string; params: unknown[] }> = [];

    const entities = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          where: () => qb,
          andWhere: () => qb,
          getOne: () => Promise.resolve(null),
        };
        return qb;
      }),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      create: jest.fn((x: any) => ({ ...x })),
      save: jest.fn((x: any) => {
        saved.push(x);
        return Promise.resolve(x);
      }),
      manager: {
        query: jest.fn((sql: string, params: unknown[]) => {
          claims.push({ sql, params });
          return Promise.resolve([{ value: String(++counter) }]);
        }),
      },
    };

    const packs = { list: jest.fn().mockResolvedValue([mapping]) };
    const service = new ImportService(entities as any, packs as any);
    return { service, saved, claims, entities };
  }

  const csv = [
    'First Name,Email',
    'Ada,ada@example.com',
    'Grace,grace@example.com',
  ].join('\n');

  it('numbers imported clients from the tenant’s own CL series', async () => {
    const { service, saved } = build('person');
    await service.run('t1', 'immigration', 'clients_csv', csv, {
      commit: true,
    });

    expect(saved.map((r) => r.recordNumber)).toEqual(['CL-000001', 'CL-000002']);
  });

  it('scopes the claim to the caller’s tenant, not the file', async () => {
    const { service, claims } = build('person');
    await service.run('t1', 'immigration', 'clients_csv', csv, {
      commit: true,
    });

    // `tenantId` reaches here from `req.user.tenantId`, never from a body
    // field or a CSV column, and `tenant_record_counters` is FORCE RLS on top.
    expect(claims.every((c) => c.params[0] === 't1')).toBe(true);
    expect(claims.every((c) => c.params[1] === 'CL')).toBe(true);
  });

  it('leaves an imported lead unnumbered — a lead is not yet a client', async () => {
    const { service, saved, claims } = build('lead');
    await service.run('t1', 'immigration', 'clients_csv', csv, {
      commit: true,
    });

    expect(saved.every((r) => r.recordNumber === null)).toBe(true);
    expect(claims).toHaveLength(0);
  });

  it('claims nothing at all on a dry run', async () => {
    // The whole point of this pipeline is that it does not write until a human
    // has seen the diff. A dry run that burned numbers would leave gaps in a
    // tenant's sequence for an import that was then abandoned.
    const { service, claims, entities } = build('person');
    await service.run('t1', 'immigration', 'clients_csv', csv);

    expect(claims).toHaveLength(0);
    expect(entities.save).not.toHaveBeenCalled();
  });
});
