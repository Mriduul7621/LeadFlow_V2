/**
 * AutoAssignmentService — opt-in auto-assignment for unassigned leads
 * (Phase 3 PR #1).
 * ------------------------------------------------------------------
 * Today a lead that arrives WITHOUT an assignee either defaults to its
 * creator (single create) or sits unassigned (bulk import) until a
 * human routes it — and field leads go cold in the gap. When an admin
 * turns the feature ON, the server routes such a lead at arrival time
 * to the least-loaded active member of the creator's team.
 *
 * THE RULE (deterministic, unit-testable):
 *   pool      = the ACTIVE users inside the creator's assignment scope
 *               — the exact set `resolveCallerVisibility` already
 *               computes for manual assignment (DownTeam = reporting
 *               downline, FullTeam = department roster, Organization /
 *               admin = everyone, Own = just the creator). Auto-assign
 *               can therefore never send a lead somewhere a manual
 *               assignment by the same caller would be forbidden.
 *   load      = OPEN leads owned (assigned_to = user, not deleted,
 *               status not in the dictionary's terminal set (DZ-6) —
 *               the same "open" predicate the follow-up queue and the
 *               deactivation transfer use).
 *   pick      = fewest open leads; ties break to the member whose most
 *               recent assignment (leads.assigned_at) is OLDEST —
 *               never-assigned counts as oldest — then employee_id ASC,
 *               so the outcome is fully deterministic.
 *   empty pool -> null. The caller keeps today's behaviour (creator
 *               default / stays unassigned). Never an error.
 *
 * THE SWITCH: one row of the app's existing Metadata Engine —
 * options(field_key='LeadAutoAssignment', option_value='enabled'),
 * is_active = the switch. Seeded INACTIVE by migration 049, so the
 * feature is OFF until an admin enables it (Settings → Overview, or
 * the Metadata/options admin API). No row / no options table = OFF:
 * every read fails closed, so a minimal schema sees zero change.
 *
 * AUDIT PARITY: an auto-assignment is written exactly like a manual
 * one — the canonical leads.assignment_history entry (with a note
 * naming the rule) plus the same server-side assignment notification
 * a manual assignment creates — and additionally recorded in
 * audit_logs under action_code 'leads.auto_assign' so an admin can
 * list every machine-made routing decision.
 */

import { getPool } from '../database/connection.js';
import { fallbackStore } from '../fallbackStore.js';
import { getTerminalStatusNames, getTerminalStatusNamesFallback } from './StageRulesService.js';
import {
  useDb,
  type CallerDbInfo,
  type CallerVisibilityResult,
} from '../routes/production/shared.js';

/* ====================================================================
   Constants — the flag lives in the Metadata Engine (options table)
==================================================================== */

export const AUTO_ASSIGN_OPTION_TYPE = 'LeadAutoAssignment';
export const AUTO_ASSIGN_OPTION_VALUE = 'enabled';
export const AUTO_ASSIGN_RULE = 'least_loaded';
export const AUTO_ASSIGN_HISTORY_NOTE =
  'Auto-assigned by rule: least-loaded active team member';
export const AUTO_ASSIGN_AUDIT_ACTION = 'leads.auto_assign';

/* ====================================================================
   The pure decision function
==================================================================== */

export interface AutoAssignCandidate {
  userId: string;
  employeeId: string;
  /** Open (non-terminal, non-deleted) leads currently owned. */
  openLeads: number;
  /** Most recent leads.assigned_at for this user, or null if never. */
  lastAssignedAt: string | null;
}

export interface AutoAssignPick extends AutoAssignCandidate {
  /** How many active members the pool had when the pick was made. */
  poolSize: number;
}

function lastAssignedTs(candidate: AutoAssignCandidate): number {
  if (!candidate.lastAssignedAt) return Number.NEGATIVE_INFINITY;
  const ts = Date.parse(candidate.lastAssignedAt);
  return Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts;
}

/**
 * Pick the least-loaded candidate. Pure and deterministic:
 *   1. fewest open leads;
 *   2. least-recently assigned (never assigned = oldest);
 *   3. employee_id ascending.
 * Returns null for an empty pool. Never mutates its input.
 */
export function pickAutoAssignee(
  candidates: AutoAssignCandidate[]
): AutoAssignCandidate | null {
  if (!candidates || candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (a.openLeads !== b.openLeads) return a.openLeads - b.openLeads;
    const ta = lastAssignedTs(a);
    const tb = lastAssignedTs(b);
    if (ta !== tb) return ta - tb;
    return String(a.employeeId || '').toUpperCase()
      .localeCompare(String(b.employeeId || '').toUpperCase());
  });
  return sorted[0];
}

/** The canonical assignment_history entry for an auto-assignment. */
export function buildAutoAssignHistoryEntry(
  pick: { employeeId: string },
  changedByEmployeeId: string,
  id: string
): Record<string, any> {
  return {
    id,
    toEmployeeId: pick.employeeId,
    changedBy: changedByEmployeeId,
    date: new Date().toISOString(),
    note: AUTO_ASSIGN_HISTORY_NOTE,
  };
}

/* ====================================================================
   The feature switch (Metadata Engine option; fails closed to OFF)
==================================================================== */

