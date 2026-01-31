import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { VerticalPolicyService } from '../../core/verticals/vertical-policy.service';
import { User } from '../entities/user.entity';
import { Tenant } from '../entities/tenant.entity';

@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private verticalPolicyService: VerticalPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as User;

    if (!user) throw new ForbiddenException('Unauthorized');

    // Assume request contains full user object (eager loaded in strategy or via decorator)
    // For this demo, we use the minimal JWT payload if tenant isn't attached.
    // In a real app, attach full tenant object to request in middleware.

    // Mocking tenant lookup for this specific snippet to ensure code works without DB eager load in JWT
    const tenant = request.user?.tenant || { vertical: 'fintech' };

    // 1. Load Vertical Policy (Cached)
    const policy = await this.verticalPolicyService.getPolicy(tenant.vertical);

    // 2. Role Check
    const requiredRoles = this.reflector.get<string[]>(
      'roles',
      context.getHandler(),
    );
    if (
      requiredRoles &&
      !requiredRoles.some((role) => user.roles.includes(role))
    ) {
      throw new ForbiddenException('Insufficient Role Privileges');
    }

    // 3. Context-Aware Checks
    // IP Whitelist
    if (policy.rules.ipWhitelist && policy.rules.ipWhitelist.length > 0) {
      const ip = request.ip;
      if (!policy.rules.ipWhitelist.includes(ip)) {
        throw new ForbiddenException(
          `Access Denied: IP ${ip} not whitelisted.`,
        );
      }
    }

    // Business Hours
    if (policy.rules.businessHours) {
      const hour = new Date().getHours();
      const { start, end } = policy.rules.businessHours;
      if (hour < start || hour >= end) {
        throw new ForbiddenException(
          `Access Denied: Outside business hours (${start}:00 - ${end}:00).`,
        );
      }
    }

    return true;
  }
}
