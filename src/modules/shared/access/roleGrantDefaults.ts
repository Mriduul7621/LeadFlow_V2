/**
 * roleGrantDefaults.ts
 * ------------------------------------------------------------------
 * ONE table for "what does a standard role hold by default".
 *
 * Why it lives here (and not in server/database): two layers need the
 * SAME answer, and before this file they each had their own copy —
 *
 *   1. the database bootstrap (migration 045 + the fresh-install seed)
 *      writes these grants into `role_permissions`, and
 *   2. the client's static route fallback (src/layouts/featureRouteAccess.ts)
 *      decides which pages a role may open before any matrix loads.
 *
 * The copies drifted: the database granted MANAGER and TEAM_LEAD
 * `reports.view`, while the client's report-page list (ADMIN/RO/RM/CEO)
 * hid those very pages from them — the same user, two answers. F16 §3.3.
 * Deriving the client fallback from this table (via
 * `rolesWithDefaultGrant`) makes the two layers structurally unable to
 * disagree: an admin who wants a different default edits Roles & Access,
 * which writes `menuAccess` and overrides this fallback per role.
 *
 * This module is deliberately dependency-free so it is safe to import
 * from both the browser bundle and the server runtime graph.
 */

/** Field executive — a frontline seller works their own pipeline. */
const FIELD_EXEC = [
  'dashboard.view',
  'leads.view', 'leads.create', 'leads.edit',
  'campaigns.view', 'products.view',
  'roadshows.view', 'notifications.view',
];

/** Team lead — runs a downline: assignment + team/report reads. */
const TEAM_LEAD = [
  ...FIELD_EXEC,
  'leads.assign',
  'roadshows.create', 'roadshows.edit',
  'teams.view', 'reports.view',
];

/** Manager — oversees full teams, transfers and exports. */
const MANAGER = [
  ...TEAM_LEAD,
  'leads.transfer', 'leads.export',
  'users.view', 'departments.view',
  'roadshows.report', 'audit.view',
];

/** Executive — organization-wide read view. */
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
 * Codes absent from this table (custom roles) are intentionally skipped —
 * a custom role starts with zero grants and the admin configures it.
 */
export const DEFAULT_GRANTS: Record<string, string[]> = {
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
export const DEFAULT_VISIBILITY: Record<string, string> = {
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

/** Named sets, exported for documentation and tests. */
export const DEFAULT_GRANT_SETS = { FIELD_EXEC, TEAM_LEAD, MANAGER, EXECUTIVE };

/**
 * Every standard role code that the DEFAULT table grants `permissionCode`.
 * ADMIN/SUPERADMIN are deliberately excluded: they bypass every check and
 * are never described by this table.
 */
export function rolesWithDefaultGrant(permissionCode: string): string[] {
  return Object.entries(DEFAULT_GRANTS)
    .filter(([, codes]) => codes.includes(permissionCode))
    .map(([roleCode]) => roleCode);
}
