import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { LeadIntakeKey } from './entities/lead-intake-key.entity';
import {
  LeadIntakeSubmission,
  LeadIntakeSubmissionStatus,
} from './entities/lead-intake-submission.entity';
import { CaptureLeadDto } from './dto/capture-lead.dto';
import {
  CreateIntakeKeyDto,
  UpdateIntakeKeyDto,
} from './dto/create-intake-key.dto';
import { CrmService } from '../crm.service';
import { EntityType, UniversalEntity } from '../entities/universal-entity.entity';
import { TenantContext } from '../../core/tenancy/tenant-context';

/** Issued token: `mli_` + 32 random bytes, base64url. */
const TOKEN_PREFIX = 'mli_';
const MAX_CUSTOM_FIELDS = 20;
const MAX_CUSTOM_KEY_LENGTH = 64;
const MAX_CUSTOM_VALUE_LENGTH = 2000;

/** A key row with the digest removed — what any read route may return. */
export type PublicIntakeKey = Omit<
  LeadIntakeKey,
  'tokenHash' | 'windowStartedAt' | 'windowCount'
> & { windowStartedAt: Date | null; submissionsThisWindow: number };

export interface CaptureInput {
  /** From the `X-Meru-Intake-Key` header or the body's `key` field. */
  token: string | undefined;
  dto: CaptureLeadDto;
  sourceIp: string | null;
  userAgent: string | null;
  origin: string | null;
}

/**
 * Website lead capture — FR-3.3, with FR-3.8's source tracking.
 *
 * ## Why this exists at all
 *
 * Every route on `@Controller('forms')` is JWT-guarded and nothing anywhere
 * carried `@Public()` for an intake, so the product could not receive a lead
 * from a firm's own website. The ImmiStack marketing site posts to a Vercel
 * function and into a third-party CRM instead — not a preference, a
 * workaround for a missing endpoint.
 *
 * ## The three things that make a public write route safe here
 *
 * 1. **The tenant comes from a secret, not from a name.** `POST /auth/register`
 *    was removed and `POST /tenants/signup` was gated because each was
 *    `@Public()` and keyed on a guessable tenant slug. This route resolves the
 *    tenant by SHA-256 digest of a 32-byte token that appears in one place —
 *    the firm's own form — and is revocable in one PATCH.
 * 2. **The limit is durable.** The Express limiter both bootstraps run is
 *    IP-keyed and in-memory, which on Vercel bounds one warm instance and
 *    nothing across them. The per-key window counter here lives in Postgres,
 *    so every instance shares it.
 * 3. **Nothing is invented.** An attribution field the form did not send is
 *    stored as null, and the response says only that the submission was
 *    received — never whether it became a new lead, matched an existing one,
 *    or was held. A uniform answer is what stops a leaked key from being an
 *    email-enumeration oracle against the firm's client list.
 */
@Injectable()
export class LeadIntakeService {
  private readonly logger = new Logger(LeadIntakeService.name);

  constructor(
    @InjectRepository(LeadIntakeKey)
    private readonly keyRepo: Repository<LeadIntakeKey>,
    @InjectRepository(LeadIntakeSubmission)
    private readonly submissionRepo: Repository<LeadIntakeSubmission>,
    @InjectRepository(UniversalEntity)
    private readonly entityRepo: Repository<UniversalEntity>,
    private readonly crm: CrmService,
  ) {}

  static digest(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  // ── Key management (authenticated, staff) ────────────────────────────────

  /**
   * Mint a key. The token is returned **once** and never again — only its
   * digest is stored, so no later route and no operator can read it back. The
   * recovery path is to mint a new one and revoke the old, which is also the
   * rotation path.
   *
   * Tenant-scoped: `tenantId` is the caller's own JWT tenant, and RLS polices
   * the insert against the same value (CLAUDE.md §5.1, both layers).
   */
  async mint(
    tenantId: string,
    actorId: string | null,
    dto: CreateIntakeKeyDto,
  ): Promise<{ key: PublicIntakeKey; token: string; endpoint: string }> {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const saved = await this.keyRepo.save(
      this.keyRepo.create({
        tenantId,
        name: dto.name,
        tokenHash: LeadIntakeService.digest(token),
        tokenPrefix: token.slice(0, 12),
        defaultChannel: dto.defaultChannel ?? null,
        defaultPartner: dto.defaultPartner ?? null,
        maxPerHour: dto.maxPerHour ?? 60,
        active: true,
        createdBy: actorId,
      }),
    );

    return {
      key: LeadIntakeService.redact(saved),
      token,
      endpoint: '/api/v1/intake/leads',
    };
  }

  /** This tenant's keys, digests omitted. */
  async listKeys(tenantId: string): Promise<PublicIntakeKey[]> {
    const rows = await this.keyRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => LeadIntakeService.redact(row));
  }

