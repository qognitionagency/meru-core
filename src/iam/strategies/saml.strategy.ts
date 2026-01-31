import { Strategy } from 'passport-saml';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { AuthProvider } from '../enums/auth-provider.enum';
import { Tenant } from '../entities/tenant.entity';

@Injectable()
export class SamlStrategy extends PassportStrategy(Strategy, 'saml') {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Tenant) private tenantRepo: Repository<Tenant>,
  ) {
    // Note: In a real multi-tenant SAML flow, you must identify the tenant 
    // BEFORE hitting this strategy (usually via subdomain or query param).
    // The strategy options would then be dynamically loaded from the Tenant.ssoConfig.
    // Below is a simplified version expecting a default config in env or passed dynamically.
    
    super({
      entryPoint: process.env.SAML_ENTRY_POINT || 'https://mock-idp.com/sso',
      issuer: process.env.SAML_ISSUER || 'meru-core',
      cert: process.env.SAML_CERT || '',
      callbackUrl: process.env.SAML_CALLBACK_URL || 'http://localhost:3000/auth/saml/callback',
    });
  }

  async validate(profile: any): Promise<any> {
    // Extract Tenant ID from NameID or Attributes (Custom SAML mapping)
    const email = profile.nameID;
    const tenantSlug = profile?.attributes?.['http://schemas.meru.com/identity/tenant'];

    if (!tenantSlug) throw new UnauthorizedException('SAML missing tenant context');

    // Lookup Tenant
    const tenant = await this.tenantRepo.findOne({ where: { slug: tenantSlug } });
    if (!tenant) throw new UnauthorizedException('Invalid Tenant');

    // Just-In-Time (JIT) Provisioning
    let user = await this.userRepo.findOne({ where: { email, tenantId: tenant.id } });
    
    if (!user) {
      user = this.userRepo.create({
        email,
        tenantId: tenant.id,
        provider: AuthProvider.SAML,
        password: '', // SAML users don't have local passwords
        roles: ['user'], // Default role
      });
      await this.userRepo.save(user);
    }

    // Attach tenant for downstream usage
    user.tenant = tenant;
    return user;
  }
}