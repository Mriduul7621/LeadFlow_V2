import { query } from "../connection.js";

/**
 * 057 — Danger Zone unlocks (Admin Control programme, slice DZ-0).
 * ------------------------------------------------------------------
 * The Danger Zone (Settings → Danger Zone) holds the app's system
 * rules. It is super-admin only, and entering it requires re-entering
 * the login password (a "step-up"). This table is the server-side
 * record of that step-up:
 *
 *   danger_zone_unlocks
 *     id          UUID PK
 *     user_id     UUID FK → users(id) ON DELETE CASCADE, UNIQUE —
 *                 ONE active unlock per super admin (the unlock
 *                 endpoint upserts), so a second unlock replaces the
 *                 first instead of stacking sessions.
 *     created_at  when the password was re-entered
 *     expires_at  created_at + 10 minutes, NON-sliding: no Danger
 *                 Zone action extends it (owner decision 2026-11-11)
 *     created_ip  the IP the unlock was created from (nullable)
 *
 * Storing the unlock server-side — rather than as a second token —
 * gives instant revocation (Lock button, logout, password
 * change/reset, deactivation/role change all delete the row) and an
 * auditable record next to the `danger_zone.*` audit_logs events.
 *
 * Idempotent. down() drops the table (unlock rows are ephemeral
 * session state — no configuration data is lost).
 */
export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS danger_zone_unlocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      created_ip VARCHAR(100)
    )
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS danger_zone_unlocks_user_id_idx
      ON danger_zone_unlocks (user_id)
  `);
}

export async function down(): Promise<void> {
  await query(`DROP TABLE IF EXISTS danger_zone_unlocks`);
}
