/**
 * hierarchyHealth.ts
 * ------------------------------------------------------------------
 * Pure, database-free computation of the company reporting-ladder health
 * stats. Extracted from `buildHierarchyConfig()` so the "missing
 * reporting manager" calculation can be unit-tested without a live
 * database and reused by the API layer.
 *
 * BUSINESS RULE (single company-wide ladder, Level 1 = CEO):
 *   - Level 1 (CEO) is the organization ROOT. It MUST NOT require a
 *     reporting manager and must never be counted as "missing" one.
 *   - Every Level 2+ employee must have exactly one manager one or two
 *     levels up, in the same department (the Level-1 CEO is the only
 *     cross-department link).
 *   - "Missing reporting manager" counts ONLY Level 2+ employees.
 *
 * The level + department authority rule is delegated to the shared pure
 * helper `validateReportingManagerCandidate` (server/utils/reportingRules)
 * so the health screen reports the exact same rule the write path enforces.
 * The function never mutates the input and never touches the database.
 */

import { UNASSIGNED_LEVEL, validateReportingManagerCandidate } from './reportingRules.js';

export { UNASSIGNED_LEVEL };

export interface HierarchyUserRow {
  id: string;
  employee_id: string;
  full_name: string;
  manager_id: string | null;
  department_id: string | null;
  is_active?: boolean | null;
  role_code: string | null;
  hierarchy_level?: number | null;
}

export interface InvalidLink {
  employeeId: string;
  employeeName: string;
  reason: string;
}

export interface HierarchyHealth {
  /** All active users placed in the ladder (any level). */
  totalUsers: number;
  /** Ladder users (any level) that currently have a manager_id. */
  usersWithManager: number;
  /** Level 2+ employees that have NO valid reporting manager. */
  usersWithoutManager: number;
  /** Reporting relationships that violate the current ladder rules. */
  invalidLinks: InvalidLink[];
}

/** Resolve a role code to its ladder level (99 = not placed in the ladder). */
export function levelForRole(
  levelByRoleCode: Map<string, number>,
  roleCode: string | null
): number {
  if (!roleCode) return UNASSIGNED_LEVEL;
  const lv = levelByRoleCode.get(String(roleCode).toUpperCase());
  return typeof lv === 'number' && lv > 0 ? lv : UNASSIGNED_LEVEL;
}

/**
 * Compute ladder health (missing-manager count + invalid links) from the
 * raw user rows and a roleCode -> ladder-level map.
 */
export function computeHierarchyHealth(
  users: HierarchyUserRow[],
  levelByRoleCode: Map<string, number>
): HierarchyHealth {
  const byId = new Map<string, HierarchyUserRow>(
    users.map((u) => [u.id, u])
  );

  let usersWithManager = 0; // ladder users (any level) with a manager_id
  let ladderUsers = 0; // all active in-ladder users (informational)
  let managerRequired = 0; // Level 2+ users: MUST have a reporting manager
  let managerRequiredWithManager = 0;
  const invalidLinks: InvalidLink[] = [];

  for (const u of users) {
    if (u.is_active === false) continue;
    const level = levelForRole(levelByRoleCode, u.role_code);
    // Role not placed in the ladder → nothing to validate yet.
    if (level === UNASSIGNED_LEVEL) continue;

    ladderUsers++;
    if (u.manager_id) usersWithManager++;

    if (level === 1) {
      // Level 1 (CEO) is the org root: it must NOT have a reporting
      // manager, and must never be counted as "missing" one.
      if (u.manager_id) {
        invalidLinks.push({
          employeeId: u.employee_id,
          employeeName: u.full_name,
          reason: 'A Level-1 (CEO) employee must not have a reporting manager.',
        });
      }
      continue;
    }

    // Level 2+ employees require exactly one manager (one or two levels above).
    managerRequired++;
    if (!u.manager_id) {
      invalidLinks.push({
        employeeId: u.employee_id,
        employeeName: u.full_name,
        reason: `Level ${level} employee has no reporting manager.`,
      });
      continue;
    }
    managerRequiredWithManager++;

    const manager = byId.get(u.manager_id);
    if (!manager) {
      invalidLinks.push({
        employeeId: u.employee_id,
        employeeName: u.full_name,
        reason: 'Reporting manager not found.',
      });
      continue;
    }

    const managerLevel = levelForRole(levelByRoleCode, manager.role_code);
    const candidateError = validateReportingManagerCandidate({
      employeeLevel: level,
      managerLevel,
      employeeDepartmentId: u.department_id || null,
      managerDepartmentId: manager.department_id || null,
    });
    if (candidateError) {
      invalidLinks.push({
        employeeId: u.employee_id,
        employeeName: u.full_name,
        reason: candidateError,
      });
    }
  }

  // "Missing reporting manager" counts ONLY Level 2+ employees. The
  // Level-1 CEO is the org root and is never counted as missing.
  const usersWithoutManager = Math.max(
    0,
    managerRequired - managerRequiredWithManager
  );

  return {
    totalUsers: ladderUsers,
    usersWithManager,
    usersWithoutManager,
    invalidLinks,
  };
}


