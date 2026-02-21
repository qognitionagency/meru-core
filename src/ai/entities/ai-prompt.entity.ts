import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

export enum PromptCategory {
  ENTITY_ANALYSIS = 'entity_analysis',
  DOCUMENT_PROCESSING = 'document_processing',
  WORKFLOW_DECISION = 'workflow_decision',
  DATA_EXTRACTION = 'data_extraction',
  VALIDATION = 'validation',
}

export enum ModelProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  LOCAL = 'local',
}

@Entity('ai_prompts')
@Index(['tenantId', 'category'])
export class AiPrompt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column({ type: 'enum', enum: PromptCategory })
  category: PromptCategory;

  @Column({ unique: true })
  key: string;

  @Column({ type: 'text' })
  prompt: string;

  @Column({ type: 'enum', enum: ModelProvider })
  preferredProvider: ModelProvider;

  @Column({ type: 'jsonb', default: {} })
  modelConfig: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}

@Entity('ai_embeddings')
@Index(['tenantId', 'vectorId'])
export class AiEmbedding {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column({ nullable: true })
  vertical: string;

  @Column({ nullable: true })
  environment: string;

  @Column()
  vectorId: string;

  @Column({ type: 'enum', enum: ['entity', 'document', 'knowledge_base'] })
  type: string;

  @Column()
  resourceId: string;

  @Column({ type: 'jsonb' })
  vector: number[];

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;
}
