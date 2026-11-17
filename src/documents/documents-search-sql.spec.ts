import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { ALL_ENTITIES } from '../config/entities';
import { DocumentsService } from './documents.service';
import { DocumentAccessService } from './document-access.service';
import { Document } from './entities/document.entity';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import type { Actor } from '../common/access';

/**
 * `GET /documents` → `DocumentsService.findAll`, asserted on the SQL TypeORM
 * actually generates rather than on a mock's call log. A DataSource is built
 * with the real entity metadata but never connected, so `getQueryAndParameters`
 * returns the exact statement Postgres would receive and nothing touches a
 * database.
 *
 * Two defects found by Anton's 2026-11-17 sweep, both live:
 *
 * 1. `sortBy` was written into `ORDER BY` verbatim. TypeORM does not quote or
 *    validate an `orderBy` column string; only the direction is checked. A
 *    caller of any role could append SQL to the statement.
 *
 * 2. `includeAI` added `orWhere(aiAnalysis ILIKE …)` flat into the WHERE before
 *    `applyScope`. TypeORM adds no brackets, so the statement read
 *    `(tenant AND … AND name ILIKE q) OR (aiAnalysis ILIKE q AND own-scope)`:
 *    the first branch carried no user scope, and a `client` token listed every
 *    document in the firm whose name matched. Sixth instance of the
 *    within-tenant isolation class (workspace CLAUDE.md §8).
 */

/** Offline DataSource: real metadata, no connection. */
async function offlineDataSource(): Promise<DataSource> {
  const ds = new DataSource({ type: 'postgres', entities: ALL_ENTITIES as any });
  // Protected in TypeORM's typings; it is what `initialize()` calls after
  // connecting, and it needs no connection itself.
  await (ds as any).buildMetadatas();
  return ds;
}

/** The WHERE clause of a generated statement, ORDER BY / LIMIT stripped. */
function whereOf(sql: string): string {
  const start = sql.indexOf(' WHERE ');
  const end = sql.search(/ ORDER BY | LIMIT | OFFSET /);
  return sql.slice(start + ' WHERE '.length, end === -1 ? undefined : end);
}

/**
 * Split a boolean expression on top-level AND. If any top-level OR remains,
 * the expression is not a pure conjunction and some conjunct can be skipped —
 * which is the whole bug.
 */
function topLevel(expr: string): { conjuncts: string[]; hasTopLevelOr: boolean } {
  const conjuncts: string[] = [];
  let depth = 0;
  let current = '';
  let hasTopLevelOr = false;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && expr.startsWith(' AND ', i)) {
      conjuncts.push(current.trim());
      current = '';
      i += ' AND '.length - 1;
      continue;
    }
    if (depth === 0 && expr.startsWith(' OR ', i)) hasTopLevelOr = true;
    current += ch;
  }
  conjuncts.push(current.trim());
  return { conjuncts, hasTopLevelOr };
}

