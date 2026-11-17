import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Inject, Injectable, Module } from '@nestjs/common';

/**
 * DI evidence for the full AppModule graph, with INTERNAL_SCHEDULER unset and
 * with it `on`, and with NO database.
 *
 * Why this exists: unit tests construct services directly, so a module that
 * imports the wrong module, or a provider whose dependency is not exported,
 * passes every one of them and then dies at boot (CLAUDE.md §8.2 — a deploy
 * once went out FUNCTION_INVOCATION_FAILED on every route that way).
 * `Test.createTestingModule(...).compile()` instantiates every provider in the
 * graph, which is the step that fails on a DI fault.
 *
 * What it does NOT prove: lifecycle hooks (`onModuleInit`,
 * `onApplicationBootstrap`) do not run under `compile()`. The ones that touch
 * Postgres — the RLS assertion, the config-pack loader — need a real database,
 * and this spec deliberately has none. That half of "Nest application
 * successfully started" still needs a boot against a NON-production Postgres.
 *
 * No database, no .env: `meru-core/.env` holds the production connection
 * string. @nestjs/config only copies a .env key into process.env when the key
 * is absent, so every key in that file is preset to '' here (Joi's
 * `.empty('')` then applies the default) and the file's values never reach the
 * graph. The TypeORM DataSource is replaced with an uninitialised one whose
 * `initialize` throws, so any attempt to connect fails this spec loudly.
 *
 * Each case loads AppModule in its own module registry, because
 * `internalSchedulerEnabled()` is read while app.module.ts's @Module decorator
 * is evaluated — at import, not at compile.
 */

const ENV_FILE = join(__dirname, '..', '.env');

/** Names only — values from the file are never read into anything. */
function envFileKeys(): string[] {
  if (!existsSync(ENV_FILE)) return [];
  return readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^export\s+/, '').split('=')[0].trim())
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
}

interface CompiledGraph {
  moduleRef: import('@nestjs/testing').TestingModule;
  dataSource: import('typeorm').DataSource;
  /** SchedulerRegistry class from the same module registry as the graph. */
  SchedulerRegistry: typeof import('@nestjs/schedule').SchedulerRegistry;
}

describe('AppModule DI graph (no database)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    for (const key of envFileKeys()) process.env[key] = '';
    // Never let a stray shell variable aim this at a real database either.
    for (const key of [
      'DATABASE_URL',
      'DATABASE_APP_URL',
      'GOVX_DB_URL',
      'GOVX_DB_APP_URL',
      'IMMISTACK_DB_URL',
      'IMMISTACK_DB_APP_URL',
      'REDIS_HOST',
      'ELASTICSEARCH_HOST',
      'VERCEL',
    ]) {
      process.env[key] = '';
    }
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'di-spec-secret-that-is-at-least-32-characters';
    process.env.SKIP_CONFIG_PACK_LOADER = 'true';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  /**
   * Compile the real AppModule (plus any extra modules) with the DataSource
   * swapped for an uninitialised one. Everything is required inside one
   * isolated registry so class identities (DataSource, SchedulerRegistry)
   * match the ones the graph was built with.
   */
  async function compileGraph(extraImports: unknown[] = []): Promise<CompiledGraph> {
    let result: CompiledGraph | undefined;
    await jest.isolateModulesAsync(async () => {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { Test } = require('@nestjs/testing');
      const { DataSource } = require('typeorm');
      const { SchedulerRegistry } = require('@nestjs/schedule');
      const { ALL_ENTITIES } = require('./config/entities');
      const { AppModule } = require('./app.module');
      /* eslint-enable @typescript-eslint/no-require-imports */

      const dataSource = new DataSource({
        type: 'postgres',
        entities: ALL_ENTITIES,
      });
      dataSource.initialize = () => {
        throw new Error('app.module.di.spec must never connect to a database');
      };

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule, ...(extraImports as any[])],
      })
        .overrideProvider(DataSource)
        .useValue(dataSource)
        .compile();

      result = { moduleRef, dataSource, SchedulerRegistry };
    });
    if (!result) throw new Error('graph did not compile');
    return result;
  }

  it('resolves every provider with INTERNAL_SCHEDULER unset, and registers no scheduler', async () => {
    delete process.env.INTERNAL_SCHEDULER;

    const { moduleRef, dataSource, SchedulerRegistry } = await compileGraph();

    expect(dataSource.isInitialized).toBe(false);
    // The .env neutralisation held: no connection string reached the graph.
    expect(process.env.DATABASE_URL).toBe('');
    expect(process.env.DATABASE_APP_URL).toBe('');
    expect(() => moduleRef.get(SchedulerRegistry, { strict: false })).toThrow();
    await moduleRef.close();
  }, 60_000);

  it('resolves every provider with INTERNAL_SCHEDULER=on, and registers the scheduler', async () => {
    process.env.INTERNAL_SCHEDULER = 'on';

    const { moduleRef, dataSource, SchedulerRegistry } = await compileGraph();

    expect(dataSource.isInitialized).toBe(false);
    expect(moduleRef.get(SchedulerRegistry, { strict: false })).toBeInstanceOf(
      SchedulerRegistry,
    );
    await moduleRef.close();
  }, 60_000);

  /**
   * Negative control: proves this harness reports a DI fault rather than
   * passing whatever it is given. A provider with an unresolvable dependency,
   * added beside the real graph, must fail compile.
   */
  it('fails to compile when a provider has an unresolvable dependency', async () => {
    delete process.env.INTERNAL_SCHEDULER;

    @Injectable()
    class NeedsMissing {
      constructor(@Inject('DI_SPEC_NOT_PROVIDED') readonly missing: unknown) {}
    }
    @Module({ providers: [NeedsMissing] })
    class BrokenModule {}

    await expect(compileGraph([BrokenModule])).rejects.toThrow(
      /DI_SPEC_NOT_PROVIDED/,
    );
  }, 60_000);
});
