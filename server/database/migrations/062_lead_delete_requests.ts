import { query } from "../connection.js";

/**
 * 062 — Lead delete requests (owner decision, 2026-11-18).
 * ------------------------------------------------------------------
 * Deleting a lead from the Leads page no longer deletes it at once:
 * the user files a DELETE REQUEST, the admins are notified in-app,
 * and only an admin's approval actually soft-deletes the lead
 * ("admin check kore submit korle then main count hobe" — counts
 * change only after approval). A rejected request leaves the lead
 * untouched; while a request is pending the lead shows a "delete
 * requested" marker and no second request can be filed for it.
 *
 * This migration creates the requests table only — no existing
 * table is touched, no data is backfilled (there are no requests
 * before this release). The partial unique index enforces the
 * one-pending-request-per-lead rule at the database level, so two
 * simultaneous requests for the same lead cannot both land (the
 * server also checks first and answers 409).
 *
 * Numbering note: 061 is RESERVED for the enterprise UX chain's
 * `rm_role_grant_scope` migration, which lives on the ux/* branches
 * and is not on main yet. This migration deliberately takes 062 so
 * the two cannot collide when both merge.
 *
 * down() drops the table (and its indexes with it). Requests are
 * workflow state, not business data — a rollback loses pending
 * requests, never leads.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS lead_delete_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL REFERENCES users(id),
      reason TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reviewed_by UUID REFERENCES users(id),
      reviewed_at TIMESTAMP,
      review_note TEXT
    )
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_delete_requests_pending_unique
      ON lead_delete_requests (lead_id) WHERE status = 'pending'
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_delete_requests_status
      ON lead_delete_requests (status, requested_at DESC)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_delete_requests_lead
      ON lead_delete_requests (lead_id)
  `);
}

export async function down(): Promise<void> {
  await query(`DROP TABLE IF EXISTS lead_delete_requests`);
}
