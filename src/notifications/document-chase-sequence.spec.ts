import * as fs from 'fs';
import * as path from 'path';
import {
  SequenceRunnerService,
  type SequenceDefinition,
} from './sequence-runner.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { SequenceEnrolment } from './entities/sequence-enrolment.entity';
import { DocumentRequestService } from '../documents/document-request.service';
import { EntityType } from '../crm/entities/universal-entity.entity';
import { TenantStatus } from '../iam/entities/tenant.entity';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import type { Actor } from '../common/access';

/**
 * The missing-document chase, end to end, against the pack as shipped.
 *
 * `chase_outstanding_documents` has been authored, schema-validated and stored
 * since the immigration pack was written, and it had never once executed:
 * `documentsRequestedAt` and `documentsReceivedAt` — its whole trigger — were
 * written nowhere in `src`. This spec is the guard on that, so the two halves
 * cannot drift apart again: it reads the real
 * `packages/config-packs/verticals/immigration.json` rather than a fixture, so
 * renaming a field in the pack fails here rather than in a firm's inbox.
 */
describe('missing-document chase (immigration pack)', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const CASE = '22222222-2222-2222-2222-222222222222';

  const pack = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        '../../packages/config-packs/verticals/immigration.json',
      ),
      'utf-8',
    ),
  ) as {
    messaging: {
      templates: Array<{
        key: string;
        subject: string;
        body: string;
        variables?: string[];
      }>;
      sequences: SequenceDefinition[];
    };
  };

  const chase = pack.messaging.sequences.find(
    (s) => s.key === 'chase_outstanding_documents',
  );
  const reminder = pack.messaging.templates.find(
    (t) => t.key === 'document_chase_reminder',
  );

  const staff: Actor = {
    id: 'user-1',
    roles: [PlatformRole.STAFF],
    email: 'coordinator@harbourline.test',
  };

  /** The one record both halves of the flow share. */
  function build() {
    const record = {
      id: CASE,
      tenantId: TENANT,
      type: EntityType.CASE,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      dueDate: null,
      deletedAt: null,
      status: 'open',
      verticalAttributes: {} as Record<string, unknown>,
    };

    // Outstanding required documents, as the pack checklist would report them.
    let outstandingRequired = 1;

    const entityRepo = {
      findOne: jest.fn(() => Promise.resolve(record)),
      find: jest.fn(() => Promise.resolve([record])),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };

    const requests = new DocumentRequestService(
      entityRepo as never,
      {
        findOne: jest.fn(() =>
          Promise.resolve({ id: TENANT, name: 'Harbourline Migration' }),
        ),
      } as never,
      { assertOwnsEntity: jest.fn(() => Promise.resolve()) } as never,
      {
        forEntity: jest.fn(() =>
          Promise.resolve({
            items: [
              {
                key: 'passport',
                label: 'Passport',
                required: true,
                uploaded: outstandingRequired === 0,
              },
            ],
            outstandingRequired,
          }),
        ),
      } as never,
      {
        renderTemplate: jest.fn(() =>
          Promise.resolve({ subject: 's', content: 'c', unrendered: [] }),
        ),
        sendFromTemplate: jest.fn(() => Promise.resolve({ id: 'n0' })),
      } as never,
    );

    const enrolments: SequenceEnrolment[] = [];
    const sent: Array<{
      templateKey: unknown;
      variables: Record<string, unknown>;
    }> = [];

    const runner = new SequenceRunnerService(
      {
        find: jest.fn(() => Promise.resolve([...enrolments])),
        create: jest.fn(
          (x: Partial<SequenceEnrolment>) => ({ ...x }) as SequenceEnrolment,
        ),
        save: jest.fn((row: SequenceEnrolment) => {
          const at = enrolments.findIndex((e) => e.entityId === row.entityId);
          if (at >= 0) enrolments[at] = row;
          else enrolments.push(row);
          return Promise.resolve(row);
        }),
      } as never,
      entityRepo as never,
      {
        find: jest.fn(() =>
          Promise.resolve([
            {
              id: TENANT,
              name: 'Harbourline Migration',
              vertical: 'immigration',
              status: TenantStatus.ACTIVE,
            },
          ]),
        ),
      } as never,
      new RuleEvaluatorService(),
      {
        section: jest.fn(() => Promise.resolve({ sequences: [chase] })),
      } as never,
      {
        sendFromTemplate: jest.fn((...args: unknown[]) => {
          sent.push({
            templateKey: args[1],
            variables: args[3] as Record<string, unknown>,
          });
          return Promise.resolve({ id: 'n1' });
        }),
      } as never,
    );

    return {
      record,
      requests,
      runner,
      enrolments,
      sent,
      receiveEverything: () => {
        outstandingRequired = 0;
      },
    };
  }

  const t0 = new Date('2026-09-01T09:00:00Z');
  const hours = (n: number) => new Date(t0.getTime() + n * 3_600_000);

  it('the pack still ships the sequence and template this wiring feeds', () => {
    // If either is renamed, everything below becomes vacuous — so fail here
    // rather than quietly testing nothing.
    expect(chase).toBeDefined();
    expect(reminder).toBeDefined();
    expect(chase!.trigger.entityType).toBe('case');
    expect(JSON.stringify(chase!.trigger.when)).toContain(
      'documentsRequestedAt',
    );
    expect(JSON.stringify(chase!.trigger.when)).toContain(
      'documentsReceivedAt',
    );
  });

  it('does not chase a client for documents nobody asked them for', async () => {
    const { runner, sent, enrolments } = build();

    const summary = await runner.run(hours(1));

    // §7.3, applied to outbound messaging: "not asked" is not "missing". This
    // is the assertion that makes the whole feature safe to switch on.
    expect(summary.enrolled).toBe(0);
    expect(enrolments).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('fires the first reminder 72 hours after documents were requested', async () => {
    const { requests, runner, record, sent, enrolments } = build();

    await requests.recordRequest({
      tenantId: TENANT,
      vertical: 'immigration',
      actor: staff,
      entityId: CASE,
      now: t0,
    });
    expect(record.verticalAttributes.documentsRequestedAt).toBe(
      t0.toISOString(),
    );

    // Enrols on the next sweep, but nothing is due yet: step one is +72h.
    const first = await runner.run(hours(1));
    expect(first.enrolled).toBe(1);
    expect(first.sent).toBe(0);
    expect(enrolments[0].stoppedAt).toBeNull();

    const second = await runner.run(hours(73));
    expect(second.sent).toBe(1);
    expect(sent[0].templateKey).toBe('document_chase_reminder');
    // The template greets on behalf of the firm, not the platform.
    expect(sent[0].variables.firmName).toBe('Harbourline Migration');
    expect(sent[0].variables.firstName).toBe('Ada');
    expect(second.unrenderedVariables).toEqual([]);
  });

  it('stops the moment the documents are in', async () => {
    const { requests, runner, record, sent, enrolments, receiveEverything } =
      build();

    await requests.recordRequest({
      tenantId: TENANT,
      vertical: 'immigration',
      actor: staff,
      entityId: CASE,
      now: t0,
    });
    await runner.run(hours(1));
    await runner.run(hours(73));
    expect(sent).toHaveLength(1);

    // The upload path: the last required document arrives and the checklist
    // comes back clear, so `documentsReceivedAt` is stamped.
    receiveEverything();
    const intake = await requests.recordIntake({
      tenantId: TENANT,
      vertical: 'immigration',
      actor: staff,
      entityId: CASE,
      now: hours(100),
    });
    expect(intake.outcome).toBe('received');
    expect(record.verticalAttributes.documentsReceivedAt).toBe(
      hours(100).toISOString(),
    );

    // Step two would have been due at +168h from enrolment.
    const summary = await runner.run(hours(200));

    expect(summary.sent).toBe(0);
    expect(sent).toHaveLength(1);
    expect(enrolments[0].stoppedAt).toEqual(hours(200));
    expect(enrolments[0].stopReason).toBe('trigger_cleared');
  });

  it('sends at most the three reminders the pack authorises', async () => {
    const { requests, runner, sent } = build();

    await requests.recordRequest({
      tenantId: TENANT,
      vertical: 'immigration',
      actor: staff,
      entityId: CASE,
      now: t0,
    });
    await runner.run(hours(1));
    // Long after every step is due: the cap, not the clock, is what bounds it.
    await runner.run(hours(1000));

    expect(sent).toHaveLength(3);
    expect(chase!.maxMessages).toBe(3);
  });

  describe('what the client actually receives', () => {
    it('supplies every variable the reminder declares', () => {
      // A template variable the runner cannot supply reaches the client as a
      // literal `{{placeholder}}`.
      const available = SequenceRunnerService.variablesFor(
        { name: 'Harbourline Migration' },
        {
          id: CASE,
          type: EntityType.CASE,
          firstName: 'Ada',
          lastName: 'Lovelace',
          verticalAttributes: {},
          dueDate: null,
        } as never,
      );

      for (const variable of reminder!.variables ?? []) {
        expect(Object.keys(available)).toContain(variable);
      }
      const placeholders = [
        ...`${reminder!.subject} ${reminder!.body}`.matchAll(/{{(\w+)}}/g),
      ].map((m) => m[1]);
      for (const placeholder of placeholders) {
        expect(Object.keys(available)).toContain(placeholder);
      }
    });

    it('stays administrative: no advice, and no threat to the client’s own file', () => {
      const copy = `${reminder!.subject} ${reminder!.body}`.toLowerCase();

      // An automated message must not constitute immigration advice — that
      // needs a credentialed practitioner's recorded sign-off, which nothing
      // in a sweep can produce.
      for (const phrase of [
        'we advise',
        'our advice',
        'you should',
        'we recommend',
        'you must',
        'will be refused',
        'your visa will',
      ]) {
        expect(copy).not.toContain(phrase);
      }

      // And it must never threaten a client's access to their own documents
      // or their own file.
      for (const phrase of [
        'lose access',
        'revoke',
        'suspend',
        'delete your',
        'close your file',
        'terminate',
      ]) {
        expect(copy).not.toContain(phrase);
      }

      // What it *does* say: here is how to see what is outstanding, and how
      // to make it stop.
      expect(copy).toContain('client portal');
      expect(copy).toContain('reply');
    });
  });
});
