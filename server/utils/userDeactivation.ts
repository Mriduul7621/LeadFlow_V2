/**
 * userDeactivation.ts
 * ------------------------------------------------------------------
 * Phase E of the user-management plan: a person can no longer be switched
 * off while they still own live leads.
 *
 * Why it exists: deactivation used to be a single column flip. The leads the
 * person owned kept pointing at a disabled account — nobody was notified,
 * nobody followed them up, and the follow-up queue quietly lost them. Every
 * deactivation checklist in the industry runs the same order: **freeze →
 * export → reassign → deactivate**, with no auto-transfer (the replacement is
 * a judgement call a human has to make, not something the system may invent).
 *
 * So this module does three things and nothing else:
 *
 *   1. `summarizeOpenLeads` — how many OPEN leads would be stranded, plus a
 *      short sample the admin can see before deciding.
 *   2. `transferOpenLeads` — move them to the chosen colleague in the caller's
 *      transaction, appending the canonical `leads.assignment_history` entry
 *      (actor + timestamp), re-pointing `assigned_*`, and notifying the new
 *      owner through the same notification path a manual reassignment uses.
 *   3. `fetchInactiveOwnersWithOpenLeads` — the drift report for people who
 *      were switched off before this rule existed (or archived by an import).
 *
 * "Open" is NOT defined here. It is the app's existing terminal-status
 * vocabulary (`TERMINAL_LEAD_STATUSES`), the very same predicate the
 * follow-up queue uses — a converted or "not interested" lead is finished
 * business and must never be dragged onto somebody else's desk.
 */

import { TERMINAL_LEAD_STATUSES } from './businessTime.js';
import { createAssignmentNotifications } from '../services/NotificationService.js';

/** The terminal (finished) statuses, as a plain array for SQL `ANY(...)`. */
export const TERMINAL_STATUSES: string[] = [...TERMINAL_LEAD_STATUSES];

export interface OpenLeadRef {
  id: string;
  leadCode: string;
  customerName: string;
  mobile: string;
  currentStatus: string;
}

export interface OpenLeadSummary {
  /** false when this database has no `leads` table at all (minimal test schema). */
  available: boolean;
  count: number;
  sample: OpenLeadRef[];
}

export interface TransferResult {
  transferred: number;
  leadCodes: string[];
  /** Notifications are best-effort (see the SAVEPOINT below). */
  notified: number;
}

/** Read-only capability probe — never memoized (one process, many databases). */
export async function hasLeadsTable(client: any): Promise<boolean> {
  try {
    const res = await client.query(`SELECT to_regclass('public.leads') IS NOT NULL AS present`);
    return res.rows[0]?.present === true;
  } catch {
    return false;
  }
}

/**
 * How many OPEN leads does this person own, and what do the first few look
 * like? A database without a leads table answers `available: false` instead
 * of throwing, so a minimal schema keeps working.
 */
export async function summarizeOpenLeads(
  client: any,
  userId: string,
  sampleLimit = 10
): Promise<OpenLeadSummary> {
  if (!userId || !(await hasLeadsTable(client))) {
    return { available: false, count: 0, sample: [] };
  }
  const counted = await client.query(
    `SELECT COUNT(*)::int AS count FROM leads l
      WHERE l.assigned_to = $1
        AND l.is_deleted = FALSE
        AND l.current_status <> ALL($2::text[])`,
    [userId, TERMINAL_STATUSES]
  );
  const count = counted.rows[0]?.count ?? 0;
  if (count === 0) return { available: true, count: 0, sample: [] };

  const rows = await client.query(
    `SELECT l.id, l.lead_code, l.customer_name, l.mobile, l.current_status
       FROM leads l
      WHERE l.assigned_to = $1
        AND l.is_deleted = FALSE
        AND l.current_status <> ALL($2::text[])
      ORDER BY l.created_at DESC
      LIMIT $3`,
    [userId, TERMINAL_STATUSES, Math.max(1, Math.min(50, sampleLimit))]
  );
  return {
    available: true,
    count,
    sample: rows.rows.map((r: any) => ({
      id: String(r.id),
      leadCode: r.lead_code || '',
      customerName: r.customer_name || '',
      mobile: r.mobile || '',
      currentStatus: r.current_status || '',
    })),
  };
}

/**
 * Move every OPEN lead from `fromUserId` to `toUserId`, inside the caller's
 * transaction. For each lead:
 *
 *   - `assigned_to` / `assigned_by` / `assigned_at` are re-pointed and
 *     `previous_assigned_to` keeps where it came from (the app's existing
 *     transfer contract);
 *   - `assignment_history` gets ONE appended entry in the canonical shape
 *     (fromEmployeeId, toEmployeeId, changedBy, date, note) — history is
 *     append-only, so the old owner is never erased from the record;
 *   - the new owner is notified through the SAME notification path a manual
 *     reassignment uses (idempotency key included, so a retry cannot double
 *     the notification).
 *
 * The notification write is wrapped in a SAVEPOINT: a notification failure
 * must not roll back a deactivation the administrator asked for, but it also
 * must not poison the caller's transaction (a swallowed statement error would
 * otherwise abort the COMMIT).
 */
