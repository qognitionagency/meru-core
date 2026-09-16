import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body for `POST /tenants/:tenantId/admin-invite/resend` — platform_admin
 * only, the operator recovery path when a provisioning invite is lost or
 * expired and the operator is not a member of the tenant they created (so
 * `POST /iam/users/:id/resend-invite`, scoped to the caller's own tenant, is
 * unreachable — see `TenantProvisioningService.provisionTenant`'s `inviteUrl`
 * comment).
 *
 * `userId` disambiguates when a tenant has more than one still-`invited`
 * firm admin; omit it when there is exactly one.
 */
export class ResendAdminInviteDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The invited firm admin to re-send. Required only when the tenant has ' +
      'more than one pending firm-admin invite.',
  })
  @IsOptional()
  @IsUUID()
  userId?: string;
}
