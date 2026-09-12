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
