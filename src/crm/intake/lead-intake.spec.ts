import {
  BadRequestException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { LeadIntakeService } from './lead-intake.service';
import { CaptureLeadDto } from './dto/capture-lead.dto';
import { EntityType } from '../entities/universal-entity.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

/**
 * FR-3.3 — the public website capture endpoint.
 *
 * This is a `@Public()` write route, which puts it in a category of fourteen,
 * and two of those have already had to be removed or gated this month
 * (`POST /auth/register`, `POST /tenants/signup`). Both failures were the same
 * shape: the route decided WHICH TENANT to write to from something a caller
 * could guess. So the tests that matter most here are not the happy path —
 * they are:
 *
 *  - an unknown or revoked key writes nothing and says only "not valid";
 *  - the tenant comes from the key row, never from the request;
 *  - the response is identical whether a lead was created, matched or held,
 *    so a leaked key cannot be used to enumerate the firm's client list;
 *  - nothing is invented: an attribution field the form did not send stays
 *    absent rather than becoming "website".
 */
describe('LeadIntakeService — public website capture (FR-3.3)', () => {
  const TENANT = 'tenant-a';
  const KEY_ID = 'key-1';
  const TOKEN = 'mli_a-real-looking-token';

  function harness(
    overrides: {
      key?: Partial<Record<string, unknown>>;
      existingEntity?: Record<string, unknown> | null;
      quota?: Array<{ windowCount: number; maxPerHour: number }>;
    } = {},
  ) {
    const keyRow: Record<string, unknown> = {
      id: KEY_ID,
      tenantId: TENANT,
      name: 'site form',
      tokenHash: LeadIntakeService.digest(TOKEN),
      tokenPrefix: TOKEN.slice(0, 12),
      defaultChannel: null,
      defaultPartner: null,
      maxPerHour: 60,
      windowStartedAt: null,
      windowCount: 0,
      active: true,
      lastUsedAt: null,
      createdBy: null,
      ...(overrides.key ?? {}),
    };

    const submissions: Array<Record<string, unknown>> = [];
    const created: Array<{ tenantId: string; dto: any }> = [];
    const quota = overrides.quota ?? [{ windowCount: 1, maxPerHour: 60 }];

    const keyRepo = {
      findOne: async ({ where }: any) =>
        where.tokenHash === keyRow.tokenHash ? keyRow : null,
      query: async () => quota,
      save: async (row: any) => row,
      create: (row: any) => row,
      find: async () => [keyRow],
      delete: async () => ({ affected: 1 }),
    };

    const submissionRepo = {
      create: (row: any) => row,
      insert: async (row: any) => {
        submissions.push(row);
        return { identifiers: [{ id: row.id }] };
      },
      find: async () => submissions,
    };

    const entityRepo = {
      createQueryBuilder: () => {
        const qb: any = {
          where: () => qb,
          andWhere: () => qb,
          getOne: async () => overrides.existingEntity ?? null,
        };
        return qb;
      },
    };

    const crm = {
      createEntity: async (tenantId: string, dto: any) => {
        created.push({ tenantId, dto });
        return { id: 'lead-1', ...dto };
      },
    };

    const service = new LeadIntakeService(
      keyRepo as any,
      submissionRepo as any,
      entityRepo as any,
      crm as any,
    );

    return { service, submissions, created, keyRow };
  }

  const body = (over: Partial<CaptureLeadDto> = {}): CaptureLeadDto =>
    ({
      firstName: 'Layla',
      lastName: 'Rashid',
      email: 'Layla@Example.com ',
      ...over,
    }) as CaptureLeadDto;

  const capture = (service: LeadIntakeService, input: any) =>
    // The ALS store exists on a real request because `TenantAlsMiddleware` ran;
    // it simply has no tenant, because there was no JWT.
    TenantContext.run({}, () => service.capture(input));

  const input = (over: Record<string, unknown> = {}) => ({
    token: TOKEN,
    dto: body(),
    sourceIp: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
    origin: 'https://example-migration.com.au',
    ...over,
  });

  describe('the key is the only thing that names a tenant', () => {
    it('refuses a missing key without touching anything', async () => {
      const { service, submissions, created } = harness();
      await expect(capture(service, input({ token: undefined }))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(submissions).toHaveLength(0);
      expect(created).toHaveLength(0);
    });

    it('refuses an unknown key', async () => {
      const { service, created } = harness();
      await expect(
        capture(service, input({ token: 'mli_not-a-key' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(created).toHaveLength(0);
    });

    it('answers a revoked key exactly as it answers an unknown one', async () => {
      // Same status and same message: a distinct 404 for "this key existed" is
      // how a scanner learns it has found a real one.
      const { service } = harness({ key: { active: false } });
      const revoked = await capture(service, input()).catch((e) => e);
      const unknown = await capture(service, input({ token: 'mli_nope' })).catch(
        (e) => e,
      );
      expect(revoked).toBeInstanceOf(UnauthorizedException);
      expect(unknown).toBeInstanceOf(UnauthorizedException);
      expect(revoked.getResponse()).toEqual(unknown.getResponse());
    });

    it('writes to the tenant on the key row, never one named by the caller', async () => {
      const { service, created, submissions } = harness();
      await capture(service, input());
      expect(created[0].tenantId).toBe(TENANT);
      expect(submissions[0].tenantId).toBe(TENANT);
    });

    it('refuses to write at all outside a tenant context', async () => {
      // No ALS store ⇒ `setTenantId` returns false ⇒ the write would land on
      // an unbound connection. Fail rather than write unscoped.
      const { service } = harness();
      await expect(service.capture(input() as any)).rejects.toThrow(
        /outside a tenant context/,
      );
    });

    it('stores only a digest of the token, and never the token itself', async () => {
      const { service, submissions, keyRow } = harness();
      await capture(service, input({ dto: body({ key: TOKEN }) }));
      expect(keyRow.tokenHash).not.toContain(TOKEN);
      expect(JSON.stringify(submissions[0])).not.toContain(TOKEN);
      expect((submissions[0].payload as Record<string, unknown>).key).toBeUndefined();
    });
  });

  describe('the lead it creates', () => {
    it('populates the promoted name and email columns (ADR 0011)', async () => {
      const { service, created } = harness();
      await capture(service, input());
      expect(created[0].dto).toMatchObject({
        type: EntityType.LEAD,
        firstName: 'Layla',
        lastName: 'Rashid',
        email: 'layla@example.com',
      });
    });

    it('does not set subjectEmail — a website enquirer is not a portal user', async () => {
      const { service, created } = harness();
      await capture(service, input());
      expect(created[0].dto.subjectEmail).toBeUndefined();
    });

    it('records the attribution it was given (FR-3.8)', async () => {
      const { service, created, submissions } = harness();
      await capture(
        service,
        input({
          dto: body({
            channel: 'website',
            campaign: 'au-skilled-q3',
            referrer: 'https://www.google.com/',
            landingPage: 'https://example.com.au/189',
            partner: 'alpha-agents',
          }),
        }),
      );
      expect(created[0].dto.verticalAttributes).toMatchObject({
        intakeChannel: 'website',
        intakeCampaign: 'au-skilled-q3',
        intakeReferrer: 'https://www.google.com/',
        intakeLandingPage: 'https://example.com.au/189',
        intakePartner: 'alpha-agents',
      });
      expect(submissions[0]).toMatchObject({
        channel: 'website',
        campaign: 'au-skilled-q3',
        partner: 'alpha-agents',
      });
    });

    it('never invents attribution that was not sent', async () => {
      const { service, created, submissions } = harness();
      await capture(service, input());
      const attrs = created[0].dto.verticalAttributes;
      // Absent, not "website". A default here would read later as a
      // measurement of where the firm's leads come from.
      expect('intakeChannel' in attrs).toBe(false);
      expect('intakeCampaign' in attrs).toBe(false);
      expect(submissions[0].channel).toBeNull();
      expect(submissions[0].campaign).toBeNull();
    });

    it('lets the key pin attribution the body cannot override', async () => {
      const { service, created } = harness({
        key: { defaultChannel: 'referral', defaultPartner: 'alpha-agents' },
      });
      await capture(
        service,
        input({ dto: body({ channel: 'website', partner: 'someone-else' }) }),
      );
      expect(created[0].dto.verticalAttributes).toMatchObject({
        intakeChannel: 'referral',
        intakePartner: 'alpha-agents',
      });
    });

    it('keeps `consent: false` and never defaults consent when unasked', async () => {
      const { service, created } = harness();
      await capture(service, input({ dto: body({ consent: false }) }));
      expect(created[0].dto.verticalAttributes.intakeConsent).toBe(false);

      const second = harness();
      await capture(second.service, input());
      expect(
        'intakeConsent' in second.created[0].dto.verticalAttributes,
      ).toBe(false);
    });
  });

  describe('spam protection', () => {
    it('refuses a filled honeypot with 400, and records the attempt', async () => {
      const { service, submissions, created } = harness();
      await expect(
        capture(service, input({ dto: body({ trap: 'buy-cheap-visas' }) })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(created).toHaveLength(0);
      expect(submissions[0].status).toBe('rejected_honeypot');
    });

    it('answers 429 over the key’s hourly limit, and creates nothing', async () => {
      const { service, created, submissions } = harness({
        quota: [{ windowCount: 61, maxPerHour: 60 }],
      });
      const err = await capture(service, input()).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect(created).toHaveLength(0);
      // Deliberately no row: recording every throttled attempt is the
      // unbounded write the limit exists to prevent.
      expect(submissions).toHaveLength(0);
    });

    it('rejects nested or oversized custom fields', async () => {
      const { service } = harness();
      await expect(
        capture(
          service,
          input({ dto: body({ fields: { nested: { a: 1 } } as any }) }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const many = Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => [`f${i}`, 'x']),
      );
      await expect(
        capture(service, input({ dto: body({ fields: many }) })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('a returning enquirer', () => {
    it('is held rather than duplicated, and the enquiry is still recorded', async () => {
      const { service, created, submissions } = harness({
        existingEntity: { id: 'existing-1' },
      });
      const result = await capture(service, input());
      expect(created).toHaveLength(0);
      expect(submissions[0]).toMatchObject({
        status: 'duplicate',
        matchedEntityId: 'existing-1',
      });
      expect(result).toEqual({ received: true, submissionId: expect.any(String) });
    });

    it('answers identically to a new lead — the response is not an oracle', async () => {
      const fresh = harness();
      const dupe = harness({ existingEntity: { id: 'existing-1' } });
      const a = await capture(fresh.service, input());
      const b = await capture(dupe.service, input());
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      expect(a.received).toBe(b.received);
    });
  });

  describe('minting a key', () => {
    it('returns the token once and stores only its digest', async () => {
      const { service, keyRow } = harness();
      const saved: any[] = [];
      (service as any).keyRepo = {
        create: (row: any) => row,
        save: async (row: any) => {
          saved.push(row);
          return { ...row, id: 'new-key', createdAt: new Date(), updatedAt: new Date() };
        },
      };

      const result = await service.mint(TENANT, 'staff-1', { name: 'site form' });

      expect(result.token.startsWith('mli_')).toBe(true);
      expect(saved[0].tokenHash).toBe(LeadIntakeService.digest(result.token));
      expect(saved[0].tokenHash).not.toBe(result.token);
      // The row itself never carries the secret, so no later read can leak it.
      expect(JSON.stringify(saved[0])).not.toContain(result.token);
      // …and the returned key object does not carry the digest either.
      expect((result.key as any).tokenHash).toBeUndefined();
      expect(keyRow.tenantId).toBe(TENANT);
    });

    it('reports the window count as attempts, digest omitted, on a list', async () => {
      const { service } = harness({ key: { windowCount: 137 } });
      const [listed] = await service.listKeys(TENANT);
      expect((listed as any).tokenHash).toBeUndefined();
      // Climbs past maxPerHour on purpose — that excess IS the abuse signal.
      expect(listed.submissionsThisWindow).toBe(137);
    });
  });
});

/**
 * A controller that is written but never registered is a route that does not
 * exist, and unit tests against the service cannot see it. This is the cheap
 * half of that check; the expensive half is a boot and a route table.
 */
describe('CrmModule wiring', () => {
  // Required lazily so this file's service tests do not pay for the module
  // graph when they are run alone.
  const { CrmModule } = require('../crm.module');
  const {
    LeadIntakeReceiverController,
    LeadIntakeAdminController,
  } = require('./lead-intake.controller');
  const { ProfileSectionService } = require('../profile/profile-section.service');
  const { CaseAgingService } = require('../aging/case-aging.service');

  it('registers the public receiver and the admin controller', () => {
    const controllers = Reflect.getMetadata('controllers', CrmModule) ?? [];
    expect(controllers).toContain(LeadIntakeReceiverController);
    expect(controllers).toContain(LeadIntakeAdminController);
  });

  it('provides everything the CRM controller now injects', () => {
    const providers = Reflect.getMetadata('providers', CrmModule) ?? [];
    expect(providers).toContain(LeadIntakeService);
    expect(providers).toContain(ProfileSectionService);
    expect(providers).toContain(CaseAgingService);
  });
});
