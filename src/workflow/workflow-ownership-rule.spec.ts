import { CrmAccessService } from '../crm/crm-access.service';
import { WorkflowEngineService } from './workflow.service';

/**
 * Anton, second gate (#15): `WorkflowEngineService.ownedEntityIds` was a
 * third hand-written copy of the "which records are this caller's" rule
 * (CrmAccessService and DocumentAccessService hold the others). It now builds
 * its id query and asks `CrmAccessService.applyScope` for the predicate, so
 * widening ownership (a co-applicant relation, say) is one edit, not three.
 */
describe('WorkflowEngineService — instance ownership uses the CRM rule', () => {
  function build(crmAccess: CrmAccessService) {
    const calls: Array<{ kind: string; sql: string; params?: any }> = [];
    const qb: any = {
      select: () => qb,
      where: (sql: string, params: any) => (calls.push({ kind: 'where', sql, params }), qb),
      andWhere: (sql: string, params: any) => (calls.push({ kind: 'andWhere', sql, params }), qb),
      getRawMany: async () => [{ id: 'own-case' }],
    };
    const entityRepo = { createQueryBuilder: jest.fn(() => qb) };
    const instanceRepo = { find: jest.fn(async () => []) };
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
      crmAccess,
    );
    return { engine, calls, qb, instanceRepo };
  }

  it('asks CrmAccessService.applyScope for the predicate, on the "e" alias, inside the tenant', async () => {
    const access = new CrmAccessService();
    const applyScope = jest.spyOn(access, 'applyScope');
    const b = build(access);
    const client = { id: 'client-1', roles: ['client'], email: 'Applicant@Example.test' };

    await b.engine.listInstances('t1', client);

    expect(applyScope).toHaveBeenCalledWith(b.qb, client, 'e');
    expect(b.calls[0]).toMatchObject({ kind: 'where', params: { tenantId: 't1' } });
    // The predicate is CrmAccessService's, not a local copy.
    expect(b.calls[1].sql).toContain('e."assignedTo" = :crmActorId');
    expect(b.calls[1].params).toEqual({
      crmActorId: 'client-1',
      crmActorEmail: 'applicant@example.test',
    });
  });
});
