import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsInt,
  IsBoolean,
  IsIn,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DocumentType,
  DocumentStatus,
  DocumentEncryption,
} from '../entities/document.entity';
import { Transform, Type } from 'class-transformer';

/**
 * The only `sortBy` values `GET /documents` accepts, each naming the entity
 * property it orders by. `DocumentsService.findAll` maps through this table
 * and never writes caller input into ORDER BY: TypeORM does not quote or
 * check an `orderBy` column string, so an unchecked `sortBy` was SQL
 * injection for any logged-in role (Anton, 2026-11-17, #1).
 */
export const DOCUMENT_SORT_COLUMNS = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  name: 'name',
  originalFileName: 'originalFileName',
  fileSize: 'fileSize',
  fileType: 'fileType',
  status: 'status',
  reviewStatus: 'reviewStatus',
  versionNumber: 'versionNumber',
} as const;

export type DocumentSortField = keyof typeof DOCUMENT_SORT_COLUMNS;

/** Either case is accepted; the service normalises to upper. */
export const SORT_ORDERS = ['ASC', 'DESC', 'asc', 'desc'] as const;

export class SearchDocumentsDto {
  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({
    enum: DocumentType,
    isArray: true,
    description: 'Filter by file types',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(DocumentType, { each: true })
  fileTypes?: DocumentType[];

  @ApiPropertyOptional({
    enum: DocumentStatus,
    description: 'Filter by status',
  })
  @IsOptional()
  @IsEnum(DocumentStatus)
  status?: DocumentStatus;

  @ApiPropertyOptional({
    enum: DocumentEncryption,
    description: 'Filter by encryption',
  })
  @IsOptional()
  @IsEnum(DocumentEncryption)
  encryption?: DocumentEncryption;

  @ApiPropertyOptional({ description: 'Filter by linked entity type' })
  @IsOptional()
  @IsString()
  linkedEntityType?: string;

  @ApiPropertyOptional({ description: 'Filter by linked entity ID' })
  @IsOptional()
  @IsString()
  linkedEntityId?: string;

  @ApiPropertyOptional({ type: [String], description: 'Filter by tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /**
   * Read from the raw query value. Under the global pipe's implicit
   * conversion `Boolean('false')` is `true`, so `?includeAI=false` used to
   * switch the AI search on. Anything other than a boolean or the words
   * `true`/`false` is passed through for `@IsBoolean` to reject.
   */
  @ApiPropertyOptional({ description: 'Search in AI analysis results' })
  @IsOptional()
  @Transform(({ obj, key }) => {
    const raw = obj[key];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  })
  @IsBoolean()
  includeAI?: boolean;

  @ApiPropertyOptional({ description: 'Page number', minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({
    description: 'Items per page',
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Sort field',
    enum: Object.keys(DOCUMENT_SORT_COLUMNS),
  })
  @IsOptional()
  @IsIn(Object.keys(DOCUMENT_SORT_COLUMNS))
  sortBy?: DocumentSortField;

  @ApiPropertyOptional({ description: 'Sort direction', enum: SORT_ORDERS })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder?: 'ASC' | 'DESC' | 'asc' | 'desc';
}
