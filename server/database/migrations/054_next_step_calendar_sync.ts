import { query } from "../connection.js";

/**
 * 054 — Next-step calendar sync (LeadFlow calendar upgrade, PR A).
 * ------------------------------------------------------------------
 * A status / follow-up update has always recorded the agent's next
 * commitment on the lead row (`leads.next_follow_up_at`) and on the
 * follow-up activity (`lead_activities.next_follow_up_at` /
 * `next_call_at` / `meeting_at`). The Workbench queues read the lead
 * column — but the Task Calendar reads ONLY `scheduled_activities`,
 * so a next step set during a status update never appeared on the
 * calendar. This migration adds the link that lets the server keep a
 * managed calendar entry in sync with every follow-up's next step
 * (see services/NextStepCalendarSync.ts for the sync rules):
 *
 *   - `source_activity_id` — the follow-up activity whose next-step
 *     datetime this entry mirrors (provenance). NULL for entries a
 *     person created by hand and for backfilled entries whose lead
 *     has no matching activity. ON DELETE SET NULL: deleting the
 *     history row must never delete the calendar entry.
 *   - `source_kind` — how a SYNC-MANAGED entry came to exist
 *     ('follow_up' | 'scheduled_complete' | 'lead_save' |
 *     'bulk_import' | 'backfill'). NULL = hand-created entry; the
 *     sync only ever touches rows whose source_kind IS NOT NULL, so
 *     manual calendar entries are never moved or closed by it.
 *
 *   - A UNIQUE partial index on (source_activity_id) enforces the
 *     core invariant — ONE calendar entry per follow-up activity —
 *     at the database level, so retries / replays / concurrent
 *     follow-ups cannot duplicate an entry.
 *   - A partial index on (lead_id) for open managed rows serves the
 *     sync's hot lookup ("this lead's still-open next-step entry").
 *
 * Backfill (idempotent): every non-deleted lead whose
 * `next_follow_up_at` is set and whose status is NOT terminal
 * (Converted / Not Interested — TERMINAL_LEAD_STATUSES) gains a
 * managed 'scheduled' entry at that datetime, assigned to the lead's
 * current assignee, linked to the LATEST follow-up activity whose
 * own next_follow_up_at matches the lead's (when one exists, so the
 * entry carries real provenance). Terminal leads are skipped on
 * purpose: their journey is closed, and the Workbench follow-up
 * queue excludes them for the same reason. The NOT EXISTS guards
 * make a re-run a no-op (a lead that already has an open managed
 * entry, or an activity that already has an entry, is never
 * duplicated).
 *
 * Idempotent — safe to run on every cold start / migration batch.
 */
export async function up(): Promise<void> {
  await query(`
    ALTER TABLE scheduled_activities
    ADD COLUMN IF NOT EXISTS source_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL
  `);

  await query(`
    ALTER TABLE scheduled_activities
    ADD COLUMN IF NOT EXISTS source_kind VARCHAR(30)
  `);

  // CHECK for source_kind, added idempotently the way migration 039
  // guards its constraint replacements (PGlite may name constraints
  // differently, so existence is probed by name first).
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_activities_source_kind_check') THEN
        BEGIN
          ALTER TABLE scheduled_activities
          ADD CONSTRAINT scheduled_activities_source_kind_check
          CHECK (source_kind IS NULL OR source_kind IN ('follow_up', 'scheduled_complete', 'lead_save', 'bulk_import', 'backfill'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
      END IF;
    END $$;
  `);

  // One calendar entry per follow-up activity — the sync's upsert
  // target. Partial: hand-created rows (NULL source) never collide.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_activities_source_activity
    ON scheduled_activities(source_activity_id)
    WHERE source_activity_id IS NOT NULL
  `);

  // The sync's per-lead lookup: the still-open managed entry.
  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_next_step_open
    ON scheduled_activities(lead_id)
    WHERE source_kind IS NOT NULL AND status = 'scheduled'
  `);

  // Backfill — populate the calendar from day one (see header).
  await query(`
    INSERT INTO scheduled_activities (
      lead_id, activity_type, title, scheduled_at, remarks, status, priority,
      meeting_type, location, created_by, assigned_to, updated_by,
      source_activity_id, source_kind
    )
    SELECT
      l.id, 'follow_up', NULL, l.next_follow_up_at, NULL, 'scheduled', 'NORMAL',
      NULL, NULL, l.updated_by, l.assigned_to, l.updated_by,
      la.id, 'backfill'
    FROM leads l
    LEFT JOIN LATERAL (
      SELECT a.id
      FROM lead_activities a
      WHERE a.lead_id = l.id
        AND a.next_follow_up_at = l.next_follow_up_at
      ORDER BY a.created_at DESC
      LIMIT 1
    ) la ON TRUE
    WHERE l.next_follow_up_at IS NOT NULL
      AND l.is_deleted = FALSE
      AND UPPER(l.current_status) NOT IN ('CONVERTED', 'NOT INTERESTED')
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_activities sa
        WHERE sa.lead_id = l.id
          AND sa.source_kind IS NOT NULL
          AND sa.status = 'scheduled'
      )
      AND (
        la.id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM scheduled_activities sa2
          WHERE sa2.source_activity_id = la.id
        )
      )
  `);

  console.log("✅ 054_next_step_calendar_sync migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — the link columns and the backfilled entries
  // remain. Dropping them would erase the provenance that ties
  // calendar entries to the follow-ups that created them.
  console.log("ℹ️ 054 down() is a no-op to protect production data.");
}
