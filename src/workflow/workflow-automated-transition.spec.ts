import { WorkflowEngineService } from './workflow.service';
import { InstanceStatus } from './entities/workflow-instance.entity';
import { SYSTEM_ACTOR } from '../common/access';
import { PlatformRole } from '../iam/enums/platform-role.enum';

/**
 * ADR 0018 §4 (misattributed-approver defect) + Anton's secops review point 2
 * (audit coverage for an automated transition).
 *
 * `sla-watchdog.service.ts`'s `auto_approve` branch used to attribute an
 * automated state change to `instance.startedBy` — the human who began the
 * matter, not the watchdog that actually approved it — and passed no
 * `userRoles`, which silently 400'd any transition whose pack declared
 * `permissions.roles`. This suite pins the fix directly against
 * `WorkflowEngineService.transition`, deliberately not through a full Nest DI
 * harness: `transition()` touches `instanceRepo`, `transitionRepo`,
 * `feeScheduleService`, `dataSource` and `auditService`; the other eight
 * constructor dependencies are unused stubs, the same approach
 * `workflow-list-scoping.spec.ts` takes.
 */
describe('WorkflowEngineService.transition — automated attribution & audit (ADR 0018 §4)', () => {
  const TENANT = 't1';

  function buildService(overrides: { auditLogEvent?: jest.Mock } = {}) {
    const instance: any = {
      id: 'inst-1',
      tenantId: TENANT,
      entityId: null,
      vertical: null,
      status: InstanceStatus.ACTIVE,
      currentStateId: 'state-a',
      currentState: { id: 'state-a', name: 'state-a', type: 'normal' },
      workflow: { slaConfig: { enabled: false } },
      context: {},
      history: [],
      startedBy: 'human-0',
    };

    const transition = {
      id: 'trans-1',
      fromStateId: 'state-a',
      toStateId: 'state-b',
      isActive: true,
      permissions: { roles: [PlatformRole.FIRM_ADMIN] },
      actions: [],
      toState: { id: 'state-b', name: 'state-b', type: 'normal' },
    };

    const instanceRepo = {
      findOne: async () => instance,
    };
    const transitionRepo = {
      findOne: async () => transition,
    };
    const feeScheduleService = {
      arrearsBlocking: async () => [],
    };
    const queryRunner = {
      connect: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      release: async () => undefined,
      manager: { update: async () => undefined },
    };
    const dataSource = { createQueryRunner: () => queryRunner };
    const auditService = {
      logEvent: overrides.auditLogEvent ?? jest.fn().mockResolvedValue({}),
    };

    const unused = {} as any;
    const service = new WorkflowEngineService(
      unused, // workflowRepo
      unused, // stateRepo
      transitionRepo as any,
      instanceRepo as any,
      unused, // entityRepo
      dataSource as any,
      unused, // searchService
      unused, // aiService
      unused, // documentHubService
      unused, // notificationsService
      unused, // taskService
      feeScheduleService as any,
      unused, // rules
      auditService as any,
      unused, // usersRepo
    );

    return { service, instance, auditService };
  }

  it('an automated transition writes triggeredBy "system", automated: true, automatedBy as given, and a CRITICAL audit entry', async () => {
    const { service, instance, auditService } = buildService();

    await service.transition({
      instanceId: instance.id,
      tenantId: TENANT,
      transitionId: 'trans-1',
      userId: SYSTEM_ACTOR.id,
      userRoles: SYSTEM_ACTOR.roles,
      automated: {
        by: 'sla-watchdog:auto_approve',
        reason: 'SLA breach auto-approval',
      },
      context: {},
    });

    expect(instance.history).toHaveLength(1);
    expect(instance.history[0]).toMatchObject({
      triggeredBy: 'system',
      automated: true,
      automatedBy: 'sla-watchdog:auto_approve',
    });

    expect(auditService.logEvent).toHaveBeenCalledTimes(1);
    const call = auditService.logEvent.mock.calls[0][0];
    expect(call.tenantId).toBe(TENANT);
    expect(call.entityId).toBe(instance.id);
    expect(call.severity).toBe('critical');
  });

  it('an ordinary transition (automated unset) is byte-for-byte unchanged on history: triggeredBy is the human userId, no automated/automatedBy keys at all', async () => {
    const { service, instance } = buildService();

    await service.transition({
      instanceId: instance.id,
      tenantId: TENANT,
      transitionId: 'trans-1',
      userId: 'human-1',
      userRoles: [PlatformRole.FIRM_ADMIN],
      context: {},
    });

    expect(instance.history).toHaveLength(1);
    const entry = instance.history[0];
    expect(entry.triggeredBy).toBe('human-1');
    // Genuinely absent, not `false`/`undefined` — a pre-ADR-0018 history
    // entry and an ordinary human transition after it must be indistinguishable.
    expect('automated' in entry).toBe(false);
    expect('automatedBy' in entry).toBe(false);
  });

  /**
   * Audit coverage for a human-triggered transition — this was a real gap:
   * `AuditService.logWorkflowTransition` existed with zero callers, so
   * `POST /workflows/instances/:id/transition` wrote nothing to `audit_logs`
   * for the overwhelmingly common case (a human advancing a matter), and only
   * the rare automated path was covered.
   */
  it('an ordinary (human) transition writes exactly one audit row, with from/to state and the acting user, distinct in shape from the automated CRITICAL entry', async () => {
    const { service, instance, auditService } = buildService();

    await service.transition({
      instanceId: instance.id,
      tenantId: TENANT,
      transitionId: 'trans-1',
      userId: 'human-1',
      userEmail: 'human-1@example.test',
      userRoles: [PlatformRole.FIRM_ADMIN],
      context: {},
    });

    expect(auditService.logEvent).toHaveBeenCalledTimes(1);
    const call = auditService.logEvent.mock.calls[0][0];
    expect(call.tenantId).toBe(TENANT);
    expect(call.userId).toBe('human-1');
    expect(call.userEmail).toBe('human-1@example.test');
    expect(call.entityId).toBe(instance.id);
    expect(call.entityType).toBe('workflow_instance');
    expect(call.beforeState).toEqual({ state: 'state-a' });
    expect(call.afterState).toEqual({ state: 'state-b' });
    expect(call.context.transitionId).toBe('trans-1');
    // Not the automated shape — no CRITICAL severity, no `automated` key.
    expect(call.severity).toBeUndefined();
    expect(call.context.automated).toBeUndefined();
  });

  it('a human transition still succeeds and returns the updated instance even when the post-commit audit write fails — fail-OPEN, logged, never propagated (the transition already happened; failing closed here would report a real state change as a failure)', async () => {
    const failingAudit = jest.fn().mockRejectedValue(new Error('audit db down'));
    const { service, instance } = buildService({ auditLogEvent: failingAudit });

    const result = await service.transition({
      instanceId: instance.id,
      tenantId: TENANT,
      transitionId: 'trans-1',
      userId: 'human-1',
      userRoles: [PlatformRole.FIRM_ADMIN],
      context: {},
    });

    // The transition itself completed — commitTransaction ran, the history
    // entry landed — and the method returned the (re-fetched) instance
    // rather than throwing, despite the audit write below rejecting.
    expect(result).toBeDefined();
    expect(instance.history).toHaveLength(1);
    expect(instance.history[0].triggeredBy).toBe('human-1');
    expect(failingAudit).toHaveBeenCalledTimes(1);
  });

  it('a transition whose permissions.roles includes firm_admin succeeds when called with SYSTEM_ACTOR.roles', async () => {
    const { service, instance } = buildService();

    await expect(
      service.transition({
        instanceId: instance.id,
        tenantId: TENANT,
        transitionId: 'trans-1',
        userId: SYSTEM_ACTOR.id,
        userRoles: SYSTEM_ACTOR.roles,
        automated: { by: 'test:job' },
        context: {},
      }),
    ).resolves.toBeDefined();
  });

  it('if the audit write fails, the transition does not happen — fail-closed, same discipline as TenancyService.runAsGod', async () => {
    const failingAudit = jest.fn().mockRejectedValue(new Error('audit db down'));
    const { service, instance } = buildService({ auditLogEvent: failingAudit });
    const historyBefore = instance.history.length;

    await expect(
      service.transition({
        instanceId: instance.id,
        tenantId: TENANT,
        transitionId: 'trans-1',
        userId: SYSTEM_ACTOR.id,
        userRoles: SYSTEM_ACTOR.roles,
        automated: { by: 'sla-watchdog:auto_approve' },
        context: {},
      }),
    ).rejects.toThrow('audit db down');

    // Nothing below the audit write ran: no history entry, no state change.
    expect(instance.history.length).toBe(historyBefore);
    expect(instance.status).toBe(InstanceStatus.ACTIVE);
    expect(instance.currentStateId).toBe('state-a');
  });
});
