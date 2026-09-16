import { TaskService } from './task.service';

/**
 * `getPrioritizedTasks` and `suggestTaskFromContext` set `context: {
 * tenantId }` only. `AiService.execute` reads the TOP-LEVEL `tenantId` field
 * for `clientFor` routing (residency), not `request.context.tenantId`, so
 * both calls always used the platform key regardless of the tenant's own
 * connector.
 *
 * `[UNVERIFIED: neither method has a caller anywhere in src today — grepped
 * — so this fix has no live tenant-binding path to verify against yet.
 * Fixed for correctness and specced so a future caller inherits it right.]`
 */
describe('TaskService — AI residency (tenantId passed top-level)', () => {
  const T = 'tenant-1';

  function build(execute: jest.Mock) {
    const taskRepo = { find: jest.fn().mockResolvedValue([]) };
    const aiService = { execute };

    return new TaskService(
      taskRepo as any,
      {} as any, // commentRepo
      {} as any, // recurringJobRepo
      {} as any, // searchService
      aiService as any,
      {} as any, // documentHubService
    );
  }

  it('getPrioritizedTasks passes tenantId to execute() top-level', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ order: [] }) });
    const service = build(execute);

    await service.getPrioritizedTasks(T, 'user-1');

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T }),
    );
  });

  it('suggestTaskFromContext passes tenantId to execute() top-level', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue({ result: JSON.stringify({ title: 'x' }) });
    const service = build(execute);

    await service.suggestTaskFromContext(T, { description: 'follow up' });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: T }),
    );
  });
});
