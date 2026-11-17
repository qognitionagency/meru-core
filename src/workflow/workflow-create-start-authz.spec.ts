import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowEngineService } from './workflow.service';
import { CrmAccessService } from '../crm/crm-access.service';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { ROLES_KEY } from '../iam/decorators/roles.decorator';

/**
 * Owen's gate, 2026-11-17: `POST /workflows` and `POST /workflows/instances`
 * carried no `@Roles`, so any authenticated caller in a tenant — a `client`
 * included — could create a workflow definition or start an instance, and
 * `startWorkflow` started one on whatever `entityId` the body named, with no
 * ownership check. Both routes are now staff-and-above (the same pair as
 * `POST /workflows/instances/:id/transition`), and the service refuses a
 * caller without tenant-wide reach an entity they do not own — 404, not 403,
 * the same as every other by-id refusal.
 *
 * Stacking: no frontend calls either route (grepped immistack, governancex
 * and meru-dashboard, 2026-11-17); ImmiStack only reads instances and
 * materialises pack workflows, which is unchanged.
 */
describe('Workflow create/start — staff only, and only on an owned entity', () => {
  it.each(['createWorkflow', 'startWorkflow'])('%s is staff-and-above', (name) => {
    const roles = Reflect.getMetadata(ROLES_KEY, (WorkflowController.prototype as any)[name]);
    expect(roles).toEqual([PlatformRole.STAFF, PlatformRole.FIRM_ADMIN]);
  });

  it('the controller passes the caller as an actor, from the token', async () => {
    const startWorkflow = jest.fn(async () => ({ id: 'wi1' }));
    const controller = new WorkflowController({ startWorkflow } as any, {} as any, {} as any);
    await controller.startWorkflow(
      { user: { id: 'u1', tenantId: 't1', roles: ['staff'], email: 's@firm.test' } } as any,
      { workflowId: 'w1', entityId: 'e1', entityType: 'case', context: {} } as any,
    );
    expect(startWorkflow).toHaveBeenCalledWith('w1', 'e1', 'case', 't1', {
      id: 'u1',
      roles: ['staff'],
      email: 's@firm.test',
    }, {});
  });

  function build(owned: string[]) {
    const saved: any[] = [];
    const qb: any = {
      select: () => qb,
      where: () => qb,
      andWhere: () => qb,
      getRawMany: jest.fn(async () => owned.map((id) => ({ id }))),
    };
    const svc: any = Object.assign(Object.create(WorkflowEngineService.prototype), {
      logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
      entityRepo: { createQueryBuilder: jest.fn(() => qb) },
      // ownedEntityIds asks CrmAccessService.applyScope for the predicate.
      crmAccess: new CrmAccessService(),
      workflowRepo: {
        findOne: jest.fn(async () => ({
          id: 'w1',
          status: 'active',
          states: [{ id: 's0', type: 'start', config: {} }],
        })),
      },
      instanceRepo: {
        create: (x: any) => x,
        save: jest.fn(async (x: any) => (saved.push(x), { ...x, id: 'wi1' })),
        findOne: jest.fn(async () => ({ id: 'wi1' })),
      },
    });
    return { svc, saved, qb };
  }

  it('refuses a non-staff caller an entity they do not own, before anything is written', async () => {
    const { svc, saved } = build(['their-own']);
    const client = { id: 'c1', roles: ['client'], email: 'c@example.test' };
    await expect(
      svc.startWorkflow('w1', 'someone-elses', 'case', 't1', client, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(saved).toHaveLength(0);
  });

  it('lets a non-staff caller start on an entity they own, recorded as started by them', async () => {
    const { svc, saved } = build(['their-own']);
    const client = { id: 'c1', roles: ['client'], email: 'c@example.test' };
    await svc.startWorkflow('w1', 'their-own', 'case', 't1', client, {});
    expect(saved[0]).toMatchObject({ entityId: 'their-own', startedBy: 'c1', tenantId: 't1' });
  });

  it('staff are not narrowed, and no ownership query runs', async () => {
    const { svc, saved, qb } = build([]);
    const staff = { id: 's1', roles: ['staff'] };
    await svc.startWorkflow('w1', 'any-entity', 'obligation', 't1', staff, {});
    expect(saved[0]).toMatchObject({ entityId: 'any-entity', startedBy: 's1' });
    expect(qb.getRawMany).not.toHaveBeenCalled();
  });
});
