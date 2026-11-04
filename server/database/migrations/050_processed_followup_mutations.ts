import { query } from "../connection.js";

/**
 * 050 — Processed follow-up mutations (Phase 3 PR #2, offline capture).
 * ------------------------------------------------------------------
 * One row per client-generated mutation id that the follow-up write
 * path (POST /api/leads/:id/follow-up) has APPLIED. Field agents can
 * now submit a follow-up from a low-network area: the client keeps the
 * submission in an on-device outbox and retries with the SAME
 * `clientMutationId` until it gets a definitive answer. This table is
 * what makes the retry safe:
 *
 *   - The handler CLAIMS the id inside the follow-up transaction
 *     (INSERT ... ON CONFLICT DO NOTHING). Only the claim winner
 *     applies the follow-up (status change + follow_up_count + 1 +
 *     activity row) — exactly once.
 *   - Before returning, the winner stores the response snapshot
 *     (`response_body`); a later retry with the same id is answered
 *     from the snapshot WITHOUT re-applying anything.
 *   - Requests that carry no `clientMutationId` never touch this
 *     table and behave exactly as they did before this feature.
 *
 * `lead_id` / `user_id` are audit context (which lead the mutation
 * applied to, whose submission it was); they are deliberately NOT
 * foreign keys — a processed-mutation record must survive its lead
 * being deleted so a late retry can still be answered honestly.
 *
 * Idempotent: safe on an existing database.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS processed_followup_mutations (
      mutation_id UUID PRIMARY KEY,
      lead_id UUID,
      user_id UUID,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
      response_body JSONB
    )
  `);

  console.log("✅ 050_processed_followup_mutations migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — the table and its rows remain.
  console.log("ℹ️ 050 down() is a no-op to protect production data.");
}
