import {
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentAccessService } from './document-access.service';
import { MeruErrorCode } from '../common/types';
import type { Actor } from '../common/access';

/**
 * ADR 0025 — the document review state machine (E19).
 *
 * Three things pinned here, per the ADR's own test plan:
 *
 * 1. **A `client` token cannot reach either new route at all.** Both carry
 *    `@Roles(PlatformRole.FIRM_ADMIN, PlatformRole.STAFF)` — proven against
 *    the REAL `Reflector` and the REAL `DocumentsController.prototype`
 *    methods, same technique `crm-create-entity-authz.spec.ts` uses, not a
 *    hand-written metadata object. This matters here specifically because a
 *    `client` who uploaded their own document passes
 *    `DocumentAccessService`'s 'write' check (the uploader owns their
 *    upload for every action) — the `@Roles` guard is the ONLY thing
 *    standing between a client and their own document's review state, and a
 *    service-layer-only test would not have caught a missing decorator.
 * 2. **A `staff` actor from another tenant cannot decide on this tenant's
 *    document** — `{id, tenantId}` load returns nothing for a foreign
 *    tenant, same 404-not-403 shape as every other document route.
 * 3. **Rejected → re-upload resets `reviewStatus` to `uploaded`, with v1
 *    intact** — `createNewVersion`'s ADR 0025 D3 reset behaviour.
 */
