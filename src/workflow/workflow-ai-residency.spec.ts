import { WorkflowEngineService } from './workflow.service';

/**
 * `analyzeWorkflowPerformance` and `getWorkflowRecommendations` set
 * `context: { tenantId }` only. `AiService.execute` reads the TOP-LEVEL
 * `tenantId` field for `clientFor` routing (residency), not
 * `request.context.tenantId`, so both calls always used the platform key
 * regardless of the tenant's own connector.
 *
 * `[UNVERIFIED: neither method has a caller anywhere in src today — grepped
 * — so this fix has no live tenant-binding path to verify against yet.
 * Fixed for correctness and specced so a future caller inherits it right.]`
 */
describe('WorkflowEngineService — AI residency (tenantId passed top-level)', () => {
  const T = 'tenant-1';
  const unused = {} as any;

  function build(execute: jest.Mock) {
    const instanceRepo = { find: jest.fn().mockResolvedValue([]) };
    const aiService = { execute };

    return new WorkflowEngineService(
      unused, // workflowRepo
      unused, // stateRepo
      unused, // transitionRepo
      instanceRepo as any,
      unused, // entityRepo
      unused, // dataSource
      unused, // searchService
      aiService as any,
      unused, // documentHubService
      unused, // notificationsService
      unused, // taskService
      unused, // feeScheduleService
      unused, // rules
      unused, // auditService
      unused, // usersRepo
    );
  }

  it('analyzeWorkflowPerformance passes tenantId to execute() top-level', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ ok: true }) });
    const service = build(execute);

    await service.analyzeWorkflowPerformance('wf-1', T);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T }),
    );
  });

  it('getWorkflowRecommendations passes tenantId to execute() top-level', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ recommendation: 'x' }) });
    const service = build(execute);
    jest.spyOn(service, 'listWorkflows').mockResolvedValue([]);

    await service.getWorkflowRecommendations(T, 'case', {});

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T }),
    );
  });
});
