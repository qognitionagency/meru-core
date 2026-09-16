import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from '../../iam/entities/tenant.entity';
import { User } from '../../iam/entities/user.entity';
import { DocumentVersion } from './document-version.entity';

export enum DocumentStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

export enum DocumentEncryption {
  NONE = 'none',
  STANDARD = 'standard',
  HIGH = 'high',
}

export enum DocumentType {
  PDF = 'pdf',
  JPG = 'jpg',
  JPEG = 'jpeg',
  PNG = 'png',
  DOCX = 'docx',
  XLSX = 'xlsx',
  TXT = 'txt',
}

/**
 * ADR 0025 — orthogonal to {@link DocumentStatus}. `DocumentStatus` answers
 * "does this object still exist" (storage lifecycle); this answers "has
 * anyone looked at it and what did they decide". A `rejected` document is
 * still `status: active` — it exists, it is simply not accepted.
 *
 * A `varchar` + `CHECK` column, not a TypeORM `enum` — see the migration's
 * comment. Not a real TypeScript enum for the same reason: a Postgres
 * `ENUM` type cannot gain or lose a value without a migration that breaks
 * this repo's usual deploy discipline, so this is deliberately a plain
 * string-literal union.
 */
export type DocumentReviewStatus =
  | 'uploaded'
  | 'under_review'
  | 'approved'
  | 'rejected';

/** One entry in `Document.reviewHistory` — append-only, never edited. */
export interface DocumentReviewHistoryEntry {
  status: 'under_review' | 'approved' | 'rejected';
  byId: string;
  at: string; // ISO-8601
  /** Which `DocumentVersion` this decision applied to. */
  versionNumber: number;
  rejectionReasonKey?: string;
  rejectionReasonNote?: string;
}

@Entity('documents')
@Index(['tenantId', 'status'])
@Index(['tenantId', 'linkedEntityType', 'linkedEntityId'])
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @ManyToOne(() => Tenant, { eager: false })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ type: 'enum', enum: DocumentType })
  fileType: DocumentType;

  @Column()
  originalFileName: string;

  @Column()
  fileSize: number;

  @Column({ type: 'text', nullable: true })
  mimeType: string;

  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.ACTIVE,
  })
  status: DocumentStatus;

  @Column({
    type: 'enum',
    enum: DocumentEncryption,
    default: DocumentEncryption.NONE,
  })
  encryption: DocumentEncryption;

  @Column({
    type: 'enum',
    enum: DocumentEncryption,
    default: DocumentEncryption.NONE,
  })
  requiredEncryption: DocumentEncryption;

  @Column({ nullable: true })
  linkedEntityType: string;

  @Column({ nullable: true })
  linkedEntityId: string;

  @Column({ type: 'jsonb', default: [] })
  tags: string[];

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'jsonb', default: {} })
  aiAnalysis: {
    extractedData?: Record<string, any>;
    summary?: string;
    categories?: string[];
    riskLevel?: 'low' | 'medium' | 'high';
    analyzedAt?: Date;
  };

  @Column({ type: 'jsonb', default: {} })
  rbac: {
    owner: string;
    roles?: string[];
    permissions?: {
      read: string[];
      write: string[];
      delete: string[];
      share: string[];
    };
  };

  // ADR 0025 — review sub-state, orthogonal to `status` above. Default
  // `'uploaded'` is deliberate: every document that existed before this
  // migration reads as "nobody has reviewed this yet", which is honest —
  // rendering a default of `approved` would be the §5.2 failure (unknown
  // reported as a positive).
  @Column({ type: 'varchar', length: 20, default: 'uploaded' })
  reviewStatus: DocumentReviewStatus;

  @Column({ type: 'uuid', nullable: true })
  reviewedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  rejectionReasonKey: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionReasonNote: string | null;

  // No `ManyToOne` on `reviewedById`, deliberately — matches every other
  // actor-id-inside-a-jsonb-history field in this codebase
  // (`WorkflowInstance.history[].triggeredBy`, `AlertFiring`) rather than the
  // relational `uploadedById` pattern on this same table: it is written from
  // `actor.id` at decision time and never joined in a hot path.
  @Column({ type: 'jsonb', default: [] })
  reviewHistory: DocumentReviewHistoryEntry[];

  @Column({ type: 'int', default: 1 })
  versionNumber: number;

  @Column({ type: 'uuid', nullable: true })
  currentVersionId: string | null;

  @Column({ type: 'text', nullable: true })
  s3Url: string;

  @ManyToOne(() => User, { eager: false })
  @JoinColumn({ name: 'uploadedById' })
  uploadedBy: User;

  @Column({ name: 'uploadedById' })
  uploadedById: string;

  @OneToMany(() => DocumentVersion, (version) => version.document, {
    cascade: true,
  })
  versions: DocumentVersion[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt: Date;
}
