import { query } from "../connection.js";

/**
 * 040 - Notification delivery idempotency
 * ------------------------------------------------------------------
 * Server-owned business notifications (lead assignment fan-out moved
 * off the browser) must survive retries without duplicating. This
 * migration adds the DB-enforced idempotency identity:
 *
 *   event_key  stable identity of a system-generated notification,
 *              derived from event type + entity + event sequence +
 *              recipient (e.g. lead-assigned:<leadCode>:<seq>:<empKey>).
 *              NEVER a timestamp / random UUID alone.
 *   event_type coarse event class ('lead-assigned'), useful for
 *              diagnosis and future targeted reads.
 *
 * Both columns are NULLABLE and untouched for pre-existing rows and
 * for self-service notifications created through POST /api/notifications,
 * so old rows remain fully readable (all existing reads SELECT n.*).
 *
 * The unique PARTIAL index enforces "at most one row per event_key"
 * only where event_key IS NOT NULL — unlimited NULL event keys
 * (manual/self-service rows) coexist exactly as before.
 *
 * Every statement is idempotent (IF NOT EXISTS), consistent with the
 * 035-style cold-start replay; safe to run on every boot.
 */
export async function up(): Promise<void> {
  await query(`
    ALTER TABLE notifications
      ADD COLUMN IF NOT EXISTS event_key VARCHAR(180),
      ADD COLUMN IF NOT EXISTS event_type VARCHAR(60)
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_event_key
    ON notifications(event_key)
    WHERE event_key IS NOT NULL
  `);
}

export async function down(): Promise<void> {
  await query(`DROP INDEX IF EXISTS uniq_notifications_event_key`);
  await query(`
    ALTER TABLE notifications
      DROP COLUMN IF EXISTS event_key,
      DROP COLUMN IF EXISTS event_type
  `);
}
