import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  VERTICAL: Joi.string().valid('core', 'immigration', 'grc', 'labour', 'fintech', 'legal').default('core'),

  // AWS Secrets Manager
  AWS_REGION: Joi.string().default('ap-south-1'),
  AWS_RDS_SECRET_NAME: Joi.string().required(),

  // Database (loaded from Secrets Manager)
  DATABASE_HOST: Joi.string().optional(),
  DATABASE_PORT: Joi.number().default(5432),
  DATABASE_USERNAME: Joi.string().optional(),
  DATABASE_PASSWORD: Joi.string().optional(),
  DATABASE_NAME: Joi.string().required(),

  // JWT
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.string().default('1h'),

  // Cache (Redis URL optional, falls back to memory)
  REDIS_HOST: Joi.string().optional(),
  REDIS_PORT: Joi.number().optional(),

  // AWS S3
  AWS_ACCESS_KEY_ID: Joi.string().required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().required(),
  AWS_S3_BUCKET: Joi.string().default('meru-documents'),

  // Documents
  DOCUMENT_ENCRYPTION_KEY: Joi.string().default('default-encryption-key-32-chars!'),
  MAX_FILE_SIZE: Joi.number().default(52428800),
});

export const configuration = () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  vertical: process.env.VERTICAL || 'core',
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    name: process.env.DATABASE_NAME,
  },
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    rdsSecretName: process.env.AWS_RDS_SECRET_NAME,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    s3Bucket: process.env.AWS_S3_BUCKET || 'meru-documents',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRATION,
  },
  cache: {
    store: process.env.REDIS_HOST ? 'redis' : 'memory',
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  documents: {
    encryptionKey: process.env.DOCUMENT_ENCRYPTION_KEY || 'default-encryption-key-32-chars!',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800', 10),
  },
});
