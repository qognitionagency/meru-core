import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '../entities/universal-entity.entity';
import { CreateEntityInput } from '../../common/types';

export class CreateEntityDto implements CreateEntityInput {
  @ApiProperty({
    enum: EntityType,
    description: 'Type of the entity',
    example: EntityType.PERSON,
  })
  @IsEnum(EntityType)
  type: EntityType;

  @ApiPropertyOptional({
    description: 'First name of the entity',
    example: 'John',
  })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({
    description: 'Last name of the entity',
    example: 'Doe',
  })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({
    description: 'Email address',
    example: 'john.doe@example.com',
  })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({
    description: 'Phone number',
    example: '+1234567890',
  })
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @ApiPropertyOptional({
    description: 'Vertical-specific attributes',
    type: 'object',
    additionalProperties: true,
    example: { customField: 'value' },
  })
  @IsOptional()
  verticalAttributes?: Record<string, any>;
}
