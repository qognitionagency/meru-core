import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantPlan, VerticalType } from '../entities/tenant.entity';

/**
 * Body of `POST /tenants/invitations` — platform_admin only.
 *
 * `allowedSlug`/`allowedVertical`/`allowedPlan` are optional pins: leave one
 * unset and the signer chooses it at redemption; set it and redemption must
 * agree or is refused (DEF-1).
 */
export class MintTenantSignupInviteDto {
  @ApiProperty({
    example: 'owner@newfirm.example',
    description: 'The only address that can redeem this invite.',
  })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: 'newfirm' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message:
      'allowedSlug must be lowercase alphanumeric with single hyphens between segments',
  })
  allowedSlug?: string;

  @ApiPropertyOptional({ enum: VerticalType })
  @IsOptional()
  @IsEnum(VerticalType)
  allowedVertical?: VerticalType;

  @ApiPropertyOptional({ enum: TenantPlan })
  @IsOptional()
  @IsEnum(TenantPlan)
  allowedPlan?: TenantPlan;
}
