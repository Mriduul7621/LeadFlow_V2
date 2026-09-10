import { query } from "../connection.js";

/**
 * 038 — Follow-up queue indexes (Step 4B)
 * Partial index on next_follow_up_at for non-deleted leads, plus
 * assigned_to + next_follow_up_at for scoped queue scans.
 * Does not drop any existing indexes.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up_active
    ON leads (next_follow_up_at)
    WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_leads_assigned_next_follow_up_active
    ON leads (assigned_to, next_follow_up_at)
    WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL
  `);

  console.log("✅ 038_followup_queue_indexes migrated");
}

export async function down(): Promise<void> {
  await query(`DROP INDEX IF EXISTS idx_leads_assigned_next_follow_up_active`);
  await query(`DROP INDEX IF EXISTS idx_leads_next_follow_up_active`);
}
