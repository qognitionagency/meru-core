import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Why an operator is lifting a sign-in lock on somebody else's account.
 *
 * Required for the same reason as `ImpersonateDto.reason`: the audit row is
 * the only record of why a security control was overridden, and "unlocked"
 * answers nothing when the lock turns out to have been stopping a real
 * attacker. MinLength stops a reflexive "-".
 */
export class UnlockUserDto {
  @ApiProperty({
    description: 'Why the lock is being lifted. Written to the audit log.',
    example: 'Ticket MER-4903 — account holder verified by phone',
    minLength: 10,
    maxLength: 300,
  })
  @IsString()
  @MinLength(10, {
    message:
      'reason must be at least 10 characters — it is the audit record for ' +
      'overriding a sign-in lock',
  })
  @MaxLength(300)
  reason: string;
}
