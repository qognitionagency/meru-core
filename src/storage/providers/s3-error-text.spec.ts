import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3StorageProvider } from './s3.provider';

/**
 * `S3StorageProvider` wrapped every SDK failure as
 * `BadRequestException(\`Upload failed: ${error.message}\`)` (and the same for
 * download, delete, copy, metadata and list). An HttpException message passes
 * the global filter untouched, so the SDK's own text — endpoint host, bucket,
 * key, request ids — went back to the caller (Anton, 2026-11-17, #5). The
 * provider already logs the detail; the caller now gets the operation name
 * only. Status codes are unchanged.
 */
describe('S3StorageProvider — SDK error text is logged, not returned', () => {
  const sdkText =
    'getaddrinfo ENOTFOUND meru-documents.internal-endpoint.example';

  function build() {
    const cfg = {
      get: (k: string, d?: unknown) =>
        (
          ({
            AWS_ACCESS_KEY_ID: 'key',
            AWS_SECRET_ACCESS_KEY: 'secret',
            AWS_S3_BUCKET: 'meru-documents',
          }) as Record<string, string>
        )[k] ?? d,
    } as unknown as ConfigService;
    const p = new S3StorageProvider(cfg);
    const failing = () => ({ promise: () => Promise.reject(new Error(sdkText)) });
    (p as any).s3 = {
      upload: failing,
      getObject: failing,
      deleteObject: failing,
      copyObject: failing,
      headObject: failing,
      listObjectsV2: failing,
    };
    (p as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    return p;
  }

  const calls: Array<[string, (p: S3StorageProvider) => Promise<unknown>]> = [
    ['upload', (p) => p.upload(Buffer.from('x'), 'tenants/t/k', {})],
    ['download', (p) => p.download('tenants/t/k')],
    ['delete', (p) => p.delete('tenants/t/k')],
    ['copy', (p) => p.copy('tenants/t/a', 'tenants/t/b')],
    ['getObjectMetadata', (p) => p.getObjectMetadata('tenants/t/k')],
    ['listObjects', (p) => p.listObjects('tenants/t/')],
  ];

  it.each(calls)('%s does not put the SDK message in the exception', async (_name, call) => {
    const p = build();
    const err = await call(p).then(
      () => {
        throw new Error('expected a failure');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    expect(JSON.stringify((err as HttpException).getResponse())).not.toContain(
      'internal-endpoint',
    );
    // Still logged for the operator.
    expect(JSON.stringify((p as any).logger.error.mock.calls)).toContain(
      'internal-endpoint',
    );
  });
});
