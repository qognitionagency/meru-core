import {
  DocumentRequestService,
  DOCUMENTS_RECEIVED_AT,
  DOCUMENTS_REQUESTED_AT,
} from './document-request.service';
import { EntityType } from '../crm/entities/universal-entity.entity';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import type { Actor } from '../common/access';

/**
 * The two fields the immigration pack's document chase is authored against.
 *
 * What is worth testing is the asymmetry: a chase must never start for
 * documents nobody asked for, and must never stop on an assumption that they
 * arrived. Both directions are wrong, but they are not equally wrong — one
 * annoys a client, the other loses them a visa.
 */
describe('DocumentRequestService', () => {
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const CASE = '22222222-2222-2222-2222-222222222222';

  const staff: Actor = {
    id: 'user-1',
    roles: [PlatformRole.STAFF],
    email: 'coordinator@harbourline.test',
  };

  function build(
    opts: {
      attributes?: Record<string, unknown>;
      checklist?: { outstandingRequired: number | null; items?: unknown[] };
      checklistThrows?: Error;
      email?: string | null;
      unrendered?: string[];
      /** `undefined` = the pack declares no upload URL at all. */
      uploadUrl?: string;
      recordNumber?: string | null;
      firstName?: string | null;
      lastName?: string | null;
    } = {},
  ) {
    const entity = {
      id: CASE,
      tenantId: TENANT,
      type: EntityType.CASE,
      recordNumber:
        opts.recordNumber === undefined ? 'CS-000042' : opts.recordNumber,
      firstName: opts.firstName === undefined ? 'Ada' : opts.firstName,
      lastName: opts.lastName === undefined ? 'Lovelace' : opts.lastName,
      email: opts.email === undefined ? 'ada@example.test' : opts.email,
      verticalAttributes: { ...(opts.attributes ?? {}) } as Record<
        string,
        unknown
      >,
    };

    const entityRepo = {
      findOne: jest.fn(({ where }: { where: Record<string, string> }) =>
        Promise.resolve(
          where.id === entity.id && where.tenantId === entity.tenantId
            ? entity
            : null,
        ),
      ),
      save: jest.fn((row: typeof entity) => Promise.resolve(row)),
    };

    const tenantRepo = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: TENANT, name: 'Harbourline Migration' }),
      ),
    };

    const access = { assertOwnsEntity: jest.fn(() => Promise.resolve()) };

    const checklist = {
      forEntity: jest.fn(() => {
        if (opts.checklistThrows) return Promise.reject(opts.checklistThrows);
        return Promise.resolve({
          items: opts.checklist?.items ?? [
            {
              key: 'passport',
              label: 'Passport',
              required: true,
              uploaded: false,
            },
            {
              key: 'photo',
              label: 'Photograph',
              required: false,
              uploaded: false,
            },
          ],
          outstandingRequired: opts.checklist?.outstandingRequired ?? 1,
        });
      }),
    };

    const sent: Array<Record<string, unknown>> = [];
    const notifications = {
      renderTemplate: jest.fn(() =>
        Promise.resolve({
          subject: 's',
          content: 'c',
          unrendered: opts.unrendered ?? [],
        }),
      ),
      sendFromTemplate: jest.fn((...args: unknown[]) => {
        sent.push({
          templateKey: args[1],
          recipientId: args[2],
          variables: args[3],
          options: args[5],
        });
        return Promise.resolve({ id: 'n1' });
      }),
    };

    // The pack, reduced to the one key this service reads from it. A pack
    // that declares no upload URL is a real configuration — GRC ships the same
    // template and no portal — so it is the default here, not the edge case.
    const packs = {
      forVertical: jest.fn(() =>
        Promise.resolve(
          opts.uploadUrl === undefined
            ? { uiConfig: {} }
            : { uiConfig: { clientDocumentUploadUrl: opts.uploadUrl } },
        ),
      ),
    };

    const service = new DocumentRequestService(
      entityRepo as never,
      tenantRepo as never,
      access as never,
      checklist as never,
      notifications as never,
      packs as never,
    );

    return {
      service,
      entity,
      entityRepo,
      access,
      checklist,
      notifications,
      packs,
      sent,
    };
  }

  const at = (iso: string) => new Date(iso);

  describe('recordRequest', () => {
    it('writes documentsRequestedAt — the field the pack chase triggers on', async () => {
      const { service, entity, entityRepo } = build();

      const result = await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
        now: at('2026-09-01T09:00:00Z'),
      });

      expect(entityRepo.save).toHaveBeenCalled();
      expect(entity.verticalAttributes[DOCUMENTS_REQUESTED_AT]).toBe(
        '2026-09-01T09:00:00.000Z',
      );
      expect(result.requestedAt).toBe('2026-09-01T09:00:00.000Z');
      expect(result.previouslyRequestedAt).toBeNull();
      expect(result.outstandingRequired).toBe(1);
      expect(result.outstanding).toEqual([
        { key: 'passport', label: 'Passport' },
      ]);
    });

    it('re-opens the loop: a fresh request clears a stale receipt', async () => {
      const { service, entity } = build({
        attributes: {
          [DOCUMENTS_REQUESTED_AT]: '2026-08-01T09:00:00.000Z',
          [DOCUMENTS_RECEIVED_AT]: '2026-08-09T09:00:00.000Z',
        },
      });

      const result = await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
        now: at('2026-09-01T09:00:00Z'),
      });

      expect(result.previouslyRequestedAt).toBe('2026-08-01T09:00:00.000Z');
      // Left in place, the old receipt would keep the new chase from ever
      // firing — the trigger is "requested and not received".
      expect(DOCUMENTS_RECEIVED_AT in entity.verticalAttributes).toBe(false);
    });

    it('checks record-level access before it writes anything', async () => {
      const { service, access } = build();

      await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
      });

      // RLS scopes to the tenant, not to a user inside it.
      expect(access.assertOwnsEntity).toHaveBeenCalledWith(TENANT, CASE, staff);
    });

    it('records the request without sending when no template is named, and says so', async () => {
      const { service, notifications, sent } = build();

      const result = await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
      });

      expect(sent).toHaveLength(0);
      expect(notifications.sendFromTemplate).not.toHaveBeenCalled();
      expect(result.notified).toBe(false);
      expect(result.notNotifiedReason).toMatch(/nothing was sent/i);
    });

    it('sends the pack template, with the firm’s name and the outstanding list', async () => {
      const { service, sent } = build();

      const result = await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
        templateKey: 'document_request',
      });

      expect(result.notified).toBe(true);
      expect(sent[0].templateKey).toBe('document_request');
      const variables = sent[0].variables as Record<string, unknown>;
      expect(variables.firmName).toBe('Harbourline Migration');
      expect(variables.documentCount).toBe(1);
      expect(variables.documentList).toBe('• Passport');
      // The recipient is a CRM record with no login, so the address travels
      // with the message.
      expect((sent[0].options as Record<string, unknown>).recipientEmail).toBe(
        'ada@example.test',
      );
    });

    it('refuses to send a template it cannot fully fill, naming the variables', async () => {
      const { service, notifications, sent } = build({
        unrendered: ['uploadUrl', 'entityLabel'],
      });

      const result = await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
        templateKey: 'document_request',
      });

      // A client receiving a literal `{{uploadUrl}}` is worse than no email:
      // the request is recorded, and the pack-authoring gap is named.
      expect(notifications.sendFromTemplate).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
      expect(result.notified).toBe(false);
      expect(result.notNotifiedReason).toContain('uploadUrl');
      expect(result.notNotifiedReason).toContain('entityLabel');
      // The request itself still stands.
      expect(result.requestedAt).toBeTruthy();
    });

    /**
     * The two variables the pack's `document_request` template declares and
     * this route did not supply.
     *
     * This is what made the refuse-to-send check above fire on **every** real
     * request: `documentsRequestedAt` was stamped, nothing reached the client,
     * and the chase sequence arrived days later reminding them about documents
     * they had never been asked for. The check was right; the missing
     * variables were the bug.
     */
    describe('the variables the pack template actually declares', () => {
      const varsOf = (h: ReturnType<typeof build>) =>
        (h.notifications.renderTemplate.mock.calls[0] as unknown[])[2] as Record<
          string,
          unknown
        >;

      it('supplies entityLabel and uploadUrl, so the client is written to', async () => {
        const h = build({ uploadUrl: 'https://app.immistack.com/client/documents' });

        const result = await h.service.recordRequest({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: CASE,
          templateKey: 'document_request',
        });

        const variables = varsOf(h);
        expect(variables.entityLabel).toBe('CS-000042');
        expect(variables.uploadUrl).toBe(
          'https://app.immistack.com/client/documents',
        );
        expect(result.notified).toBe(true);
        expect(result.notNotifiedReason).toBeNull();
      });

      it('reads the upload URL from the pack, never from core', async () => {
        // Core does not know what a client portal looks like (CLAUDE.md §7.1).
        // The pack authors the whole URL and this passes it through unchanged
        // — no base, no appended path, nothing to get wrong per vertical.
        const h = build({ uploadUrl: 'https://govx-app.vercel.app/en/uploads' });

        await h.service.recordRequest({
          tenantId: TENANT,
          vertical: 'grc',
          actor: staff,
          entityId: CASE,
          templateKey: 'document_request',
        });

        expect(h.packs.forVertical).toHaveBeenCalledWith('grc');
        expect(varsOf(h).uploadUrl).toBe('https://govx-app.vercel.app/en/uploads');
      });

      it('labels by record number, falling back to the applicant name', async () => {
        const h = build({ recordNumber: null, uploadUrl: 'https://x.test/u' });

        await h.service.recordRequest({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: CASE,
          templateKey: 'document_request',
        });

        expect(varsOf(h).entityLabel).toBe('Ada Lovelace');
      });

      it('omits the key rather than sending an empty label', async () => {
        // The important half. `renderTemplate` does `String(value)` on whatever
        // it is handed, so `entityLabel: ''` renders as an empty string and
        // `undefined` renders as the literal text "undefined" — either one
        // passes the unrendered-variable check and reaches an applicant's
        // inbox mid-sentence. Absent, the placeholder survives and the send is
        // refused instead. §7.3, in email form.
        const h = build({
          recordNumber: null,
          firstName: null,
          lastName: null,
          uploadUrl: 'https://x.test/u',
        });

        await h.service.recordRequest({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: CASE,
          templateKey: 'document_request',
        });

        expect('entityLabel' in varsOf(h)).toBe(false);
      });

      it('omits uploadUrl when the pack declares none', async () => {
        // A pack with no client portal keeps exactly today's behaviour —
        // request recorded, nothing sent, the variable named — rather than
        // mailing a link into a product that may not exist.
        const h = build();

        await h.service.recordRequest({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: CASE,
          templateKey: 'document_request',
        });

        expect('uploadUrl' in varsOf(h)).toBe(false);
      });

      it('treats a blank upload URL in the pack as no URL', async () => {
        const h = build({ uploadUrl: '   ' });

        await h.service.recordRequest({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: CASE,
          templateKey: 'document_request',
        });

        expect('uploadUrl' in varsOf(h)).toBe(false);
      });

      it('never lets a record attribute overwrite the supplied uploadUrl', async () => {
        // `verticalAttributes` is spread into the variable map first and is
        // client-influenced data on some intake paths. It must not be able to
        // redirect the one link this service sends.
        const h = build({
          uploadUrl: 'https://app.immistack.com/client/documents',
          attributes: { uploadUrl: 'https://attacker.test/harvest' },
        });

        await h.service.recordRequest({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: CASE,
          templateKey: 'document_request',
        });

        expect(varsOf(h).uploadUrl).toBe(
          'https://app.immistack.com/client/documents',
        );
      });
    });

    it('reports honestly when the record has no address to write to', async () => {
      const { service } = build({ email: null });

      const result = await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
        templateKey: 'document_request',
      });

      expect(result.notified).toBe(false);
      expect(result.notNotifiedReason).toMatch(/no email address/i);
    });

    it('records the request even when the checklist cannot be resolved', async () => {
      const { service, entity } = build({
        checklistThrows: new Error('No active config pack for vertical'),
      });

      const result = await service.recordRequest({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
      });

      expect(entity.verticalAttributes[DOCUMENTS_REQUESTED_AT]).toBeTruthy();
      // null is "we could not tell", never "nothing outstanding".
      expect(result.outstandingRequired).toBeNull();
      expect(result.outstanding).toEqual([]);
    });
  });

  describe('recordIntake', () => {
    it('does not stamp a receipt for documents nobody asked for', async () => {
      const { service, entity, entityRepo } = build({
        checklist: { outstandingRequired: 0 },
      });

      const result = await service.recordIntake({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
      });

      // §7.3: "not asked" is not "missing", and it is not "received" either.
      // A receipt here would sit on the record and pre-satisfy the next
      // request, so the chase after it could never fire.
      expect(result.outcome).toBe('no-request-recorded');
      expect(entity.verticalAttributes[DOCUMENTS_RECEIVED_AT]).toBeUndefined();
      expect(entityRepo.save).not.toHaveBeenCalled();
    });

    it('keeps the chase running while anything required is still outstanding', async () => {
      const { service, entity } = build({
        attributes: { [DOCUMENTS_REQUESTED_AT]: '2026-09-01T09:00:00.000Z' },
        checklist: { outstandingRequired: 2 },
      });

      const result = await service.recordIntake({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
      });

      expect(result.outcome).toBe('still-outstanding');
      expect(result.outstandingRequired).toBe(2);
      expect(entity.verticalAttributes[DOCUMENTS_RECEIVED_AT]).toBeUndefined();
    });

    it('stamps documentsReceivedAt once the required checklist is complete', async () => {
      const { service, entity } = build({
        attributes: { [DOCUMENTS_REQUESTED_AT]: '2026-09-01T09:00:00.000Z' },
        checklist: { outstandingRequired: 0 },
      });

      const result = await service.recordIntake({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
        now: at('2026-09-05T11:00:00Z'),
      });

      expect(result.outcome).toBe('received');
      expect(entity.verticalAttributes[DOCUMENTS_RECEIVED_AT]).toBe(
        '2026-09-05T11:00:00.000Z',
      );
    });

    it('never overwrites an existing receipt', async () => {
      const { service, entity, entityRepo } = build({
        attributes: {
          [DOCUMENTS_REQUESTED_AT]: '2026-09-01T09:00:00.000Z',
          [DOCUMENTS_RECEIVED_AT]: '2026-09-04T09:00:00.000Z',
        },
        checklist: { outstandingRequired: 0 },
      });

      const result = await service.recordIntake({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
      });

      expect(result.outcome).toBe('already-received');
      expect(entity.verticalAttributes[DOCUMENTS_RECEIVED_AT]).toBe(
        '2026-09-04T09:00:00.000Z',
      );
      expect(entityRepo.save).not.toHaveBeenCalled();
    });

    it('treats an unresolvable vertical or checklist as unknown, not as complete', async () => {
      const noVertical = build({
        attributes: { [DOCUMENTS_REQUESTED_AT]: '2026-09-01T09:00:00.000Z' },
        checklist: { outstandingRequired: 0 },
      });
      const noChecklist = build({
        attributes: { [DOCUMENTS_REQUESTED_AT]: '2026-09-01T09:00:00.000Z' },
        checklistThrows: new Error('No active config pack for vertical'),
      });

      await expect(
        noVertical.service.recordIntake({
          tenantId: TENANT,
          vertical: null,
          actor: staff,
          entityId: CASE,
        }),
      ).resolves.toMatchObject({ outcome: 'vertical-unresolved' });

      await expect(
        noChecklist.service.recordIntake({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: CASE,
        }),
      ).resolves.toMatchObject({ outcome: 'checklist-unavailable' });

      expect(
        noVertical.entity.verticalAttributes[DOCUMENTS_RECEIVED_AT],
      ).toBeUndefined();
      expect(
        noChecklist.entity.verticalAttributes[DOCUMENTS_RECEIVED_AT],
      ).toBeUndefined();
    });

    it('reports a record it cannot find rather than throwing at an upload', async () => {
      const { service } = build();

      await expect(
        service.recordIntake({
          tenantId: TENANT,
          vertical: 'immigration',
          actor: staff,
          entityId: '33333333-3333-3333-3333-333333333333',
        }),
      ).resolves.toMatchObject({ outcome: 'entity-not-found' });
    });

    it('scopes the lookup to the caller’s tenant', async () => {
      const { service, entityRepo } = build();

      await service.recordIntake({
        tenantId: TENANT,
        vertical: 'immigration',
        actor: staff,
        entityId: CASE,
      });

      expect(entityRepo.findOne).toHaveBeenCalledWith({
        where: { id: CASE, tenantId: TENANT },
      });
    });
  });
});
