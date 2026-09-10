import { IsOptional, IsString, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestChecklistDocumentsDto {
  @ApiProperty({
    description:
      'The record the documents are being requested against — the case or ' +
      'matter whose checklist is outstanding.',
  })
  @IsUUID()
  entityId: string;

  @ApiPropertyOptional({
    description:
      "A messaging template key from the tenant's config pack (see GET " +
      '/notifications/templates) — the immigration pack ships ' +
      '`document_request`. Omit to record the request without sending ' +
      'anything from here; the response reports which happened.\n\n' +
      'There is deliberately no free-text field: an automated client-facing ' +
      'message is only ever wording a pack author wrote and a practitioner ' +
      'can review, never prose this API composed.',
  })
  @IsOptional()
  @IsString()
  templateKey?: string;
}
