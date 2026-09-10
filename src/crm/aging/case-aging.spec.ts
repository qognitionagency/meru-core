import { CaseAgingService } from './case-aging.service';
import { CrmService } from '../crm.service';
import { CrmAccessService } from '../crm-access.service';
import {
  EntityStatus,
  EntityType,
  UniversalEntity,
} from '../entities/universal-entity.entity';
import { Actor } from '../../common/access';

/**
 * FR-5.10 — case aging.
 *
 * Every assertion here is really one assertion, restated: **a measurement
 * nobody took is not a measurement of zero** (CLAUDE.md §5.2). A case with no
 * recorded contact is the case most likely to need chasing, and reporting it
 * as "0 days since last contact" sorts it to the safe end of the list.
 *
 * The second rule is that a number must measure what it says it measures.
 * "Days in current stage" has no fallback to the record's age: a plausible
 * number from the wrong clock is indistinguishable from a real one, and it is
 * worse than a null, which at least renders as "unknown".
 */
describe('CaseAgingService (FR-5.10)', () => {
  const NOW = new Date('2026-09-10T00:00:00.000Z');
  const TENANT = 't1';

  const caseRecord = (over: Partial<UniversalEntity> = {}): UniversalEntity =>
    ({
      id: 'c1',
      tenantId: TENANT,
      type: EntityType.CASE,
      status: EntityStatus.OPEN,
      subjectEmail: 'applicant@example.com',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      verticalAttributes: {},
      metadata: {},
      ...over,
    }) as UniversalEntity;

  const service = (rows: any[] = []) =>
    new CaseAgingService({ query: async () => rows } as any);

  describe('days in current stage', () => {
    it('is null with a reason when the record carries no stage', async () => {
      const aging = await service().forEntity(TENANT, caseRecord(), NOW);
      expect(aging.stage.value).toBeNull();
      expect(aging.stage.days).toBeNull();
      expect(aging.stage.unavailableReason).toMatch(/no stage/i);
    });

    it('is null when the stage was never recorded as a transition', async () => {
      const aging = await service().forEntity(
        TENANT,
        caseRecord({ verticalAttributes: { stage: 'documents_pending' } }),
        NOW,
      );
      expect(aging.stage.value).toBe('documents_pending');
      expect(aging.stage.basis).toBe('unknown');
      expect(aging.stage.days).toBeNull();
      // And specifically NOT the record's age, which is 40 days here.
      expect(aging.recordAge.days).toBe(40);
    });

    it('counts from the recorded transition into the current stage', async () => {
      const aging = await service().forEntity(
        TENANT,
        caseRecord({
          verticalAttributes: { stage: 'documents_pending' },
          metadata: {
            stageHistory: [
              { stage: 'documents_pending', at: '2026-09-03T00:00:00.000Z', by: 'u1' },
              { stage: 'signed_up', at: '2026-08-20T00:00:00.000Z', by: 'u1' },
            ],
          },
        } as Partial<UniversalEntity>),
        NOW,
      );
      expect(aging.stage.basis).toBe('stageChangeRecorded');
      expect(aging.stage.days).toBe(7);
      expect(aging.stage.since).toBe('2026-09-03T00:00:00.000Z');
      expect(aging.stage.history).toHaveLength(2);
    });

    it('ignores a malformed history rather than throwing on it', async () => {
      const aging = await service().forEntity(
        TENANT,
        caseRecord({
          verticalAttributes: { stage: 'granted' },
          metadata: { stageHistory: 'nonsense' },
        } as Partial<UniversalEntity>),
        NOW,
      );
      expect(aging.stage.days).toBeNull();
      expect(aging.stage.history).toEqual([]);
    });
  });

  describe('days since last client contact', () => {
    const contactRow = (at: string) => ({
      email: 'applicant@example.com',
      at: new Date(at),
      channel: 'email',
      direction: 'outbound',
    });

    it('is null with a reason when nothing has been sent or received', async () => {
      const aging = await service([]).forEntity(TENANT, caseRecord(), NOW);
      expect(aging.lastClientContact.at).toBeNull();
      // The whole point: not 0.
      expect(aging.lastClientContact.days).toBeNull();
      expect(aging.lastClientContact.unavailableReason).toMatch(
        /not the same as contact today/,
      );
    });

    it('is null with a different reason when the record has no subject', async () => {
      const aging = await service([contactRow('2026-09-08T00:00:00.000Z')]).forEntity(
        TENANT,
        caseRecord({ subjectEmail: null }),
        NOW,
      );
      expect(aging.lastClientContact.days).toBeNull();
      expect(aging.lastClientContact.unavailableReason).toMatch(/no subject email/i);
    });

    it('counts from the most recent message', async () => {
      const aging = await service([contactRow('2026-09-08T00:00:00.000Z')]).forEntity(
        TENANT,
        caseRecord(),
        NOW,
      );
      expect(aging.lastClientContact.days).toBe(2);
      expect(aging.lastClientContact.channel).toBe('email');
      expect(aging.lastClientContact.direction).toBe('outbound');
    });

    it('matches the subject address case-insensitively, as the column is written', async () => {
      const aging = await service([contactRow('2026-09-09T00:00:00.000Z')]).forEntity(
        TENANT,
        caseRecord({ subjectEmail: '  Applicant@Example.com ' }),
        NOW,
      );
      expect(aging.lastClientContact.days).toBe(1);
    });

    it('asks the database only for messages that actually went out', async () => {
      // A `pending` or `failed` row is not contact — dispatch has been dead
      // for 34 hours before now without anything going red (AGENTS.md §2.1).
      let sql = '';
      const svc = new CaseAgingService({
        query: async (q: string) => {
          sql = q;
          return [];
        },
      } as any);
      await svc.forEntity(TENANT, caseRecord(), NOW);
      expect(sql).toMatch(/COALESCE\("deliveredAt", "sentAt"\) IS NOT NULL/);
      expect(sql).toMatch(/"tenantId" = \$1/);
    });

    it('does not query at all when no record on the page has a subject', async () => {
      let called = false;
      const svc = new CaseAgingService({
        query: async () => {
          called = true;
          return [];
        },
      } as any);
      await svc.forEntities(TENANT, [caseRecord({ subjectEmail: null })], NOW);
      expect(called).toBe(false);
    });
  });

  it('reports a page in one pass, keyed by record id', async () => {
    const rows = [
      {
        email: 'applicant@example.com',
        at: new Date('2026-09-09T00:00:00.000Z'),
        channel: 'email',
        direction: 'inbound',
      },
    ];
    const map = await service(rows).forEntities(
      TENANT,
      [caseRecord(), caseRecord({ id: 'c2', subjectEmail: 'other@example.com' })],
      NOW,
    );
    expect(map.get('c1')!.lastClientContact.days).toBe(1);
    expect(map.get('c2')!.lastClientContact.days).toBeNull();
  });
});

