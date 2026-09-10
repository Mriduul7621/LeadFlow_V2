import { getPool } from './database/connection.js';

/**
 * authz.ts — server-side data-visibility enforcement.
 * ------------------------------------------------------------------
 * The reporting tree (users.manager_id) is the single source of truth
 * for "whose data can I see". The caller's role permission profile
 * (roles.data_visibility) selects the scope:
 *
 *   'Organization' / ADMIN -> everyone (no restriction)
 *   'FullTeam'             -> everyone in the caller's department (+ self)
 *   'DownTeam'             -> the caller's own reporting subtree
 *                             (self + direct and indirect reports)
 *   'Own' (default)        -> only the caller
 *
 * IMPORTANT: this module is the security boundary. The client-side
 * copy (src/modules/users/utils/dataScope.ts) only drives UX and must
 * never be trusted on its own.
 */

export type DataVisibility = 'Own' | 'DownTeam' | 'FullTeam' | 'Organization';

export interface VisibilityResult {
  /** true = unrestricted (sees everyone) */
  all: boolean;
  /** visible users.id values (uuid) — only meaningful when all === false */
  userIds: string[];
  /** visible employee_id values — only meaningful when all === false */
  employeeIds: string[];
}

const VISIBILITIES: DataVisibility[] = ['Own', 'DownTeam', 'FullTeam', 'Organization'];

/**
 * Effective data-visibility scope for a role code. Falls back to the
 * least-privilege 'Own' when the role has no permission profile.
 */
export async function resolveDataVisibility(roleCode: string): Promise<DataVisibility> {
  const normalized = String(roleCode || '').trim().toUpperCase();
  if (normalized === 'ADMIN' || normalized === 'SUPERADMIN') return 'Organization';
  try {
    const pool = getPool();
    const result = await pool.query<{ data_visibility: string | null }>(
      `SELECT data_visibility FROM roles WHERE UPPER(role_code) = $1 LIMIT 1`,
      [normalized]
    );
    const value = result.rows[0]?.data_visibility as DataVisibility | undefined;
    return value && VISIBILITIES.includes(value) ? value : 'Own';
  } catch {
    return 'Own';
  }
}

/**
 * Every users.id in the reporting subtree rooted at `userId`
 * (including the root itself). Depth-guarded against cycles in bad data.
 */
export async function getDownlineIds(userId: string): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ id: string }>(
    `WITH RECURSIVE downline(id, depth) AS (
       SELECT u.id, 0 FROM users u WHERE u.id = $1
       UNION ALL
       SELECT u.id, d.depth + 1
         FROM users u
         JOIN downline d ON u.manager_id = d.id
        WHERE d.depth < 100 AND u.id <> d.id
     )
     SELECT id FROM downline`
  , [userId]);
  return result.rows.map(r => r.id);
}

/**
 * Full server-side visibility resolution for an authenticated caller.
 * Never throws — on any failure it degrades to least privilege ('Own').
 */
export async function resolveVisibility(
  userId: string,
  roleCode: string,
  departmentId?: string | null
): Promise<VisibilityResult> {
  const scope = await resolveDataVisibility(roleCode);

  if (scope === 'Organization') return { all: true, userIds: [], employeeIds: [] };

  const pool = getPool();
  try {
    if (scope === 'FullTeam') {
      let deptId = departmentId ?? null;
      if (!deptId) {
        const own = await pool.query<{ department_id: string | null }>(
          'SELECT department_id FROM users WHERE id = $1 LIMIT 1',
          [userId]
        );
        deptId = own.rows[0]?.department_id || null;
      }
      if (deptId) {
        const result = await pool.query<{ id: string; employee_id: string }>(
          `SELECT id, employee_id FROM users WHERE department_id = $1 OR id = $2`,
          [deptId, userId]
        );
        return {
          all: false,
          userIds: result.rows.map(r => r.id),
          employeeIds: result.rows.map(r => r.employee_id),
        };
      }
      // No department assigned - fall back to the reporting downline
      // (mirrors the client-side dataScope policy).
      const ids = await getDownlineIds(userId);
      if (ids.length > 0) {
        const result = await pool.query<{ id: string; employee_id: string }>(
          `SELECT id, employee_id FROM users WHERE id = ANY($1::uuid[])`,
          [ids]
        );
        return {
          all: false,
          userIds: result.rows.map(r => r.id),
          employeeIds: result.rows.map(r => r.employee_id),
        };
      }
    }

    if (scope === 'DownTeam') {
      const ids = await getDownlineIds(userId);
      if (ids.length === 0) {
        return { all: false, userIds: [userId], employeeIds: [] };
      }
      const result = await pool.query<{ id: string; employee_id: string }>(
        `SELECT id, employee_id FROM users WHERE id = ANY($1::uuid[])`,
        [ids]
      );
      return {
        all: false,
        userIds: result.rows.map(r => r.id),
        employeeIds: result.rows.map(r => r.employee_id),
      };
    }

    // 'Own' — least privilege.
    const result = await pool.query<{ id: string; employee_id: string }>(
      `SELECT id, employee_id FROM users WHERE id = $1`,
      [userId]
    );
    const row = result.rows[0];
    return {
      all: false,
      userIds: row ? [row.id] : [userId],
      employeeIds: row ? [row.employee_id] : [],
    };
  } catch {
    return { all: false, userIds: [userId], employeeIds: [] };
  }
}

/**
 * Legacy helper kept for compatibility: employee-id based subtree set.
 * Returns null when unrestricted (ADMIN).
 */
export async function getScopedEmployeeIds(employeeId: string, role: string): Promise<Set<string> | null> {
  if (role === 'ADMIN') return null;

  const pool = getPool();
  if (!pool) return new Set([employeeId]);

  try {
    const result = await pool.query<{ employee_id: string }>(
      `WITH RECURSIVE downline(id, depth) AS (
         SELECT u.id, 0 FROM users u WHERE u.employee_id = $1
         UNION ALL
         SELECT u.id, d.depth + 1
           FROM users u
           JOIN downline d ON u.manager_id = d.id
          WHERE d.depth < 100 AND u.id <> d.id
       )
       SELECT u.employee_id
         FROM users u
         JOIN downline d ON u.id = d.id`
    , [employeeId]);
    return new Set(result.rows.map(r => r.employee_id));
  } catch {
    return new Set([employeeId]);
  }
}
