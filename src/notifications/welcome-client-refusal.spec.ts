import * as fs from 'fs';
import * as path from 'path';
import {
  SequenceRunnerService,
  type SequenceDefinition,
} from './sequence-runner.service';
import { RuleEvaluatorService } from '../rules/rule-evaluator.service';
import { SequenceEnrolment } from './entities/sequence-enrolment.entity';
import { EntityType } from '../crm/entities/universal-entity.entity';
import { TenantStatus } from '../iam/entities/tenant.entity';

/**
 * `send()` now refuses to dispatch a template whose rendered subject/body
 * still declares an unresolved variable — it used to send first and only
 * report the leftover `{{placeholder}}` afterwards, by which point the
 * client already had it. This is `welcome_client`'s own case, end to end,
 * against the real packs rather than a synthetic template, so a change to
 * either the pack or the variable-supply code is caught here.
 *
 * `renderReal` below is a deliberate, hand-mirrored copy of
 * `NotificationsService.renderTemplate`'s substitution algorithm — the same
 * choice `document-request-template.spec.ts` made for its own `SUPPLIED` set
 * and for the same reason: importing the real implementation would make this
 * test agree with the code by construction. Both sides moving in step is
 * what this file exists to catch.
 */
function renderReal(
  subject: string,
  body: string,
  variables: Record<string, unknown>,
): { subject: string; content: string; unrendered: string[] } {
  let content = body;
  let subj = subject;
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    content = content.replace(regex, String(value));
    subj = subj.replace(regex, String(value));
  });
  const unrendered = new Set<string>();
  for (const part of [subj, content]) {
    for (const match of part.matchAll(/{{(\w+)}}/g)) unrendered.add(match[1]);
  }
  return { subject: subj, content, unrendered: [...unrendered] };
}

const PACKS = path.resolve(__dirname, '../../packages/config-packs');

function readPack(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(PACKS, rel), 'utf8'));
}

function welcomeClientTemplate(pack: any) {
  const t = (pack.messaging?.templates ?? []).find(
    (x: any) => x.key === 'welcome_client',
  );
  if (!t) throw new Error('welcome_client not found in pack fixture');
  return t as { subject: string; body: string; variables: string[] };
}

describe('welcome_client is refused, not sent, while it declares an unresolved variable', () => {
  const TENANT = '33333333-3333-3333-3333-333333333333';

  function buildFor(vertical: 'immigration' | 'grc', packFile: string) {
    const pack = readPack(packFile);
    const template = welcomeClientTemplate(pack);

    const sequence: SequenceDefinition = {
      key: 'welcome_client_probe',
      label: 'Welcome (test-only wiring)',
      trigger: { entityType: 'person', when: { '==': [1, 1] } },
      steps: [{ templateKey: 'welcome_client', afterHours: 0 }],
    };

    const entity = {
      id: '44444444-4444-4444-4444-444444444444',
      tenantId: TENANT,
      type: EntityType.PERSON,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      dueDate: null,
      deletedAt: null,
      status: 'open',
      verticalAttributes: {} as Record<string, unknown>,
    };

    const enrolments: SequenceEnrolment[] = [];
    const sendFromTemplate = jest.fn(() => Promise.resolve({ id: 'n1' }));

    const service = new SequenceRunnerService(
      {
        find: jest.fn(() => Promise.resolve([...enrolments])),
        create: jest.fn(
          (x: Partial<SequenceEnrolment>) => ({ ...x }) as SequenceEnrolment,
        ),
        save: jest.fn((row: SequenceEnrolment) => {
          enrolments.push(row);
          return Promise.resolve(row);
        }),
      } as never,
      { find: jest.fn(() => Promise.resolve([entity])) } as never,
      {
        find: jest.fn(() =>
          Promise.resolve([{ id: TENANT, vertical, status: TenantStatus.ACTIVE }]),
        ),
      } as never,
      new RuleEvaluatorService(),
      {
        section: jest.fn(() => Promise.resolve({ sequences: [sequence] })),
        // The real pack's uiConfig — this is the one place immigration and
        // grc genuinely differ: immigration.json now carries
        // `clientPortalUrl` (this session's portalUrl fix); grc.json does not.
        forVertical: jest.fn(() => Promise.resolve({ uiConfig: pack.uiConfig ?? {} })),
      } as never,
      {
        renderTemplate: jest.fn((_tenantId, _key, variables) =>
          Promise.resolve(renderReal(template.subject, template.body, variables)),
        ),
        sendFromTemplate,
      } as never,
    );

    return { service, sendFromTemplate, template };
  }

  it('GRC welcome_client is refused: no clientPortalUrl, and no entityLabel/contact sources either', async () => {
    const { service, sendFromTemplate } = buildFor('grc', 'verticals/grc.json');

    const summary = await service.run(new Date('2026-09-17T09:00:00Z'));

    expect(sendFromTemplate).not.toHaveBeenCalled();
    expect(summary.refused).toHaveLength(1);
    expect(summary.refused[0].templateKey).toBe('welcome_client');
    // portalUrl is unresolved here specifically because grc.json has not
    // been given a clientPortalUrl — deliberately out of scope this session
    // (operator instruction: GovX is a separate project).
    expect(summary.refused[0].variables).toEqual(
      expect.arrayContaining(['portalUrl']),
    );
  });

  it('ImmiStack welcome_client is ALSO refused — portalUrl now resolves, but entityLabel/contactName/contactEmail still have no source', async () => {
    const { service, sendFromTemplate } = buildFor(
      'immigration',
      'verticals/immigration.json',
    );

    const summary = await service.run(new Date('2026-09-17T09:00:00Z'));

    expect(sendFromTemplate).not.toHaveBeenCalled();
    expect(summary.refused).toHaveLength(1);
    // The one variable this session's portalUrl fix closed must NOT be in
    // the refused list any more.
    expect(summary.refused[0].variables).not.toContain('portalUrl');
    // These three are a real, pre-existing gap (see
    // welcome-client-template.spec.ts) — not invented here, and not silently
    // worked around: no source exists in `variablesFor` or in core for a
    // record's assignee/contact, so refusing is correct until one does.
    expect(summary.refused[0].variables.sort()).toEqual(
      ['contactEmail', 'contactName', 'entityLabel'].sort(),
    );
  });
});
