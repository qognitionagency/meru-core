import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import {
  WorkflowInstance,
  InstanceStatus,
} from '../entities/workflow-instance.entity';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  NotificationType,
  NotificationPriority,
  NotificationCategory,
} from '../../notifications/entities/notification.entity';
import { WorkflowEngineService } from '../workflow.service';
import { SYSTEM_ACTOR } from '../../common/access';
import { runTenantBoundSweep } from '../../core/tenancy/tenant-bound-sweep';
import { JobScopeEvidence } from '../../jobs/job-catalogue';

@Injectable()
export class SlaWatchdogService {
  private readonly logger = new Logger(SlaWatchdogService.name);

  constructor(
    @InjectRepository(WorkflowInstance)
    private instanceRepo: Repository<WorkflowInstance>,
    private workflowService: WorkflowEngineService,
    private notificationsService: NotificationsService,
  ) {}

  /**
   * Notify the configured recipients of an SLA breach.
   *
   * `escalation.notify` holds user ids (or the literal 'assignee', resolved
   * from the instance). Delivery itself is the dispatcher's job — this only
   * records the intent, so a failing transport cannot stop the watchdog from
   * processing the rest of the breaches.
   */
  private async notifyRecipients(
    instance: WorkflowInstance,
    notify: string[],
    kind: 'notify' | 'escalate',
  ): Promise<void> {
    const recipients = new Set(
      (notify ?? [])
        // WorkflowInstance has no assignee column — `startedBy` is the only
        // person the instance actually names. Resolving 'assignee' to
        // anything else would be inventing a relationship.
        .map((n) => (n === 'assignee' ? instance.startedBy : n))
        .filter((n): n is string => !!n),
    );

    if (recipients.size === 0) {
      this.logger.warn(
        `SLA breach on instance ${instance.id} has no resolvable recipient`,
      );
      return;
    }

    const subject =
      kind === 'escalate'
        ? `Escalated: SLA breach on workflow ${instance.workflowId}`
        : `SLA breach on workflow ${instance.workflowId}`;

    for (const recipientId of recipients) {
      try {
        await this.notificationsService.sendNotification({
          tenantId: instance.tenantId,
          type: NotificationType.EMAIL,
          recipientId,
          subject,
          content:
            `Workflow instance ${instance.id} breached its SLA at ` +
            `escalation level ${instance.escalationLevel ?? 1}. ` +
            `Current state: ${instance.currentStateId ?? 'unknown'}.`,
          priority:
            kind === 'escalate'
              ? NotificationPriority.URGENT
              : NotificationPriority.HIGH,
          category: NotificationCategory.WORKFLOW,
          metadata: {
            workflowInstanceId: instance.id,
            workflowId: instance.workflowId,
            escalationLevel: instance.escalationLevel,
          },
        });
      } catch (err) {
        this.logger.error(
          `Failed to queue SLA notification for ${recipientId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkSLAViolations(): Promise<{
    violationsFound: number;
    escalated: number;
    scope: JobScopeEvidence;
  }> {
    this.logger.log('Running SLA violation check...');

    // ADR 0018 — this used to run outside any tenant context: a scheduled
    // job has `TenantContext.get()` undefined, so the RLS-bound connection
    // matched zero rows on every tenant's `workflow_instances`, and this
    // logged "Found 0 SLA violations" forever with no error to read — the
    // watchdog never actually escalated a breach. `runTenantBoundSweep`
    // enumerates cross-tenant under system context (the one place this
    // legitimately has to see every tenant), then binds each instance to its
    // own tenant for the full duration of `processEscalation`, reads and
    // writes both — including the write one level down inside
    // `WorkflowEngineService.transition` (§1.5 of the ADR: binding only the
    // enumeration and not the whole per-item unit of work reproduces the
    // identical bug via a silently-no-op `UPDATE`).
    const sweep = await runTenantBoundSweep<WorkflowInstance>(
      'sla watchdog',
      () =>
        this.instanceRepo.find({
          where: {
            status: InstanceStatus.ACTIVE,
            slaDeadline: LessThan(new Date()),
          },
          relations: ['workflow', 'currentState'],
        }),
      (instance) => this.processEscalation(instance),
    );

    this.logger.log(
      `Found ${sweep.itemsFound} SLA violations, escalated ${sweep.itemsProcessed} ` +
        `(${sweep.failures.length} failed)`,
    );

    return {
      violationsFound: sweep.itemsFound,
      escalated: sweep.itemsProcessed,
      scope: {
        eligible: sweep.eligible,
        scanned: sweep.scanned,
        failures: sweep.failures,
      },
    };
  }

  private async processEscalation(instance: WorkflowInstance): Promise<void> {
    const escalationLevel = instance.escalationLevel + 1;
    const escalationConfig =
      instance.workflow.slaConfig?.escalationLevels?.find(
        (e) => e.level === escalationLevel,
      );

    if (!escalationConfig) {
      this.logger.warn(
        `No escalation config found for level ${escalationLevel} on workflow ${instance.workflowId}`,
      );
      return;
    }

    this.logger.warn(
      `Processing SLA violation for instance ${instance.id}: Level ${escalationLevel}`,
    );

    // Update instance with violation
    instance.slaViolations.push({
      level: escalationLevel,
      timestamp: new Date(),
      action: escalationConfig.action,
    });

    await this.instanceRepo.update(instance.id, {
      escalationLevel,
      slaViolations: instance.slaViolations,
    });

    // Execute escalation actions
    await this.executeEscalationActions(instance, escalationConfig);
  }

  private async executeEscalationActions(
    instance: WorkflowInstance,
    escalation: { action: string; notify: string[] },
  ): Promise<void> {
    switch (escalation.action) {
      case 'notify':
        // Was a log line and a TODO: an SLA breach was detected and then
        // told to nobody, which makes the whole watchdog decorative. COM
        // only started delivering recently, so this could not be wired
        // before.
        await this.notifyRecipients(instance, escalation.notify, 'notify');
        break;
      case 'escalate':
        // Escalation notifies the same recipient list at high priority.
        // Reassignment to a manager needs an org hierarchy the IAM module
        // does not model yet, so it is deliberately not faked here.
        await this.notifyRecipients(instance, escalation.notify, 'escalate');
        break;
      case 'auto_approve': {
        // Take the first transition out of the current state, as the
        // configured actor. Deliberately only the first: an auto-approval that
        // guessed between two branches would be inventing a decision nobody
        // made, and an unmoved instance is recoverable where a wrongly
        // approved one is not.
        // The watchdog is a scheduled job with no user behind it — SYSTEM_ACTOR
        // is the documented use (`common/access.ts`), confined by the
        // instance's own `tenantId` below.
        const moved = await this.workflowService
          .getAvailableTransitions(instance.id, instance.tenantId, SYSTEM_ACTOR)
          .then((available) => available[0])
          .catch(() => undefined);

        if (!moved) {
          this.logger.warn(
            `Cannot auto-approve instance ${instance.id}: no available transition`,
          );
          break;
        }

        // ADR 0018 §4.1/§4.2 — this used to attribute the transition to
        // `instance.startedBy`, the human who began the matter, not the
        // watchdog that actually approved it: a compliance review of "who
        // approved this matter's progression" read a human's name off a
        // decision that human never made. `automated` records the truth in
        // `history[].automated`/`automatedBy`, and passing `userRoles` fixes
        // an adjacent silent gap — without it `checkPermissions` evaluated
        // against an empty array and any pack transition declaring
        // `permissions.roles` always 400'd here, invisible until
        // `runTenantBoundSweep` stopped turning one instance's exception into
        // an abort of the whole sweep.
        await this.workflowService.transition({
          instanceId: instance.id,
          tenantId: instance.tenantId,
          transitionId: moved.id,
          userId: SYSTEM_ACTOR.id,
          userRoles: SYSTEM_ACTOR.roles,
          automated: {
            by: 'sla-watchdog:auto_approve',
            reason: 'SLA breach auto-approval',
          },
          context: { autoApprovedBySlaBreach: true },
        });
        this.logger.log(
          `Auto-approved instance ${instance.id} via transition ${moved.id} after SLA breach`,
        );
        break;
      }
      case 'cancel':
        this.logger.log(`Cancelling workflow due to SLA breach`);
        await this.instanceRepo.update(instance.id, {
          status: InstanceStatus.CANCELLED,
        });
        break;
      default:
        this.logger.log(`Unknown escalation action: ${escalation.action}`);
    }
  }
}