describe('DocumentsService.findAll — generated SQL', () => {
  const T = 'tenant-1';
  const staff: Actor = { id: 'staff-1', roles: ['staff'] };
  // A client with no owned cases: applyScope narrows to `uploadedById`.
  const client: Actor = { id: 'client-a', roles: ['client'] };

  let ds: DataSource;
  beforeAll(async () => {
    ds = await offlineDataSource();
  });

  function build() {
    const captured: { sql?: string; params?: unknown[] } = {};
    const documentRepo = {
      createQueryBuilder: (alias: string) => {
        const qb: SelectQueryBuilder<Document> = ds
          .getRepository(Document)
          .createQueryBuilder(alias);
        jest.spyOn(qb, 'getManyAndCount').mockImplementation(async () => {
          const [sql, params] = qb.getQueryAndParameters();
          captured.sql = sql;
          captured.params = params;
          return [[], 0];
        });
        return qb;
      },
    };
    // ownedEntityIds → none, so a client is scoped to its own uploads.
    const entities = {
      createQueryBuilder: () => {
        const q: any = {
          select: () => q,
          where: () => q,
          andWhere: () => q,
          getRawMany: async () => [],
        };
        return q;
      },
    };
    const service = new DocumentsService(
      documentRepo as any,
      {} as any, // versionRepo
      {} as any, // metadataRepo
      {} as any, // userRepo
      {} as any, // configService
      {} as any, // dataSource
      {} as any, // orchestrationService
      new DocumentAccessService(entities as any, {} as any, {} as any),
      {} as any, // storage
      {} as any, // documentRequests
      {} as any, // packs
      {} as any, // auditService
    );
    return { service, captured };
  }

  describe('own-scope applies to every branch of the text search (#3)', () => {
    it('a client searching with includeAI gets one conjunction, scope included', async () => {
      const { service, captured } = build();

      await service.findAll(T, { query: 'a', includeAI: true } as any, client);

      const { conjuncts, hasTopLevelOr } = topLevel(whereOf(captured.sql!));
      expect(hasTopLevelOr).toBe(false);
      expect(conjuncts).toContain('"document"."tenantId" = $1');
      expect(
        conjuncts.some((c) => c.includes('"document"."uploadedById" =')),
      ).toBe(true);
      // The AI branch is still searched — inside the bracketed group.
      expect(
        conjuncts.some(
          (c) => c.includes('aiAnalysis') && c.includes('"document"."name" ILIKE'),
        ),
      ).toBe(true);
      expect(captured.params).toEqual(
        expect.arrayContaining([T, '%a%', client.id]),
      );
    });

    it('a client searching without includeAI is likewise a single conjunction', async () => {
      const { service, captured } = build();

      await service.findAll(T, { query: 'a' } as any, client);

      const { hasTopLevelOr, conjuncts } = topLevel(whereOf(captured.sql!));
      expect(hasTopLevelOr).toBe(false);
      expect(conjuncts.some((c) => c.includes('aiAnalysis'))).toBe(false);
    });

    it('staff keep tenant-wide reach, and the tenant predicate is still a top-level conjunct', async () => {
      const { service, captured } = build();

      await service.findAll(T, { query: 'a', includeAI: true } as any, staff);

      const { conjuncts, hasTopLevelOr } = topLevel(whereOf(captured.sql!));
      expect(hasTopLevelOr).toBe(false);
      expect(conjuncts).toContain('"document"."tenantId" = $1');
    });
  });

  describe('sortBy never reaches SQL unmapped (#1)', () => {
    it('refuses a sortBy that is not an allow-listed field, before running anything', async () => {
      const { service, captured } = build();

      await expect(
        service.findAll(
          T,
          { sortBy: 'createdAt; SELECT pg_sleep(5) --' } as any,
          staff,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(captured.sql).toBeUndefined();
    });

    it('refuses a sortOrder that is not ASC or DESC', async () => {
      const { service, captured } = build();

      await expect(
        service.findAll(T, { sortOrder: 'DESC, (SELECT 1)' } as any, staff),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(captured.sql).toBeUndefined();
    });

    it('orders by the quoted, mapped column for an allowed field', async () => {
      const { service, captured } = build();

      await service.findAll(T, { sortBy: 'name', sortOrder: 'ASC' } as any, staff);

      expect(captured.sql).toMatch(/ORDER BY "document"\."name" ASC/);
    });

    it('defaults to createdAt DESC', async () => {
      const { service, captured } = build();

      await service.findAll(T, {} as any, staff);

      expect(captured.sql).toMatch(/ORDER BY "document"\."createdAt" DESC/);
    });
  });
});

/**
 * The DTO under the global ValidationPipe, configured exactly as `src/main.ts`
 * and `api/index.js` configure it. If those change, change this.
 */
describe('SearchDocumentsDto under the global ValidationPipe', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const run = (query: Record<string, string>) =>
    pipe.transform(query, { type: 'query', metatype: SearchDocumentsDto });

  it('rejects a sortBy outside the allow-list with a 400', async () => {
    await expect(
      run({ sortBy: 'createdAt; DROP TABLE users --' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a sortOrder outside ASC/DESC with a 400', async () => {
    await expect(run({ sortOrder: 'sideways' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts an allow-listed sortBy and either case of sortOrder', async () => {
    await expect(run({ sortBy: 'createdAt', sortOrder: 'asc' })).resolves.toMatchObject({
      sortBy: 'createdAt',
    });
  });

  it('reads includeAI=false as false — implicit conversion used to make it true', async () => {
    const dto = (await run({ includeAI: 'false' })) as SearchDocumentsDto;
    expect(dto.includeAI).toBe(false);
  });

  it('reads includeAI=true as true', async () => {
    const dto = (await run({ includeAI: 'true' })) as SearchDocumentsDto;
    expect(dto.includeAI).toBe(true);
  });

  it('rejects an includeAI that is not a boolean word', async () => {
    await expect(run({ includeAI: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
