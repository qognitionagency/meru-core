import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { IamController } from './iam.controller';
import { IamService } from './iam.service';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { SamlStrategy } from './strategies/saml.strategy';
import { PolicyGuard } from './guards/policy.guard';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';
import { VerticalPolicyService } from '../core/verticals/vertical-policy.service';

@Module({
  imports: [
    CacheModule.register(),
    TypeOrmModule.forFeature([User, Tenant]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('jwt.secret') || 'default-secret',
        signOptions: { expiresIn: configService.get('jwt.expiresIn') || '1h' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [IamController],
  providers: [
    IamService, 
    JwtStrategy, 
    SamlStrategy, 
    PolicyGuard,
    VerticalPolicyService
  ],
})
export class IamModule {
  configure(consumer: any) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}