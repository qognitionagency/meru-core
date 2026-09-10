import { BadRequestException, Injectable } from '@nestjs/common';
import { UniversalEntity } from '../entities/universal-entity.entity';
import { VerticalPackService } from '../../tenant/services/vertical-pack.service';

/** One field of an `entityTypes[]` entry, as the pack declares it. */
export interface PackFieldDeclaration {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
  multiple?: boolean;
  /**
   * Present ⇒ this field is a **repeating structured set** (FR-4.3/FR-4.4):
   * the value is an array of flat objects with these keys, not free text.
   * Absent ⇒ an ordinary scalar field, exactly as before.
   */
  itemFields?: PackItemFieldDeclaration[];
}

export interface PackItemFieldDeclaration {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
}

export interface PackEntityTypeDeclaration {
  type: string;
  label: string;
  fields?: PackFieldDeclaration[];
}

/**
 * Three states, and the middle one is the whole point.
 *
 * - `recorded`      — the firm has entered something.
 * - `declared_none` — the firm saved an EMPTY set: asked, and the answer was
 *                     none. Only a set can be in this state; an empty array is
 *                     an affirmative answer, an absent key is not.
 * - `not_recorded`  — nobody has answered. **Never render this as "none", "0"
 *                     or a clean result** (CLAUDE.md §5.2). On a refusal
 *                     history it is the difference between "no previous
 *                     refusals" and "we never asked", and those change what may
 *                     lawfully be advised.
 */
export type ProfileState = 'recorded' | 'declared_none' | 'not_recorded';

export interface ProfileFieldReport {
  key: string;
  label: string;
  type: string;
  required: boolean;
  state: Exclude<ProfileState, 'declared_none'>;
  value: unknown;
}

export interface ProfileSetReport {
  key: string;
  label: string;
  state: ProfileState;
  /** Number of entries. `null` when nothing has been recorded — never 0. */
  items: number | null;
  itemFields: PackItemFieldDeclaration[];
}

export interface ProfileReport {
  entityId: string;
  type: string;
  recordNumber: string | null;
  pack: { code: string; version: string } | null;
  /** False ⇒ the pack declares nothing for this type; the report is empty and says so. */
  declared: boolean;
  unavailableReason?: string;
  fields: ProfileFieldReport[];
  sets: ProfileSetReport[];
  /** Attributes on the record that the pack does not declare. Shown, never silently dropped. */
  undeclaredAttributes: string[];
  completeness: {
    declared: number;
    recorded: number;
    notRecorded: number;
    /** `null` when nothing is declared — a percentage over an empty population is not 0%. */
    percentRecorded: number | null;
  };
}

/** Bounds on a repeating set, so a profile cannot become an unbounded jsonb dump. */
const MAX_SET_ITEMS = 200;
const MAX_ITEM_VALUE_LENGTH = 4000;

/**
 * The deep client profile — FR-4.1 to FR-4.5.
 *
 * ## Why none of this is a column
 *
 * Immigration history, education, employment, travel, refusals and prior visas
 * are the vertical's vocabulary, so they live in `verticalAttributes` and are
 * *declared* in the config pack (CLAUDE.md §5.5). Core never learns what a
 * subclass 189 is. What core supplies is the two generic things a pack cannot:
 *
 * 1. **A shape guarantee.** A declared set must be an array of flat objects
 *    whose keys the pack declared. That is what makes it "repeating structured
 *    data, not free text" — without enforcement, `educationHistory` becomes a
 *    paragraph again within a month.
 * 2. **An honest report of what is missing.** `report()` distinguishes
 *    recorded, affirmatively-none, and never-asked, and refuses to compute a
 *    percentage when nothing is declared.
 *
 * ## The stacking rule
 *
 * Both are **opt-in per field**: a pack that declares no `itemFields` gets
 * exactly the behaviour it had before, so GovernanceX is untouched
 * (CLAUDE.md §5.5b). The failure direction matches
 * `CrmService.assertNoLockedFieldChanged` — a declaration core cannot make
 * sense of is reported, never silently enforced.
 */
