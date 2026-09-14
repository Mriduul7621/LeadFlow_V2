import { query } from "../connection.js";

/**
 * 040 — Notification Reliability
 * ------------------------------------------------------------------
 * Adds idempotency and event-typing columns to the notifications table
 * so server-side business flows can create system-generated notifications
 * with DB-enforced deduplication.
 *
 * Design:
 *   - `event_type` classifies the business event (e.g. 'lead-assigned',
 *     'lead-reassigned', 'scheduled-activity-created').
 *   - `idempotency_key` is a stable, deterministic string derived from
 *     (event_type + entity_id + recipient_id + business_event_version).
 *     A UNIQUE partial index on non-null idempotency_key guarantees that
 *     retries of the same business event never create duplicate rows.
 *   - Both columns are nullable so existing notification rows remain
 *     readable without migration.
 *   - Existing generic POST /api/notifications (client self-service)
 *     leaves both columns NULL — those rows are not subject to the
 *     unique constraint.
 *
 * Idempotent — safe to run on every cold start / migration batch.
 */
export async function up(): Promise<void> {
  await query(`
    ALTER TABLE notifications
      ADD COLUMN IF NOT EXISTS event_type VARCHAR(100),
      ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(500)
  `);

  // Unique partial index: only enforced when idempotency_key IS NOT NULL.
  // Client-created generic notifications (NULL key) are unaffected.
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_notifications_idempotency_key'
      ) THEN
        CREATE UNIQUE INDEX idx_notifications_idempotency_key
          ON notifications(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      END IF;
    END
    $$;
  `);

  // Index for event_type lookups (audit/reporting).
  await query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_event_type
    ON notifications(event_type)
    WHERE event_type IS NOT NULL;
  `);

  console.log("✅ 040_notification_reliability migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — columns and indexes remain.
  console.log("ℹ️ 040 down() is a no-op to protect production data.");
}
