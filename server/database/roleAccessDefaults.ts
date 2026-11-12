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
 * DZ-5 (Danger Zone): the table this routine applies is no longer only
 * the code constants below — it is the EFFECTIVE table, i.e. the
 * Danger Zone's stored table when a super admin has saved one, and the
 * code constants otherwise (server/services/roleDefaultsStore.ts).
 * The guards are unchanged: zero-grant roles only, visibility moves
 * only while it still holds 'Own'. The routine now returns a report
 * of what it actually changed, so the Danger Zone's Apply step can
 * show and audit-log it; callers that ignore the return value
 * (migration 045, the seed runner, ensureDefaultRoles) behave
 * exactly as before.
 *
 * Why this exists at all: migrations 026/042 only ever granted ADMIN.
 * With `hasPermissionCode()` failing closed, every other role answered 403
 * for every read on a database where nobody had opened Roles & Access yet
 * — the product looked broken (empty pages, no explanation) for MANAGER,
 * TEAM_LEAD, EMPLOYEE, SBE, SM and the CEO.
 */
import { query } from "./connection.js";

/**
 * Canonical codes each standard role needs — mirrors the Roles & Access
 * editor. The table itself lives in ONE place now
 * (src/modules/shared/access/roleGrantDefaults) because the client's
 * report-page fallback derives from the same data; two hand-kept copies
 * had drifted (F16 §3.3).
 *
 * DZ-5: these constants are the CODE DEFAULTS (version 0) of the
 * Danger Zone table. The effective table may differ once a super
 * admin saves an edit — always read it via getEffectiveRoleDefaults().
 */
import {
  DEFAULT_GRANTS,
  DEFAULT_VISIBILITY,
} from '../../src/modules/shared/access/roleGrantDefaults.js';
import { getEffectiveRoleDefaults } from '../services/roleDefaultsStore.js';

export { DEFAULT_GRANTS, DEFAULT_VISIBILITY };

/** What one Apply run did to one role. */
export interface RoleDefaultsApplyEntry {
  roleCode: string;
  /** Codes this run wrote (the role held zero before, so all are new). */
  grantsAdded: string[];
  visibilityChanged: boolean;
  visibilityFrom: string | null;
  visibilityTo: string | null;
}

/** What one Apply run did overall. */
export interface RoleDefaultsApplyReport {
  applied: RoleDefaultsApplyEntry[];
  /** Role codes that already held a grant and were left exactly as is. */
  skipped: string[];
}