@Injectable()
export class ProfileSectionService {
  constructor(private readonly packs: VerticalPackService) {}

  /** The pack's declaration for one entity type, or null. */
  private async declarationFor(
    vertical: string | null,
    type: string,
  ): Promise<{
    declaration: PackEntityTypeDeclaration | null;
    pack: { code: string; version: string } | null;
  }> {
    const { pack, section } = await this.packs.sectionWithPack<
      PackEntityTypeDeclaration[]
    >(vertical, 'entityTypes');

    const declaration =
      (Array.isArray(section) ? section : []).find((e) => e.type === type) ??
      null;

    return {
      declaration,
      pack: pack ? { code: pack.code, version: pack.version } : null,
    };
  }

  /**
   * Wrapper for callers that already hold a `VerticalPackService`. The rules
   * live in {@link assertDeclaredSetsValid} as a pure function so
   * `CrmService` can apply them on create and update without taking a new
   * constructor dependency — every spec in `src/crm/` builds that service
   * positionally, and a tenth argument would break them all for no gain.
   */
  async assertSetsValid(
    type: string,
    incoming: Record<string, unknown> | undefined,
    vertical: string | null,
  ): Promise<void> {
    if (!incoming || Object.keys(incoming).length === 0) return;
    const { declaration } = await this.declarationFor(vertical, type);
    if (!declaration) return;
    assertDeclaredSetsValid(declaration, incoming);
  }

  /**
   * What this record does and does not carry, against what its pack declares.
   *
   * Read-only. It changes nothing and blocks nothing — its job is to make
   * "we never asked" impossible to render as "nothing to declare".
   */
  async report(
    entity: UniversalEntity,
    vertical: string | null,
  ): Promise<ProfileReport> {
    const { declaration, pack } = await this.declarationFor(
      vertical,
      entity.type,
    );
    const attrs = entity.verticalAttributes ?? {};

    const base = {
      entityId: entity.id,
      type: entity.type,
      recordNumber: entity.recordNumber ?? null,
      pack,
    };

    if (!declaration) {
      // No declaration is NOT an empty profile. Saying "0 of 0 recorded" here
      // would report a fully-complete record for a tenant whose pack simply
      // has not been authored yet.
      return {
        ...base,
        declared: false,
        unavailableReason: pack
          ? `Pack '${pack.code}' declares no entityTypes entry for '${entity.type}', so there is nothing to check this record against.`
          : 'No config pack resolves for this tenant, so there is nothing to check this record against.',
        fields: [],
        sets: [],
        undeclaredAttributes: Object.keys(attrs),
        completeness: {
          declared: 0,
          recorded: 0,
          notRecorded: 0,
          percentRecorded: null,
        },
      };
    }

    const declared = declaration.fields ?? [];
    const fields: ProfileFieldReport[] = [];
    const sets: ProfileSetReport[] = [];

    for (const field of declared) {
      const value = attrs[field.key];
      const isSet = Array.isArray(field.itemFields) && field.itemFields.length > 0;

      if (isSet) {
        sets.push({
          key: field.key,
          label: field.label,
          state: ProfileSectionService.setState(value),
          items: Array.isArray(value) && value.length > 0 ? value.length : null,
          itemFields: field.itemFields!,
        });
        continue;
      }

      fields.push({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required === true,
        state:
          value === undefined || value === null || value === ''
            ? 'not_recorded'
            : 'recorded',
        value: value ?? null,
      });
    }

    const declaredKeys = new Set(declared.map((f) => f.key));
    const undeclaredAttributes = Object.keys(attrs).filter(
      (k) => !declaredKeys.has(k),
    );

    const totalDeclared = fields.length + sets.length;
    const recorded =
      fields.filter((f) => f.state === 'recorded').length +
      sets.filter((s) => s.state !== 'not_recorded').length;

    return {
      ...base,
      declared: true,
      fields,
      sets,
      undeclaredAttributes,
      completeness: {
        declared: totalDeclared,
        recorded,
        notRecorded: totalDeclared - recorded,
        // A percentage over an empty population is `null`, not `0%`
        // (CLAUDE.md §5.2).
        percentRecorded:
          totalDeclared === 0
            ? null
            : Math.round((recorded / totalDeclared) * 100),
      },
    };
  }

