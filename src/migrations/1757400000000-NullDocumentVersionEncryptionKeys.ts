import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Erase the platform document key from every `document_versions` row.
 *
 * `DocumentsService.upload` and `createNewVersion` wrote the raw
 * `DOCUMENT_ENCRYPTION_KEY` into `"encryptionKey"` on every encrypted version,
 * and the version read routes returned it — so the value in this column is a
 * leaked secret, the same one on every row of every tenant. The code no longer
 * writes or selects it (see `DocumentVersion.encryptionKey`); this removes the
 * copies already stored.
 *
 * `"encryptionAlgorithm"` is left alone: it is the non-secret marker that the
 * bytes are encrypted, and nothing else records that per version.
 *
 * **`down()` cannot restore the values and deliberately does not try.** This
 * is a one-way data change. That is acceptable here, and only here, because
 * the values are a leaked secret that nothing reads — `decryptFile` has no
 * caller, and it never took its key from this column. Rolling the CODE back
 * is still safe: the column remains, nullable, and an old build would simply
 * start writing the key into it again. The key itself should be treated as
 * exposed and rotated; see AGENTS.md, "Document encryption — known defects",
 * for why rotation is not yet possible without orphaning existing files.
 *
 * Tenant scope: this is a cross-tenant maintenance write, run by the owner
 * role (`DATABASE_URL`, BYPASSRLS) like every migration. It sets one column to
 * NULL on every row.
 *
 * **It proves that, rather than assuming it.** `document_versions` has FORCE
 * row-level security, so under a role without BYPASSRLS (`meru_app`, or any
 * owner without it) and no tenant bound, the UPDATE matches zero rows and
 * reports success — and a count under the same policies also reads zero.
 * That would record a leaked secret as erased while every copy remains. So:
 *
 * - **Before:** the current role must hold BYPASSRLS (or be a superuser, to
 *   which RLS does not apply either), or the migration throws and changes
 *   nothing.
 * - **After:** it counts rows still holding a key and throws if any remain.
 *   Throwing inside `up()` rolls the migration's transaction back, so a
 *   failed post-condition is not recorded as run.
 */
export class NullDocumentVersionEncryptionKeys1757400000000
  implements MigrationInterface
{
  name = 'NullDocumentVersionEncryptionKeys1757400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [role] = (await queryRunner.query(
      `SELECT current_user AS name, rolbypassrls, rolsuper
       FROM pg_roles WHERE rolname = current_user`,
    )) as Array<{ name: string; rolbypassrls: boolean; rolsuper: boolean }>;

    if (!role) {
      throw new Error(
        `${this.name}: could not read the current database role from ` +
          `pg_roles, so it cannot prove row-level security will not hide ` +
          `rows from this UPDATE. Refusing to run.`,
      );
    }
    if (!role.rolbypassrls && !role.rolsuper) {
      throw new Error(
        `${this.name}: database role "${role.name}" does not have BYPASSRLS. ` +
          `"document_versions" has FORCE row-level security, so under this ` +
          `role the UPDATE would match no rows and report success while every ` +
          `stored key remained. Run migrations as the owner role ` +
          `(DATABASE_URL), not the application role.`,
      );
    }

    await queryRunner.query(
      `UPDATE "document_versions" SET "encryptionKey" = NULL WHERE "encryptionKey" IS NOT NULL`,
    );

    const [{ remaining }] = (await queryRunner.query(
      `SELECT count(*)::int AS remaining FROM "document_versions" WHERE "encryptionKey" IS NOT NULL`,
    )) as Array<{ remaining: number | string }>;

    if (Number(remaining) !== 0) {
      throw new Error(
        `${this.name}: ${remaining} document_versions row(s) still hold an ` +
          `"encryptionKey" after the UPDATE. Refusing to record this ` +
          `migration as run.`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally empty — see the class comment. There is nothing to put
    // back that should ever exist again.
  }
}
