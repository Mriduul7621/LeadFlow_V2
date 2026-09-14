import { query } from "../connection.js";

/**
 * 041 — Scheduled activity "open" index (database performance audit)
 * ------------------------------------------------------------------
 * Adds ONE evidence-based partial index identified by the production
 * query audit (docs/DATABASE_PERFORMANCE_AUDIT.md).
 *
 * Hot query served — fetchScheduledQualitySignals() in
 * server/utils/leadQualitySignals.ts, executed on EVERY dashboard,
 * lead list, follow-up queue, scheduled-activity list and single-lead
 * read (Lead Quality is scored at read time):
 *
 *   SELECT s.lead_id, MIN(s.scheduled_at)
 *     FROM scheduled_activities s
 *    WHERE s.lead_id = ANY($1::uuid[])
 *      AND s.status = 'scheduled'
 *    GROUP BY s.lead_id
 *
 * Why existing indexes are insufficient:
 *   - idx_scheduled_activities_lead_scheduled (lead_id, scheduled_at)
 *     matches the lead_id predicate, but the status filter is applied
 *     AFTER the index scan (Filter), so completed/cancelled history —
 *     which grows forever while the open set stays small — is fetched
 *     and discarded on every request.
 *   - EXPLAIN evidence (isolated PGlite, 3k leads / 15k scheduled
 *     activities): the partial index removes the post-filter step and
 *     cuts buffer hits ~2x (see docs/DATABASE_PERFORMANCE_AUDIT.md).
 *
 * Partial-index trade-off:
 *   - Read benefit: highest-frequency aggregate in the app (runs for
 *     every page that scores leads) touches only still-open rows.
 *   - Write cost: index maintenance only on rows whose status is
 *     'scheduled' (insert + the single transition out of scheduled on
 *     complete/cancel). scheduled_activities is far less write-heavy
 *     than leads; no impact on leads/notifications write paths.
 *   - Storage: strictly smaller than the equivalent full index because
 *     completed/cancelled rows are excluded.
 *
 * Idempotent — safe to run on every cold start / migration batch.
 * No data rewrite, no table locks beyond an ordinary CREATE INDEX.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_activities_open_lead
    ON scheduled_activities(lead_id, scheduled_at)
    WHERE status = 'scheduled'
  `);

  console.log("✅ 041_scheduled_activity_open_index migrated");
}

export async function down(): Promise<void> {
  await query(`DROP INDEX IF EXISTS idx_scheduled_activities_open_lead`);
}
