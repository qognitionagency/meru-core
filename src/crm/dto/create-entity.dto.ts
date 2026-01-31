import { IsString, IsOptional, IsEnum } from 'class-validator';
import { EntityType } from '../entities/universal-entity.entity';
import { CreateEntityInput } from '../../common/types';

export class CreateEntityDto implements CreateEntityInput {
  @IsEnum(EntityType)
  type: EntityType;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  verticalAttributes?: Record<string, any>;
}
