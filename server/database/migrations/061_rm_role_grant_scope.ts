import { query } from "../connection.js";
import {
  DEFAULT_GRANTS,
} from "../../../src/modules/shared/access/roleGrantDefaults.js";

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
 */

async function replaceExactMatrix(fromCodes: string[], toCodes: string[]): Promise<void> {
  if (!fromCodes.length || !toCodes.length) return;

  await query(
    `WITH current_matrix AS (
       SELECT r.id AS role_id,
              array_agg(p.permission_code ORDER BY p.permission_code) AS codes,
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
}

export async function up(): Promise<void> {
  await replaceExactMatrix(DEFAULT_GRANTS.MANAGER, DEFAULT_GRANTS.TEAM_LEAD);
  console.log("✅ 061_rm_role_grant_scope migrated (exact legacy RM defaults only)");
}

export async function down(): Promise<void> {
  await replaceExactMatrix(DEFAULT_GRANTS.TEAM_LEAD, DEFAULT_GRANTS.MANAGER);
  console.log("↩️  061_rm_role_grant_scope reverted (exact Team Lead RM defaults only)");
}
