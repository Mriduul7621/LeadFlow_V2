/**
 * NextStepCalendarSync — the Task Calendar mirror of follow-up next steps
 * ------------------------------------------------------------------
 * A status / follow-up update records the agent's next commitment on
 * the follow-up activity (lead_activities.next_follow_up_at /
 * next_call_at / meeting_at) and, for the follow-up date, on the lead
 * row (leads.next_follow_up_at — the Workbench queues' source). The
 * Task Calendar, however, reads ONLY scheduled_activities, so before
 * this service a next step set during a status update never appeared
 * on the calendar (the one exception — "Meeting Fixed" — was mirrored
 * by the LeadUpdate PAGE with a second, unlinked, failure-prone
 * client request; that mirror is retired in favour of this one).
 *
 * This module is the ONE shared server layer every write path uses,
 * so all of them behave identically:
 *
 *   - POST /api/leads/:id/follow-up            → syncNextStepAfterFollowUp
 *     (incl. the offline-capture replays, which re-enter this handler)
 *   - POST /api/scheduled-activities/:id/complete (follow-up branch)
 *                                              → syncNextStepAfterFollowUp
 *   - POST /api/leads (create / upsert)        → reconcileLeadNextStepCalendar
 *   - POST /api/leads/bulk (rows whose sheet supplies a follow-up date)
 *                                              → reconcileLeadNextStepCalendar
 *   - server/routes/leadImport.ts builds LeadRecords for the same
 *     bulk/upsert persistence, so imports reconcile identically.
 *
 * Data model (migration 054): a sync-managed entry is a
 * scheduled_activities row with source_kind NOT NULL and
 * source_activity_id pointing at the follow-up activity whose
 * next step it mirrors (NULL provenance only for entries created by
 * reconcile/backfill when no activity matches). Hand-created entries
 * (source_kind NULL) are NEVER touched by the sync.
 *
 * Sync rules (follow-up flows):
 *   - The follow-up set a next step → the entry for THAT activity is
 *     upserted (one entry per follow-up — the partial UNIQUE index on
 *     source_activity_id enforces it; re-syncing the same activity
 *     MOVES its row instead of duplicating), and every OTHER still
 *     open managed entry for the lead is completed with
 *     completed_activity_id = the new activity: recording a new
 *     follow-up IS working the previous commitment.
 *   - Which datetime/kind: the follow-up's own fields, by precedence
 *     meeting_at ('meeting') > next_call_at ('call') >
 *     next_follow_up_at ('follow_up'). Meeting entries carry the
 *     title `Meeting - <customer name>`, exactly what the retired
 *     client mirror produced; other kinds keep title NULL (the
 *     calendar composes "Follow-up: <name>" / "Call: <name>").
 *   - The follow-up set NO next step → open entries are left alone
 *     (the lead's next_follow_up_at is likewise preserved by those
 *     handlers), UNLESS the lead reached a terminal status
 *     (TERMINAL_LEAD_STATUSES): 'Converted' completes the open entry
 *     (the journey succeeded), 'Not Interested' cancels it (closed —
 *     the same outcome pair the calendar's own complete/cancel
 *     endpoints produce).
 *   - assigned_to is the lead's assignee after the write — the same
 *     default POST /scheduled-activities uses for manual entries.
 *
 * Reconcile rules (lead-save / import flows — no new activity):
 * the lead row is the only truth, so the open managed 'follow_up'
 * entry is made to mirror leads.next_follow_up_at: moved when the
 * datetime changed, created when none exists (provenance = the
 * latest activity whose next_follow_up_at matches, when one does),
 * cancelled when the datetime was cleared or the lead is terminal.
 * Call/meeting entries are NOT moved by reconcile — they mirror
 * activity-level dates the lead row does not govern — but a terminal
 * lead closes every open managed entry.
 *
 * Failure contract: the sync runs INSIDE the caller's transaction,
 * so a real failure rolls the business write back with it (the
 * calendar can never silently diverge). The single exception is a
 * database that predates migration 054 (legacy test fixtures, or a
 * deploy mid-rollout): presence of the 054 columns is PROBED first
 * (information_schema — the migration-053 pattern) and the sync
 * degrades to a logged no-op. Probing rather than catching SQL
 * errors matters: any statement error aborts the caller's whole
 * PostgreSQL transaction, so the sync must decide BEFORE touching
 * scheduled_activities, never fail inside the transaction.
 *
 * Demo mode: the *Demo twins below mirror the same rules over the
 * in-memory fallbackStore (NotificationService convention).
 */

