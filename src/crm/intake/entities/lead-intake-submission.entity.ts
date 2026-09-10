import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * What a submission was allowed to become.
 *
 * Every one of these is recorded, including the refusals. A firm that cannot
 * see how much spam its form is taking has no way to judge whether the limits
 * are set right, and an enquiry that was held rather than converted must not
 * simply vanish — `duplicate` in particular is a real enquiry from a real
 * person that staff still have to answer.
 */
export type LeadIntakeSubmissionStatus =
  /** A `lead` record was created; `leadId` names it. */
  | 'accepted'
  /**
   * The email already belongs to a record in this tenant, so no new record was
   * created — `CrmService.createEntity` refuses a duplicate email tenant-wide
   * (`crm.service.ts`), and a second record for one person is worse than a
   * held enquiry anyway. `matchedEntityId` names the existing record.
   */
  | 'duplicate'
  /** The honeypot field arrived non-empty. Nothing was created. */
  | 'rejected_honeypot';

@Entity('lead_intake_submissions')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'keyId'])
export class LeadIntakeSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid' })
  keyId: string;

  @Column({ type: 'varchar', length: 30 })
  status: LeadIntakeSubmissionStatus;

  /** The `universal_entities.id` created from this submission, when one was. */
  @Column({ type: 'uuid', nullable: true })
  leadId: string | null;

  /** The existing record this submission matched, on `duplicate`. */
  @Column({ type: 'uuid', nullable: true })
  matchedEntityId: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  firstName: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  lastName: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phoneNumber: string | null;

  // ── Source tracking, FR-3.8 ──────────────────────────────────────────────
  //
  // Five nullable columns rather than one jsonb blob, because these are the
  // five the requirement names and a firm reports on them. **Null means the
  // submission did not carry one.** Nothing here is ever defaulted or
  // inferred: a form that does not send `channel` produces a lead whose
  // channel is unknown, not one whose channel is "website".

  @Column({ type: 'varchar', length: 60, nullable: true })
  channel: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  campaign: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  referrer: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  landingPage: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  partner: string | null;

  /**
   * Everything the form sent that is not a column: the free-text message, the
   * firm's own custom fields, and the consent flag if one was supplied.
   *
   * The raw submission is kept because the lead record is a *derived* view of
   * it. If the mapping is later found to be wrong, this is what the correction
   * is re-derived from — and where a consent question was answered is worth
   * more as the exact bytes than as an interpretation of them.
   */
  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceIp: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  /** `Origin` / `Referer` of the posting page, when the caller sent one. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceOrigin: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
