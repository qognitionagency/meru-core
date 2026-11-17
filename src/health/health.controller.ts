import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Public } from '../iam/decorators/public.decorator';
import { Roles } from '../iam/decorators/roles.decorator';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { CapabilitiesService } from './capabilities.service';

@Controller('health')
@ApiTags('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly capabilities: CapabilitiesService
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness + readiness probe (checks DB)' })
  @ApiResponse({ status: 200, description: 'Service healthy' })
  @ApiResponse({ status: 503, description: 'Service unhealthy' })
  async check() {
    let database = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      service: 'meru-core',
      vertical: process.env.VERTICAL || 'core',
      database,
      // Counts only. This route is public, so naming which credentials are
      // absent would hand an unauthenticated caller a reconnaissance list.
      capabilities: await this.capabilities.summary(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: 503 when the database cannot answer `SELECT 1`.
   *
   * `GET /health` above answers **200 with `database: "down"`**, so a platform
   * health check pointed at it cannot see a dead database (render.yaml, and
   * docs/runbooks/render-deploy.md §8). It is left as it is on purpose. Per
   * render.com/docs/health-checks (as recorded in that runbook), Render stops
   * routing to an instance after 15 s of failed checks and **restarts it after
   * 60 s** — so pointing the blueprint here means a database outage longer than
   * a minute restarts the API, and a restart does not fix a database. What it
   * buys: a deploy that boots but cannot query is refused instead of marked
   * live, and traffic stops reaching an instance that can only answer 500s.
   * Which of those the blueprint wants is the blueprint owner's call; this
   * route exists so it can make it.
   *
   * Public, like `/health`, and says less: no capabilities, no uptime, no
   * tenant data, and never the driver's error, which can name the database
   * host. The failure is logged server-side instead.
   *
   * Tenancy: none. `SELECT 1` reads no table; an anonymous request binds no
   * tenant, so `applyRlsToDataSource` sets an empty `app.current_tenant_id`
   * on the connection and every tenant-scoped policy would match nothing.
   *
   * `[UNVERIFIED: behaviour when the pool is exhausted rather than the database
   * down — the query waits for a connection and the platform's own probe
   * timeout decides. Not observed.]`
   */
  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness probe: 503 when the database is unreachable' })
  @ApiResponse({ status: 200, description: 'Database answered SELECT 1' })
  @ApiResponse({ status: 503, description: 'Database unreachable' })
  async ready(): Promise<{ status: 'ready'; database: 'up' }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch (error) {
      this.logger.error(
        `Readiness: database unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('Database unreachable');
    }
    return { status: 'ready', database: 'up' };
  }

  /**
   * Which credentials are missing, and what each one breaks.
   *
   * platform_admin only, and guarded with a PlatformRole member rather than a
   * string — `@Roles('admin')` is a role no user holds, which makes a route
   * unreachable rather than protected. That mistake has been made twice here.
   *
   * The third mistake was subtler: `@Roles` sat here with nothing that reads
   * it. `GlobalAuthGuard` (APP_GUARD) authenticates every non-`@Public` route
   * and fills `request.user`, but role checks are `PolicyGuard`'s job and this
   * controller applied it nowhere — so the restriction was inert and any
   * authenticated caller of any role, `client` included, got the report.
   *
   * Fixed with the guard, per ADR 0007 D4.
   *
   * An earlier pass checked the role inline instead, on the assumption that
   * `@UseGuards(PolicyGuard)` would need `HealthModule` to import `IamModule`
   * and risk a wiring fault that only shows at runtime. That assumption was
   * wrong: `PolicyGuard`'s three dependencies are all globally available —
   * `Reflector` and `DataSource` inherently, and `VerticalPolicyService`
   * through `CoreModule`, which is `@Global()`. `TasksModule` proves it
   * empirically, using this guard while importing neither.
   *
   * Class-level rather than method-level is still not an option: `GET /health`
   * above is `@Public()` and must stay anonymous, and `PolicyGuard` throws
   * when there is no user.
   */
  @Get('capabilities')
  @UseGuards(PolicyGuard)
  @Roles(PlatformRole.PLATFORM_ADMIN)
  @ApiOperation({ summary: 'Per-capability configuration report' })
  @ApiResponse({ status: 200, description: 'Capability report' })
  @ApiResponse({ status: 403, description: 'Not a platform admin' })
  async capabilityReport() {
    return {
      capabilities: await this.capabilities.report(),
      summary: await this.capabilities.summary(),
    };
  }
}
