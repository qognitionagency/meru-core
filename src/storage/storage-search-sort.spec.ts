import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { ALL_ENTITIES } from '../config/entities';
import { StorageService } from './storage.service';
import { StorageFile } from './entities/storage-file.entity';
import { SearchFilesDto } from './dto/storage.dto';

/**
 * `GET /storage/files` → `StorageService.searchFiles` wrote `sortBy` into
 * ORDER BY verbatim (Anton, 2026-11-17, #1). TypeORM does not quote or check
 * an `orderBy` column string, so any logged-in role could append SQL.
 *
 * Asserted on the SQL TypeORM really generates: a DataSource with the real
 * entity metadata, never connected. `storage-search-scope.spec.ts` pins the
 * actor scoping on the same method with a call-log fake; this one pins the
 * statement itself.
 */
describe('StorageService.searchFiles — ORDER BY never takes caller input', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = new DataSource({ type: 'postgres', entities: ALL_ENTITIES as any });
    await (ds as any).buildMetadatas();
  });

  function build() {
    const captured: { sql?: string } = {};
    const fileRepo = {
      createQueryBuilder: (alias: string) => {
        const qb: SelectQueryBuilder<StorageFile> = ds
          .getRepository(StorageFile)
          .createQueryBuilder(alias);
        jest.spyOn(qb, 'getManyAndCount').mockImplementation(async () => {
          captured.sql = qb.getQuery();
          return [[], 0];
        });
        return qb;
      },
    };
    const service = new StorageService(
      fileRepo as any,
      {} as any, // versionRepo
      {} as any, // multipartRepo
      {} as any, // configService
      {} as any, // dataSource
      {} as any, // eventEmitter
      {} as any, // drivers
    );
    return { service, captured };
  }

  const staff = { id: 'staff-1', roles: ['staff'] };

  it('refuses a sortBy outside the allow-list before running anything', async () => {
    const { service, captured } = build();

    await expect(
      service.searchFiles({
        tenantId: 't1',
        actor: staff,
        sortBy: 'createdAt; SELECT pg_sleep(5) --' as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(captured.sql).toBeUndefined();
  });

  it('refuses a sortOrder outside asc/desc', async () => {
    const { service, captured } = build();

    await expect(
      service.searchFiles({
        tenantId: 't1',
        actor: staff,
        sortOrder: 'desc, (select 1)' as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(captured.sql).toBeUndefined();
  });

  it("maps the interface's `name` to the real column, quoted", async () => {
    const { service, captured } = build();

    await service.searchFiles({
      tenantId: 't1',
      actor: staff,
      sortBy: 'name',
      sortOrder: 'asc',
    });

    expect(captured.sql).toMatch(/ORDER BY "file"\."originalName" ASC/);
  });

  it('defaults to createdAt DESC', async () => {
    const { service, captured } = build();

    await service.searchFiles({ tenantId: 't1', actor: staff });

    expect(captured.sql).toMatch(/ORDER BY "file"\."createdAt" DESC/);
  });
});

describe('SearchFilesDto under the global ValidationPipe', () => {
  // Must mirror src/main.ts and api/index.js. If those change, change this.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const run = (query: Record<string, string>) =>
    pipe.transform(query, { type: 'query', metatype: SearchFilesDto });

  it('rejects a sortBy outside the allow-list with a 400', async () => {
    await expect(
      run({ sortBy: 'createdAt; DROP TABLE users --' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a sortOrder outside asc/desc with a 400', async () => {
    await expect(run({ sortOrder: 'sideways' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts the documented values', async () => {
    await expect(
      run({ sortBy: 'lastAccessedAt', sortOrder: 'ASC' }),
    ).resolves.toMatchObject({ sortBy: 'lastAccessedAt' });
  });
});
