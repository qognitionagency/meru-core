import {
  IsDateString,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus, EntityType } from '../entities/universal-entity.entity';

/**
 * Partial update for a CRM entity.
 *
 * There is no `tenantId` here and there never should be: the tenant is taken
 * from the caller's JWT, so this route cannot be used to move a record between
 * tenants.
 *
 * `type` is deliberately absent too, but it is not immutable — changing it
 * silently would reinterpret every field a vertical pack reads off the record,
 * so it is an explicit action instead: `POST /crm/entities/:id/convert`. That
 * route keeps the id, and therefore the comments, documents, tasks and payments
 * already filed against it.
 *
 * `verticalAttributes` is **deep**-merged: send only the branch that changed and
 * nested siblings survive. Send `null` for a key to remove it.
 */
export class UpdateEntityDto {
  @ApiPropertyOptional({ example: 'Layla' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  firstName?: string;

  @ApiPropertyOptional({
    description:
      'Email of the person this record is ABOUT. Setting it is what makes ' +
      'the record visible to that person in the client portal; clearing it ' +
      'hides the record from them.',
    example: 'applicant@example.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  subjectEmail?: string;

  @ApiPropertyOptional({ example: 'Rashid' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  lastName?: string;

  @ApiPropertyOptional({ example: 'layla@acme-bank.ae' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: '+971500000000' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phoneNumber?: string;

  @ApiPropertyOptional({
    enum: EntityStatus,
    description:
      'Generic lifecycle state. A vertical maps its own vocabulary onto these ' +
      'in its config pack — core does not know about GRC or immigration stages.',
  })
  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;

  @ApiPropertyOptional({ example: '2026-09-30T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'users.id of the owner. Send null to unassign.',
  })
  @IsOptional()
  @IsUUID()
  assignedTo?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Merged into the existing bag, not replaced — a partial update must not ' +
      'silently drop attributes the caller did not send.',
  })
  @IsOptional()
  @IsObject()
  verticalAttributes?: Record<string, any>;
}

/** Filters for `GET /crm/entities`. */
export class ListEntitiesQueryDto {
  @ApiPropertyOptional({
    enum: EntityType,
    description: 'e.g. `obligation`, `breach`, `case`.',
  })
  @IsOptional()
  @IsEnum(EntityType)
  type?: EntityType;

  @ApiPropertyOptional({ enum: EntityStatus })
  @IsOptional()
  @IsEnum(EntityStatus)
  status?: EntityStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({
    description:
      'Filter to records ABOUT this person. A `client`-role caller has this ' +
      'forced to their own address by the controller and cannot widen it.',
    example: 'applicant@example.com',
  })
  @IsOptional()
  @IsString()
  subjectEmail?: string;

  @ApiPropertyOptional({
    description: 'Only records due on or after this instant.',
    example: '2026-07-01',
  })
  @IsOptional()
  @IsDateString()
  dueBefore?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsDateString()
  dueAfter?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description:
      'FR-5.10. `true` adds an `aging` object to every row — days in the ' +
      'current stage and days since the last recorded client contact. Both ' +
      'are `null` with a stated reason when unknown; **neither is ever 0 ' +
      'because nothing was found**. Off by default so no existing consumer’s ' +
      'payload changes, and because it costs one extra query per page.',
    enum: ['true', 'false'],
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  withAging?: string;
}

/**
 * Body for `POST /crm/entities/:id/convert`.
 *
 * One field on purpose. A conversion that also edited fields would make the
 * audit entry ambiguous about what actually changed.
 */
export class ConvertEntityDto {
  @ApiProperty({
    enum: EntityType,
    description:
      'The type the record becomes. Permitted transitions are constrained: a ' +
      '`lead` may become a `person` or an `organization`, and a `person` and ' +
      '`organization` may swap. Anything else is a 400 naming what is allowed.',
    example: EntityType.PERSON,
  })
  @IsEnum(EntityType)
  toType: EntityType;
}
