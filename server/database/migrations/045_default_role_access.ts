import { query } from "../connection.js";

/**
 * 045 — default access for the standard roles (fresh-install fix).
 * ------------------------------------------------------------------
 * Symptom this fixes: on a database where nobody had opened Roles &
 * Access yet, every role except ADMIN was locked out of the product —
 * `GET /api/leads`, `/api/dashboard`, `/api/roadshows`, `/api/audit-logs`
 * all answered 403 ("You do not have permission to ..."), so the app
 * rendered empty pages with no explanation. Migration 026 only ever
 * granted the ADMIN role, and migration 042 did the same for the
 * roadshow codes, so the fail-closed `hasPermissionCode()` made every
 * other role a dead end until an admin hand-tuned the matrix.
 *
 * What it does:
 *   1. Grants the STANDARD roles the canonical permission codes their
 *      job needs — and ONLY for roles that currently hold NO grants at
 *      all. A role whose matrix has been curated (by hand or through
 *      Roles & Access, which writes >= 1 row) is never touched, so this
 *      cannot silently re-open access an admin deliberately closed.
 *   2. Gives manager-level roles the data visibility their job implies
 *      (MANAGER/SM -> FullTeam, TEAM_LEAD/BDM -> DownTeam, CEO/BH ->
 *      Organization) — but only while the column still holds its
 *      untouched default 'Own'. A value an admin chose is left alone.
 *      Employees stay 'Own' (they may only see their own leads).
 *
 * Everything here is idempotent: re-running finds either existing grants
 * (skipped by the "no grants yet" guard) or a non-default visibility.
 * `hasPermissionCode()` and Data Visibility keep failing closed for any
 * role this migration does not name (custom codes stay hand-configured).
 */

import { applyDefaultRoleAccess, revertDefaultRoleAccess } from "../roleAccessDefaults.js";

export async function up(): Promise<void> {
    await applyDefaultRoleAccess();
    console.log("✅ 045_default_role_access migrated");
}

export async function down(): Promise<void> {
    await revertDefaultRoleAccess();
}