import { TERMINAL_LEAD_STATUSES } from '../utils/businessTime.js';
import { createId } from '../fallbackStore.js';

type Queryable = {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export type NextStepKind = 'call' | 'meeting' | 'follow_up';
export type NextStepSourceKind = 'follow_up' | 'scheduled_complete' | 'lead_save' | 'bulk_import' | 'backfill';

const TERMINAL_SET = new Set<string>(TERMINAL_LEAD_STATUSES.map(s => s.toLowerCase()));

export function isTerminalLeadStatus(status: unknown): boolean {
  return TERMINAL_SET.has(String(status ?? '').trim().toLowerCase());
}

/**
 * The one next step a follow-up commits to, chosen from its own date
 * fields: a fixed meeting is the most concrete commitment, then a
 * promised call, then the generic follow-up date.
 */
export function resolveNextStep(input: {
  meetingAt?: string | null;
  nextCallAt?: string | null;
  nextFollowUpAt?: string | null;
}): { at: string; kind: NextStepKind } | null {
  if (input.meetingAt) return { at: input.meetingAt, kind: 'meeting' };
  if (input.nextCallAt) return { at: input.nextCallAt, kind: 'call' };
  if (input.nextFollowUpAt) return { at: input.nextFollowUpAt, kind: 'follow_up' };
  return null;
}

/**
 * True when migration 054's link columns exist. The probe query
 * itself can never fail on a pre-054 schema (information_schema
 * always exists), so callers' transactions stay healthy either way.
 */
async function hasSyncColumns(db: Queryable): Promise<boolean> {
  const res = await db.query(
    `SELECT (
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'scheduled_activities' AND column_name = 'source_activity_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'scheduled_activities' AND column_name = 'source_kind')
     ) AS ok`
  );
  return Boolean(res.rows[0]?.ok);
}

export interface SyncNextStepAfterFollowUpArgs {
  leadId: string;
  /** The follow-up activity that was just inserted (provenance + link). */
  sourceActivityId: string;
  sourceKind: 'follow_up' | 'scheduled_complete';
  actorId: string | null;
  /** The lead's assignee AFTER the write (scheduled entry default). */
  assignedTo: string | null;
  customerName?: string | null;
  /** The follow-up's next step (from resolveNextStep); null when it set none. */
  nextStepAt: string | null;
  kind: NextStepKind;
  meetingType?: string | null;
  remarks?: string | null;
  leadStatusAfter?: string | null;
  /** A scheduled row the calling flow already closed itself — never re-touched. */
  excludeScheduledId?: string | null;
}

const UPSERT_MANAGED_ENTRY_SQL = `
  INSERT INTO scheduled_activities (
    lead_id, activity_type, title, scheduled_at, remarks, status, priority,
    meeting_type, created_by, assigned_to, updated_by, source_activity_id, source_kind
  ) VALUES ($1, $2, $3, $4, $5, 'scheduled', 'NORMAL', $6, $7, $8, $7, $9, $10)
  ON CONFLICT (source_activity_id) WHERE source_activity_id IS NOT NULL
  DO UPDATE SET
    activity_type = EXCLUDED.activity_type,
    title = EXCLUDED.title,
    scheduled_at = EXCLUDED.scheduled_at,
    remarks = EXCLUDED.remarks,
    meeting_type = EXCLUDED.meeting_type,
    assigned_to = EXCLUDED.assigned_to,
    updated_by = EXCLUDED.updated_by,
    updated_at = NOW(),
    status = 'scheduled',
    completed_at = NULL,
    completed_by = NULL,
    completed_activity_id = NULL,
    source_kind = EXCLUDED.source_kind
  RETURNING id`;

function meetingTitle(kind: NextStepKind, customerName?: string | null): string | null {
  if (kind !== 'meeting') return null;
  const name = String(customerName ?? '').trim();
  return name ? `Meeting - ${name}`.slice(0, 255) : null;
}

/**
 * Apply the follow-up sync rules inside the caller's transaction.
 * Returns { synced: false } only for the pre-054 schema degradation.
 */
export async function syncNextStepAfterFollowUp(
  db: Queryable,
  args: SyncNextStepAfterFollowUpArgs
): Promise<{ synced: boolean }> {
  if (!(await hasSyncColumns(db))) {
    console.warn('[next-step-calendar] sync skipped (pre-054 schema)');
    return { synced: false };
  }
  {
    if (args.nextStepAt) {
      // Supersede: every OTHER open managed entry for this lead was
      // the previous commitment — recording this follow-up worked it.
      await db.query(
        `UPDATE scheduled_activities
            SET status = 'completed', completed_at = NOW(), completed_by = $2,
                completed_activity_id = $3, updated_by = $2, updated_at = NOW()
          WHERE lead_id = $1
            AND source_kind IS NOT NULL
            AND status = 'scheduled'
            AND source_activity_id IS DISTINCT FROM $3
            AND ($4::uuid IS NULL OR id <> $4::uuid)`,
        [args.leadId, args.actorId, args.sourceActivityId, args.excludeScheduledId ?? null]
      );
      await db.query(UPSERT_MANAGED_ENTRY_SQL, [
        args.leadId,
        args.kind,
        meetingTitle(args.kind, args.customerName),
        args.nextStepAt,
        args.remarks ?? null,
        args.meetingType ?? null,
        args.actorId,
        args.assignedTo,
        args.sourceActivityId,
        args.sourceKind,
      ]);
      return { synced: true };
    }

    if (isTerminalLeadStatus(args.leadStatusAfter)) {
      const converted = String(args.leadStatusAfter).trim().toLowerCase() === 'converted';
      if (converted) {
        await db.query(
          `UPDATE scheduled_activities
              SET status = 'completed', completed_at = NOW(), completed_by = $2,
                  completed_activity_id = $3, updated_by = $2, updated_at = NOW()
            WHERE lead_id = $1
              AND source_kind IS NOT NULL
              AND status = 'scheduled'
              AND ($4::uuid IS NULL OR id <> $4::uuid)`,
          [args.leadId, args.actorId, args.sourceActivityId, args.excludeScheduledId ?? null]
        );
      } else {
        await db.query(
          `UPDATE scheduled_activities
              SET status = 'cancelled', updated_by = $2, updated_at = NOW()
            WHERE lead_id = $1
              AND source_kind IS NOT NULL
              AND status = 'scheduled'
              AND ($3::uuid IS NULL OR id <> $3::uuid)`,
          [args.leadId, args.actorId, args.excludeScheduledId ?? null]
        );
      }
      return { synced: true };
    }

    return { synced: true };
  }
}

export interface ReconcileLeadNextStepArgs {
  leadId: string;
  actorId: string | null;
  sourceKind: 'lead_save' | 'bulk_import';
}

/**
 * Mirror leads.next_follow_up_at onto the calendar for write paths
 * that carry no follow-up activity (lead create/upsert, bulk import).
 * Runs inside the caller's transaction; same degradation contract.
 */
export async function reconcileLeadNextStepCalendar(
  db: Queryable,
  args: ReconcileLeadNextStepArgs
): Promise<{ synced: boolean }> {
  if (!(await hasSyncColumns(db))) {
    console.warn('[next-step-calendar] reconcile skipped (pre-054 schema)');
    return { synced: false };
  }
  {
    const leadRes = await db.query(
      `SELECT id, current_status, next_follow_up_at, assigned_to FROM leads WHERE id = $1`,
      [args.leadId]
    );
    const lead = leadRes.rows[0];
    if (!lead) return { synced: false };

    if (isTerminalLeadStatus(lead.current_status)) {
      // A closed lead keeps no open next step, whatever kind it was.
      await db.query(
        `UPDATE scheduled_activities
            SET status = 'cancelled', updated_by = $2, updated_at = NOW()
          WHERE lead_id = $1 AND source_kind IS NOT NULL AND status = 'scheduled'`,
        [args.leadId, args.actorId]
      );
      return { synced: true };
    }

    if (!lead.next_follow_up_at) {
      // Datetime cleared — cancel the managed follow-up entry (the
      // row is preserved for audit; the calendar hides cancelled).
      await db.query(
        `UPDATE scheduled_activities
            SET status = 'cancelled', updated_by = $2, updated_at = NOW()
          WHERE lead_id = $1 AND source_kind IS NOT NULL AND status = 'scheduled'
            AND activity_type = 'follow_up'`,
        [args.leadId, args.actorId]
      );
      return { synced: true };
    }

    const atIso = new Date(lead.next_follow_up_at).toISOString();
    const openRes = await db.query(
      `SELECT id FROM scheduled_activities
        WHERE lead_id = $1 AND source_kind IS NOT NULL AND status = 'scheduled'
          AND activity_type = 'follow_up'
        ORDER BY created_at DESC
        LIMIT 1`,
      [args.leadId]
    );
    if (openRes.rows[0]) {
      // Move the existing entry — never a second one.
      await db.query(
        `UPDATE scheduled_activities
            SET scheduled_at = $2, assigned_to = $3, updated_by = $4, updated_at = NOW()
          WHERE id = $1`,
        [openRes.rows[0].id, atIso, lead.assigned_to ?? null, args.actorId]
      );
      return { synced: true };
    }

    // No open entry: create one, linked to the latest activity whose
    // own next_follow_up_at matches the lead's, when one exists.
    const provRes = await db.query(
      `SELECT id FROM lead_activities
        WHERE lead_id = $1 AND next_follow_up_at = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [args.leadId, atIso]
    );
    const sourceActivityId: string | null = provRes.rows[0]?.id ?? null;
    if (sourceActivityId) {
      await db.query(UPSERT_MANAGED_ENTRY_SQL, [
        args.leadId, 'follow_up', null, atIso, null, null,
        args.actorId, lead.assigned_to ?? null, sourceActivityId, args.sourceKind,
      ]);
    } else {
      await db.query(
        `INSERT INTO scheduled_activities (
           lead_id, activity_type, title, scheduled_at, remarks, status, priority,
           meeting_type, created_by, assigned_to, updated_by, source_activity_id, source_kind
         ) VALUES ($1, 'follow_up', NULL, $2, NULL, 'scheduled', 'NORMAL', NULL, $3, $4, $3, NULL, $5)`,
        [args.leadId, atIso, args.actorId, lead.assigned_to ?? null, args.sourceKind]
      );
    }
    return { synced: true };
  }
}

/* ====================================================================
   Demo (in-memory fallbackStore) mirrors — same rules, plain arrays.
   Demo scheduled rows carry dual camelCase/snake_case fields, exactly
   like the demo branch of POST /scheduled-activities writes them.
==================================================================== */

function demoIsManaged(row: any): boolean {
  return (row.sourceKind ?? row.source_kind) != null;
}

function demoCloseEntry(row: any, outcome: 'completed' | 'cancelled', actorId: string | null, completedActivityId: string | null, nowIso: string): void {
  row.status = outcome;
  if (outcome === 'completed') {
    row.completedAt = nowIso;
    row.completed_at = nowIso;
    row.completedBy = actorId;
    row.completed_by = actorId;
    row.completedActivityId = completedActivityId;
    row.completed_activity_id = completedActivityId;
  }
  row.updatedBy = actorId;
  row.updated_by = actorId;
  row.updatedAt = nowIso;
  row.updated_at = nowIso;
}

export function syncNextStepAfterFollowUpDemo(store: any, args: {
  leadId: string;
  sourceActivityId: string;
  sourceKind: 'follow_up' | 'scheduled_complete';
  actorId: string | null;
  assignedTo: string | null;
  customerName?: string | null;
  nextStepAt: string | null;
  kind: NextStepKind;
  meetingType?: string | null;
  remarks?: string | null;
  leadStatusAfter?: string | null;
  excludeScheduledId?: string | null;
}): void {
  if (!Array.isArray(store.scheduledActivities)) store.scheduledActivities = [];
  const rows: any[] = store.scheduledActivities;
  const nowIso = new Date().toISOString();
  const openManaged = () => rows.filter(r =>
    String(r.leadId ?? r.lead_id) === String(args.leadId) &&
    demoIsManaged(r) &&
    String(r.status).toLowerCase() === 'scheduled' &&
    String(r.id) !== String(args.excludeScheduledId ?? '')
  );

  if (args.nextStepAt) {
    for (const row of openManaged()) {
      if (String(row.sourceActivityId ?? row.source_activity_id ?? '') !== String(args.sourceActivityId)) {
        demoCloseEntry(row, 'completed', args.actorId, args.sourceActivityId, nowIso);
      }
    }
    const existing = rows.find(r => String(r.sourceActivityId ?? r.source_activity_id ?? '') === String(args.sourceActivityId));
    if (existing) {
      existing.activityType = args.kind;
      existing.activity_type = args.kind;
      existing.title = meetingTitle(args.kind, args.customerName);
      existing.scheduledAt = args.nextStepAt;
      existing.scheduled_at = args.nextStepAt;
      existing.remarks = args.remarks ?? null;
      existing.meetingType = args.meetingType ?? null;
      existing.meeting_type = args.meetingType ?? null;
      existing.assignedTo = args.assignedTo;
      existing.assigned_to = args.assignedTo;
      existing.sourceKind = args.sourceKind;
      existing.source_kind = args.sourceKind;
      existing.status = 'scheduled';
      existing.completedAt = null;
      existing.completed_at = null;
      existing.completedBy = null;
      existing.completed_by = null;
      existing.completedActivityId = null;
      existing.completed_activity_id = null;
      existing.updatedBy = args.actorId;
      existing.updated_by = args.actorId;
      existing.updatedAt = nowIso;
      existing.updated_at = nowIso;
    } else {
      rows.push({
        id: createId('sched'),
        leadId: String(args.leadId),
        lead_id: String(args.leadId),
        activityType: args.kind,
        activity_type: args.kind,
        title: meetingTitle(args.kind, args.customerName),
        scheduledAt: args.nextStepAt,
        scheduled_at: args.nextStepAt,
        durationMinutes: null,
        duration_minutes: null,
        remarks: args.remarks ?? null,
        status: 'scheduled',
        priority: 'NORMAL',
        meetingType: args.meetingType ?? null,
        meeting_type: args.meetingType ?? null,
        location: null,
        createdBy: args.actorId,
        created_by: args.actorId,
        assignedTo: args.assignedTo,
        assigned_to: args.assignedTo,
        updatedBy: args.actorId,
        updated_by: args.actorId,
        createdAt: nowIso,
        created_at: nowIso,
        updatedAt: nowIso,
        updated_at: nowIso,
        completedAt: null,
        completed_at: null,
        completedBy: null,
        completed_by: null,
        completedActivityId: null,
        completed_activity_id: null,
        sourceActivityId: args.sourceActivityId,
        source_activity_id: args.sourceActivityId,
        sourceKind: args.sourceKind,
        source_kind: args.sourceKind,
      });
    }
    return;
  }

  if (isTerminalLeadStatus(args.leadStatusAfter)) {
    const converted = String(args.leadStatusAfter).trim().toLowerCase() === 'converted';
    for (const row of openManaged()) {
      demoCloseEntry(row, converted ? 'completed' : 'cancelled', args.actorId, converted ? args.sourceActivityId : null, nowIso);
    }
  }
}

export function reconcileLeadNextStepCalendarDemo(store: any, args: {
  lead: any;
  actorId: string | null;
  sourceKind: 'lead_save' | 'bulk_import';
}): void {
  const lead = args.lead;
  if (!lead) return;
  if (!Array.isArray(store.scheduledActivities)) store.scheduledActivities = [];
  const rows: any[] = store.scheduledActivities;
  const nowIso = new Date().toISOString();
  const leadId = String(lead.id);
  const openManaged = (followUpOnly: boolean) => rows.filter(r =>
    String(r.leadId ?? r.lead_id) === leadId &&
    demoIsManaged(r) &&
    String(r.status).toLowerCase() === 'scheduled' &&
    (!followUpOnly || String(r.activityType ?? r.activity_type) === 'follow_up')
  );

  if (isTerminalLeadStatus(lead.currentStatus ?? lead.current_status)) {
    for (const row of openManaged(false)) demoCloseEntry(row, 'cancelled', args.actorId, null, nowIso);
    return;
  }
  const nextAt: string | null = lead.nextFollowUpDate ?? lead.next_follow_up_at ?? null;
  if (!nextAt) {
    for (const row of openManaged(true)) demoCloseEntry(row, 'cancelled', args.actorId, null, nowIso);
    return;
  }
  const atIso = new Date(nextAt).toISOString();
  const existing = openManaged(true)
    .sort((a, b) => new Date(b.createdAt ?? b.created_at).getTime() - new Date(a.createdAt ?? a.created_at).getTime())[0];
  const assignedTo = lead.assignedTo ?? lead.assigned_to ?? null;
  if (existing) {
    existing.scheduledAt = atIso;
    existing.scheduled_at = atIso;
    existing.assignedTo = assignedTo;
    existing.assigned_to = assignedTo;
    existing.updatedBy = args.actorId;
    existing.updated_by = args.actorId;
    existing.updatedAt = nowIso;
    existing.updated_at = nowIso;
    return;
  }
  const activities: any[] = Array.isArray(store.leadActivities) ? store.leadActivities : [];
  const prov = activities
    .filter(a => String(a.leadId ?? a.lead_id) === leadId && (a.nextFollowUpAt ?? a.next_follow_up_at))
    .filter(a => new Date(a.nextFollowUpAt ?? a.next_follow_up_at).getTime() === new Date(atIso).getTime())
    .sort((a, b) => new Date(b.createdAt ?? b.created_at).getTime() - new Date(a.createdAt ?? a.created_at).getTime())[0];
  rows.push({
    id: createId('sched'),
    leadId,
    lead_id: leadId,
    activityType: 'follow_up',
    activity_type: 'follow_up',
    title: null,
    scheduledAt: atIso,
    scheduled_at: atIso,
    durationMinutes: null,
    duration_minutes: null,
    remarks: null,
    status: 'scheduled',
    priority: 'NORMAL',
    meetingType: null,
    meeting_type: null,
    location: null,
    createdBy: args.actorId,
    created_by: args.actorId,
    assignedTo,
    assigned_to: assignedTo,
    updatedBy: args.actorId,
    updated_by: args.actorId,
    createdAt: nowIso,
    created_at: nowIso,
    updatedAt: nowIso,
    updated_at: nowIso,
    completedAt: null,
    completed_at: null,
    completedBy: null,
    completed_by: null,
    completedActivityId: null,
    completed_activity_id: null,
    sourceActivityId: prov ? String(prov.id) : null,
    source_activity_id: prov ? String(prov.id) : null,
    sourceKind: args.sourceKind,
    source_kind: args.sourceKind,
  });
}
