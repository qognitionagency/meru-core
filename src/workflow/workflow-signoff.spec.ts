import { BadRequestException } from '@nestjs/common';
import { WorkflowEngineService } from './workflow.service';
import { InstanceStatus } from './entities/workflow-instance.entity';
import { PlatformRole } from '../iam/enums/platform-role.enum';

/**
 * ADR 0027 — workflow sign-off enforcement, gated on the practitioner-
 * credential column (a live DB read, not a JWT claim — see the ADR's D3 for
 * why). Same construction style as `workflow-automated-transition.spec.ts`:
 * built directly against `WorkflowEngineService.transition`, not a full Nest
 * DI harness.
 *
 * **Synthetic fixture, deliberately not sourced from `au-immigration.json`.**
 * No pack on disk ships `requiresSignOff: true` yet — per ADR 0027 §9
 * consequence 4, a tenant with no credentialed user would lock every matter
 * at whichever step is flagged, and onboarding does not yet persist a
 * practitioner credential (E3). The flag itself is deferred to its own
 * commit once E3 lands; only the gate mechanism this spec covers ships now.
 * State names (`lodgement_fee → lodged`, "Charge forwarded to the
 * Department") are kept as a mnemonic for the placement guidance recorded in
 * `pack-workflow.service.ts` — a pack author flags the step whose
 * COMPLETION is the regulated act, not the step that records the outcome —
 * not as a claim that this is what any pack currently declares.
 */
describe('WorkflowEngineService.transition — sign-off gate (ADR 0027)', () => {
  const TENANT = 't1';

  function buildService(opts: {
    requiresSignOff: boolean;
    actorRow: { id: string; practitionerCredential: string | null; practitionerCredentialType: string | null } | null;
  }) {
    const instance: any = {
      id: 'inst-1',
      tenantId: TENANT,
      entityId: null,
      vertical: null,
      status: InstanceStatus.ACTIVE,
      currentStateId: 'state-lodgement-fee',
      currentState: { id: 'state-lodgement-fee', name: 'lodgement_fee', type: 'normal' },
      workflow: { slaConfig: { enabled: false } },
      context: {},
      history: [],
      startedBy: 'human-0',
    };

    const transition = {
      id: 'trans-1',
      fromStateId: 'state-lodgement-fee',
      toStateId: 'state-lodged',
      isActive: true,
      permissions: {
        roles: [PlatformRole.STAFF],
        requiresSignOff: opts.requiresSignOff,
      },
      actions: [],
      toState: { id: 'state-lodged', name: 'lodged', type: 'normal' },
    };

    const instanceRepo = { findOne: async () => instance };
    const transitionRepo = { findOne: async () => transition };
    const feeScheduleService = { arrearsBlocking: async () => [] };
    const queryRunner = {
      connect: async () => undefined,
      startTransaction: async () => undefined,
      commitTransaction: async () => undefined,
      rollbackTransaction: async () => undefined,
      release: async () => undefined,
      manager: { update: async () => undefined },
    };
    const dataSource = { createQueryRunner: () => queryRunner };
    const auditService = { logEvent: jest.fn().mockResolvedValue({}) };
    const usersRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.tenantId !== TENANT) return null;
        return opts.actorRow;
      }),
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
      usersRepo as any,
    );

    return { service, instance, usersRepo };
  }

  it('refuses an actor with no recorded practitionerCredential', async () => {
    const { service, instance } = buildService({
      requiresSignOff: true,
      actorRow: { id: 'staff-1', practitionerCredential: null, practitionerCredentialType: null },
    });

    await expect(
      service.transition({
        instanceId: instance.id,
        tenantId: TENANT,
        transitionId: 'trans-1',
        userId: 'staff-1',
        userRoles: [PlatformRole.STAFF],
        context: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(instance.history).toHaveLength(0);
  });

  it('succeeds for a credentialed actor, and records signedOffBy + a credential snapshot on the history entry, and nowhere else', async () => {
    const { service, instance } = buildService({
      requiresSignOff: true,
      actorRow: {
        id: 'staff-1',
        practitionerCredential: 'MARN1234567',
        practitionerCredentialType: 'marn',
      },
    });

    await service.transition({
      instanceId: instance.id,
      tenantId: TENANT,
      transitionId: 'trans-1',
      userId: 'staff-1',
      userRoles: [PlatformRole.STAFF],
      context: {},
    });

    expect(instance.history).toHaveLength(1);
    expect(instance.history[0]).toMatchObject({
      triggeredBy: 'staff-1',
      signedOffBy: 'staff-1',
      signedOffCredential: { type: 'marn', number: 'MARN1234567' },
    });
    // Nowhere else on the instance carries the credential.
    expect(instance.context).not.toHaveProperty('signedOffCredential');
  });

  it('a transition without requiresSignOff is completely unaffected — no gate query, no signedOffBy on the history entry', async () => {
    const { service, instance, usersRepo } = buildService({
      requiresSignOff: false,
      actorRow: null,
    });

    await service.transition({
      instanceId: instance.id,
      tenantId: TENANT,
      transitionId: 'trans-1',
      userId: 'staff-1',
      userRoles: [PlatformRole.STAFF],
      context: {},
    });

    expect(usersRepo.findOne).not.toHaveBeenCalled();
    expect(instance.history).toHaveLength(1);
    expect('signedOffBy' in instance.history[0]).toBe(false);
    expect('signedOffCredential' in instance.history[0]).toBe(false);
  });

  it('the credential snapshot reflects the value AT SIGN-OFF TIME, not a later edit to the user row', async () => {
    const actorRow = {
      id: 'staff-1',
      practitionerCredential: 'MARN1234567',
      practitionerCredentialType: 'marn',
    };
    const { service, instance } = buildService({ requiresSignOff: true, actorRow });

    await service.transition({
      instanceId: instance.id,
      tenantId: TENANT,
      transitionId: 'trans-1',
      userId: 'staff-1',
      userRoles: [PlatformRole.STAFF],
      context: {},
    });

    // Mutate the "live" row after sign-off, as PATCH /iam/users/:id would.
    actorRow.practitionerCredential = 'MARN9999999';

    expect(instance.history[0].signedOffCredential).toEqual({
      type: 'marn',
      number: 'MARN1234567',
    });
  });
});