  /**
   * Absent, empty and populated are three different answers.
   *
   * An empty array is the firm affirmatively saving "none" — the only way to
   * record that a client has no previous refusals. An absent key is nobody
   * having asked. A UI that sends `[]` to mean "unknown" destroys the
   * distinction FR-4.4 depends on; to return a set to unknown, PATCH the key
   * to `null`, which deletes it (CLAUDE.md §7.5).
   */
  private static setState(value: unknown): ProfileState {
    if (value === undefined || value === null) return 'not_recorded';
    if (!Array.isArray(value)) return 'recorded';
    return value.length === 0 ? 'declared_none' : 'recorded';
  }
}

/**
 * Refuse a write that would put a declared repeating set out of shape.
 *
 * Only fires for a key the write actually mentions AND the pack declares with
 * `itemFields`. `null` is allowed through — it clears the key, which returns
 * the section to `not_recorded` ("we no longer claim to know"), and that has
 * to stay possible.
 *
 * A pack that declares no `itemFields` anywhere reaches the `return` on the
 * first line and nothing changes — which is why this cannot affect
 * GovernanceX (CLAUDE.md §5.5b), and why it is safe to run on every write.
 *
 * Note the interaction with `verticalAttributes`' deep merge: **arrays
 * replace** (CLAUDE.md §7.5), so a write touching a set must send the whole
 * set. That is the right semantics — an edit to one previous refusal is an
 * edit to the refusal list — but it is a trap if a caller assumes items are
 * appended.
 */
export function assertDeclaredSetsValid(
  declaration: PackEntityTypeDeclaration,
  incoming: Record<string, unknown>,
): void {
  const sets = (declaration.fields ?? []).filter(
    (f) => Array.isArray(f.itemFields) && f.itemFields.length > 0,
  );
  if (!sets.length) return;

  for (const set of sets) {
    if (!(set.key in incoming)) continue;
    const value = incoming[set.key];
    if (value === null || value === undefined) continue;

    const declaredKeys = new Set(set.itemFields!.map((f) => f.key));

    if (!Array.isArray(value)) {
      throw new BadRequestException(
        `'${set.key}' (${set.label}) is a repeating set: send an array of ` +
          `entries, or null to clear it. An empty array records "none".`,
      );
    }
    if (value.length > MAX_SET_ITEMS) {
      throw new BadRequestException(
        `'${set.key}' accepts at most ${MAX_SET_ITEMS} entries; received ${value.length}.`,
      );
    }

    value.forEach((item, index) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new BadRequestException(
          `'${set.key}[${index}]' must be an object with the fields the pack ` +
            `declares (${[...declaredKeys].join(', ')}).`,
        );
      }

      for (const [name, entryValue] of Object.entries(
        item as Record<string, unknown>,
      )) {
        if (!declaredKeys.has(name)) {
          throw new BadRequestException(
            `'${set.key}[${index}].${name}' is not declared on this pack. ` +
              `Declared fields: ${[...declaredKeys].join(', ')}.`,
          );
        }
        if (entryValue !== null && typeof entryValue === 'object') {
          throw new BadRequestException(
            `'${set.key}[${index}].${name}' must be a scalar; a repeating set ` +
              `holds flat entries.`,
          );
        }
        if (
          typeof entryValue === 'string' &&
          entryValue.length > MAX_ITEM_VALUE_LENGTH
        ) {
          throw new BadRequestException(
            `'${set.key}[${index}].${name}' is longer than ${MAX_ITEM_VALUE_LENGTH} characters.`,
          );
        }
      }

      for (const field of set.itemFields!) {
        if (!field.required) continue;
        const entryValue = (item as Record<string, unknown>)[field.key];
        if (entryValue === undefined || entryValue === null || entryValue === '') {
          throw new BadRequestException(
            `'${set.key}[${index}].${field.key}' (${field.label}) is required by the pack.`,
          );
        }
      }
    });
  }
}
