import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';
import { PlatformRole } from './enums/platform-role.enum';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenancyService } from '../core/tenancy/tenancy.service';
import type { AuthenticatedRequest } from '../common/types';
import { ConfigPackLoaderService } from '../tenant/services/config-pack-loader.service';
import { NoImpersonationGuard } from './guards/no-impersonation.guard';
import { AuthAttemptLimiter } from './services/auth-attempt-limiter.service';
import { UnlockUserDto } from './dto/unlock-user.dto';

/**
 * Platform-level (cross-tenant) reads for the God UI. Everything here is
 * platform_admin-only and runs through runAsGod, which writes a CRITICAL
 * audit entry before the query executes (CLAUDE.md §6.4).
 */
@Controller('platform')
@ApiTags('platform')
export class PlatformController {
  constructor(
    private readonly tenantProvisioningService: TenantProvisioningService,
    private readonly tenancyService: TenancyService,
    private readonly configPackLoader: ConfigPackLoaderService,
    private readonly attempts: AuthAttemptLimiter,
  ) {}

  @Get('stats')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Platform-wide aggregates (God View)',
    description:
      'Tenant counts by vertical/status/plan, user totals, 30-day growth.',
  })
  @ApiResponse({ status: 200, description: 'Stats retrieved' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  async stats(@Request() req: AuthenticatedRequest) {
    // Left under the operator's own tenant, deliberately: this aggregates
    // across every tenant on the platform, so there is no single target
    // tenant to attribute the audit row to instead. Do not "fix" this to a
    // specific tenant id — there isn't one.
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      'Platform stats (God View)',
      () => this.tenantProvisioningService.getPlatformStats(),
    );
  }

  @Post('config-packs/reload')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Reload config packs from disk (God View)',
    description:
      'Runs the same load pass as application boot and returns a per-pack ' +
      'report: file version, the version read back from the database after ' +
      'writing, whether the two match, and the section keys actually ' +
      'persisted. The operator-facing twin of POST /jobs/packs/reload, which ' +
      'needs CRON_SECRET — a human publishing a pack should not need the ' +
      'machine credential. Idempotent: it only reads files shipped with the ' +
      'deployment and never downgrades a stored version.',
  })
  @ApiResponse({ status: 200, description: 'Load report' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin' })
  async reloadConfigPacks(@Request() req: AuthenticatedRequest) {
    // runAsGod, like every other route here: `config_packs` is platform-global,
    // so this writes rows every tenant then reads, and that belongs in the
    // CRITICAL audit trail rather than happening quietly. Left under the
    // operator's own tenant for the same reason as `stats` above — a pack
    // reload touches every tenant on the platform, not one.
    return this.tenancyService.runAsGod(
      req.user.id,
      req.user.tenantId,
      'Reload config packs from disk (God View)',
      () => this.configPackLoader.reload(),
    );
  }

  @Post('users/:id/unlock')
  @HttpCode(HttpStatus.OK)
  // NoImpersonationGuard after the JWT guard (it reads req.user): an
  // impersonation session's runAsGod row would name the impersonated user.
  @UseGuards(AuthGuard('jwt'), PolicyGuard, NoImpersonationGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: "Lift a user's sign-in lock (God View)",
    description:
      'Writes the CRITICAL god-mode entry against the user\'s own tenant, ' +
      'then one `auth.login.unlocked` audit row carrying `unlockedAt`. ' +
      'Password AND MFA failures at or before that instant stop counting, ' +
      'for every source, which also lifts the MFA hard cap (10 failures per ' +
      'account per 24 h; a password reset lifts it too). `reason` is ' +
      'required and is written verbatim.',
  })
  @ApiParam({ name: 'id', description: 'User id' })
  @ApiResponse({ status: 200, description: 'Unlocked' })
  @ApiResponse({ status: 403, description: 'Requires platform_admin; refused to an impersonation session' })
  @ApiResponse({ status: 404, description: 'No such user' })
  @ApiResponse({ status: 503, description: 'Audit log unavailable — nothing was unlocked' })
  async unlockUser(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnlockUserDto,
  ) {
    // Bootstrap read under runAsSystem: the user's tenant is what it finds.
    // Nothing is written for an id that does not exist.
    const account = await this.attempts.findAccountById(id);
    if (!account) throw new NotFoundException('User not found');

    // Tenant scope: the ACCOUNT's tenant, resolved server-side, so the firm
    // sees the override in its own audit log (as for impersonation). The
    // CRITICAL row is written before the unlock and rethrows if it cannot be.
    await this.tenancyService.runAsGod(
      req.user.id,
      account.tenantId,
      `Unlock sign-in for user ${account.id} — ${dto.reason} (God View)`,
      () =>
        this.attempts.unlock(
          account,
          { id: req.user.id, tenantId: req.user.tenantId, email: req.user.email },
          dto.reason,
        ),
    );
    return { userId: account.id, unlocked: true };
  }
}
