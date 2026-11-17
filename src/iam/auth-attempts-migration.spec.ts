import { AddAuthAttempts1757500000000 } from '../migrations/1757500000000-AddAuthAttempts';

/**
 * Owen's gate, 2026-11-17. Default privileges cover only tables created by
 * the role that set them, so `meru_app`'s access to `auth_attempts` must not
 * depend on which owner runs this migration: without the grant, a database
 * migrated by another owner gave `meru_app` no privilege at all, the
 * limiter's boot self-test failed, and production refused to start
 * (measured against a real Postgres). Lives outside `src/migrations/`
 * because `data-source.ts` loads every file there as a migration.
 */
describe('AddAuthAttempts1757500000000 — the runtime role is granted the table', () => {
  it('grants SELECT, INSERT, UPDATE, DELETE on auth_attempts to meru_app, after creating it', async () => {
    const sql: string[] = [];
    await new AddAuthAttempts1757500000000().up({
      query: async (q: string) => {
        sql.push(q);
      },
    } as any);

    const create = sql.findIndex((q) => q.includes('CREATE TABLE IF NOT EXISTS "auth_attempts"'));
    const grant = sql.findIndex((q) =>
      q.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_attempts" TO meru_app'),
    );
    expect(create).toBeGreaterThanOrEqual(0);
    expect(grant).toBeGreaterThan(create);
  });
});
