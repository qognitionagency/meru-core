import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * `POST /documents/:id/review/decision` (ADR 0025 D3).
 *
 * Cross-field validation — `rejectionReasonKey` required when
 * `decision === 'reject'`, and must be a member of the tenant's resolved
 * `compliance.documentReview.rejectionReasons[]` — is deliberately NOT here.
 * A `class-validator` decorator cannot know the tenant's pack vocabulary at
 * decoration time, so that check lives in `DocumentsService.decideReview`,
 * mirroring `IamService.grantPracticeRoles`'s "name the invalid key and the
 * pack code/version" error shape.
 */
export class ReviewDecisionDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @ApiPropertyOptional({
    description:
      'A key from compliance.documentReview.rejectionReasons[]. Required ' +
      "when decision === 'reject'; ignored otherwise.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  rejectionReasonKey?: string;

  @ApiPropertyOptional({
    description: 'Free text alongside the reason key — never instead of it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  rejectionReasonNote?: string;
}
