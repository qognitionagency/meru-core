import * as fs from 'fs';
import * as path from 'path';

/**
 * The guard for the bug this repository has shipped **four times**.
 *
 * "Migration on disk, missing from `ALL_MIGRATIONS`" is recorded as a real
 * production incident in `src/config/migrations.ts`'s own comment, in
 * CLAUDE.md and in AGENTS.md — `AddInboundWebhooks` was the fourth, and it
 * shipped 500s from `src/webhooks/*` against a table that had never been
 * created. The same shape applies to `ALL_ENTITIES`: the catalogue is what the
 * govx and immistack DataSources build their schema from, so an entity missing
 * there is a table that exists on the control plane and nowhere else.
 *
 * Every one of those four was invisible to the whole suite, because nothing
 * ever compared the directory with the array. This does, and it costs
 * milliseconds.
 */
describe('migration and entity registries', () => {
  const root = path.join(__dirname, '..');

  describe('ALL_MIGRATIONS', () => {
    const dir = path.join(root, 'migrations');
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.includes('.spec.'));
    const source = fs.readFileSync(
      path.join(__dirname, 'migrations.ts'),
      'utf8',
    );

    it.each(files)('registers %s', (file) => {
      const declared = fs
        .readFileSync(path.join(dir, file), 'utf8')
        .match(/export class (\w+)/);
      expect(declared).not.toBeNull();
      expect(source).toMatch(new RegExp(`\\b${declared![1]}\\b`));
    });

    it('carries exactly as many entries as there are files', () => {
      const entries = [...source.matchAll(/^\s{2}([A-Za-z]+\d{13}),/gm)];
      expect(entries).toHaveLength(files.length);
    });

    it('lists them in timestamp order — the order is what runs', () => {
      // `AddRecordNumbering` then `BackfillRecordNumbers` is not tidiness: the
      // backfill writes into a column the previous entry creates.
      const stamps = [...source.matchAll(/^\s{2}[A-Za-z]+(\d{13}),/gm)].map((m) =>
        Number(m[1]),
      );
      expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    });
  });

  describe('ALL_ENTITIES', () => {
    const source = fs.readFileSync(path.join(__dirname, 'entities.ts'), 'utf8');

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith('.entity.ts')) out.push(full);
      }
      return out;
    };

    const declarations = walk(root).flatMap((file) =>
      [
        ...fs
          .readFileSync(file, 'utf8')
          .matchAll(/@Entity\([^)]*\)\s*(?:@[^\n]*\n\s*)*export class (\w+)/g),
      ].map((m) => ({ file: path.relative(root, file), name: m[1] })),
    );

    it('finds the entity classes at all (the walk has not silently broken)', () => {
      expect(declarations.length).toBeGreaterThan(50);
    });

    it.each(declarations.map((d) => [d.name, d.file]))(
      'registers %s (%s)',
      (name) => {
        expect(source).toMatch(new RegExp(`\\b${name}\\b`));
      },
    );
  });
});
