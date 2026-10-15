import { Lead, RolePermission, User } from '../../shared/types';

/**
 * dataScope.ts
 * ------------------------------------------------------------------
 * Single source of truth for "who can see whose data" in the
 * enterprise hierarchy (CEO/Admin -> Business Head -> Business
 * Executive -> BDM -> ASM -> RM -> RO/Sales Agent).
 *
 * IMPORTANT: This mirrors the scoping enforced by the server
 * (see server/authz.ts). The client-side copy exists only to drive
 * UI filtering/UX; it must NEVER be treated as the security boundary
 * on its own, because a user can edit localStorage / call the API
 * directly. Real enforcement happens server-side.
 *
 * Scopes (must match RolePermission.dataVisibility):
 *  - 'Own'          -> only records the user personally owns/created
 *  - 'DownTeam'     -> the user + everyone under them in the manager
 *                      reporting chain (their team, direct + indirect)
 *  - 'FullTeam'     -> everyone in the user's DEPARTMENT(S) (all teams of
 *                      each). "My departments" are the user's ACTIVE
 *                      memberships (`departmentIds`), because one head may
 *                      lead several departments (F16 Phase D) — the single
 *                      `departmentId` column alone would show a
 *                      multi-department head only one team.
 *  - 'Organization' -> everyone across the whole company
 */

export type ResolvedScope = 'Own' | 'DownTeam' | 'FullTeam' | 'Organization';

/**
 * Walks the manager reporting chain (via `managerId`) starting at
 * `rootEmployeeId` and returns every employeeId under them
 * (including the root itself). BFS with a visited-set to guard
 * against accidental cycles in bad data.
 */
export function getDownlineEmployeeIds(rootEmployeeId: string, allUsers: User[]): string[] {
  const result: string[] = [rootEmployeeId];
  const queue: string[] = [rootEmployeeId];
  const visited = new Set<string>([rootEmployeeId]);

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const directReports = allUsers.filter(u => u.managerId === currentId || u.reportingManagerId === currentId);
    for (const report of directReports) {
      if (!visited.has(report.employeeId)) {
        visited.add(report.employeeId);
        result.push(report.employeeId);
        queue.push(report.employeeId);
      }
    }
  }

  return result;
}

/**
 * Determines the effective dataVisibility scope for a given user,
 * based on their assigned role's permission profile. Falls back to
 * a conservative 'Own' (least privilege) if the role can't be found,
 * so misconfiguration never silently grants broader access.
 */
export function resolveUserScope(user: Pick<User, 'role'>, roles: RolePermission[]): ResolvedScope {
  if (!user?.role) return 'Own';
  const roleNormalized = String(user.role).toUpperCase();

  if (roleNormalized === 'ADMIN') return 'Organization';

  const matchedRole = roles.find(
    r => r.roleId === user.role || r.roleId.toUpperCase() === roleNormalized
  );

  const allowed: ResolvedScope[] = ['Own', 'DownTeam', 'FullTeam', 'Organization'];
  if (matchedRole?.dataVisibility && allowed.includes(matchedRole.dataVisibility as ResolvedScope)) {
    return matchedRole.dataVisibility as ResolvedScope;
  }

  // Least-privilege fallback if no explicit role config exists yet.
  return 'Own';
}

/**
 * Returns the full set of employeeIds a given user is allowed to see,
 * given their resolved scope.
 */
export function getVisibleEmployeeIds(
  currentUser: Pick<User, 'employeeId' | 'role' | 'departmentId' | 'primaryDepartmentId' | 'departmentIds'>,
  allUsers: User[],
  roles: RolePermission[]
): string[] {
  const scope = resolveUserScope(currentUser, roles);

  if (scope === 'Organization') {
    return allUsers.map(u => u.employeeId);
  }

  if (scope === 'FullTeam') {
    const myDepartments = departmentIdsOf(currentUser);
    if (myDepartments.size > 0) {
      return allUsers
        .filter(u => departmentIdsOf(u).size > 0
          && [...departmentIdsOf(u)].some(id => myDepartments.has(id)))
        .map(u => u.employeeId);
    }
    // No department assigned - fall back to reporting-chain downline.
    return getDownlineEmployeeIds(currentUser.employeeId, allUsers);
  }

  if (scope === 'DownTeam') {
    return getDownlineEmployeeIds(currentUser.employeeId, allUsers);
  }

  // 'Own'
  return [currentUser.employeeId];
}

/**
 * The departments a person belongs to, as seen by the client: the active
 * membership list when the API sent one (`departmentIds`), plus the primary
 * department column as a fallback for cached/older payloads. Mirrors
 * `server/authz.ts` — a person is in my team when EITHER side says so.
 */
export function departmentIdsOf(
  user: Pick<User, 'departmentId' | 'primaryDepartmentId' | 'departmentIds'>
): Set<string> {
  const ids = new Set<string>();
  for (const id of [
    ...(Array.isArray(user?.departmentIds) ? user.departmentIds : []),
    user?.primaryDepartmentId,
    user?.departmentId,
  ]) {
    if (id && String(id).trim()) ids.add(String(id));
  }
  return ids;
}

/**
 * Filters a list of leads down to only what the current user is
 * permitted to view, based on assignment (assignedTo/assignedBy) and
 * their resolved hierarchy scope.
 */
export function filterLeadsByScope(
  leads: Lead[],
  currentUser: Pick<User, 'employeeId' | 'role' | 'departmentId' | 'primaryDepartmentId' | 'departmentIds'> | null | undefined,
  allUsers: User[],
  roles: RolePermission[]
): Lead[] {
  if (!currentUser?.employeeId) return leads;

  const roleNormalized = String(currentUser.role || '').toUpperCase();
  if (roleNormalized === 'ADMIN') return leads;

  const visibleIds = new Set(getVisibleEmployeeIds(currentUser, allUsers, roles));
  return leads.filter(l => visibleIds.has(l.assignedTo || '') || visibleIds.has(l.assignedBy || ''));
}

/**
 * Filters a list of users/employees down to only what the current
 * user is permitted to view/manage, based on their resolved scope.
 * ADMIN always sees everyone.
 */
export function filterUsersByScope(
  users: User[],
  currentUser: Pick<User, 'employeeId' | 'role' | 'departmentId' | 'primaryDepartmentId' | 'departmentIds'> | null | undefined,
  roles: RolePermission[]
): User[] {
  if (!currentUser?.employeeId) return users;

  const roleNormalized = String(currentUser.role || '').toUpperCase();
  if (roleNormalized === 'ADMIN') return users;

  const visibleIds = new Set(getVisibleEmployeeIds(currentUser, users, roles));
  return users.filter(u => visibleIds.has(u.employeeId));
}
