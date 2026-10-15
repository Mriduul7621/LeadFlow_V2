/**
 * roleAccessDefaults.ts — default access for the standard roles.
 * ------------------------------------------------------------------
 * Shared by TWO entry points, because the roles table may be empty when a
 * migration runs:
 *
 *   - migration 045 (upgrade path): an existing database already has its
 *     roles, so the defaults are applied — and ledger-recorded — at
 *     migration time;
 *   - the baseline seed step (fresh install): migrations run BEFORE the
 *     roles are seeded, so 045 finds an empty table. The seed runner calls
 *     this right after `seedRoles()`, which is the first moment a fresh
 *     install has roles to grant to.
 *
 * Both calls are idempotent and guarded: a role that already holds ANY
 * grant was configured (by hand or through Roles & Access) and is never
 * touched again, so an admin's narrowed matrix survives every boot.
 *
 * Why this exists at all: migrations 026/042 only ever granted ADMIN.
 * With `hasPermissionCode()` failing closed, every other role answered 403
 * for every read on a database where nobody had opened Roles & Access yet
 * — the product looked broken (empty pages, no explanation) for MANAGER,
 * TEAM_LEAD, EMPLOYEE, SBE, SM and the CEO.
 */
import { query } from "./connection.js";

/** Canonical codes each standard role needs — mirrors the Roles & Access editor. */
const FIELD_EXEC = [
  'dashboard.view',
  'leads.view', 'leads.create', 'leads.edit',
  'campaigns.view', 'products.view',
  'roadshows.view', 'notifications.view',
];
const TEAM_LEAD = [
  ...FIELD_EXEC,
  'leads.assign',
  'roadshows.create', 'roadshows.edit',
  'teams.view', 'reports.view',
];
const MANAGER = [
  ...TEAM_LEAD,
  'leads.transfer', 'leads.export',
  'users.view', 'departments.view',
  'roadshows.report', 'audit.view',
];
const EXECUTIVE = [
  'dashboard.view', 'leads.view',
  'reports.view', 'users.view', 'roles.view',
  'teams.view', 'departments.view', 'audit.view',
  'campaigns.view', 'products.view',
  'roadshows.view', 'roadshows.report',
  'notifications.view',
];

/**
 * role_code -> permission codes. Legacy codes (RO/RM/ASM/BDM/BE/BH) map to
 * the closest modern equivalent so pre-rename databases behave the same.
 * Codes absent from this table (custom roles) are intentionally skipped.
 */
const DEFAULT_GRANTS: Record<string, string[]> = {
  CEO: EXECUTIVE,
  BH: EXECUTIVE,
  MANAGER: MANAGER,
  SM: MANAGER,
  RM: MANAGER,
  TEAM_LEAD: TEAM_LEAD,
  BDM: TEAM_LEAD,
  ASM: TEAM_LEAD,
  EMPLOYEE: FIELD_EXEC,
  SBE: FIELD_EXEC,
  BE: FIELD_EXEC,
  RO: FIELD_EXEC,
};

/** role_code -> data visibility. Only applied while the value is still 'Own'. */
const DEFAULT_VISIBILITY: Record<string, string> = {
  CEO: 'Organization',
  BH: 'Organization',
  MANAGER: 'FullTeam',
  SM: 'FullTeam',
  RM: 'FullTeam',
  TEAM_LEAD: 'DownTeam',
  BDM: 'DownTeam',
  ASM: 'DownTeam',
  RO: 'DownTeam',
};

export async function applyDefaultRoleAccess(): Promise<void> {
    // ---- 1. Default permission grants (fresh roles only) ----------------
    for (const [roleCode, codes] of Object.entries(DEFAULT_GRANTS)) {
        // The guard: does this role already hold ANY grant? If yes, it has
        // been configured (or previously defaulted) — leave it exactly as is.
        const existing = await query<{ count: number }>(
            `SELECT COUNT(*)::int AS count
               FROM role_permissions rp
               JOIN roles r ON r.id = rp.role_id
              WHERE UPPER(r.role_code) = $1`,
            [roleCode]
        );
        if ((existing.rows[0]?.count ?? 0) > 0) continue;

        await query(
            `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
             SELECT r.id, p.id, TRUE
               FROM roles r
               CROSS JOIN permissions p
              WHERE UPPER(r.role_code) = $1
                AND p.permission_code = ANY($2)
             ON CONFLICT (role_id, permission_id) DO UPDATE
                SET is_allowed = TRUE, updated_at = NOW()`,
            [roleCode, codes]
        );
    }

    // ---- 2. Data visibility defaults (untouched 'Own' only) ------------
    const hasVisibilityColumn = await query<{ exists: boolean }>(
        `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = 'roles' AND column_name = 'data_visibility'
         ) AS exists`
    );
    if (hasVisibilityColumn.rows[0]?.exists) {
        for (const [roleCode, visibility] of Object.entries(DEFAULT_VISIBILITY)) {
            await query(
                `UPDATE roles
                    SET data_visibility = $2, updated_at = NOW()
                  WHERE UPPER(role_code) = $1
                    AND COALESCE(data_visibility, 'Own') = 'Own'`,
                [roleCode, visibility]
            );
        }
    }

}

export async function revertDefaultRoleAccess(): Promise<void> {
    /**
     * Best-effort rollback. `up()` never touches a role that already held
     * grants, so the rollback must not either — it clears a role ONLY when
     * its current matrix is exactly the default set this migration would
     * have written (i.e. nothing else was curated before or after).
     */
    for (const [roleCode, codes] of Object.entries(DEFAULT_GRANTS)) {
        const current = await query<{ permission_code: string }>(
            `SELECT p.permission_code
               FROM role_permissions rp
               JOIN roles r ON r.id = rp.role_id
               JOIN permissions p ON p.id = rp.permission_id
              WHERE UPPER(r.role_code) = $1 AND rp.is_allowed`,
            [roleCode]
        );
        const currentCodes = current.rows.map((row) => row.permission_code).sort();
        const expected = [...codes].sort();
        const isExactlyTheDefault =
            currentCodes.length === expected.length &&
            currentCodes.every((code, i) => code === expected[i]);
        if (!isExactlyTheDefault) continue;

        await query(
            `DELETE FROM role_permissions rp
              USING roles r, permissions p
              WHERE rp.role_id = r.id
                AND rp.permission_id = p.id
                AND UPPER(r.role_code) = $1
                AND p.permission_code = ANY($2)`,
            [roleCode, codes]
        );
    }
    // Same rule for visibility: only move a value back that still equals
    // the default this migration set.
    for (const [roleCode, visibility] of Object.entries(DEFAULT_VISIBILITY)) {
        await query(
            `UPDATE roles SET data_visibility = 'Own', updated_at = NOW()
              WHERE UPPER(role_code) = $1 AND data_visibility = $2`,
            [roleCode, visibility]
        );
    }
}
