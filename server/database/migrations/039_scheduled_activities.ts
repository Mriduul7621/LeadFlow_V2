import { query } from "../connection.js";

/**
 * 039 — Scheduled Activities (Step 5C)
 * ------------------------------------------------------------------
 * Server-authoritative table for future-dated activities (calls,
 * meetings, follow-ups) that appear on the Dashboard Daily Execution
 * panel and the Task Calendar. Each row is tied to a lead and is
 * visible only when the lead itself is visible to the caller
 * (Own/DownTeam/FullTeam/Organization via resolveVisibility).
 *
 * Business time is Asia/Dhaka (server side). The client never
 * fabricates calendar events from lead fields; it fetches this table.
 *
 * Idempotent — safe to run on every cold start.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call', 'meeting', 'follow_up')),
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL,
      duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_lead_id
    ON scheduled_activities(lead_id);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_scheduled_at
    ON scheduled_activities(scheduled_at);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_lead_scheduled
    ON scheduled_activities(lead_id, scheduled_at);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_status
    ON scheduled_activities(status);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_type
    ON scheduled_activities(activity_type);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_created_by
    ON scheduled_activities(created_by);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_assigned_to
    ON scheduled_activities(assigned_to);
  `);

  // Visibility + range helper for calendar scans:
  // leads join + scheduled_at range is the hot path for GET /api/scheduled-activities.
  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_scheduled_at_status
    ON scheduled_activities(scheduled_at, status);
  `);

  console.log("✅ 039_scheduled_activities migrated");
}

export async function down(): Promise<void> {
  await query(`DROP TABLE IF EXISTS scheduled_activities CASCADE;`);
}
