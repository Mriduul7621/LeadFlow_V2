import { query } from "../connection.js";

/**
 * 061 — align RM action grants with its first-line supervisor scope.
 *
 * RM has DownTeam data visibility and is the first-line manager of its own
 * reporting subtree. Its previous default accidentally inherited the full
 * MANAGER action set, including lead transfer/export and audit-log access.
 *
 * Existing role matrices are changed ONLY when the entire RM matrix is an
 * exact match for the previous shipped MANAGER defaults (all allowed, no
 * extra/denied rows). A manually curated matrix is always left untouched.
 * MANAGER, SM, custom roles, user overrides and Data Visibility are untouched.
 *
 * The two grant lists below are FROZEN snapshots of the code defaults as
 * they stood when this migration shipped (roleGrantDefaults.ts:
 * MANAGER = TEAM_LEAD + leads.transfer/leads.export/users.view/
 * departments.view/roadshows.report/audit.view). They are inlined
 * deliberately: a migration must be immutable, and importing the live
 * DEFAULT_GRANTS table would let a future change to the code defaults
 * change what this migration compares against on a fresh database.
 */

// MANAGER default grant set (19 codes) — the exact pre-061 RM default.
const LEGACY_RM_MANAGER_GRANTS: string[] = [
  'dashboard.view',
  'leads.view', 'leads.create', 'leads.edit',
  'campaigns.view', 'products.view',
  'roadshows.view', 'notifications.view',
  'leads.assign',
  'roadshows.create', 'roadshows.edit',
  'teams.view', 'reports.view',
  'leads.transfer', 'leads.export',
  'users.view', 'departments.view',
  'roadshows.report', 'audit.view',
];

// TEAM_LEAD default grant set (13 codes) — the post-061 RM default.
const RM_TEAM_LEAD_GRANTS: string[] = [
  'dashboard.view',
  'leads.view', 'leads.create', 'leads.edit',
  'campaigns.view', 'products.view',
  'roadshows.view', 'notifications.view',
  'leads.assign',
  'roadshows.create', 'roadshows.edit',
  'teams.view', 'reports.view',
];

async function replaceExactMatrix(fromCodes: string[], toCodes: string[]): Promise<number> {
  if (!fromCodes.length || !toCodes.length) return 0;

  // NOTE (collation): the eligibility check compares a JS-sorted array
  // ([...codes].sort(), UTF-16 code-unit order) against a DB-sorted
  // array_agg (ORDER BY under the database collation). For this code set
  // the orders agree (covered by the migration-061 integration test); if
  // a deployment's collation ever disagreed, the comparison would fail
  // closed — the migration would change nothing rather than rewrite the
  // wrong matrix.
  const result = await query(
    `WITH current_matrix AS (
       SELECT r.id AS role_id,
              array_agg(p.permission_code::text ORDER BY p.permission_code::text) AS codes,
              bool_and(rp.is_allowed) AS all_allowed,
              count(*)::int AS total
         FROM roles r
         JOIN role_permissions rp ON rp.role_id = r.id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE UPPER(r.role_code) = 'RM'
        GROUP BY r.id
     ),
     eligible AS MATERIALIZED (
       SELECT role_id
         FROM current_matrix
        WHERE codes = $1::text[]
          AND all_allowed
          AND total = cardinality($1::text[])
          AND (SELECT count(*) FROM permissions WHERE permission_code = ANY($2::text[]))
              = cardinality($2::text[])
     ),
     deleted AS (
       DELETE FROM role_permissions rp
        USING eligible e
        WHERE rp.role_id = e.role_id
        RETURNING rp.role_id
     ),
     inserted AS (
       INSERT INTO role_permissions (role_id, permission_id, is_allowed)
       SELECT DISTINCT d.role_id, p.id, TRUE
         FROM (SELECT DISTINCT role_id FROM deleted) d
         CROSS JOIN permissions p
        WHERE p.permission_code = ANY($2::text[])
       ON CONFLICT (role_id, permission_id)
       DO UPDATE SET is_allowed = TRUE
       RETURNING role_id
     )
     SELECT count(DISTINCT role_id)::int AS updated_roles FROM inserted`,
    [[...fromCodes].sort(), [...toCodes].sort()]
  );
  return Number(result.rows?.[0]?.updated_roles ?? 0);
}

export async function up(): Promise<void> {
  const updated = await replaceExactMatrix(LEGACY_RM_MANAGER_GRANTS, RM_TEAM_LEAD_GRANTS);
  console.log(`✅ 061_rm_role_grant_scope migrated (exact legacy RM defaults only; ${updated} role(s) narrowed)`);
}

export async function down(): Promise<void> {
  // Best-effort/manual-only rollback: this broadens ANY RM role whose
  // matrix exactly matches the TEAM_LEAD set — including an RM role created
  // fresh after this release, or one manually curated to exactly that set —
  // because the migration cannot distinguish "narrowed by 061" from
  // "natively TEAM_LEAD". The shipped runner is up-only and never invokes
  // down(); use it only by hand, after checking the RM matrix first.
  const updated = await replaceExactMatrix(RM_TEAM_LEAD_GRANTS, LEGACY_RM_MANAGER_GRANTS);
  console.log(`↩️  061_rm_role_grant_scope reverted (exact Team Lead RM defaults only; ${updated} role(s) broadened)`);
}
