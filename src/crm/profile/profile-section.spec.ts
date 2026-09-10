import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import {
  ProfileSectionService,
  PackEntityTypeDeclaration,
  assertDeclaredSetsValid,
} from './profile-section.service';
import { UniversalEntity, EntityType } from '../entities/universal-entity.entity';

/**
 * FR-4.1–FR-4.5 — the deep client profile.
 *
 * Two properties are under test and they pull in opposite directions, which is
 * why they are in one file:
 *
 * 1. **Structure is enforced**, so "repeating structured sets, not free text"
 *    stays true a month after it ships.
 * 2. **Absence is preserved.** `not_recorded` (nobody asked) and
 *    `declared_none` (asked; the answer was none) must not collapse into each
 *    other, because on FR-4.4's previous-refusals section that distinction
 *    changes what may lawfully be advised.
 */
describe('ProfileSectionService (FR-4.1–4.5)', () => {
  const DECLARATION: PackEntityTypeDeclaration = {
    type: 'person',
    label: 'Client',
    fields: [
      { key: 'passportNumber', label: 'Passport number', type: 'text', required: true },
      { key: 'nationality', label: 'Nationality', type: 'country' },
      {
        key: 'previousRefusals',
        label: 'Previous refusals',
        type: 'set',
        itemFields: [
          { key: 'country', label: 'Country', type: 'country', required: true },
          { key: 'visaType', label: 'Visa', type: 'text', required: true },
          { key: 'refusedOn', label: 'Refused on', type: 'date' },
        ],
      },
    ],
  };

  const entity = (attrs: Record<string, unknown>): UniversalEntity =>
    ({
      id: 'e1',
      tenantId: 't1',
      type: EntityType.PERSON,
      recordNumber: 'CL-000001',
      verticalAttributes: attrs,
    }) as unknown as UniversalEntity;

  const serviceWith = (
    section: PackEntityTypeDeclaration[] | null,
    pack: { code: string; version: string } | null = {
      code: 'immigration',
      version: '2.7.0',
    },
  ) =>
    new ProfileSectionService({
      sectionWithPack: async () => ({ pack, section }),
    } as any);

  describe('what the record does and does not carry', () => {
    it('reports an absent set as not_recorded with no item count', async () => {
      const report = await serviceWith([DECLARATION]).report(
        entity({ passportNumber: 'PA123' }),
        'immigration',
      );
      const refusals = report.sets.find((s) => s.key === 'previousRefusals')!;
      expect(refusals.state).toBe('not_recorded');
      // Not 0. A count of zero reads as "we checked and there are none".
      expect(refusals.items).toBeNull();
    });

    it('distinguishes "asked, none" from "never asked"', async () => {
      const asked = await serviceWith([DECLARATION]).report(
        entity({ previousRefusals: [] }),
        'immigration',
      );
      const never = await serviceWith([DECLARATION]).report(
        entity({}),
        'immigration',
      );
      expect(asked.sets[0].state).toBe('declared_none');
      expect(never.sets[0].state).toBe('not_recorded');
      expect(asked.sets[0].state).not.toBe(never.sets[0].state);
    });

    it('counts recorded entries', async () => {
      const report = await serviceWith([DECLARATION]).report(
        entity({
          previousRefusals: [
            { country: 'GB', visaType: 'Student', refusedOn: '2023-02-01' },
          ],
        }),
        'immigration',
      );
      expect(report.sets[0]).toMatchObject({ state: 'recorded', items: 1 });
    });

    it('marks an empty-string field as not recorded', async () => {
      const report = await serviceWith([DECLARATION]).report(
        entity({ passportNumber: '' }),
        'immigration',
      );
      expect(report.fields.find((f) => f.key === 'passportNumber')!.state).toBe(
        'not_recorded',
      );
    });

    it('lists attributes the pack does not declare rather than dropping them', async () => {
      const report = await serviceWith([DECLARATION]).report(
        entity({ someLegacyField: 'x' }),
        'immigration',
      );
      expect(report.undeclaredAttributes).toContain('someLegacyField');
    });

    it('says so — and reports null, not 0% — when the pack declares nothing', async () => {
      const report = await serviceWith([]).report(entity({}), 'immigration');
      expect(report.declared).toBe(false);
      expect(report.unavailableReason).toMatch(/declares no entityTypes entry/);
      // A percentage over an empty population is null (CLAUDE.md §5.2). "0%
      // complete" and "100% complete" would both be inventions here.
      expect(report.completeness.percentRecorded).toBeNull();
    });

    it('says so when no pack resolves for the tenant at all', async () => {
      const report = await serviceWith(null, null).report(
        entity({}),
        'immigration',
      );
      expect(report.declared).toBe(false);
      expect(report.unavailableReason).toMatch(/No config pack/);
    });

    it('computes completeness over declared fields and sets', async () => {
      const report = await serviceWith([DECLARATION]).report(
        entity({ passportNumber: 'PA123', previousRefusals: [] }),
        'immigration',
      );
      // passportNumber recorded, previousRefusals declared_none (an answer),
      // nationality not recorded.
      expect(report.completeness).toEqual({
        declared: 3,
        recorded: 2,
        notRecorded: 1,
        percentRecorded: 67,
      });
    });
  });

  describe('the shape guarantee', () => {
    const check = (attrs: Record<string, unknown>) => () =>
      assertDeclaredSetsValid(DECLARATION, attrs);

    it('refuses free text where a repeating set is declared', () => {
      expect(check({ previousRefusals: 'refused in the UK once, 2023' })).toThrow(
        BadRequestException,
      );
    });

    it('refuses an entry that is not an object', () => {
      expect(check({ previousRefusals: ['GB'] })).toThrow(BadRequestException);
    });

    it('refuses an undeclared entry field, naming what is declared', () => {
      expect(check({ previousRefusals: [{ country: 'GB', visaType: 'X', note: 'y' }] }))
        .toThrow(/not declared on this pack.*country, visaType, refusedOn/s);
    });

    it('refuses a nested value inside an entry', () => {
      expect(
        check({ previousRefusals: [{ country: { code: 'GB' }, visaType: 'X' }] }),
      ).toThrow(BadRequestException);
    });

    it('refuses an entry missing a pack-required field', () => {
      expect(check({ previousRefusals: [{ country: 'GB' }] })).toThrow(
        /visaType.*is required by the pack/,
      );
    });

    it('caps the number of entries', () => {
      const many = Array.from({ length: 201 }, () => ({
        country: 'GB',
        visaType: 'Student',
      }));
      expect(check({ previousRefusals: many })).toThrow(/at most 200/);
    });

    it('allows an empty array (an affirmative "none") and null (clear it)', () => {
      expect(check({ previousRefusals: [] })).not.toThrow();
      expect(check({ previousRefusals: null })).not.toThrow();
    });

    it('ignores a set the write does not mention', () => {
      expect(check({ passportNumber: 'PA123' })).not.toThrow();
    });

    it('changes nothing for a pack that declares no itemFields — the GovX case', () => {
      // CLAUDE.md §5.5b: a change made for one vertical must not reach the
      // other. A declaration with no sets exits before it can refuse anything.
      const grcLike: PackEntityTypeDeclaration = {
        type: 'obligation',
        label: 'Obligation',
        fields: [{ key: 'obligationType', label: 'Type', type: 'select' }],
      };
      expect(() =>
        assertDeclaredSetsValid(grcLike, {
          obligationType: 'reporting',
          anythingElse: [{ deeply: { nested: true } }],
        }),
      ).not.toThrow();
    });
  });

  describe('the shipped immigration pack', () => {
    // Authoring is half of this feature, so it is tested rather than assumed:
    // a schema key nothing declares is a key nothing renders.
    const pack = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          '../../../packages/config-packs/verticals/immigration.json',
        ),
        'utf8',
      ),
    );
    const person = (pack.entityTypes as PackEntityTypeDeclaration[]).find(
      (e) => e.type === 'person',
    )!;

    it('declares every repeating set FR-4.3 and FR-4.4 name', () => {
      const sets = (person.fields ?? [])
        .filter((f) => f.itemFields?.length)
        .map((f) => f.key);
      expect(sets).toEqual(
        expect.arrayContaining([
          'immigrationHistory',
          'educationHistory',
          'employmentHistory',
          'travelHistory',
          'previousRefusals',
          'visaHistory',
        ]),
      );
    });

    it('accepts a real refusal entry and refuses a free-text one', () => {
      expect(() =>
        assertDeclaredSetsValid(person, {
          previousRefusals: [
            { country: 'GB', visaType: 'Student (Tier 4)', refusedOn: '2023-02-01' },
          ],
        }),
      ).not.toThrow();
      expect(() =>
        assertDeclaredSetsValid(person, { previousRefusals: 'one, in 2023' }),
      ).toThrow(BadRequestException);
    });

    it('models dependants as linked person records, not as a set (FR-4.2)', () => {
      // A dependant holds their own documents, so they are a record — a
      // sub-object on the client could never own a passport scan.
      const sets = (person.fields ?? []).filter((f) => f.itemFields?.length);
      expect(sets.map((f) => f.key)).not.toContain('dependants');
      expect(pack.relationships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'dependant_of',
            fromType: 'person',
            toType: 'person',
          }),
        ]),
      );
    });
  });
});
