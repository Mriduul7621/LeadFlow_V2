import { query } from "../connection.js";

/**
 * 055 — Meeting data model (LeadFlow calendar upgrade, PR B).
 * ------------------------------------------------------------------
 * Until now every `scheduled_activities` row was a piece of planned
 * work ON a lead: `lead_id` was NOT NULL and the only person attached
 * was the single `assigned_to`. Mahadi wants Microsoft-Calendar-style
 * team meetings — any LeadFlow user can book a meeting with
 * colleagues, with no customer lead involved, and the meeting shows
 * on every attendee's calendar. This migration is the data
 * foundation (API in roadshows.routes.ts; UI + reminder delivery in
 * later PRs):
 *
 *   - `lead_id` → DROP NOT NULL. Lead-less rows (internal meetings,
 *     standalone tasks) become legal. Existing rows are untouched;
 *     every read path that assumed a lead now LEFT JOINs (see the
 *     route audit in the PR body).
 *   - `scheduled_activity_attendees` — one row per invited user:
 *     response ('pending' | 'accepted' | 'declined', default
 *     'pending') + responded_at for RSVP. PK (activity_id, user_id)
 *     makes an invite idempotent; ON DELETE CASCADE on the activity
 *     (deleting the event removes its invites, like
 *     roadshow_assignees); the user FK is a plain reference — a user
 *     who is hard-deleted while invited blocks nothing (user deletes
 *     are admin operations that re-point work first).
 *   - `reminder_minutes` — minutes before `scheduled_at` at which
 *     the organiser wants a reminder (NULL = no reminder; 0 = at
 *     start). Column only — the delivery machinery (in-app + push)
 *     ships in the notifications PR.
 *
 * Idempotent — safe to run on every cold start / migration batch.
 * down() is a deliberate non-destructive no-op: re-imposing
 * lead_id NOT NULL would fail (or worse, tempt a data purge) the
 * moment a lead-less meeting exists, and dropping the attendees
 * table would erase RSVP history.
 */
export async function up(): Promise<void> {
  await query(`
    ALTER TABLE scheduled_activities
    ALTER COLUMN lead_id DROP NOT NULL
  `);

  await query(`
    ALTER TABLE scheduled_activities
    ADD COLUMN IF NOT EXISTS reminder_minutes INTEGER
  `);

  // CHECK for reminder_minutes, added idempotently the way migration
  // 054 guards its constraint (existence probed by name first).
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_activities_reminder_minutes_check') THEN
        BEGIN
          ALTER TABLE scheduled_activities
          ADD CONSTRAINT scheduled_activities_reminder_minutes_check
          CHECK (reminder_minutes IS NULL OR reminder_minutes >= 0);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
      END IF;
    END $$;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scheduled_activity_attendees (
      activity_id UUID NOT NULL REFERENCES scheduled_activities(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id),
      response VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (response IN ('pending', 'accepted', 'declined')),
      responded_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (activity_id, user_id)
    )
  `);

  // Attendee-first lookups ("my meetings") — the PK already serves
  // activity-first lookups.
  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activity_attendees_user
    ON scheduled_activity_attendees(user_id)
  `);

  console.log("✅ 055_meeting_data_model migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — see header. Lead-less meetings and their RSVP
  // rows are real user data the moment this ships.
  console.log("ℹ️ 055 down() is a no-op to protect production data.");
}
