import { getMetadataArgsStorage } from 'typeorm';
import { DocumentsService } from './documents.service';
import { DocumentAccessService } from './document-access.service';
import {
  DocumentEncryption,
  DocumentType,
} from './entities/document.entity';
import { DocumentVersion } from './entities/document-version.entity';
import { StorageProvider } from '../storage/interfaces/storage.interface';
import { configuration } from '../config/configuration';
import { NullDocumentVersionEncryptionKeys1757400000000 } from '../migrations/1757400000000-NullDocumentVersionEncryptionKeys';
import type { Actor } from '../common/access';

/**
 * Anton's sign-off, HIGH: the platform-wide `DOCUMENT_ENCRYPTION_KEY` was
 * written in clear into `document_versions."encryptionKey"` on every encrypted
 * upload and every new version, and `GET /documents/:id` (versions relation),
 * `GET /documents/:id/versions` and `GET /documents/:id/versions/:versionId`
 * returned the rows unfiltered. Any authenticated caller who could read one
 * encrypted document — a `client` reading their own passport — could read
 * back the single key every tenant's encrypted documents are under.
 *
 * Pinned here:
 *  1. the key is never written into a version row (upload, new version);
 *  2. the column is `select: false`, so no find or relation load reads it;
 *  3. the three read paths map their output, so even a row that DID carry it
 *     (an older row before the migration ran, or a future `addSelect`) leaves
 *     the service without it — staff and client alike;
 *  4. no literal key fallback remains: a missing key fails, it never encrypts
 *     under a constant committed to this repository;
 *  5. the migration that NULLs the stored copies, both directions.
 */
