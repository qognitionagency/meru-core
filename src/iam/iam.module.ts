import { forwardRef, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { IamController } from './iam.controller';
import { UsersController } from './users.controller';
import { IamService } from './iam.service';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { Role } from './entities/role.entity';
import { Session } from './entities/session.entity';
import { ApiKey } from './entities/api-key.entity';
import { AuthToken } from './entities/auth-token.entity';
import { TenantConfigPin } from './entities/tenant-config-pin.entity';
import { TenantSignupInvite } from './entities/tenant-signup-invite.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';
import { PolicyGuard } from './guards/policy.guard';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';
import { CoreModule } from '../core/core.module';
import { TenantProvisioningService } from './tenant-provisioning.service';
import { TenantProvisioningController } from './tenant-provisioning.controller';
import { PlatformController } from './platform.controller';
import { TenantModule } from '../tenant/tenant.module';
import { TenantSetting } from '../tenant/entities/tenant-setting.entity';
import { AuditModule } from '../audit/audit.module';
import { SamlService } from './services/saml.service';
import { AuthAttemptLimiter } from './services/auth-attempt-limiter.service';
import { MfaAttemptLimitInterceptor } from './interceptors/mfa-attempt-limit.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Tenant,
      Role,
      Session,
      ApiKey,
      AuthToken,
      TenantConfigPin,
      TenantSignupInvite,
      TenantSetting,
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        // No literal fallback: see JwtStrategy's constructor.
        secret: configService.getOrThrow<string>('jwt.secret'),
        signOptions: { expiresIn: configService.get('jwt.expiresIn') || '1h' },
      }),
      inject: [ConfigService],
    }),
    CoreModule,
    AuditModule,
    // forwardRef: OperatorModule already wires IamModule and TenantModule
    // together, and TenantModule reaches Billing and Audit. A plain import here
    // is fine today but one edge away from a cycle, and a Nest cycle surfaces
    // as an undefined injected provider at runtime rather than a build error.
    forwardRef(() => TenantModule),
  ],
  controllers: [
    IamController,
    UsersController,
    TenantProvisioningController,
    PlatformController,
  ],
  providers: [
    IamService,
    JwtStrategy,
    LocalStrategy,
    PolicyGuard,
    TenantProvisioningService,
    SamlService,
    // Per-account attempt limits (Anton, 2026-11-17, #6). The interceptor is
    // global but acts only on IamController.verifyMfaLogin / disableMfa.
    AuthAttemptLimiter,
    { provide: APP_INTERCEPTOR, useClass: MfaAttemptLimitInterceptor },
  ],
  exports: [
    IamService,
    TenantProvisioningService,
    PolicyGuard,
    JwtStrategy,
    SamlService,
    JwtModule,
    // JobsModule's `auth-attempts-prune` (retention for auth_attempts).
    AuthAttemptLimiter,
  ],
})
export class IamModule {
  configure(consumer: any) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