export async function transferOpenLeads(
  client: any,
  opts: {
    fromUserId: string;
    fromEmployeeId: string;
    toUserId: string;
    toEmployeeId: string;
    actorUserId?: string | null;
    actorEmployeeId: string;
    note?: string;
  }
): Promise<TransferResult> {
  if (!(await hasLeadsTable(client))) return { transferred: 0, leadCodes: [], notified: 0 };

  const note = opts.note || `Transferred when ${opts.fromEmployeeId} was deactivated`;
  const updated = await client.query(
    `UPDATE leads l SET
       previous_assigned_to = l.assigned_to,
       assigned_to = $2,
       assigned_by = $3,
       assigned_at = NOW(),
       updated_by = $3,
       updated_at = NOW(),
       assignment_history = COALESCE(l.assignment_history, '[]'::jsonb) || jsonb_build_array(
         jsonb_build_object(
           'id', 'assign_xfer_' || (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint || '_' || LEFT(l.id::text, 8),
           -- every value is cast explicitly: jsonb_build_object cannot infer the
           -- type of a bare placeholder, and the driver would answer
           -- "could not determine data type of parameter $4".
           'fromEmployeeId', $4::text,
           'toEmployeeId', $5::text,
           'changedBy', $6::text,
           'date', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'note', $7::text
         )
       )
     WHERE l.assigned_to = $1
       AND l.is_deleted = FALSE
       AND l.current_status <> ALL($8::text[])
     RETURNING l.id, l.lead_code, l.customer_name, l.assignment_history`,
    [
      opts.fromUserId,
      opts.toUserId,
      opts.actorUserId || null,
      opts.fromEmployeeId,
      opts.toEmployeeId,
      opts.actorEmployeeId,
      note,
      TERMINAL_STATUSES,
    ]
  );

  let notified = 0;
  for (const row of updated.rows) {
    const history: any[] = Array.isArray(row.assignment_history) ? row.assignment_history : [];
    const latest = history.length > 0 ? history[history.length - 1] : null;
    await client.query('SAVEPOINT xfer_notify');
    try {
      await createAssignmentNotifications(client, {
        leadId: String(row.id),
        leadCode: String(row.lead_code || ''),
        prospectName: String(row.customer_name || 'Unknown'),
        assignedToUserId: opts.toUserId,
        assignedToEmployeeId: opts.toEmployeeId,
        changedByEmployeeId: opts.actorEmployeeId,
        eventType: 'lead-reassigned',
        assignmentHistoryId: String(latest?.id || `assign_xfer_${row.id}`),
      });
      await client.query('RELEASE SAVEPOINT xfer_notify');
      notified += 1;
    } catch {
      try {
        await client.query('ROLLBACK TO SAVEPOINT xfer_notify');
      } catch {
        /* the savepoint is already gone — nothing left to release */
      }
    }
  }

  return {
    transferred: updated.rowCount ?? updated.rows.length,
    leadCodes: updated.rows.map((r: any) => String(r.lead_code || '')),
    notified,
  };
}

/**
 * The drift report: people who are NOT active yet still own open leads —
 * switched off before this rule existed, or imported that way. `GET
 * /hierarchy-config` renders it so the admin can fix it from one screen (open
 * the person, pick a replacement, save = the same transfer path).
 */
export async function fetchInactiveOwnersWithOpenLeads(
  client: any
): Promise<Array<{ employeeId: string; fullName: string; openLeadCount: number }>> {
  if (!(await hasLeadsTable(client))) return [];
  const rows = await client.query(
    `SELECT u.employee_id, u.full_name, COUNT(l.id)::int AS open_lead_count
       FROM users u
       JOIN leads l ON l.assigned_to = u.id
      WHERE u.is_active = FALSE
        AND l.is_deleted = FALSE
        AND l.current_status <> ALL($1::text[])
      GROUP BY u.id, u.employee_id, u.full_name
      ORDER BY open_lead_count DESC, u.employee_id ASC`,
    [TERMINAL_STATUSES]
  );
  return rows.rows.map((r: any) => ({
    employeeId: r.employee_id,
    fullName: r.full_name,
    openLeadCount: r.open_lead_count ?? 0,
  }));
}

/**
 * Open-lead counts for a set of users — one aggregate query for the whole
 * roster (never one query per row), so the Users screen can warn BEFORE the
 * administrator submits a deactivation.
 */
export async function fetchOpenLeadCountMap(
  client: any,
  userIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!userIds || userIds.length === 0 || !(await hasLeadsTable(client))) return map;
  const rows = await client.query(
    `SELECT l.assigned_to AS user_id, COUNT(*)::int AS count
       FROM leads l
      WHERE l.assigned_to = ANY($1::uuid[])
        AND l.is_deleted = FALSE
        AND l.current_status <> ALL($2::text[])
      GROUP BY l.assigned_to`,
    [userIds, TERMINAL_STATUSES]
  );
  for (const row of rows.rows) {
    map.set(String(row.user_id), row.count ?? 0);
  }
  return map;
}
