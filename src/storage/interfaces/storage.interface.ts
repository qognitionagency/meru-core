export enum StorageProvider {
  S3 = 's3',
  AZURE = 'azure',
  GCS = 'gcs',
  LOCAL = 'local',
}

export enum StorageClass {
  STANDARD = 'standard',
  INFREQUENT = 'infrequent',
  ARCHIVE = 'archive',
  GLACIER = 'glacier',
}

export enum FileStatus {
  UPLOADING = 'uploading',
  ACTIVE = 'active',
  PROCESSING = 'processing',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
}

export enum FileAccess {
  PUBLIC = 'public',
  PRIVATE = 'private',
  RESTRICTED = 'restricted',
}

export interface StorageFile {
  id: string;
  tenantId: string;
  provider: StorageProvider;
  bucket: string;
  key: string;
  originalName: string;
  mimeType: string;
  size: number;
  checksum: string;
  status: FileStatus;
  storageClass: StorageClass;
  access: FileAccess;
  metadata: Record<string, any>;
  tags: string[];
  encryption?: {
    algorithm: string;
    keyId?: string;
  };
  versions: FileVersion[];
  currentVersionId: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  lastAccessedAt?: Date;
  accessCount: number;
}

export interface FileVersion {
  id: string;
  fileId: string;
  versionNumber: number;
  size: number;
  checksum: string;
  key: string;
  createdAt: Date;
  createdById: string;
  changeDescription?: string;
  isCurrent: boolean;
}

export interface UploadOptions {
  tenantId: string;
  fileName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  metadata?: Record<string, any>;
  tags?: string[];
  storageClass?: StorageClass;
  access?: FileAccess;
  expiresInDays?: number;
  encrypt?: boolean;
  folder?: string;
  userId: string;
}

export interface DownloadOptions {
  fileId: string;
  versionId?: string;
  tenantId: string;
  userId?: string;
}

export interface StorageProviderConfig {
  provider: StorageProvider;
  region?: string;
  bucket: string;
  credentials: {
    accessKeyId?: string;
    secretAccessKey?: string;
    connectionString?: string;
    projectId?: string;
    keyFilename?: string;
  };
  options?: {
    endpoint?: string;
    forcePathStyle?: boolean;
    sslEnabled?: boolean;
  };
}

export interface PresignedUrlOptions {
  fileId: string;
  versionId?: string;
  expiresInSeconds?: number;
  responseDisposition?: 'inline' | 'attachment';
  responseContentType?: string;
}

export interface MultipartUpload {
  uploadId: string;
  fileId: string;
  parts: MultipartPart[];
  partSize: number;
  totalParts: number;
  completedParts: number;
  status: 'pending' | 'in_progress' | 'completed' | 'aborted';
  createdAt: Date;
  expiresAt: Date;
}

export interface MultipartPart {
  partNumber: number;
  etag?: string;
  size: number;
  status: 'pending' | 'uploaded';
}

export interface StorageMetrics {
  totalFiles: number;
  totalSize: number;
  storageByClass: Record<StorageClass, { count: number; size: number }>;
  accessPatterns: {
    date: string;
    downloads: number;
    uploads: number;
  }[];
}

export interface FileSearchFilters {
  tenantId: string;
  query?: string;
  mimeTypes?: string[];
  tags?: string[];
  status?: FileStatus;
  storageClass?: StorageClass;
  createdAfter?: Date;
  createdBefore?: Date;
  sizeMin?: number;
  sizeMax?: number;
  metadata?: Record<string, any>;
  folder?: string;
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'size' | 'createdAt' | 'lastAccessedAt';
  sortOrder?: 'asc' | 'desc';
}