describe('DocumentsService — the document encryption key is never stored or returned', () => {
  const T = 'tenant-1';
  const LEAKED = 'LEAKED-PLATFORM-DOCUMENT-KEY';
  const DOC_ID = '00000000-0000-4000-8000-000000000001';
  const V1 = '00000000-0000-4000-8000-0000000000a1';
  const V2 = '00000000-0000-4000-8000-0000000000a2';

  const staff: Actor = { id: 'staff-1', roles: ['staff'] };
  const client: Actor = {
    id: 'client-a',
    roles: ['client'],
    email: 'a@example.test',
  };

  /** A version row as the database used to hand it back: key included. */
  const storedVersion = (id: string, versionNumber: number) => ({
    id,
    documentId: DOC_ID,
    versionNumber,
    status: 'active',
    s3Key: `tenants/${T}/documents/passport/v${versionNumber}.pdf`,
    s3Bucket: 'docs-bucket',
    storageProvider: 'supabase',
    fileSize: 10,
    checksum: 'abc',
    encryptionKey: LEAKED,
    encryptionAlgorithm: 'aes-256-gcm',
    uploadedById: client.id,
  });

  const storedDocument = () => ({
    id: DOC_ID,
    tenantId: T,
    name: 'Passport',
    slug: 'passport-1',
    fileType: DocumentType.PDF,
    // The client uploaded it, so the client may read it (`canAccess`).
    uploadedById: client.id,
    rbac: { owner: client.id },
    versionNumber: 2,
    requiredEncryption: DocumentEncryption.STANDARD,
    reviewStatus: 'uploaded',
    versions: [storedVersion(V2, 2), storedVersion(V1, 1)],
  });

  function build(
    configService: Record<string, unknown> = {
      get: jest.fn(() => 'test-document-key'),
      getOrThrow: jest.fn(() => 'test-document-key'),
    },
  ) {
    const created: Record<string, any>[] = [];

    const documentRepo = {
      findOne: jest.fn(async () => storedDocument()),
      create: (x: any) => ({ ...x }),
      save: jest.fn(async (d: any) => d),
    };
    const versionRepo = {
      find: jest.fn(async () => [storedVersion(V2, 2), storedVersion(V1, 1)]),
      findOne: jest.fn(async () => storedVersion(V1, 1)),
      create: (x: any) => ({ ...x }),
      save: jest.fn(async (v: any) => v),
    };
    const userRepo = {
      findOne: jest.fn(async () => ({ id: staff.id })),
    };
    const storage = {
      putObject: jest.fn(async () => ({
        bucket: 'docs-bucket',
        provider: StorageProvider.SUPABASE,
      })),
      signedReadUrl: jest.fn(async () => 'https://signed/read'),
    };
    const dataSource = {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn(async () => undefined),
        startTransaction: jest.fn(async () => undefined),
        commitTransaction: jest.fn(async () => undefined),
        rollbackTransaction: jest.fn(async () => undefined),
        release: jest.fn(async () => undefined),
        manager: {
          create: jest.fn((_entity: unknown, data: any) => {
            const row = { ...data };
            created.push(row);
            return row;
          }),
          save: jest.fn(async (row: any) => row),
        },
      })),
    };
    // Real access decision: the client reaches the document as its uploader,
    // staff by tenant-wide reach. No CRM lookup is needed for either.
    const access = new DocumentAccessService({} as any);

    const service = new DocumentsService(
      documentRepo as any,
      versionRepo as any,
      {} as any, // metadataRepo
      userRepo as any,
      configService as any,
      dataSource as any,
      {} as any, // orchestrationService
      access,
      storage as any,
      { recordIntake: jest.fn(async () => ({ outcome: 'no-request-recorded' })) } as any,
      {} as any, // packs
      {} as any, // auditService
    );
    return { service, created, storage };
  }

  const file = {
    size: 10,
    mimetype: 'application/pdf',
    originalname: 'passport.pdf',
    buffer: Buffer.from('passport-bytes'),
  } as any;

  const noKeyAnywhere = (value: unknown) => {
    expect(JSON.stringify(value)).not.toContain(LEAKED);
    expect(JSON.stringify(value)).not.toContain('test-document-key');
  };

  describe('writes', () => {
    it('upload() with encryption on writes no encryptionKey into the version row', async () => {
      const { service, created } = build();
      const result = await service.upload(
        file,
        {
          name: 'Passport',
          requiredEncryption: DocumentEncryption.STANDARD,
        } as any,
        T,
        staff,
      );

      const version = created.find((r) => 'versionNumber' in r && 's3Key' in r)!;
      expect(version).toBeDefined();
      expect(version).not.toHaveProperty('encryptionKey');
      // The non-secret marker that the bytes ARE encrypted survives.
      expect(version.encryptionAlgorithm).toBe('aes-256-gcm');
      expect(result.version).not.toHaveProperty('encryptionKey');
      noKeyAnywhere(result.version);
    });

    it('createNewVersion() with encryption on writes no encryptionKey into the version row', async () => {
      const { service, created } = build();
      const result = await service.createNewVersion(
        DOC_ID,
        file,
        'rescan',
        T,
        staff,
      );

      const version = created.find((r) => 's3Key' in r)!;
      expect(version).toBeDefined();
      expect(version).not.toHaveProperty('encryptionKey');
      expect(version.encryptionAlgorithm).toBe('aes-256-gcm');
      noKeyAnywhere(result.version);
    });
  });

  describe('the column', () => {
    it('is select: false, so no find() or relation load reads it', () => {
      const column = getMetadataArgsStorage().columns.find(
        (c) => c.target === DocumentVersion && c.propertyName === 'encryptionKey',
      );
      expect(column).toBeDefined();
      expect(column!.options.select).toBe(false);
    });
  });

  describe.each([
    ['staff', staff],
    ['client', client],
  ])('reads, as %s', (_label, actor) => {
    it('findOne (GET /documents/:id) returns versions with no encryptionKey property', async () => {
      const { service } = build();
      const document = await service.findOne(DOC_ID, T, actor);

      expect(document.versions).toHaveLength(2);
      for (const v of document.versions!) {
        expect(Object.prototype.hasOwnProperty.call(v, 'encryptionKey')).toBe(false);
        expect(v.id).toBeDefined();
        expect(v.encryptionAlgorithm).toBe('aes-256-gcm');
      }
      noKeyAnywhere(document);
    });

    it('getVersions (GET /documents/:id/versions) returns no encryptionKey property', async () => {
      const { service } = build();
      const versions = await service.getVersions(DOC_ID, T, actor);

      expect(versions).toHaveLength(2);
      for (const v of versions) {
        expect(Object.prototype.hasOwnProperty.call(v, 'encryptionKey')).toBe(false);
      }
      noKeyAnywhere(versions);
    });

    it('getVersion (GET /documents/:id/versions/:versionId) returns no encryptionKey property', async () => {
      const { service } = build();
      const version = await service.getVersion(DOC_ID, V1, T, actor);

      expect(Object.prototype.hasOwnProperty.call(version, 'encryptionKey')).toBe(false);
      expect(version.id).toBe(V1);
      noKeyAnywhere(version);
    });
  });

  describe('no literal key fallback', () => {
    it('an encrypted upload with no configured key fails rather than encrypting under a committed constant', async () => {
      const { service, storage } = build({
        // What ConfigService does with a default argument: hands it back.
        get: jest.fn((_key: string, fallback?: unknown) => fallback),
        getOrThrow: jest.fn(() => {
          throw new TypeError('Configuration key "DOCUMENT_ENCRYPTION_KEY" does not exist');
        }),
      });

      await expect(
        service.upload(
          file,
          { name: 'Passport', requiredEncryption: DocumentEncryption.STANDARD } as any,
          T,
          staff,
        ),
      ).rejects.toThrow(/DOCUMENT_ENCRYPTION_KEY/);
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('configuration() carries no copy of the key, and no committed default for it', () => {
      const previous = process.env.DOCUMENT_ENCRYPTION_KEY;
      delete process.env.DOCUMENT_ENCRYPTION_KEY;
      try {
        const serialised = JSON.stringify(configuration());
        expect(serialised).not.toContain('default-encryption-key-32-chars!');
        expect(configuration().documents).not.toHaveProperty('encryptionKey');
      } finally {
        if (previous !== undefined) process.env.DOCUMENT_ENCRYPTION_KEY = previous;
      }
    });
  });

  describe('migration NullDocumentVersionEncryptionKeys1757400000000', () => {
    /**
     * `document_versions` has FORCE row-level security. Under a role without
     * BYPASSRLS and with no tenant bound, the UPDATE matches zero rows and
     * reports success — and a COUNT afterwards, under the same policies, also
     * reads zero. A false "clean" on a leaked-secret cleanup (Owen's gate).
     * So the migration proves its role first, and counts afterwards.
     */
    const runner = (opts: {
      role?: { name: string; rolbypassrls: boolean; rolsuper: boolean } | null;
      remaining?: number | string;
    } = {}) => {
      const sql: string[] = [];
      const role =
        opts.role === undefined
          ? { name: 'neondb_owner', rolbypassrls: true, rolsuper: false }
          : opts.role;
      const queryRunner = {
        query: jest.fn(async (q: string) => {
          sql.push(q);
          if (/FROM pg_roles/i.test(q)) return role ? [role] : [];
          if (/count\(\*\)/i.test(q)) return [{ remaining: opts.remaining ?? 0 }];
          return [];
        }),
      } as any;
      return { sql, queryRunner };
    };
    const norm = (q: string) => q.replace(/\s+/g, ' ');
    const migration = () => new NullDocumentVersionEncryptionKeys1757400000000();

    it('up() NULLs every stored key and touches no other column', async () => {
      const { sql, queryRunner } = runner();
      await migration().up(queryRunner);

      const updates = sql.map(norm).filter((q) => /^\s*UPDATE/i.test(q));
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatch(/UPDATE "document_versions" SET "encryptionKey" = NULL/);
      expect(updates[0]).toMatch(/WHERE "encryptionKey" IS NOT NULL/);
      expect(updates[0]).not.toMatch(/encryptionAlgorithm/);
    });

    it('checks the role BEFORE the update and counts what is left AFTER it', async () => {
      const { sql, queryRunner } = runner();
      await migration().up(queryRunner);
      const kinds = sql.map((q) =>
        /pg_roles/i.test(q) ? 'role' : /^\s*UPDATE/i.test(q) ? 'update' : /count\(\*\)/i.test(q) ? 'count' : q,
      );
      expect(kinds).toEqual(['role', 'update', 'count']);
      expect(norm(sql[0])).toMatch(/rolname = current_user/);
      expect(norm(sql[2])).toMatch(
        /FROM "document_versions" WHERE "encryptionKey" IS NOT NULL/,
      );
    });

    it('refuses to run under a role without BYPASSRLS, naming the role and the reason, and updates nothing', async () => {
      const { sql, queryRunner } = runner({
        role: { name: 'meru_app', rolbypassrls: false, rolsuper: false },
      });
      const err = await migration().up(queryRunner).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/"meru_app"/);
      expect(err.message).toMatch(/BYPASSRLS/);
      expect(err.message).toMatch(/row-level security/i);
      expect(sql.some((q) => /^\s*UPDATE/i.test(q))).toBe(false);
    });

    it('refuses when the current role cannot be read at all', async () => {
      const { sql, queryRunner } = runner({ role: null });
      await expect(migration().up(queryRunner)).rejects.toThrow(/role/i);
      expect(sql.some((q) => /^\s*UPDATE/i.test(q))).toBe(false);
    });

    it('accepts a superuser — RLS does not apply to one either', async () => {
      const { queryRunner } = runner({
        role: { name: 'postgres', rolbypassrls: false, rolsuper: true },
      });
      await expect(migration().up(queryRunner)).resolves.toBeUndefined();
    });

    it('throws if any key is still stored after the update — never a false clean', async () => {
      // pg returns count(*) as a string unless cast; handle both.
      const { queryRunner } = runner({ remaining: '3' });
      await expect(migration().up(queryRunner)).rejects.toThrow(/3/);
    });

    it('down() runs cleanly and writes nothing back — a leaked secret is not restored', async () => {
      const { sql, queryRunner } = runner();
      await expect(migration().down(queryRunner)).resolves.toBeUndefined();
      expect(sql).toEqual([]);
    });
  });
});