export async function applyDefaultRoleAccess(): Promise<RoleDefaultsApplyReport> {
    const effective = await getEffectiveRoleDefaults();
    const GRANTS = effective.grants;
    const VISIBILITY = effective.visibility;
    const report: RoleDefaultsApplyReport = { applied: [], skipped: [] };
    /* `role_permissions.updated_at` is a product column (migration 035), but
       minimal schemas exist in the wild — the forced-password-change fixture
       creates the table without it, and a hard reference to it turned every
       user creation on such a database into a 500. Detect it once instead of
       assuming it. */
    const hasTouchColumn = await query<{ exists: boolean }>(
        `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = 'role_permissions' AND column_name = 'updated_at'
         ) AS exists`
    );
    const touchClause = hasTouchColumn.rows[0]?.exists ? ', updated_at = NOW()' : '';

    // ---- 1. Default permission grants (fresh roles only) ----------------
    // Roles that already hold ANY grant row are "configured". This
    // pre-read only feeds the report; the guard below still decides
    // role by role, so the two can never disagree about a role that
    // gains grants mid-run.
    const configuredRows = await query<{ role_code: string }>(
        `SELECT DISTINCT UPPER(r.role_code) AS role_code
           FROM role_permissions rp JOIN roles r ON r.id = rp.role_id`
    );
    const configuredCodes = new Set(configuredRows.rows.map((row) => row.role_code));
    for (const [roleCode, codes] of Object.entries(GRANTS)) {
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

        // A code with no role row is inert (as before): nothing to apply to.
        const roleRow = await query<{ id: string }>(
            `SELECT id FROM roles WHERE UPPER(role_code) = $1 LIMIT 1`,
            [roleCode]
        );
        if (!roleRow.rows[0]) continue;

        await query(
            `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
             SELECT r.id, p.id, TRUE
               FROM roles r
               CROSS JOIN permissions p
              WHERE UPPER(r.role_code) = $1
                AND p.permission_code = ANY($2)
             ON CONFLICT (role_id, permission_id) DO UPDATE
                SET is_allowed = TRUE${touchClause}`,
            [roleCode, codes]
        );
        // The role held zero grants, so every code the INSERT could
        // resolve is new. Report the codes that actually landed (a code
        // missing from the permissions table resolves to nothing).
        const landed = await query<{ permission_code: string }>(
            `SELECT p.permission_code
               FROM role_permissions rp
               JOIN roles r ON r.id = rp.role_id
               JOIN permissions p ON p.id = rp.permission_id
              WHERE UPPER(r.role_code) = $1 AND rp.is_allowed`,
            [roleCode]
        );
        report.applied.push({
            roleCode,
            grantsAdded: landed.rows.map((row) => row.permission_code).sort(),
            visibilityChanged: false,
            visibilityFrom: null,
            visibilityTo: null,
        });
    }

    // ---- 2. Data visibility defaults (untouched 'Own' only) ------------
    const hasVisibilityColumn = await query<{ exists: boolean }>(
        `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = 'roles' AND column_name = 'data_visibility'
         ) AS exists`
    );
    if (hasVisibilityColumn.rows[0]?.exists) {
        for (const [roleCode, visibility] of Object.entries(VISIBILITY)) {
            const before = await query<{ data_visibility: string | null }>(
                `SELECT data_visibility FROM roles WHERE UPPER(role_code) = $1 LIMIT 1`,
                [roleCode]
            );
            const from = before.rows[0]?.data_visibility ?? null;
            const updated = await query(
                `UPDATE roles
                    SET data_visibility = $2, updated_at = NOW()
                  WHERE UPPER(role_code) = $1
                    AND COALESCE(data_visibility, 'Own') = 'Own'`,
                [roleCode, visibility]
            );
            if ((updated.rowCount ?? 0) === 0) continue;
            const entry = report.applied.find((e) => e.roleCode === roleCode);
            if (entry) {
                entry.visibilityChanged = true;
                entry.visibilityFrom = from ?? 'Own';
                entry.visibilityTo = visibility;
            } else {
                // The role held grants already (skipped in step 1) but its
                // visibility was still untouched 'Own': the visibility
                // default still applies — the two guards are independent.
                report.applied.push({
                    roleCode,
                    grantsAdded: [],
                    visibilityChanged: true,
                    visibilityFrom: from ?? 'Own',
                    visibilityTo: visibility,
                });
            }
        }
    }

    // Skipped = the table's roles that already held a grant when this
    // run started (the pre-read above); the guard decided role by
    // role, this only reports it.
    report.skipped = Object.keys(GRANTS).filter((code) => configuredCodes.has(code));

    return report;
}

export async function revertDefaultRoleAccess(): Promise<void> {
    /**
     * Best-effort rollback. `up()` never touches a role that already held
     * grants, so the rollback must not either — it clears a role ONLY when
     * its current matrix is exactly the default set this migration would
     * have written (i.e. nothing else was curated before or after).
     * "The default set" is the EFFECTIVE table (DZ-5): a rollback after
     * a Danger Zone edit undoes what the edited table wrote, not what
     * the code constants say.
     */
    const effective = await getEffectiveRoleDefaults();
    const GRANTS = effective.grants;
    const VISIBILITY = effective.visibility;
    for (const [roleCode, codes] of Object.entries(GRANTS)) {
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
    for (const [roleCode, visibility] of Object.entries(VISIBILITY)) {
        await query(
            `UPDATE roles SET data_visibility = 'Own', updated_at = NOW()
              WHERE UPPER(role_code) = $1 AND data_visibility = $2`,
            [roleCode, visibility]
        );
    }
}
