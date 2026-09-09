import { query } from "../connection.js";

/**
 * 036 - Fine-grained module permissions
 * ------------------------------------------------------------------
 * Persists the per-role module/action matrix edited in the Roles &
 * Permissions workspace (the `Permissions` contract in
 * `src/modules/shared/types`):
 *
 *   { roleId, roleName, modules: { <module>: { view, create, edit,
 *     delete, upload } } }
 *
 * Design notes:
 * - `role_code` (UPPER-normalized by the API) is the business key and
 *   references `roles(role_code)` so deleting a role cascades to its
 *   fine-permission row. The API auto-provisions the parent role row
 *   (via the same resolveRoleId helper used for user creation) before
 *   upserting, so saving permissions for a brand-new role code works.
 * - `modules` is JSONB; the API validates its shape (boolean flags per
 *   module) before writing.
 * - Every statement is idempotent (CREATE TABLE/EXTENSION IF NOT
 *   EXISTS + guarded constraint creation) so re-running migrations on
 *   every cold start is safe and never touches existing rows.
 */
export async function up(): Promise<void> {
  // gen_random_uuid() lives in pgcrypto. Managed providers (Supabase /
  // Neon / Render) pre-enable it, so this is a no-op there; it only
  // matters for fresh self-hosted databases. Best-effort: if the role
  // cannot create extensions, the CREATE TABLE below still fails loudly
  // exactly as migrations 001-035 would have.
  try {
    await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  } catch (error: any) {
    console.warn(
      "⚠️ 036: could not ensure pgcrypto extension:",
      error?.message || error
    );
  }

  await query(`
    CREATE TABLE IF NOT EXISTS fine_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(30) NOT NULL,
      role_name VARCHAR(100) NOT NULL DEFAULT '',
      modules JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_fine_permissions_role_code'
      ) THEN
        ALTER TABLE fine_permissions
          ADD CONSTRAINT uq_fine_permissions_role_code UNIQUE (role_code);
      END IF;
    END
    $$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_fine_permissions_role_code'
      ) THEN
        ALTER TABLE fine_permissions
          ADD CONSTRAINT fk_fine_permissions_role_code
          FOREIGN KEY (role_code) REFERENCES roles(role_code)
          ON UPDATE CASCADE ON DELETE CASCADE;
      END IF;
    END
    $$;
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_fine_permissions_updated
    ON fine_permissions(updated_at DESC)
  `);

  console.log("✅ 036_fine_permissions migrated");
}

export async function down(): Promise<void> {
  // Intentionally non-destructive; nothing is dropped.
  console.log("ℹ️ 036 down() is a no-op to protect production data.");
}
