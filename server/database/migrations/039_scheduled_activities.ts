import { query } from "../connection.js";

/**
 * 039 — Scheduled Activities (Step 5C)
 * ------------------------------------------------------------------
 * Server-authoritative table for future-dated activities (calls,
 * meetings, follow-ups, tasks) that appear on the Dashboard Daily
 * Execution panel and the Task Calendar. Each row is tied to a lead
 * and is visible only when the lead itself is visible to the caller
 * (Own/DownTeam/FullTeam/Organization via resolveVisibility).
 *
 * Architecture: scheduled_activities = planned work (mutable until
 * completed/cancelled), lead_activities = immutable completed history.
 *
 * Business time is Asia/Dhaka (server side). The client never
 * fabricates calendar events from lead fields; it fetches this table.
 *
 * Idempotent — safe to run on every cold start / migration batch.
 * Extends safely for TASK, priority, meeting_type, location,
 * updated_by, completed_at/by, completed_activity_id.
 */
export async function up(): Promise<void> {
  // Base table — now includes TASK and all BLOCKER 4 fields.
  // For already-provisioned DBs, the ADD COLUMN IF NOT EXISTS alters below
  // backfill the new columns without recreating the table.
  await query(`
    CREATE TABLE IF NOT EXISTS scheduled_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call', 'meeting', 'follow_up', 'task')),
      title VARCHAR(255),
      scheduled_at TIMESTAMP NOT NULL,
      duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
      remarks TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL',
      meeting_type VARCHAR(255),
      location VARCHAR(255),
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      completed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL
    );
  `);

  // Idempotent backfill for DBs provisioned with the earlier 039 (call/meeting/follow_up only)
  await query(`ALTER TABLE scheduled_activities ADD COLUMN IF NOT EXISTS priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL'`);
  await query(`ALTER TABLE scheduled_activities ADD COLUMN IF NOT EXISTS meeting_type VARCHAR(255)`);
  await query(`ALTER TABLE scheduled_activities ADD COLUMN IF NOT EXISTS location VARCHAR(255)`);
  await query(`ALTER TABLE scheduled_activities ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE scheduled_activities ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP`);
  await query(`ALTER TABLE scheduled_activities ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES users(id) ON DELETE SET NULL`);
  await query(`ALTER TABLE scheduled_activities ADD COLUMN IF NOT EXISTS completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL`);

  // Widen activity_type CHECK to include TASK (idempotent)
  // Older DBs have constraint scheduled_activities_activity_type_check = IN ('call','meeting','follow_up')
  await query(`
    DO $$
    BEGIN
      -- Drop the old check if it exists and does not already allow 'task'
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'scheduled_activities_activity_type_check'
      ) THEN
        -- Inspect the definition; if it does not mention 'task', replace it
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'scheduled_activities_activity_type_check'
            AND pg_get_constraintdef(oid) LIKE '%task%'
        ) THEN
          ALTER TABLE scheduled_activities DROP CONSTRAINT scheduled_activities_activity_type_check;
          ALTER TABLE scheduled_activities ADD CONSTRAINT scheduled_activities_activity_type_check CHECK (activity_type IN ('call', 'meeting', 'follow_up', 'task'));
        END IF;
      ELSE
        -- No named constraint — add one if missing (covers PGlite which may not name it)
        BEGIN
          ALTER TABLE scheduled_activities ADD CONSTRAINT scheduled_activities_activity_type_check CHECK (activity_type IN ('call', 'meeting', 'follow_up', 'task'));
        EXCEPTION WHEN duplicate_object THEN
          -- already exists under a different name or with task
          NULL;
        END;
      END IF;
    END $$;
  `);

  // Ensure status check exists (scheduled/completed/cancelled)
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_activities_status_check') THEN
        BEGIN
          ALTER TABLE scheduled_activities ADD CONSTRAINT scheduled_activities_status_check CHECK (status IN ('scheduled', 'completed', 'cancelled'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
      END IF;
    END $$;
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

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_updated_by
    ON scheduled_activities(updated_by);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_completed_by
    ON scheduled_activities(completed_by);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_completed_activity
    ON scheduled_activities(completed_activity_id);
  `);

  // Visibility + range helper for calendar scans:
  // leads join + scheduled_at range is the hot path for GET /api/scheduled-activities.
  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_scheduled_at_status
    ON scheduled_activities(scheduled_at, status);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_priority
    ON scheduled_activities(priority);
  `);

  console.log("✅ 039_scheduled_activities migrated");
}

export async function down(): Promise<void> {
  await query(`DROP TABLE IF EXISTS scheduled_activities CASCADE;`);
}
