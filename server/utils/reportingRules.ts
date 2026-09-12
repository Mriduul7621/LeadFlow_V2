/**
 * reportingRules.ts — single server-authoritative reporting-manager rule.
 * ------------------------------------------------------------------
 * Centralises the "may employee X report directly to manager Y" rule so that
 * manual user create, manual user edit, bulk user import and the hierarchy
 * health screen all enforce the SAME business rule instead of drifting
 * apart. This module is pure and database-free: identity, active-status and
 * cycle checks are DB-aware and remain with the callers (which already own
 * them correctly); this module owns the level + department authority rule.
 *
 * BUSINESS RULE (Level 1 = CEO, highest authority):
 *   - users.manager_id stays the DIRECT reporting relationship.
 *   - Level 1 (CEO) is the org root: it reports to nobody.
 *   - Roles not placed in the ladder (hierarchy_level >= 99, incl. the
 *     ADMIN/SUPERADMIN system roles and custom roles) keep the existing
 *     optional-manager behavior — they are NOT silently reinterpreted.
 *   - A normal (in-ladder) Level 2+ employee requires a manager whose role
 *     holds STRICTLY higher authority, one OR two levels up. Same level,
 *     lower level, and gaps greater than two levels are all rejected.
 *   - Department rule: only a Level-1 (CEO) manager may sit across
 *     departments; every other manager must share the employee's department.
 */

export const UNASSIGNED_LEVEL = 99;

/** Maximum allowed upward reporting distance (in hierarchy levels). */
export const MAX_REPORTING_GAP = 2;

/** Coerce a raw role hierarchy_level into a ladder level (99 = unassigned). */
export function resolveRoleLevel(raw: number | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : UNASSIGNED_LEVEL;
}

/** True when the level participates in the company reporting ladder. */
export function isLadderLevel(level: number): boolean {
  return level > 0 && level < UNASSIGNED_LEVEL;
}

/** The manager levels an employee at `employeeLevel` may report to (1 or 2 up). */
export function allowedManagerLevels(employeeLevel: number): number[] {
  if (!isLadderLevel(employeeLevel) || employeeLevel === 1) return [];
  const levels: number[] = [];
  for (let gap = 1; gap <= MAX_REPORTING_GAP; gap++) {
    const managerLevel = employeeLevel - gap;
    if (managerLevel >= 1) levels.push(managerLevel);
  }
  return levels;
}

export interface ReportingManagerCandidate {
  /** Employee's resolved ladder level (UNASSIGNED_LEVEL when off-ladder). */
  employeeLevel: number;
  /** Manager's resolved ladder level (UNASSIGNED_LEVEL when off-ladder). */
  managerLevel: number;
  employeeDepartmentId: string | null;
  managerDepartmentId: string | null;
}

/**
 * Validate the level + department parts of a direct-reporting link.
 * Returns a human-readable error message, or null when the link is valid.
 *
 * Identity ("not self"), active-status, "manager exists" and cycle checks
 * are intentionally NOT performed here — callers handle those with the
 * DB. This function is the single authority for the gap/department rule.
 */
export function validateReportingManagerCandidate(
  c: ReportingManagerCandidate
): string | null {
  const { employeeLevel, managerLevel, employeeDepartmentId, managerDepartmentId } = c;

  // Level 1 (CEO) is the org root — it reports to nobody.
  if (employeeLevel === 1) {
    return 'A Level-1 (CEO) employee cannot report to anyone. Leave the reporting manager empty.';
  }

  // Roles outside the ladder keep their existing optional-manager behavior.
  if (!isLadderLevel(employeeLevel)) return null;

  // The manager's role must be placed in the ladder and hold strictly higher
  // authority: one or two levels up.
  if (!isLadderLevel(managerLevel)) {
    return 'Invalid reporting manager: the manager\'s role is not placed in the reporting ladder.';
  }

  const gap = employeeLevel - managerLevel;
  if (gap < 1 || gap > MAX_REPORTING_GAP) {
    const allowed = allowedManagerLevels(employeeLevel);
    const allowedDesc = allowed.length === 1
      ? `Level ${allowed[0]}`
      : `Level ${allowed[0]} or ${allowed[1]}`;
    return `Invalid reporting manager: this role sits at Level ${employeeLevel}, so the manager must hold a ${allowedDesc} role (current manager level: ${managerLevel}).`;
  }

  // Department rule: Level 1 (CEO) is the only cross-department link.
  if (managerLevel !== 1) {
    if (
      !employeeDepartmentId ||
      !managerDepartmentId ||
      String(managerDepartmentId) !== String(employeeDepartmentId)
    ) {
      return 'Invalid reporting manager: the manager must belong to the same department.';
    }
  }

  return null;
}

export interface ReportingManagerRequiredContext {
  employeeLevel: number;
  managerIsRequired: boolean;
  hasManager: boolean;
}

/**
 * Whether a manager is mandatory for this employee. Level 1 (CEO) never
 * needs one; off-ladder roles (level 99) keep optional-manager behavior;
 * in-ladder Level 2+ employees need exactly one when `managerIsRequired`.
 */
export function reportingManagerRequiredError(
  ctx: ReportingManagerRequiredContext
): string | null {
  if (ctx.hasManager) return null;
  if (ctx.employeeLevel === 1) return null;
  if (!isLadderLevel(ctx.employeeLevel)) return null;
  if (ctx.managerIsRequired) {
    return 'A reporting manager is required: select the employee this person reports to (one or two levels up, same department).';
  }
  return null;
}