/* ====================================================================
   DEPARTMENT HEALTH (F16 Phase D)
   --------------------------------------------------------------------
   The ladder health above answers "is every employee plugged into the
   reporting tree?". This answers the other half of the org model:
   "is every DEPARTMENT plugged into a head and its team?" — the Phase C
   invariant (one department = one mirror team, roster = memberships,
   leader = primary head) plus the scheduling question an admin actually
   asks: which departments still have nobody in charge?

   Pure and database-free on purpose: the API layer hands over the raw rows
   and the screen renders exactly what this returns, so the same rules can be
   unit-tested without a database (and the UI can never invent a value).
==================================================================== */

export interface DepartmentRow {
  id: string;
  name: string;
  is_active?: boolean | null;
}

export interface DepartmentMembershipRow {
  department_id: string;
  user_id: string;
  is_active?: boolean | null;
  is_primary_head?: boolean | null;
  is_head?: boolean | null;
}

export interface MirrorTeamRow {
  id: string;
  department_id: string | null;
  leader_id?: string | null;
  member_ids?: string[] | null;
}

export interface DepartmentDriftRow {
  id: string;
  name: string;
  teamId: string | null;
  membershipCount: number;
  rosterCount: number;
  issues: string[];
}

export interface DepartmentHealth {
  /** false when the database has no department-members layer (migration 046). */
  available: boolean;
  totalDepartments: number;
  /** Departments with members but NO active primary head. */
  headless: Array<{ id: string; name: string; memberCount: number; coHeadCount: number }>;
  /** Departments with nobody in them at all. */
  empty: Array<{ id: string; name: string }>;
  /** Departments whose mirror team is missing, stale or led by the wrong person. */
  teamDrift: DepartmentDriftRow[];
  /** Active employees who belong to no department at all. */
  membersWithoutDepartment: Array<{ employeeId: string; fullName: string }>;
  /** Informational: people who head more than one department (allowed by design). */
  multiDepartmentHeads: Array<{ employeeId: string; fullName: string; departmentCount: number }>;
}

export interface DepartmentHealthInput {
  departments: DepartmentRow[];
  memberships: DepartmentMembershipRow[];
  mirrorTeams: MirrorTeamRow[];
  users: Array<{
    id: string;
    employee_id: string;
    full_name: string;
    department_id: string | null;
    is_active?: boolean | null;
    role_code?: string | null;
  }>;
  /**
   * roleCode -> ladder level. Used only to keep the org root (Level 1 / CEO)
   * and the platform roles (ADMIN/SUPERADMIN) out of the "belongs to no
   * department" list: the same reasoning that keeps a Level-1 employee out of
   * the "missing reporting manager" count — the company root is nobody's
   * subordinate and the admin is not business staff.
   */
  levelByRoleCode?: Map<string, number>;
}

/**
 * Compute department health from raw rows. Never mutates its input, never
 * touches the database and never throws: a department with no members is
 * reported, not skipped, and the drift check compares SETS so roster order
 * can never masquerade as drift.
 */
