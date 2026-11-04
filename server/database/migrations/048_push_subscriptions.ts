import { query } from "../connection.js";

/**
 * 048 — Web Push subscriptions (Phase 2 PR #2, free follow-up reminders).
 * ------------------------------------------------------------------
 * One row per (browser/device) Web Push subscription an agent created
 * when they opted in to the daily follow-up reminder. The daily cron
 * (GET /api/notifications/push/cron-daily) reads this table, sends ONE
 * summary push per user ("আজ Xটি follow-up due, Yটি overdue") and
 * prunes rows whose push service answers 404/410 (subscription gone).
 *
 * Design notes:
 *   - `endpoint` is the push-service URL issued by the browser; it is
 *     globally unique per subscription, so it carries a UNIQUE index
 *     and subscribe is an upsert on it (a device that re-subscribes, or
 *     an endpoint that changes hands, refreshes the same row).
 *   - `p256dh` / `auth` are the subscription's encryption keys from
 *     PushSubscription.toJSON() — required by the Web Push protocol
 *     (RFC 8291) to encrypt the payload for that device.
 *   - `user_id` cascades on user deletion: a deactivated/deleted
 *     account must never keep receiving pushes.
 *   - Zero-cost feature: delivery uses the Web Push protocol only
 *     (the free `web-push` library). No paid push provider is involved.
 *
 * Idempotent: safe on an existing database.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_push_subscriptions_endpoint
    ON push_subscriptions (endpoint)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
    ON push_subscriptions (user_id)
  `);

  console.log("✅ 048_push_subscriptions migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — the table and its rows remain.
  console.log("ℹ️ 048 down() is a no-op to protect production data.");
}
