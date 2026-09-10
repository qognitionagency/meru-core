import { NotFoundException } from '@nestjs/common';
import { DocumentGenerationService, type DocumentTemplate } from './document-generation.service';
import { DocumentAccessService } from './document-access.service';
import type { Actor } from '../common/access';

/**
 * `POST /documents/generate/:templateKey` returned rendered PDF bytes
 * straight from `buildContext`, which loaded `entityId` scoped to the tenant
 * only. Any authenticated caller in the tenant — including a `client` role —
 * could pass another applicant's `entityId` and receive that applicant's
 * filled cost agreement: name, fee amounts, payment history and vertical
 * attributes. Storing the result was optional (`?store=true`) and was the
 * only path that checked ownership, via `DocumentGenerationService.store`.
 *
 * Same construction style as `document-checklist-authz.spec.ts`: services
 * built directly, `DocumentAccessService` given a hand-rolled `UniversalEntity`
 * repo stub answering the same assignment/subject query the real SQL would.
 */
describe('DocumentGenerationService.generate — POST /documents/generate/:templateKey', () => {
  const T = 'tenant-1';
  const OWNED_CASE = 'case-owned';
  const FOREIGN_CASE = 'case-foreign';

  const staff: Actor = { id: 'staff-1', roles: ['staff'] };
  const clientA: Actor = {
    id: 'client-a',
    roles: ['client'],
    email: 'a@example.test',
  };

  // client-a is the SUBJECT of OWNED_CASE, never its assignee — matching
  // CrmAccessService/DocumentAccessService's ownership model.
  const assignments: Record<string, string[]> = {};
  const subjects: Record<string, string[]> = {
    'a@example.test': [OWNED_CASE],
  };

  const template: DocumentTemplate = {
    key: 'cost_agreement',
    label: 'Cost agreement',
    blocks: [{ type: 'paragraph', text: 'Between {{tenant.name}} and {{client.fullName}}.' }],
  };

  function build() {
    const entitiesForAccess = {
      createQueryBuilder: jest.fn(() => {
        const params: Record<string, any> = {};
        const bind = (_sql: string, p: Record<string, any> = {}) => {
          Object.assign(params, p);
          return qb;
        };
        const qb: any = {
          select: () => qb,
          where: bind,
          andWhere: bind,
          getRawMany: async () => {
            const ids = new Set<string>(assignments[params.userId] ?? []);
            if (params.email) {
              for (const id of subjects[params.email] ?? []) ids.add(id);
            }
            return [...ids].map((id) => ({ id }));
          },
        };
        return qb;
      }),
    };
    const access = new DocumentAccessService(entitiesForAccess as any);

    const packs = {
      sectionWithPack: jest.fn(async () => ({
        pack: { code: 'immigration', version: '1.0.0' },
        section: [template],
      })),
    };

    const entityRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.id === OWNED_CASE && where.tenantId === T) {
          return {
            id: OWNED_CASE,
            tenantId: T,
            firstName: 'Priya',
            lastName: 'Sharma',
            email: 'a@example.test',
            type: 'person',
            status: 'open',
            verticalAttributes: {},
          };
        }
        if (where.id === FOREIGN_CASE && where.tenantId === T) {
          return {
            id: FOREIGN_CASE,
            tenantId: T,
            firstName: 'Someone',
            lastName: 'Else',
            email: 'other@example.test',
            type: 'person',
            status: 'open',
            verticalAttributes: {},
          };
        }
        return null;
      }),
    };

    const paymentRepo = { find: jest.fn(async () => []) };
    const tenantRepo = {
      findOne: jest.fn(async () => ({ name: 'Acme Migration', slug: 'acme' })),
    };
    const documents = { upload: jest.fn() };

    const service = new DocumentGenerationService(
      packs as any,
      entityRepo as any,
      paymentRepo as any,
      tenantRepo as any,
      documents as any,
      access,
    );

    return { service, entityRepo };
  }

  it('refuses a client generating a document for a case that is not theirs, 404 not 403', async () => {
    const { service, entityRepo } = build();

    await expect(
      service.generate(T, 'immigration', 'cost_agreement', clientA, FOREIGN_CASE),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Refused before the record — and therefore its fees and vertical
    // attributes — was ever loaded.
    expect(entityRepo.findOne).not.toHaveBeenCalled();
  });

  it('allows a client to generate a document for their own case', async () => {
    const { service } = build();

    const out = await service.generate(T, 'immigration', 'cost_agreement', clientA, OWNED_CASE);

    expect(out.mimeType).toBe('application/pdf');
  });

  it('allows staff to generate a document for any case in the tenant', async () => {
    const { service } = build();

    const out = await service.generate(T, 'immigration', 'cost_agreement', staff, FOREIGN_CASE);

    expect(out.mimeType).toBe('application/pdf');
  });

  it('a staff actor generating with no entityId is unaffected by the check', async () => {
    const { service, entityRepo } = build();

    const out = await service.generate(T, 'immigration', 'cost_agreement', staff);

    expect(out.mimeType).toBe('application/pdf');
    expect(entityRepo.findOne).not.toHaveBeenCalled();
  });
});