export function computeDepartmentHealth(input: DepartmentHealthInput): DepartmentHealth {
  const activeMemberships = (input.memberships || []).filter((m) => m?.is_active !== false);
  const membershipsByDepartment = new Map<string, DepartmentMembershipRow[]>();
  for (const m of activeMemberships) {
    const key = String(m.department_id);
    const list = membershipsByDepartment.get(key) || [];
    list.push(m);
    membershipsByDepartment.set(key, list);
  }

  const teamByDepartment = new Map<string, MirrorTeamRow>();
  for (const team of input.mirrorTeams || []) {
    if (team?.department_id) teamByDepartment.set(String(team.department_id), team);
  }

  const userById = new Map((input.users || []).map((u) => [String(u.id), u]));

  const headless: DepartmentHealth['headless'] = [];
  const empty: DepartmentHealth['empty'] = [];
  const teamDrift: DepartmentDriftRow[] = [];

  for (const dept of input.departments || []) {
    if (dept?.is_active === false) continue;
    const id = String(dept.id);
    const members = membershipsByDepartment.get(id) || [];
    const primaryHead = members.find((m) => m.is_primary_head === true) || null;
    const coHeadCount = members.filter((m) => m.is_head === true && m.is_primary_head !== true).length;

    if (members.length === 0) {
      empty.push({ id, name: dept.name });
    } else if (!primaryHead) {
      headless.push({ id, name: dept.name, memberCount: members.length, coHeadCount });
    }

    const team = teamByDepartment.get(id) || null;
    const issues: string[] = [];
    const rosterIds = new Set((team?.member_ids || []).map((x) => String(x)));
    const membershipIds = new Set(members.map((m) => String(m.user_id)));
    const missingFromRoster = [...membershipIds].filter((uid) => !rosterIds.has(uid)).length;
    const staleInRoster = [...rosterIds].filter((uid) => !membershipIds.has(uid)).length;
    if (membershipIds.size !== rosterIds.size || missingFromRoster > 0 || staleInRoster > 0) {
      issues.push('roster-mismatch');
    }
    if (!team) issues.push('missing-team');
    const primaryHeadId = primaryHead ? String(primaryHead.user_id) : null;
    const teamLeaderId = team?.leader_id ? String(team.leader_id) : null;
    if (team && primaryHeadId !== teamLeaderId) issues.push('leader-mismatch');
    if (issues.length > 0) {
      teamDrift.push({
        id,
        name: dept.name,
        teamId: team ? String(team.id) : null,
        membershipCount: membershipIds.size,
        rosterCount: rosterIds.size,
        issues,
      });
    }
  }

  const membershipsByUser = new Map<string, number>();
  for (const m of activeMemberships) {
    const key = String(m.user_id);
    membershipsByUser.set(key, (membershipsByUser.get(key) || 0) + 1);
  }

  const systemRoles = new Set(['ADMIN', 'SUPERADMIN']);
  const membersWithoutDepartment: DepartmentHealth['membersWithoutDepartment'] = [];
  for (const u of input.users || []) {
    if (u?.is_active === false) continue;
    const roleCode = String(u.role_code || '').toUpperCase();
    if (systemRoles.has(roleCode)) continue;
    if (input.levelByRoleCode && levelForRole(input.levelByRoleCode, roleCode) === 1) continue;
    const hasMembership = (membershipsByUser.get(String(u.id)) || 0) > 0;
    if (!hasMembership && !u.department_id) {
      membersWithoutDepartment.push({ employeeId: u.employee_id, fullName: u.full_name });
    }
  }

  const headSeatsByUser = new Map<string, number>();
  for (const m of activeMemberships) {
    if (m.is_head !== true) continue;
    const key = String(m.user_id);
    headSeatsByUser.set(key, (headSeatsByUser.get(key) || 0) + 1);
  }
  const multiDepartmentHeads: DepartmentHealth['multiDepartmentHeads'] = [];
  for (const [userId, count] of headSeatsByUser) {
    if (count < 2) continue;
    const user = userById.get(userId);
    multiDepartmentHeads.push({
      employeeId: user?.employee_id || userId,
      fullName: user?.full_name || '',
      departmentCount: count,
    });
  }

  return {
    available: true,
    totalDepartments: (input.departments || []).filter((d) => d?.is_active !== false).length,
    headless,
    empty,
    teamDrift,
    membersWithoutDepartment,
    multiDepartmentHeads,
  };
}

/** The block returned when the database has no migration-046 layer at all. */
export function emptyDepartmentHealth(totalDepartments = 0): DepartmentHealth {
  return {
    available: false,
    totalDepartments,
    headless: [],
    empty: [],
    teamDrift: [],
    membersWithoutDepartment: [],
    multiDepartmentHeads: [],
  };
}
