import { SearchService } from './search.service';

/**
 * ADR 0011 §2.4 — the search index's title fallback chain.
 *
 * `'Unknown'` as a result title is the same failure as "Unnamed client" on the
 * client list (CLAUDE.md §5.2, "unknown is never clear"). It has gone
 * unnoticed longer only because it sits inside a result list rather than on a
 * primary screen, and a staff member reading it cannot tell a genuine data gap
 * from a rendering placeholder.
 *
 * The chain is ordered, and `recordNumber` (ADR 0010) sits second on purpose:
 * it is the record's own true, server-assigned identity, guaranteed present on
 * every eligible record, and never invented.
 */
describe('SearchService — record identity in the index', () => {
  function build() {
    const rows: any[] = [];
    const searchRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((row: any) => {
        rows.push(row);
        return Promise.resolve({ id: 's1', ...row });
      }),
    };
    const es = { available: false, indexDocument: jest.fn() };
    const service = new SearchService(searchRepo as any, es as any);
    return { service, rows };
  }

  const entity = (over: Record<string, any> = {}) => ({
    id: 'e1',
    tenantId: 't1',
    type: 'person',
    firstName: null,
    lastName: null,
    email: null,
    phoneNumber: null,
    recordNumber: null,
    verticalAttributes: {},
    ...over,
  });

  it('prefers a real name, unchanged', async () => {
    const { service, rows } = build();
    await service.indexEntityData(
      entity({ firstName: 'Priya', lastName: 'Sharma', recordNumber: 'CL-000042' }),
    );
    expect(rows[0].title).toBe('Priya Sharma');
  });

  it('falls to the record number before the email, never to "Unknown"', async () => {
    const { service, rows } = build();
    await service.indexEntityData(
      entity({ recordNumber: 'CL-000042', email: 'a@example.com' }),
    );
    expect(rows[0].title).toBe('CL-000042');
  });

  it('falls to email, then phone, when there is no number', async () => {
    const { service, rows } = build();
    await service.indexEntityData(entity({ email: 'a@example.com' }));
    expect(rows[0].title).toBe('a@example.com');

    const second = build();
    await second.service.indexEntityData(entity({ phoneNumber: '+61400000000' }));
    expect(second.rows[0].title).toBe('+61400000000');
  });

  it('still says "Unknown" when it genuinely is', async () => {
    // The last resort survives, and it is honest there: a pre-backfill row
    // with no name, no number and no contact detail has no identity this
    // system can state. Inventing one would be the failure, not admitting it.
    const { service, rows } = build();
    await service.indexEntityData(entity());
    expect(rows[0].title).toBe('Unknown');
  });

  it('does not overwrite a title a wrapper caller already computed', async () => {
    // Tasks, forms, workflow instances and documents pass their own `title`.
    // A task called "Chase passport" must not be re-titled to a case number.
    const { service, rows } = build();
    await service.indexEntityData({
      ...entity({ recordNumber: 'CS-000001' }),
      searchableId: 'task-1',
      searchableType: 'task',
      title: 'Chase passport',
    });
    expect(rows[0].title).toBe('Chase passport');
  });

  it('indexes the number as searchable content, so CS-000042 finds the case', async () => {
    // ADR 0010 open item 7. A number that cannot be typed into search is a
    // number a caseworker has to eyeball down a list — which is the workflow
    // the paper-file cross-check exists to replace.
    const { service, rows } = build();
    await service.indexEntityData(
      entity({ type: 'case', recordNumber: 'CS-000042' }),
    );
    // `generateContent` lowercases the whole blob — the Postgres path matches
    // with `ILIKE` and the ES path is analysed, so case is irrelevant to the
    // lookup. What matters is that the number is in there at all.
    expect(rows[0].content.toUpperCase()).toContain('CS-000042');
  });
});
