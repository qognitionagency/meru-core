import 'reflect-metadata';
import { CrmAccessService } from '../crm/crm-access.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { InstanceStatus } from './entities/workflow-instance.entity';
import { WorkflowController } from './workflow.controller';
import { WorkflowEngineService } from './workflow.service';
import { TatService } from './services/tat.service';

/**
 * Anton, second gate (MEDIUM — the eighth read leak):
 *
 * - `GET /workflows/instances/:id/tat` filtered `{ id, tenantId }` only, so a
 *   `client` token could read the stage-by-stage timeline of any applicant's
 *   matter in the firm. It now goes through the one instance-ownership rule
 *   (`WorkflowEngineService.getInstance`: started it, or the record is theirs
 *   by assignee or subject email), 404 otherwise.
 * - `GET /workflows/tat` is firm-wide aggregate turnaround — staff and above.
 *
 * The ownership rule here is the REAL WorkflowEngineService, over a fake
 * CRM query builder that answers the ownership query the way the SQL would.
 */
describe('turnaround time — client-role reach', () => {
  const T = 't1';
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const instanceFor = (id: string, entityId: string, startedBy = 'staff-1') => ({
    id,
    tenantId: T,
    workflowId: 'wf1',
    entityType: 'case',
    entityId,
    startedBy,
    status: InstanceStatus.ACTIVE,
    createdAt: hoursAgo(10),
    completedAt: null,
    stateEnteredAt: hoursAgo(5),
    currentState: { name: 'review', config: {} },
    workflow: { slaConfig: { enabled: false } },
    history: [{ timestamp: hoursAgo(5), fromState: 'intake', toState: 'review' }],
  });
  const instances = [instanceFor('mine', 'own-case'), instanceFor('theirs', 'other-case')];
  const records = [
    { id: 'own-case', tenantId: T, assignedTo: 'staff-1', subjectEmail: 'applicant@example.test' },
    { id: 'other-case', tenantId: T, assignedTo: 'staff-1', subjectEmail: 'other@example.test' },
  ];
  const client = { id: 'client-1', roles: [PlatformRole.CLIENT], email: 'applicant@example.test' };
  const staff = { id: 'staff-1', roles: [PlatformRole.STAFF], email: 's@firm.test' };

  function build() {
    const instanceRepo = {
      findOne: jest.fn(async ({ where }: any) =>
        instances.find((i) => i.id === where.id && i.tenantId === where.tenantId) ?? null,
      ),
    };
    const entityRepo = {
      createQueryBuilder: () => {
        const p: Record<string, any> = {};
        const qb: any = {
          select: () => qb,
          where: (_s: string, x: any) => (Object.assign(p, x), qb),
          andWhere: (_s: string, x: any) => (Object.assign(p, x), qb),
          getRawMany: async () => {
            const uid = p.userId ?? p.crmActorId;
            const email = p.email ?? p.crmActorEmail;
            return records
              .filter((r) => r.tenantId === p.tenantId)
              .filter((r) => r.assignedTo === uid || (!!email && r.subjectEmail === email))
              .map((r) => ({ id: r.id }));
          },
        };
        return qb;
      },
    };
    const unused = {} as any;
    const engine = new WorkflowEngineService(
      unused, // workflowRepo
      unused, // stateRepo
      unused, // transitionRepo
      instanceRepo as any,
      entityRepo as any,
      unused, // dataSource
      unused, // searchService
      unused, // aiService
      unused, // documentHubService
      unused, // notificationsService
      unused, // taskService
      unused, // feeScheduleService
      unused, // rules
      unused, // auditService
      unused, // usersRepo
      new CrmAccessService(),
    );
    const getInstance = jest.spyOn(engine, 'getInstance');
    const tat = new TatService(instanceRepo as any, engine);
    return { tat, getInstance };
  }

  it("refuses a client the timeline of another applicant's matter — 404", async () => {
    await expect(build().tat.forInstance(T, 'theirs', client)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('gives a client the timeline of their own matter', async () => {
    const res = await build().tat.forInstance(T, 'mine', client);
    expect(res.instanceId).toBe('mine');
    expect(res.stages.length).toBeGreaterThan(0);
  });

  it('staff read any matter in the tenant without the ownership query', async () => {
    const b = build();
    const res = await b.tat.forInstance(T, 'theirs', staff);
    expect(res.instanceId).toBe('theirs');
    expect(b.getInstance).not.toHaveBeenCalled();
  });

  it('the controller hands the service the caller from the token', async () => {
    const forInstance = jest.fn(async () => ({}));
    const controller = new WorkflowController({} as any, { forInstance } as any, {} as any);
    await controller.tatForInstance(
      { user: { id: 'client-1', tenantId: T, roles: ['client'], email: 'c@example.test' } } as any,
      'mine',
    );
    expect(forInstance).toHaveBeenCalledWith(T, 'mine', {
      id: 'client-1',
      roles: ['client'],
      email: 'c@example.test',
    });
  });

  describe('GET /workflows/tat is staff and above', () => {
    const guard = new PolicyGuard(new Reflector(), {} as any, {} as any);
    const as = (roles: string[], handler: (...a: any[]) => unknown) =>
      guard.canActivate({
        getHandler: () => handler,
        getClass: () => WorkflowController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', roles } }) }),
      } as any);

    it('refuses a client token; admits staff and firm_admin', async () => {
      const h = WorkflowController.prototype.tatAggregate;
      await expect(as([PlatformRole.CLIENT], h)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(as([PlatformRole.STAFF], h)).resolves.toBe(true);
      await expect(as([PlatformRole.FIRM_ADMIN], h)).resolves.toBe(true);
    });

    it('the per-instance route stays open to a client (it is own-scoped in the service)', async () => {
      await expect(
        as([PlatformRole.CLIENT], WorkflowController.prototype.tatForInstance),
      ).resolves.toBe(true);
    });
  });
});
