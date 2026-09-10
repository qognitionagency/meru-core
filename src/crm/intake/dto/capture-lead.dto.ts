import {
  IsBoolean,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The public website-capture body (FR-3.3 / FR-3.8).
 *
 * Every field is length-capped, and the global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so a body carrying anything not declared here is a
 * 400 rather than something the service has to sanitise. Custom form fields
 * have one declared home — `fields` — and it is capped too.
 */
export class CaptureLeadDto {
  @ApiProperty({
    description:
      'Given name. **Required**, with `email`, because ADR 0011 forbids core ' +
      'from deriving a name later: a producer that skips the promoted ' +
      '`firstName`/`lastName` columns is what produced "Unnamed client". A ' +
      'form collecting one "Full name" box must split it before posting — ' +
      'core will not guess where the split goes.',
    example: 'Layla',
  })
  @IsString()
  @MaxLength(200)
  firstName: string;

  @ApiPropertyOptional({ example: 'Rashid' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  lastName?: string;

  @ApiProperty({
    description:
      'Required: it is the only field that lets the firm reply, and it is the ' +
      'key this endpoint matches an existing record on.',
    example: 'layla@example.com',
  })
  @IsEmail()
  @MaxLength(320)
  email: string;

  @ApiPropertyOptional({ example: '+61400000000' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phoneNumber?: string;

  @ApiPropertyOptional({
    description: 'The enquiry itself, as typed.',
    example: 'I am on a 485 expiring in March and would like to discuss a 189.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  message?: string;

  // ── Source tracking (FR-3.8) ─────────────────────────────────────────────
  //
  // All optional, and an absent one is recorded as absent. Nothing here is
  // defaulted: a lead whose channel was not sent has an unknown channel, and
  // "website" would be a guess that later reads as a measurement.

  @ApiPropertyOptional({
    description:
      'How the enquiry arrived — `website`, `referral`, `event`. Ignored if ' +
      'the capture key pins a channel.',
    example: 'website',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  channel?: string;

  @ApiPropertyOptional({ example: 'au-skilled-migration-q3' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  campaign?: string;

  @ApiPropertyOptional({
    description: 'Where the visitor came from, as the page saw it.',
    example: 'https://www.google.com/',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  @ApiPropertyOptional({ example: 'https://example-migration.com.au/189-visa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  landingPage?: string;

  @ApiPropertyOptional({
    description:
      'Referring partner. Ignored if the capture key pins one — a partner ' +
      'posting through their own key cannot attribute the lead elsewhere.',
    example: 'alpha-education-agents',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  partner?: string;

  @ApiPropertyOptional({
    description:
      'Whether the person agreed to be contacted. Recorded exactly as sent ' +
      'and **never defaulted** — an absent value means the form did not ask, ' +
      'which is not the same as consent.',
  })
  @IsOptional()
  @IsBoolean()
  consent?: boolean;

  @ApiPropertyOptional({
    description: 'The exact wording the person agreed to, if any.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  consentText?: string;

  @ApiPropertyOptional({
    description:
      "The firm's own form fields — visa of interest, country, budget. Flat " +
      'string values only; at most 20 keys, keys ≤64 and values ≤2000 ' +
      'characters. Stored verbatim under `verticalAttributes.intakeFields`.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { visaOfInterest: 'Subclass 189', country: 'Australia' },
  })
  @IsOptional()
  @IsObject()
  fields?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Honeypot. Render it hidden and leave it empty; a bot that fills every ' +
      'input gets a 400 and the attempt is recorded as `rejected_honeypot`. ' +
      '**It answers 400 rather than a polite 200 on purpose**: a browser ' +
      'autofilling a hidden field is a real failure mode, and a silent drop ' +
      'would show the visitor a thank-you page for an enquiry nobody received.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  trap?: string;

  @ApiPropertyOptional({
    description:
      'The capture key, for callers that cannot set a header — a plain HTML ' +
      '`<form>` post. Prefer the `X-Meru-Intake-Key` header: a key in a body ' +
      'is a key in page source. Either way it is stripped before storage and ' +
      'never written to a lead, a submission or a log.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  key?: string;
}