describe('ADR 0025 — document review authz and state machine', () => {
  const T = 'tenant-1';

  describe('guard: POST /documents/:id/review/start and .../decision are staff-only', () => {
    function contextFor(user: unknown, handler: Function) {
      return {
        getHandler: () => handler,
        getClass: () => DocumentsController,
        switchToHttp: () => ({
          getRequest: () => ({ user, ip: '203.0.113.10' }),
        }),
      } as any;
    }

    function buildGuard() {
      const reflector = new Reflector();
      const verticalPolicyService = {
        getPolicy: jest.fn(),
      } as unknown as VerticalPolicyService;
      const dataSource = { query: jest.fn() } as unknown as DataSource;
      return new PolicyGuard(reflector, verticalPolicyService, dataSource);
    }

    it.each([
      ['review/start', DocumentsController.prototype.startReview],
      ['review/decision', DocumentsController.prototype.decideReview],
    ])('refuses a client-only token on %s', async (_name, handler) => {
      const guard = buildGuard();
      await expect(
        guard.canActivate(
          contextFor({ id: 'client-a', roles: ['client'] }, handler),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['review/start', DocumentsController.prototype.startReview],
      ['review/decision', DocumentsController.prototype.decideReview],
    ])('allows staff on %s', async (_name, handler) => {
      const guard = buildGuard();
      await expect(
        guard.canActivate(
          contextFor({ id: 'staff-1', roles: ['staff'] }, handler),
        ),
      ).resolves.toBe(true);
    });

    it.each([
      ['review/start', DocumentsController.prototype.startReview],
      ['review/decision', DocumentsController.prototype.decideReview],
    ])('allows firm_admin on %s', async (_name, handler) => {
      const guard = buildGuard();
      await expect(
        guard.canActivate(
          contextFor({ id: 'admin-1', roles: ['firm_admin'] }, handler),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('service layer', () => {
    const staffA: Actor = { id: 'staff-a', roles: ['staff'] };

    function build() {
      const document: any = {
        id: 'doc-1',
        tenantId: T,
        uploadedById: 'client-1',
        rbac: { owner: 'client-1' },
        linkedEntityId: 'case-1',
        versionNumber: 1,
        reviewStatus: 'uploaded',
        reviewedById: null,
        reviewedAt: null,
        rejectionReasonKey: null,
        rejectionReasonNote: null,
        reviewHistory: [],
        slug: 'passport-123',
        fileType: 'pdf',
        requiredEncryption: 'none',
      };

      const documentRepo = {
        findOne: jest.fn(async ({ where }: any) => {
          if (where.id === document.id && where.tenantId === T) return document;
          return null; // wrong tenant, or unknown id
        }),
        save: jest.fn(async (d: any) => {
          Object.assign(document, d);
          return document;
        }),
      };

      const entitiesForAccess = { createQueryBuilder: jest.fn() };
      const access = new DocumentAccessService(entitiesForAccess as any);

      const packs = {
        sectionWithPack: jest.fn(async () => ({
          pack: { code: 'immigration', version: '2.10.0' },
          section: {
            documentReview: {
              rejectionReasons: [
                { key: 'illegible', label: 'Illegible or low quality' },
                { key: 'expired', label: 'Document has expired' },
              ],
            },
          },
        })),
      };

      const auditService = { logUpdate: jest.fn().mockResolvedValue({}) };

      const userRepo = {
        findOne: jest.fn(async () => ({ id: staffA.id, email: 'staff-a@test' })),
      };
      const versionRepo = {
        create: jest.fn((v: any) => v),
        save: jest.fn(async () => undefined),
      };
      const dataSource = {
        createQueryRunner: () => ({
          connect: async () => undefined,
          startTransaction: async () => undefined,
          commitTransaction: async () => undefined,
          rollbackTransaction: async () => undefined,
          release: async () => undefined,
          manager: {
            create: jest.fn((_cls: any, obj: any) => obj),
            save: jest.fn(async () => undefined),
          },
        }),
      };
      const storage = {
        putObject: jest.fn(async () => ({ bucket: 'b', provider: 's3' })),
        signedReadUrl: jest.fn(async () => 'https://signed'),
      };

      const service = new DocumentsService(
        documentRepo as any,
        versionRepo as any,
        {} as any, // metadataRepo
        userRepo as any,
        {} as any, // configService
        dataSource as any,
        {} as any, // orchestrationService
        access,
        storage as any,
        {} as any, // documentRequests
        packs as any,
        auditService as any,
      );

      return { service, document, documentRepo, auditService, packs };
    }

    it('a staff actor from another tenant cannot decide on this tenant\'s document — 404, not 403', async () => {
      const { service } = build();

      await expect(
        service.decideReview(
          'doc-1',
          'tenant-other',
          staffA,
          { decision: 'approve' },
          'immigration',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects with a valid pack key, records reviewedById/At and a reviewHistory entry', async () => {
      const { service, document, auditService } = build();

      const result = await service.decideReview(
        'doc-1',
        T,
        staffA,
        { decision: 'reject', rejectionReasonKey: 'illegible', rejectionReasonNote: 'blurry scan' },
        'immigration',
      );

      expect(result.reviewStatus).toBe('rejected');
      expect(result.reviewedById).toBe('staff-a');
      expect(result.rejectionReasonKey).toBe('illegible');
      expect(document.reviewHistory).toHaveLength(1);
      expect(document.reviewHistory[0]).toMatchObject({
        status: 'rejected',
        byId: 'staff-a',
        rejectionReasonKey: 'illegible',
      });
      expect(auditService.logUpdate).toHaveBeenCalledTimes(1);
    });

    it('refuses a reject with a key not in the resolved pack\'s rejectionReasons[]', async () => {
      const { service } = build();

      await expect(
        service.decideReview(
          'doc-1',
          T,
          staffA,
          { decision: 'reject', rejectionReasonKey: 'not_a_real_key' },
          'immigration',
        ),
      ).rejects.toThrow(/rejectionReasonKey must be one of/);
    });

    it('refuses a reject with no rejectionReasonKey at all', async () => {
      const { service } = build();

      await expect(
        service.decideReview('doc-1', T, staffA, { decision: 'reject' }, 'immigration'),
      ).rejects.toThrow(/rejectionReasonKey must be one of/);
    });

    /**
     * No active config pack for this vertical (`sectionWithPack` resolving
     * `{pack: null, section: null}` — e.g. an unpinned tenant on a vertical
     * with nothing published yet) must still answer a clean 400
     * `MER-VAL-0006`, never a 500: `decideReview`'s reject branch reads
     * `section?.documentReview?.rejectionReasons ?? []`, which is null-safe,
     * and the error message's `pack ? ... : 'the pack'` ternary is
     * null-safe too.
     */
    it('reject with no active config pack (sectionWithPack → {pack: null, section: null}) answers 400 MER-VAL-0006, not 500', async () => {
      const { service, packs } = build();
      packs.sectionWithPack.mockResolvedValueOnce({ pack: null, section: null });

      const error = await service
        .decideReview(
          'doc-1',
          T,
          staffA,
          { decision: 'reject', rejectionReasonKey: 'illegible' },
          'immigration',
        )
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getStatus()).toBe(400);
      expect((error.getResponse() as any).code).toBe(
        MeruErrorCode.VALIDATION_INVALID_ENUM_VALUE,
      );
      expect((error.getResponse() as any).message).toMatch(/the pack's/);
    });

    it('approve succeeds with no active config pack — approving never reads the pack at all', async () => {
      const { service, packs } = build();
      packs.sectionWithPack.mockResolvedValueOnce({ pack: null, section: null });

      const result = await service.decideReview(
        'doc-1',
        T,
        staffA,
        { decision: 'approve' },
        'immigration',
      );

      expect(result.reviewStatus).toBe('approved');
      expect(packs.sectionWithPack).not.toHaveBeenCalled();
    });

    it('approving clears a stale prior rejection reason', async () => {
      const { service, document } = build();
      document.reviewStatus = 'rejected';
      document.rejectionReasonKey = 'expired';
      document.rejectionReasonNote = 'old note';

      const result = await service.decideReview(
        'doc-1',
        T,
        staffA,
        { decision: 'approve' },
        'immigration',
      );

      expect(result.reviewStatus).toBe('approved');
      expect(result.rejectionReasonKey).toBeNull();
      expect(result.rejectionReasonNote).toBeNull();
    });

    it('review/start is a no-op 200 when already under_review', async () => {
      const { service, document, documentRepo } = build();
      document.reviewStatus = 'under_review';

      const result = await service.startReview('doc-1', T, staffA);

      expect(result.reviewStatus).toBe('under_review');
      expect(documentRepo.save).not.toHaveBeenCalled();
    });

    it('review/start refuses (409) on an already-decided document', async () => {
      const { service, document } = build();
      document.reviewStatus = 'approved';

      await expect(service.startReview('doc-1', T, staffA)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejected → re-upload resets reviewStatus to uploaded, with the prior decision preserved in reviewHistory and v1 intact', async () => {
      const { service, document } = build();
      document.reviewStatus = 'rejected';
      document.reviewedById = 'staff-a';
      document.reviewedAt = new Date('2026-09-01T00:00:00.000Z');
      document.rejectionReasonKey = 'illegible';
      document.rejectionReasonNote = 'blurry';
      document.versionNumber = 1;

      const file = { buffer: Buffer.from('x'), size: 1, mimetype: 'application/pdf' } as any;

      const result = await service.createNewVersion(
        'doc-1',
        file,
        'Re-upload after rejection',
        T,
        staffA,
      );

      // v1 intact: the reset is a new v2, not a mutation of the rejected v1.
      expect(result.document.versionNumber).toBe(2);
      expect(result.document.reviewStatus).toBe('uploaded');
      expect(result.document.reviewedById).toBeNull();
      expect(result.document.reviewedAt).toBeNull();
      expect(result.document.rejectionReasonKey).toBeNull();
      expect(result.document.rejectionReasonNote).toBeNull();

      expect(document.reviewHistory).toHaveLength(1);
      expect(document.reviewHistory[0]).toMatchObject({
        status: 'rejected',
        byId: 'staff-a',
        versionNumber: 1,
        rejectionReasonKey: 'illegible',
      });
    });
  });
});
