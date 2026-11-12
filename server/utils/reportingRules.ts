/**
 * reportingRules.ts — single server-authoritative reporting-manager rule.
 * ------------------------------------------------------------------
 * Centralises the "may employee X report directly to manager Y" rule so that
 * manual user create, manual user edit, bulk user import and the hierarchy
 * health screen all apply the SAME business rule instead of drifting
 * apart. This module is pure and database-free: identity, active-status and
 * cycle checks are DB-aware and remain with the callers (which already own
 * them correctly); this module owns the level + department judgement.
 *
 * BUSINESS RULE — UM-1 (owner's role-model fix, 2026-11-11).
 * Before UM-1 the level gap (1–2 up) and the same-department rule were
 * HARD BLOCKS on every write path, and the create form's manager picker
 * only listed candidates passing both — so the real line manager often
 * could not be selected or saved at all whenever the org did not match
 * the textbook ladder. The owner replaced that model:
 *   - users.manager_id stays the DIRECT reporting relationship.
 *   - A manager may be ANY active user. The only hard rules left are
 *     the ones callers enforce with the DB: not self, no cycle, the
 *     manager must exist and be active, and Level 1 (CEO) gets none.
 *   - The gap and department shape of a link are ADVISORY: unusual
 *     links (gap > 2, same-or-lower level, off-ladder manager,
 *     cross-department) are accepted and reported as WARNINGS by the
 *     hierarchy-health screen (`reportingLinkWarnings`), never blocked.
 *   - Level 1 (CEO) is the org root: it reports to nobody — the one
 *     hard rule this pure module still owns.
 *   - Roles not placed in the ladder (hierarchy_level >= 99, incl. the
 *     ADMIN/SUPERADMIN system roles and custom roles) keep the existing
 *     optional-manager behavior — they are NOT silently reinterpreted.
 *   - A normal (in-ladder) Level 2+ employee still REQUIRES a manager
 *     (`reportingManagerRequiredError`) — UM-1 unblocks WHO the manager
 *     may be, not WHETHER one is needed.
 *
 * DZ-7 (Danger Zone, audit §2.3 C2/C4): the two numbers behind the
 * warnings are no longer frozen in this file. The super admin edits
 * them in the Danger Zone (`HierarchyRulesService` — one versioned
 * Metadata row, code values as fallback) and every place that runs
 * the health check reads the LIVE rules and passes them in as the
 * `rules` argument below. The shape is the same either way:
 *   - `maxReportingGap` (audit bound 1–3, default 2): the widest
 *     manager gap the health check still calls normal.
 *   - `requireSameDepartment` (default true): while on, a link whose
 *     manager belongs to a different department is flagged; while
 *     off, the health check ignores department shape entirely.
 * The knobs configure what gets FLAGGED, never what gets BLOCKED —
 * no DZ-7 value can re-impose a UM-1 write-path block, and the
 * Level-1 root rule plus the Level-1 cross-department exception
 * stay hardcoded here (§3.4). Callers that pass no `rules` get the
 * code defaults, so the pure functions stay usable without a DB.
 */

export const UNASSIGNED_LEVEL = 99;

/** Maximum allowed upward reporting distance (in hierarchy levels). */
export const MAX_REPORTING_GAP = 2;

/** C2 (DZ-7, audit bound): the maximum reporting gap is 1–3 levels. */
export const MAX_REPORTING_GAP_MIN = 1;
export const MAX_REPORTING_GAP_MAX = 3;

/**
 * The DZ-7 hierarchy knobs (audit §2.3 C2/C4) — the live values a
 * super admin edits in the Danger Zone. `HierarchyRulesService`
 * stores the versioned row and resolves these at request time;
 * this pure module only defines the shape and the code defaults.
 */
export interface HierarchyRulesShape {
  /** C2 — widest manager gap the health check calls normal (1–3). */
  maxReportingGap: number;
  /** C4 — flag cross-department reporting links as warnings. */
  requireSameDepartment: boolean;
}

/** Code defaults (today's behaviour): gap 2, department shape flagged. */
export const DEFAULT_HIERARCHY_RULES: HierarchyRulesShape = {
  maxReportingGap: MAX_REPORTING_GAP,
  requireSameDepartment: true,
};

/** Coerce a raw role hierarchy_level into a ladder level (99 = unassigned). */
export function resolveRoleLevel(raw: number | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : UNASSIGNED_LEVEL;
}