  /** Revoke, restore, or re-limit. Tenant-scoped by the `where`, then by RLS. */
  async updateKey(
    tenantId: string,
    id: string,
    dto: UpdateIntakeKeyDto,
  ): Promise<PublicIntakeKey> {
    const row = await this.keyRepo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('Intake key not found');
    if (dto.active !== undefined) row.active = dto.active;
    if (dto.maxPerHour !== undefined) row.maxPerHour = dto.maxPerHour;
    return LeadIntakeService.redact(await this.keyRepo.save(row));
  }

  async removeKey(tenantId: string, id: string): Promise<void> {
    const result = await this.keyRepo.delete({ id, tenantId });
    if (!result.affected) throw new NotFoundException('Intake key not found');
  }

  /**
   * Received submissions, newest first — **including the refused ones**.
   *
   * This is the only place the outcome of a submission is visible. The public
   * response deliberately does not carry it, so a firm looking for "did that
   * enquiry arrive" looks here.
   */
  async listSubmissions(
    tenantId: string,
    filters: { keyId?: string; status?: string; limit?: number } = {},
  ): Promise<LeadIntakeSubmission[]> {
    const where: Record<string, unknown> = { tenantId };
    if (filters.keyId) where.keyId = filters.keyId;
    if (filters.status) where.status = filters.status;
    return this.submissionRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    });
  }

  // ── The public route ─────────────────────────────────────────────────────

  /**
   * Verify the key, bind the tenant, throttle, record, and create the lead.
   *
   * Returns the same shape whatever happened downstream — see the class
   * comment.
   */
  async capture(input: CaptureInput): Promise<{
    received: true;
    submissionId: string;
  }> {
    const token = input.token?.trim();
    if (!token) {
      throw new UnauthorizedException({
        code: 'MER-AUTH-0001',
        message:
          'Missing capture key. Send it as X-Meru-Intake-Key, or as `key` in the body.',
      });
    }

    // Resolve the digest to a tenant. This one statement has to run outside
    // tenancy — there is no tenant bound yet, and the key row is the only
    // thing that names one. Same escape hatch, and the same narrow use, as
    // `InboundWebhookService.receive`.
    const key = await TenantContext.runAsSystem(
      'lead intake: resolve capture key to tenant',
      () =>
        this.keyRepo.findOne({
          where: { tokenHash: LeadIntakeService.digest(token) },
        }),
    );

    // Unknown and revoked answer identically. A distinct 404 for "no such key"
    // would tell a scanner when it had found a real one.
    if (!key || !key.active) {
      throw new UnauthorizedException({
        code: 'MER-AUTH-0001',
        message: 'Capture key is not valid for this endpoint.',
      });
    }

    // Everything from here runs bound to the key's tenant, so RLS polices the
    // writes exactly as it does an authenticated request. `false` means the
    // ALS middleware did not run, which is a deployment fault, not a caller
    // error — fail rather than write unbound.
    if (!TenantContext.setTenantId(key.tenantId)) {
      throw new Error('Lead intake received outside a tenant context');
    }

    await this.consumeQuota(key);

    const dto = input.dto;
    const submissionId = randomUUID();

    if (dto.trap && dto.trap.trim().length > 0) {
      await this.record(submissionId, key, dto, input, 'rejected_honeypot', {});
      throw new BadRequestException({
        code: 'MER-VAL-0001',
        message: 'Submission rejected.',
      });
    }

    const fields = LeadIntakeService.assertCustomFields(dto.fields);

    // Attribution: what the key pins beats what the body claims.
    const channel = key.defaultChannel ?? dto.channel ?? null;
    const partner = key.defaultPartner ?? dto.partner ?? null;
    const email = dto.email.trim().toLowerCase();

    // `CrmService.createEntity` refuses a duplicate email tenant-wide, so a
    // returning enquirer would otherwise 400 and the enquiry would be lost.
    // Matched instead: the submission is kept and staff see it against the
    // record it belongs to.
    const existing = await this.entityRepo
      .createQueryBuilder('e')
      .where('e."tenantId" = :tenantId', { tenantId: key.tenantId })
      .andWhere('LOWER(TRIM(e.email)) = :email', { email })
      .andWhere('e."deletedAt" IS NULL')
      .getOne();

    if (existing) {
      await this.record(submissionId, key, dto, input, 'duplicate', {
        channel,
        partner,
        matchedEntityId: existing.id,
      });
      return { received: true, submissionId };
    }

    let lead: UniversalEntity;
    try {
      lead = await this.crm.createEntity(key.tenantId, {
        type: EntityType.LEAD,
        // ADR 0011: the promoted columns are populated by the producer. A lead
        // created here is never nameless, because the DTO requires the name.
        firstName: dto.firstName.trim(),
        lastName: dto.lastName?.trim(),
        email,
        phoneNumber: dto.phoneNumber?.trim(),
        // `subjectEmail` is deliberately NOT set. It is what makes a record
        // visible in the client portal, and a website enquirer has no login
        // and is not yet a client of the firm.
        verticalAttributes: LeadIntakeService.attributesFor(
          submissionId,
          key,
          dto,
          { channel, partner, fields },
        ),
      });
    } catch (err) {
      // Two submissions for the same new address can race between the lookup
      // above and the insert. Losing that race is a duplicate, not a failure —
      // the enquiry is still recorded.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('already exists')) throw err;

      const matched = await this.entityRepo
        .createQueryBuilder('e')
        .where('e."tenantId" = :tenantId', { tenantId: key.tenantId })
        .andWhere('LOWER(TRIM(e.email)) = :email', { email })
        .getOne();
      await this.record(submissionId, key, dto, input, 'duplicate', {
        channel,
        partner,
        matchedEntityId: matched?.id ?? null,
      });
      return { received: true, submissionId };
    }

    await this.record(submissionId, key, dto, input, 'accepted', {
      channel,
      partner,
      leadId: lead.id,
    });

    this.logger.log(
      `Lead captured for tenant ${key.tenantId} via key ${key.tokenPrefix}… (${lead.id})`,
    );
    return { received: true, submissionId };
  }

  /**
   * Advance the key's window counter and refuse when it is spent.
   *
   * ONE statement, so two concurrent submissions cannot both read the same
   * count and both be admitted — the same reasoning as `claimRecordNumber`
   * (ADR 0010 §2.2) and for the same reason: on Vercel there is no shared
   * process to hold a counter in. `windowStartedAt` inside the SET clause
   * reads the OLD row value in Postgres, which is what makes the roll-over
   * branch and the increment branch agree.
   */
  private async consumeQuota(key: LeadIntakeKey): Promise<void> {
    const rows: Array<{ windowCount: number; maxPerHour: number }> =
      await this.keyRepo.query(
        `UPDATE "lead_intake_keys"
            SET "windowStartedAt" = CASE
                  WHEN "windowStartedAt" IS NULL
                    OR "windowStartedAt" < now() - interval '1 hour'
                  THEN now() ELSE "windowStartedAt" END,
                "windowCount" = CASE
                  WHEN "windowStartedAt" IS NULL
                    OR "windowStartedAt" < now() - interval '1 hour'
                  THEN 1 ELSE "windowCount" + 1 END,
                "lastUsedAt" = now()
          WHERE "id" = $1 AND "tenantId" = $2 AND "active" = true
          RETURNING "windowCount", "maxPerHour"`,
        [key.id, key.tenantId],
      );

    // Revoked between the lookup and here.
    if (!rows.length) {
      throw new UnauthorizedException({
        code: 'MER-AUTH-0001',
        message: 'Capture key is not valid for this endpoint.',
      });
    }

    const count = Number(rows[0].windowCount);
    const max = Number(rows[0].maxPerHour);
    if (count > max) {
      this.logger.warn(
        `Lead intake key ${key.tokenPrefix}… (tenant ${key.tenantId}) over its ` +
          `hourly limit: ${count} attempts against a ceiling of ${max}`,
      );
      // Same code and family as the global limiter, so a caller handling one
      // handles both. 429, not a quiet 200: the firm's site must be able to
      // tell the visitor to try again rather than show a false thank-you.
      throw new HttpException(
        {
          code: 'MER-RATE-0001',
          message: 'Too many submissions on this capture key. Try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Persist the submission — accepted, held or refused, all of them. */
  private async record(
    id: string,
    key: LeadIntakeKey,
    dto: CaptureLeadDto,
    input: CaptureInput,
    status: LeadIntakeSubmissionStatus,
    outcome: {
      channel?: string | null;
      partner?: string | null;
      leadId?: string | null;
      matchedEntityId?: string | null;
    },
  ): Promise<void> {
    // `key` is stripped here and nowhere else has it: the credential must not
    // reach a row, a log line or an export.
    const { key: _credential, trap: _trap, ...body } = dto;

    // `insert`, not `save`: TypeORM's `save` on an entity carrying a primary
    // key issues a SELECT before the INSERT to decide which it is doing. This
    // is a public route on a function with a pool of `max: 1`, and the id is
    // one we generated a line ago — there is nothing to check for.
    await this.submissionRepo.insert(
      // TypeORM maps a `Record<string, unknown>` jsonb column into
      // `QueryDeepPartialEntity` as `(() => string) | QueryDeepPartialEntity<…>`,
      // which a plain object does not satisfy under `strict`. The value is
      // correct and `create()` has already produced a real entity; only the
      // mapped type is wrong. Cast here rather than loosening `payload` on the
      // entity — storing the exact submitted bytes is the whole point of that
      // column, and a weaker type there would invite someone to reshape them.
      this.submissionRepo.create({
        id,
        tenantId: key.tenantId,
        keyId: key.id,
        status,
        leadId: outcome.leadId ?? null,
        matchedEntityId: outcome.matchedEntityId ?? null,
        email: dto.email?.trim().toLowerCase() ?? null,
        firstName: dto.firstName?.trim() ?? null,
        lastName: dto.lastName?.trim() ?? null,
        phoneNumber: dto.phoneNumber?.trim() ?? null,
        channel: outcome.channel ?? null,
        campaign: dto.campaign ?? null,
        referrer: dto.referrer ?? null,
        landingPage: dto.landingPage ?? null,
        partner: outcome.partner ?? null,
        payload: body as Record<string, unknown>,
        sourceIp: input.sourceIp,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
        sourceOrigin: input.origin?.slice(0, 255) ?? null,
      }) as unknown as Parameters<typeof this.submissionRepo.insert>[0],
    );
  }

  /**
   * The lead's `verticalAttributes`.
   *
   * **Flat `intake*` keys, not a nested `intake` object**, for two reasons.
   * The pack's `entityTypes[].fields[].key` addresses one level, so flat keys
   * are the only ones a pack can declare and a UI can therefore render from
   * the pack rather than from hardcoded knowledge (CLAUDE.md §7.6). And the
   * immigration pack already declares `lead.source` as a `select`; writing an
   * object at `source` would collide with it.
   *
   * A key is present only when a value was actually supplied. An absent key
   * means "not captured" — distinct from a key holding an empty string, and
   * neither is ever rendered as a measured zero.
   */
  private static attributesFor(
    submissionId: string,
    key: LeadIntakeKey,
    dto: CaptureLeadDto,
    resolved: {
      channel: string | null;
      partner: string | null;
      fields: Record<string, string> | null;
    },
  ): Record<string, unknown> {
    const attrs: Record<string, unknown> = {
      intakeSubmissionId: submissionId,
      intakeKeyId: key.id,
      intakeReceivedAt: new Date().toISOString(),
    };
    const put = (name: string, value: unknown) => {
      if (value !== undefined && value !== null && value !== '') {
        attrs[name] = value;
      }
    };
    put('intakeChannel', resolved.channel);
    put('intakeCampaign', dto.campaign);
    put('intakeReferrer', dto.referrer);
    put('intakeLandingPage', dto.landingPage);
    put('intakePartner', resolved.partner);
    put('intakeMessage', dto.message);
    // Consent is written only when the form actually asked. `false` is a real
    // answer and must survive, so it is tested against undefined, not truth.
    if (dto.consent !== undefined) attrs.intakeConsent = dto.consent;
    put('intakeConsentText', dto.consentText);
    if (resolved.fields && Object.keys(resolved.fields).length > 0) {
      attrs.intakeFields = resolved.fields;
    }
    return attrs;
  }

  /**
   * Custom fields are a flat string map with hard caps. Anything else is a
   * 400 that names the problem — a public route must not accept an
   * unbounded, arbitrarily nested object into a jsonb column.
   */
  private static assertCustomFields(
    fields: Record<string, unknown> | undefined,
  ): Record<string, string> | null {
    if (!fields) return null;
    const entries = Object.entries(fields);
    if (entries.length > MAX_CUSTOM_FIELDS) {
      throw new BadRequestException(
        `At most ${MAX_CUSTOM_FIELDS} custom fields; received ${entries.length}.`,
      );
    }
    const out: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (name.length > MAX_CUSTOM_KEY_LENGTH) {
        throw new BadRequestException(
          `Custom field name longer than ${MAX_CUSTOM_KEY_LENGTH} characters.`,
        );
      }
      if (typeof value !== 'string') {
        throw new BadRequestException(
          `Custom field '${name}' must be a string; nested objects are not accepted.`,
        );
      }
      if (value.length > MAX_CUSTOM_VALUE_LENGTH) {
        throw new BadRequestException(
          `Custom field '${name}' is longer than ${MAX_CUSTOM_VALUE_LENGTH} characters.`,
        );
      }
      out[name] = value;
    }
    return out;
  }

  private static redact(row: LeadIntakeKey): PublicIntakeKey {
    const { tokenHash: _hash, windowCount, ...rest } = row;
    return { ...rest, submissionsThisWindow: windowCount };
  }
}
