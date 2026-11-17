import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { DocumentAccessService } from '../documents/document-access.service';
import { FormController } from './form.controller';
import { FormBuilderService } from './form-builder.service';

/**
 * Anton, second gate (HIGH), forms:
 *
 * 1. `POST /forms`, `PUT /forms/:id`, `POST /forms/:id/publish` and
 *    `POST /forms/:id/version` had no `@Roles`: a `client` token could author,
 *    rewrite and publish the firm's forms. Now staff and above.
 * 2. `POST /forms/:id/submissions` wrote whatever `entityId` it was given, so
 *    a client could attach a submission to another applicant's record. It
 *    now asks the one ownership rule, `DocumentAccessService.assertOwnsEntity`
 *    (assignee OR subject email), 404 on refusal, before anything is read or
 *    written. A client submitting against their OWN record still works; no
 *    frontend submits a form today (meru-core-fe grepped), so nothing
 *    legitimate is cut off.
 */
describe('forms — client-role reach', () => {
  const T = 'tenant-1';
  const client = { id: 'client-1', roles: [PlatformRole.CLIENT], email: 'Applicant@Example.test ' };
  const staff = { id: 'staff-1', roles: [PlatformRole.STAFF], email: 's@firm.test' };

  describe('form authoring is staff and above', () => {
    const guard = new PolicyGuard(new Reflector(), {} as any, {} as any);
    const as = (roles: string[], handler: (...a: any[]) => unknown) =>
      guard.canActivate({
        getHandler: () => handler,
        getClass: () => FormController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', roles } }) }),
      } as any);
    const p = FormController.prototype;

    it.each([
      ['POST /forms', p.createForm],
      ['PUT /forms/:id', p.updateForm],
      ['POST /forms/:id/publish', p.publishForm],
      ['POST /forms/:id/version', p.createNewVersion],
    ])('%s refuses a client token and admits staff and firm_admin', async (_n, h) => {
      await expect(as([PlatformRole.CLIENT], h)).rejects.toBeInstanceOf(ForbiddenException);
      for (const r of [PlatformRole.STAFF, PlatformRole.FIRM_ADMIN]) {
        await expect(as([r], h)).resolves.toBe(true);
      }
    });

    it('a client may still create a submission (the route is not role-gated)', async () => {
      await expect(as([PlatformRole.CLIENT], p.createSubmission)).resolves.toBe(true);
    });
  });

  describe('createSubmission asks the one ownership rule for its entityId', () => {
    const records = [
      { id: 'own-case', tenantId: T, assignedTo: 'staff-1', subjectEmail: 'applicant@example.test' },
      { id: 'other-case', tenantId: T, assignedTo: 'staff-1', subjectEmail: 'someone-else@example.test' },
    ];

    function build() {
      // A query builder that answers DocumentAccessService.ownedEntityIds
      // from `records` the way the SQL would.
      const entities = {
        createQueryBuilder: () => {
          const params: Record<string, any> = {};
          const qb: any = {
            select: () => qb,
            where: (_s: string, p: any) => (Object.assign(params, p), qb),
            andWhere: (_s: string, p: any) => (Object.assign(params, p), qb),
            getRawMany: async () =>
              records
                .filter((r) => r.tenantId === params.tenantId)
                .filter(
                  (r) =>
                    r.assignedTo === params.userId ||
                    (!!params.email && r.subjectEmail.toLowerCase() === params.email),
                )
                .map((r) => ({ id: r.id })),
          };
          return qb;
        },
      };
      const access = new DocumentAccessService(entities as any, {} as any, {} as any);
      const formSchemaRepo = {
        findOne: jest.fn(async () => ({ id: 'form-1', tenantId: T, fields: [] })),
      };
      const saved: any[] = [];
      const submissionRepo = {
        create: (x: any) => x,
        save: jest.fn(async (x: any) => (saved.push(x), { ...x, id: 'sub-1' })),
        findOne: jest.fn(async () => saved[saved.length - 1] ?? null),
      };
      const unused = {} as any;
      const service = new FormBuilderService(
        formSchemaRepo as any,
        unused, // formFieldRepo
        submissionRepo as any,
        unused, // dataSource
        unused, // searchService
        unused, // aiService
        unused, // documentHubService
        access,
      );
      return { service, submissionRepo, formSchemaRepo, saved };
    }

    it("refuses a client naming another applicant's record — 404, nothing read or written", async () => {
      const b = build();
      await expect(
        b.service.createSubmission('form-1', T, client, { a: 1 }, 'other-case'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(b.submissionRepo.save).not.toHaveBeenCalled();
      expect(b.formSchemaRepo.findOne).not.toHaveBeenCalled();
    });

    it('lets a client submit against their own record (matched by subject email)', async () => {
      const b = build();
      await b.service.createSubmission('form-1', T, client, { a: 1 }, 'own-case');
      expect(b.saved[0]).toMatchObject({ entityId: 'own-case', submittedBy: 'client-1', tenantId: T });
    });

    it('lets a client submit with no record named', async () => {
      const b = build();
      await b.service.createSubmission('form-1', T, client, { a: 1 });
      expect(b.saved[0]).toMatchObject({ submittedBy: 'client-1' });
    });

    it('staff reach any record in the tenant', async () => {
      const b = build();
      await b.service.createSubmission('form-1', T, staff, { a: 1 }, 'other-case');
      expect(b.saved[0]).toMatchObject({ entityId: 'other-case', submittedBy: 'staff-1' });
    });

    it('the controller hands the service the caller from the token, email included', async () => {
      const createSubmission = jest.fn(async () => ({}));
      const controller = new FormController({ createSubmission } as any);
      await controller.createSubmission(
        { user: { id: 'client-1', tenantId: T, roles: ['client'], email: 'c@example.test' } } as any,
        'form-1',
        { data: { a: 1 }, entityId: 'own-case' },
      );
      expect(createSubmission).toHaveBeenCalledWith(
        'form-1',
        T,
        { id: 'client-1', roles: ['client'], email: 'c@example.test' },
        { a: 1 },
        'own-case',
      );
    });
  });
});