/**
 * The other half of FR-5.10: without a recorded transition there is nothing to
 * measure from, so `updateEntity` writes one.
 */
describe('CrmService records stage changes (FR-5.10)', () => {
  const TENANT = 't1';
  const ACTOR: Actor = { id: 'staff-1', roles: ['staff'] };

  function harness(initial: Partial<UniversalEntity> = {}) {
    const row: any = {
      id: 'c1',
      tenantId: TENANT,
      type: EntityType.CASE,
      status: EntityStatus.OPEN,
      verticalAttributes: {},
      metadata: {},
      relationships: [],
      ...initial,
    };
    const entityRepo = {
      findOne: async () => row,
      save: async (e: any) => e,
    };
    const service = new CrmService(
      entityRepo as any,
      {} as any,
      {} as any,
      {} as any,
      { assertCompletable: async () => undefined } as any,
      new CrmAccessService(),
      // `packs` — `section` is consulted for locked fields and declared sets;
      // an immigration pack with neither leaves both inert.
      { section: async () => null } as any,
      {} as any,
      {} as any,
    );
    return { service, row };
  }

  it('appends an entry when the stage moves', async () => {
    const { service } = harness();
    const updated = await service.updateEntity('c1', TENANT, ACTOR, {
      verticalAttributes: { stage: 'documents_pending' },
    } as any);
    expect(updated.metadata.stageHistory).toHaveLength(1);
    expect(updated.metadata.stageHistory[0]).toMatchObject({
      stage: 'documents_pending',
      by: 'staff-1',
    });
  });

  it('does not append when the stage is unchanged', async () => {
    const { service } = harness({
      verticalAttributes: { stage: 'documents_pending' },
    } as Partial<UniversalEntity>);
    const updated = await service.updateEntity('c1', TENANT, ACTOR, {
      verticalAttributes: { stage: 'documents_pending', governmentRef: 'TRN-1' },
    } as any);
    expect(updated.metadata.stageHistory ?? []).toHaveLength(0);
  });

  it('keeps the newest entries first and caps the history', async () => {
    const { service } = harness({
      metadata: {
        stageHistory: Array.from({ length: 50 }, (_, i) => ({
          stage: `s${i}`,
          at: '2026-01-01T00:00:00.000Z',
          by: null,
        })),
      },
    } as Partial<UniversalEntity>);
    const updated = await service.updateEntity('c1', TENANT, ACTOR, {
      verticalAttributes: { stage: 'granted' },
    } as any);
    expect(updated.metadata.stageHistory).toHaveLength(50);
    expect(updated.metadata.stageHistory[0].stage).toBe('granted');
  });

  it('leaves other metadata alone', async () => {
    const { service } = harness({
      metadata: { somethingElse: 'keep me' },
    } as Partial<UniversalEntity>);
    const updated = await service.updateEntity('c1', TENANT, ACTOR, {
      verticalAttributes: { stage: 'lodged' },
    } as any);
    expect(updated.metadata.somethingElse).toBe('keep me');
  });
});