/** True when the level participates in the company reporting ladder. */
export function isLadderLevel(level: number): boolean {
  return level > 0 && level < UNASSIGNED_LEVEL;
}

/** The manager levels an employee at `employeeLevel` may report to (1 or 2 up, or up to `maxGap`). */
export function allowedManagerLevels(employeeLevel: number, maxGap: number = MAX_REPORTING_GAP): number[] {
  if (!isLadderLevel(employeeLevel) || employeeLevel === 1) return [];
  const levels: number[] = [];
  for (let gap = 1; gap <= maxGap; gap++) {
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
  /**
   * Every department the manager belongs to — their primary department plus
   * any ADDITIONAL seats (active `department_members` rows). A Head can head
   * several departments, so "same department" means the employee's
   * department is ANY of the manager's departments, not only the primary
   * one. When omitted/null the single `managerDepartmentId` stands alone
   * (the historical behaviour for callers that cannot load memberships).
   */
  managerDepartmentIds?: Array<string | null | undefined> | null;
}

/**
 * Validate the level + department parts of a direct-reporting link.
 * Returns a human-readable error message, or null when the link is valid.
 *
 * UM-1: the ONLY hard error left here is the Level-1 rule — a CEO
 * reports to nobody. Gap shape and department shape no longer block;
 * they are reported by `reportingLinkWarnings` instead. Identity
 * ("not self"), active-status, "manager exists" and cycle checks are
 * intentionally NOT performed here — callers handle those with the DB.
 */
export function validateReportingManagerCandidate(
  c: ReportingManagerCandidate
): string | null {
  // Level 1 (CEO) is the org root — it reports to nobody.
  if (c.employeeLevel === 1) {
    return 'A Level-1 (CEO) employee cannot report to anyone. Leave the reporting manager empty.';
  }
  return null;
}

/**
 * Advisory warnings for a direct-reporting link (UM-1). A link that
 * produces warnings is VALID and saves normally — the hierarchy-health
 * screen lists these so an admin can spot unusual shapes (a gap of
 * more than the configured maximum, a manager at the same or a lower
 * level, an off-ladder manager, a cross-department link) without the
 * write path ever refusing the real line manager again.
 *
 * DZ-7: `rules` carries the live Danger Zone knobs (default = code
 * defaults). `maxReportingGap` sets the gap threshold; when
 * `requireSameDepartment` is off, department shape is not flagged
 * at all. The Level-1 cross-department exception stays in code: a
 * CEO manager is never flagged for department shape.
 */
export function reportingLinkWarnings(
  c: ReportingManagerCandidate,
  rules: HierarchyRulesShape = DEFAULT_HIERARCHY_RULES
): string[] {
  const { employeeLevel, managerLevel, employeeDepartmentId, managerDepartmentId, managerDepartmentIds } = c;
  const warnings: string[] = [];
  const maxGap = rules.maxReportingGap;

  // Level 1 (CEO) has no manager at all; off-ladder employees keep
  // their optional-manager behaviour — neither produces shape warnings.
  if (employeeLevel === 1 || !isLadderLevel(employeeLevel)) return warnings;

  if (!isLadderLevel(managerLevel)) {
    warnings.push('The reporting manager\'s role is not placed in the reporting ladder.');
    return warnings;
  }

  const gap = employeeLevel - managerLevel;
  if (gap < 1) {
    warnings.push(`The reporting manager sits at Level ${managerLevel}, which is not above this employee's Level ${employeeLevel}.`);
  } else if (gap > maxGap) {
    warnings.push(`The reporting manager is ${gap} levels above this employee — more than the usual ${maxGap}.`);
  }

  // Department shape (C4, DZ-7): only flagged while the
  // same-department requirement is switched on. A Level-1 (CEO)
  // manager legitimately sits above every department. Anyone else
  // whose departments (primary + additional seats) do not include
  // the employee's department makes the link cross-department —
  // accepted, but flagged.
  if (rules.requireSameDepartment && managerLevel !== 1) {
    const managerDepartments = new Set<string>();
    if (managerDepartmentId) managerDepartments.add(String(managerDepartmentId));
    if (Array.isArray(managerDepartmentIds)) {
      for (const id of managerDepartmentIds) {
        if (id) managerDepartments.add(String(id));
      }
    }
    if (!employeeDepartmentId || !managerDepartments.has(String(employeeDepartmentId))) {
      warnings.push('The reporting manager belongs to a different department.');
    }
  }

  return warnings;
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
    return 'A reporting manager is required: select the employee this person reports to.';
  }
  return null;
}
