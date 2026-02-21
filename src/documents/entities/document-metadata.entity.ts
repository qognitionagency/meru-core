import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Document } from './document.entity';
import { DocumentVersion } from './document-version.entity';

export enum MetadataType {
  EXIF = 'exif',
  OCR = 'ocr',
  FORM_DATA = 'form_data',
  CUSTOM = 'custom',
  AI_EXTRACTION = 'ai_extraction',
}

@Entity('document_metadata')
@Index(['documentId', 'type'])
@Index(['documentVersionId'])
export class DocumentMetadata {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  documentId: string;

  @ManyToOne(() => Document, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'documentId' })
  document: Document;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ nullable: true })
  documentVersionId: string;

  @ManyToOne(() => DocumentVersion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'documentVersionId' })
  documentVersion: DocumentVersion;

  @Column({ type: 'enum', enum: MetadataType })
  type: MetadataType;

  @Column({ type: 'jsonb', default: {} })
  data: Record<string, any>;

  @Column({ type: 'jsonb', default: {} })
  extractedBy: {
    type: 'ai' | 'manual' | 'system';
    model?: string;
    version?: string;
    confidence?: number;
  };

  @CreateDateColumn()
  createdAt: Date;
}