export async function isAutoAssignmentEnabled(): Promise<boolean> {
  if (!useDb()) {
    const row = (fallbackStore.options as any[]).find(
      (o: any) => o.type === AUTO_ASSIGN_OPTION_TYPE && o.value === AUTO_ASSIGN_OPTION_VALUE
    );
    return Boolean(row) && row.status !== 'Inactive';
  }
  try {
    const result = await getPool().query(
      `SELECT is_active FROM options WHERE field_key = $1 AND option_value = $2 LIMIT 1`,
      [AUTO_ASSIGN_OPTION_TYPE, AUTO_ASSIGN_OPTION_VALUE]
    );
    return result.rows[0]?.is_active === true;
  } catch {
    // No options table (minimal schema) or read failure: OFF.
    return false;
  }
}

/* ====================================================================
   Pool loading — PostgreSQL aggregate (one query, never N+1)
==================================================================== */

/**
 * Load the pool candidates for a set of user ids (null = every user),
 * restricted to ACTIVE accounts. Open-lead counts use the app's
 * terminal-status predicate. Any failure (e.g. a minimal schema
 * without a leads table) yields an empty pool — auto-assignment then
 * simply does not happen, instead of breaking the caller's request.
 *
 * CAUTION: pass a POOL (or any non-transaction executor), never a
 * transaction client — a failed query aborts the caller's transaction
 * even though this function swallows the error.
 */
export async function loadAutoAssignCandidates(
  exec: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> },
  poolUserIds: string[] | null
): Promise<AutoAssignCandidate[]> {
  if (poolUserIds !== null && poolUserIds.length === 0) return [];
  try {
    // DZ-6: open-lead counts exclude the dictionary's terminal
    // statuses (isTerminal flag), resolved through the passed
    // executor — never the deleted code constant.
    const terminal = await getTerminalStatusNames(exec);
    const result = await exec.query(
      `SELECT u.id AS user_id,
              u.employee_id AS employee_id,
              (COUNT(l.id) FILTER (WHERE l.current_status <> ALL($2::text[])))::int AS open_leads,
              MAX(l.assigned_at) AS last_assigned_at
         FROM users u
         LEFT JOIN leads l
           ON l.assigned_to = u.id AND l.is_deleted = FALSE
        WHERE ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))
          AND COALESCE(u.is_active, TRUE) = TRUE
        GROUP BY u.id, u.employee_id`,
      [poolUserIds, terminal]
    );
    return result.rows.map((row: any) => ({
      userId: String(row.user_id),
      employeeId: String(row.employee_id || ''),
      openLeads: Number(row.open_leads || 0),
      lastAssignedAt: row.last_assigned_at
        ? new Date(row.last_assigned_at).toISOString()
        : null,
    }));
  } catch {
    return [];
  }
}

/* ====================================================================
   Pool loading — dev-demo (fallbackStore) mirror
==================================================================== */

function demoUserIsActive(user: any): boolean {
  if (!user) return false;
  if (user.isActive === false) return false;
  const statusText = String(user.status ?? user.employmentStatus ?? 'Active');
  return statusText.toLowerCase() !== 'inactive';
}

/**
 * Pure candidate builder over the in-memory demo store. Demo leads
 * carry `assignedTo` as an EMPLOYEE id (the canonical demo shape).
 */
export function buildDemoAutoAssignCandidates(
  poolUserIds: string[] | null
): AutoAssignCandidate[] {
  const pool = poolUserIds === null ? null : new Set(poolUserIds);
  // DZ-6: demo mirror of the dictionary terminal set.
  const terminal = new Set(getTerminalStatusNamesFallback().map(s => s.toLowerCase()));
  const users = (fallbackStore.users as any[]).filter(
    u => (pool === null || pool.has(u.id)) && demoUserIsActive(u)
  );
  return users.map((u: any) => {
    const mine = (fallbackStore.leads as any[]).filter((l: any) => {
      const owner = String(l.assignedTo || '');
      return owner !== '' && (owner === u.employeeId || owner === u.id);
    });
    const openLeads = mine.filter(
      (l: any) => !terminal.has(String(l.currentStatus || '').toLowerCase())
    ).length;
    let lastAssignedAt: string | null = null;
    for (const l of mine) {
      const when = (l as any).assignedDate || l.timestamp || l.creationDate || null;
      if (when && (!lastAssignedAt || String(when) > String(lastAssignedAt))) {
        lastAssignedAt = String(when);
      }
    }
    return {
      userId: String(u.id),
      employeeId: String(u.employeeId || ''),
      openLeads,
      lastAssignedAt,
    };
  });
}

/* ====================================================================
   Entry point used by the lead write paths
==================================================================== */

/**
 * Resolve an auto-assignment for a lead created/imported by `caller`.
 * Returns null when the feature is OFF, the pool is empty, or anything
 * fails — the caller then keeps today's default behaviour untouched.
 *
 * `exec` lets a transactional caller (bulk import) read pool loads
 * inside its own transaction; the single-create path passes the pool.
 */
export async function resolveAutoAssignment(
  caller: CallerDbInfo,
  visibility: CallerVisibilityResult,
  exec?: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }
): Promise<AutoAssignPick | null> {
  try {
    if (!(await isAutoAssignmentEnabled())) return null;
    const poolUserIds = visibility.all ? null : visibility.userIds;
    const candidates = useDb()
      ? await loadAutoAssignCandidates(exec || getPool(), poolUserIds)
      : buildDemoAutoAssignCandidates(poolUserIds);
    const pick = pickAutoAssignee(candidates);
    if (!pick) return null;
    // The pick is by construction an active pool member: a deactivated
    // user, an out-of-scope user, or (for a scoped caller) a stranger
    // can never be returned. The creator receives the lead only when
    // they are themselves in the pool and the rule selects them.
    return { ...pick, poolSize: candidates.length };
  } catch {
    return null;
  }
}
