import { ConfigService } from '@nestjs/config';
import { S3StorageProvider } from './s3.provider';

/**
 * Guards the S3-compatible endpoint override.
 *
 * Without it the AWS SDK silently resolves `s3.<region>.amazonaws.com`, so a
 * Supabase/R2/MinIO key pair authenticates against AWS and fails as
 * `InvalidAccessKeyId` — a credential error that points nowhere near the real
 * cause. That exact failure was reproduced against live Supabase credentials
 * before this was added, which is why it is tested rather than assumed.
 */
describe('S3StorageProvider — S3-compatible endpoint', () => {
  const cfg = (vals: Record<string, string | undefined>) =>
    ({
      get: (k: string, d?: unknown) => vals[k] ?? d,
    }) as unknown as ConfigService;

  const CREDS = {
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_S3_BUCKET: 'meru-documents',
  };

  it('points the client at the override and uses path-style addressing', () => {
    const p = new S3StorageProvider(
      cfg({
        ...CREDS,
        AWS_REGION: 'ap-northeast-2',
        AWS_S3_ENDPOINT:
          'https://example.storage.supabase.co/storage/v1/s3',
      }),
    );
    const c = (p as unknown as { s3: { config: Record<string, unknown> } }).s3
      .config;
    expect(String(c.endpoint)).toContain('storage.supabase.co');
    // Supabase addresses buckets as <endpoint>/<bucket>/<key>. The SDK
    // defaults to the virtual-host form, which resolves to a host that does
    // not exist.
    expect(c.s3ForcePathStyle).toBe(true);
    expect(c.signatureVersion).toBe('v4');
  });

  it('leaves the AWS default in place when no override is set', () => {
    const p = new S3StorageProvider(cfg({ ...CREDS, AWS_REGION: 'us-east-1' }));
    const c = (p as unknown as { s3: { config: Record<string, unknown> } }).s3
      .config;
    expect(String(c.endpoint)).toContain('amazonaws.com');
    expect(c.s3ForcePathStyle).toBeFalsy();
  });

  it('stays unconfigured without a bucket, endpoint or not', () => {
    const p = new S3StorageProvider(
      cfg({
        AWS_ACCESS_KEY_ID: 'key',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_S3_ENDPOINT: 'https://example.storage.supabase.co/storage/v1/s3',
      }),
    );
    // A driver that registers without a bucket becomes the silent default and
    // every upload hangs — the failure this flag exists to prevent.
    expect(p.configured).toBe(false);
  });
});
