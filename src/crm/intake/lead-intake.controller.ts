import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../iam/decorators/public.decorator';
import { PolicyGuard } from '../../iam/guards/policy.guard';
import { Roles } from '../../iam/decorators/roles.decorator';
import { PlatformRole } from '../../iam/enums/platform-role.enum';
import type { AuthenticatedRequest } from '../../common/types';
import { LeadIntakeService } from './lead-intake.service';
import { CaptureLeadDto } from './dto/capture-lead.dto';
import {
  CreateIntakeKeyDto,
  UpdateIntakeKeyDto,
} from './dto/create-intake-key.dto';

/**
 * The public receiver, FR-3.3.
 *
 * Its own controller with no class-level guard, for the reason
 * `InboundWebhookReceiverController` records: `@Public()` suppresses the global
 * guard, but a class-level `AuthGuard('jwt')` would still run and demand a
 * bearer token the firm's website cannot have.
 */
@ApiTags('intake')
@Controller('intake')
export class LeadIntakeReceiverController {
  constructor(private readonly intake: LeadIntakeService) {}

  @Post('leads')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({
    name: 'X-Meru-Intake-Key',
    required: false,
    description:
      'The capture key from `POST /intake/keys`. Required unless it is sent ' +
      'as `key` in the body.',
  })
  @ApiOperation({
    summary: 'Capture a lead from a firm’s website (public; key-authenticated)',
    description:
      'The endpoint a firm’s own site posts an enquiry to. It creates a ' +
      '`lead` record on the tenant that owns the key.\n\n' +
      '**Authentication is the key, not a tenant name.** Send it as ' +
      '`X-Meru-Intake-Key`, or as `key` in the body for a plain HTML form ' +
      'post. Deliberately not keyed on the tenant slug: a slug is published ' +
      'on every portal URL, and `POST /auth/register` was removed for exactly ' +
      'that shape.\n\n' +
      '**Spam protection.** A durable per-key hourly limit (Postgres-backed, ' +
      'so it holds across serverless instances) answering `429 MER-RATE-0001`; ' +
      'a honeypot field (`trap`) answering 400; hard caps on every field and ' +
      'on the number of custom fields; and `forbidNonWhitelisted`, so an ' +
      'undeclared field is a 400 rather than something stored.\n\n' +
      '**The response is uniform on purpose.** `{received: true, ' +
      'submissionId}` is returned whether the submission created a lead, ' +
      'matched a record that already existed, or was held. A key used in a ' +
      'browser is visible in page source, and an answer that varied would ' +
      'make it an email-enumeration oracle against the firm’s client list. ' +
      'The outcome of each submission is visible to authenticated staff at ' +
      '`GET /intake/submissions`.\n\n' +
      '**Browser integrations need one deployment step.** CORS runs from a ' +
      'fixed allowlist (`src/common/cors-origins.ts`, extended by ' +
      '`CORS_ALLOWED_ORIGINS`), so a `fetch()` from a firm’s own domain is ' +
      'refused at preflight until that origin is added. Posting server-side ' +
      '— from the site’s own backend or serverless function — needs nothing, ' +
      'and keeps the key off the page.',
  })
  @ApiResponse({
    status: 202,
    description: 'Submission received. `{received: true, submissionId}`.',
  })
  @ApiResponse({ status: 400, description: 'Malformed body, or the honeypot was filled' })
  @ApiResponse({ status: 401, description: 'Missing, unknown or revoked capture key' })
  @ApiResponse({ status: 429, description: 'Over this key’s hourly limit' })
  async capture(
    @Body() dto: CaptureLeadDto,
    @Headers('x-meru-intake-key') headerKey: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Headers('referer') referer: string | undefined,
    @Ip() ip: string,
  ) {
    return this.intake.capture({
      // Header first: a body field is the fallback for callers that cannot set
      // one, not the recommended path.
      token: headerKey ?? dto.key,
      dto,
      sourceIp: ip ?? null,
      userAgent: userAgent ?? null,
      origin: origin ?? referer ?? null,
    });
  }
}

/**
 * Key management and the submission log. Ordinary authenticated surface —
 * minting is admin-only, reading the log is open to staff who work the leads.
 */
@ApiTags('intake')
@ApiBearerAuth('JWT-auth')
@Controller('intake')
@UseGuards(AuthGuard('jwt'), PolicyGuard)
export class LeadIntakeAdminController {
  constructor(private readonly intake: LeadIntakeService) {}

  @Post('keys')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({
    summary: 'Mint a website capture key',
    description:
      'Returns the token **once**. Only its SHA-256 digest is stored, so it ' +
      'cannot be read back by any route or any operator — rotation is mint a ' +
      'new one, paste it into the site, then revoke the old.',
  })
  @ApiResponse({ status: 201, description: '`{key, token, endpoint}`' })
  mint(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateIntakeKeyDto,
  ) {
    return this.intake.mint(req.user.tenantId, req.user.id ?? null, dto);
  }

  @Get('keys')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({
    summary: 'This tenant’s capture keys (digests omitted)',
    description:
      '`submissionsThisWindow` is attempts in the current hour, accepted and ' +
      'refused together — it climbs past `maxPerHour` when a key is being ' +
      'hammered, which is the point of reporting it.',
  })
  listKeys(@Request() req: AuthenticatedRequest) {
    return this.intake.listKeys(req.user.tenantId);
  }

  @Patch('keys/:id')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @ApiOperation({
    summary: 'Revoke, restore or re-limit a key',
    description:
      'Revoking is immediate: the next submission on it answers 401. Leads ' +
      'already captured are unaffected.',
  })
  updateKey(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIntakeKeyDto,
  ) {
    return this.intake.updateKey(req.user.tenantId, id, dto);
  }

  @Delete('keys/:id')
  @Roles(PlatformRole.PLATFORM_ADMIN, PlatformRole.FIRM_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a key; its submissions are kept',
  })
  async removeKey(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.intake.removeKey(req.user.tenantId, id);
  }

  @Get('submissions')
  @Roles(
    PlatformRole.PLATFORM_ADMIN,
    PlatformRole.FIRM_ADMIN,
    PlatformRole.STAFF,
  )
  @ApiOperation({
    summary: 'Website submissions, newest first',
    description:
      'Every submission, including refusals. `status` is `accepted` (a lead ' +
      'was created, `leadId` names it), `duplicate` (the address already ' +
      'belongs to `matchedEntityId`, so no second record was made — **this ' +
      'is still a real enquiry somebody has to answer**), or ' +
      '`rejected_honeypot`.\n\n' +
      'Submissions refused by the rate limiter are **not** rows here — ' +
      'recording them would be the unbounded write the limit exists to ' +
      'prevent. Their volume shows as `submissionsThisWindow` on the key.\n\n' +
      'Staff-and-above: a `client`-role token has no business reading the ' +
      'firm’s enquiry log.',
  })
  @ApiQuery({ name: 'keyId', required: false, format: 'uuid' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['accepted', 'duplicate', 'rejected_honeypot'],
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listSubmissions(
    @Request() req: AuthenticatedRequest,
    @Query('keyId') keyId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.intake.listSubmissions(req.user.tenantId, {
      keyId,
      status,
      limit: limit ? parseInt(limit, 10) || 100 : 100,
    });
  }
}
