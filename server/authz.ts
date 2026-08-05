import { getPool } from './db.ts';

/**
 * server/authz.ts
 * ------------------------------------------------------------------
 * Server-side mirror of src/utils/dataScope.ts. This is the REAL
 * security boundary: given a requesting user's employeeId + role,
 * returns the set of employeeIds whose leads/records they're allowed
 * to see, based on the enterprise hierarchy (manager_id chain) and
 * department, per the role's configured dataVisibility scope:
 *   Own | DownTeam | FullTeam | Organization
 */

interface MinimalUserRow {
  employee_id: string;
  manager_id: string | null;
  department_id: string | null;
}

async function getRoleScope(roleId: string): Promise<'Own' | 'DownTeam' | 'FullTeam' | 'Organization'> {
  if ((roleId || '').toUpperCase() === 'ADMIN') return 'Organization';

  const pool = getPool();
  if (!pool) return 'Own';

  try {
    const result = await pool.query('SELECT data_visibility FROM roles WHERE UPPER(role_id) = UPPER($1)', [roleId]);
    const val = result.rows[0]?.data_visibility;
    if (val === 'Own' || val === 'DownTeam' || val === 'FullTeam' || val === 'Organization') {
      return val;
    }
  } catch (err) {
    console.error('Failed to resolve role scope, defaulting to least-privilege (Own):', err);
  }
  // Least-privilege fallback: never silently grant broad access.
  return 'Own';
}

function getDownline(rootEmployeeId: string, allUsers: MinimalUserRow[]): Set<string> {
  const visited = new Set<string>([rootEmployeeId]);
  const queue: string[] = [rootEmployeeId];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const u of allUsers) {
      if (u.manager_id === currentId && !visited.has(u.employee_id)) {
        visited.add(u.employee_id);
        queue.push(u.employee_id);
      }
    }
  }
  return visited;
}

/**
 * Returns the set of employeeIds the given requester is allowed to see,
 * or `null` to indicate "no restriction" (Organization-wide / Admin).
 */
export async function getScopedEmployeeIds(requesterEmployeeId: string, requesterRole: string): Promise<Set<string> | null> {
  const scope = await getRoleScope(requesterRole);
  if (scope === 'Organization') return null;

  const pool = getPool();
  if (!pool) return new Set([requesterEmployeeId]);

  const result = await pool.query('SELECT employee_id, manager_id, department_id FROM users');
  const allUsers: MinimalUserRow[] = result.rows;

  if (scope === 'Own') {
    return new Set([requesterEmployeeId]);
  }

  if (scope === 'DownTeam') {
    return getDownline(requesterEmployeeId, allUsers);
  }

  // FullTeam -> everyone in the requester's department; fall back to downline
  // if they have no department assigned.
  const self = allUsers.find(u => u.employee_id === requesterEmployeeId);
  if (self?.department_id) {
    return new Set(allUsers.filter(u => u.department_id === self.department_id).map(u => u.employee_id));
  }
  return getDownline(requesterEmployeeId, allUsers);
}
