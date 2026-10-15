import { query } from "../connection.js";

/**
 * 047 — role templates (F16 Phase F, user-management §6 Phase F).
 * ------------------------------------------------------------------
 * A role template is a NAMED SNAPSHOT of an access configuration: data
 * visibility + the granted canonical action codes + the page (menu) set.
 *
 * Why snapshots and not another layer of inheritance:
 *   - industry guidance is "create role templates that map job functions to
 *     baseline entitlements, then add the optional extras" — templates are a
 *     STARTING POINT for a human, not a second source of truth that keeps
 *     re-shaping roles behind the administrator's back;
 *   - a template therefore never grants anything by itself: the admin loads
 *     it into the role editor, sees every toggle, and saves through the ONE
 *     existing write path (`POST /api/roles` + `PUT /api/roles/:id/permissions`).
 *     That is also why there is no `is_system` row here: the shipped
 *     standard roles ARE the baseline templates, and they are derived LIVE
 *     from `roles`/`role_permissions` — so an admin who edits "Manager"
 *     edits its baseline too, and no second copy can drift (F16 §3.3).
 *
 * This table stores only the templates the administrator chose to save.
 * Idempotent: safe on an existing database.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS role_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      template_name VARCHAR(150) NOT NULL,
      description TEXT,
      /* Which role the snapshot was taken from (informational: the snapshot
         below stays exactly as it was taken, even if that role changes). */
      source_role_code VARCHAR(30),
      data_visibility VARCHAR(20) NOT NULL DEFAULT 'Own',
      /* Canonical permission codes that were ALLOWED when the snapshot was
         taken. Codes that are not allowed are simply absent. */
      grants JSONB NOT NULL DEFAULT '[]'::jsonb,
      /* Page visibility snapshot ({"/leads": true, ...}). */
      menu_access JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  /* Two templates may not share a name (case-insensitive) — an ambiguous
     picker is worse than a rejected save. */
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_role_templates_name
    ON role_templates (LOWER(template_name))
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_role_templates_created
    ON role_templates (created_at DESC)
  `);
}
