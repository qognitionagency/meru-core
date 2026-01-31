import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../entities/tenant.entity';

declare global {
  namespace Express {
    interface Request {
      meruTenant?: Tenant;
    }
  }
}

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // Skip for public health checks or auth
    if (req.path.includes('health') || req.path.includes('register')) return next();

    // Identify Tenant via Subdomain (e.g., fintech.meru.com -> fintech)
    const host = req.headers.host;
    // In local dev, host might be localhost:3000. We handle that.
    // In prod, we expect subdomain.domain.tld
    const parts = host ? host.split('.') : [];
    
    // Logic: If localhost, assume default or query param. If domain, use subdomain.
    let subdomain = 'default';
    if (host && !host.includes('localhost')) {
      subdomain = parts[0];
    } else if (req.query.tenant) {
      subdomain = req.query.tenant as string; // For local testing via query param
    }

    if (subdomain === 'default') return next(); // No tenant context needed

    const tenant = await this.tenantRepo.findOne({ where: { slug: subdomain } });
    if (tenant) {
      req.meruTenant = tenant;
    }

    next();
  }
}