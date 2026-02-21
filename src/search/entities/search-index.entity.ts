import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

export enum SearchableType {
  ENTITY = 'entity',
  DOCUMENT = 'document',
  NOTE = 'note',
  EMAIL = 'email',
}

@Entity('search_index')
@Index(['tenantId', 'searchableId', 'searchableType'])
@Index(['tenantId', 'searchableType'])
export class SearchIndex {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ type: 'enum', enum: SearchableType })
  searchableType: SearchableType;

  @Column()
  searchableId: string;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'tsvector', nullable: true })
  vector: string;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}
