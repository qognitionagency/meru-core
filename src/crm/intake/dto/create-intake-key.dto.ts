import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateIntakeKeyDto {
  @ApiProperty({
    description: 'What the firm calls this key, so two can be told apart.',
    example: 'example-migration.com.au — contact form',
  })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({
    description:
      'Pin the attribution channel for every lead from this key. A pinned ' +
      'value overrides whatever the body sends.',
    example: 'website',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  defaultChannel?: string;

  @ApiPropertyOptional({
    description: 'Pin the referring partner for every lead from this key.',
    example: 'alpha-education-agents',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  defaultPartner?: string;

  @ApiPropertyOptional({
    description:
      'Submissions accepted per hour on this key, counted durably in Postgres ' +
      'so the limit holds across serverless instances. Default 60. Keep it ' +
      'near the real volume of the form: it is the ceiling on what a leaked ' +
      'key can cost.',
    default: 60,
    minimum: 1,
    maximum: 10000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxPerHour?: number;
}

export class UpdateIntakeKeyDto {
  @ApiPropertyOptional({ description: 'Revoke (false) or restore (true).' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxPerHour?: number;
}
