import { query } from "../connection.js";

/**
 * 037 - lead_activities (server-authoritative follow-up / status activity)
 * ------------------------------------------------------------------
 * Append-only event log for lead follow-up + status activity created
 * INSIDE LeadFlow from now on.
 *
 * Why a table (instead of only the existing `leads.status_history` JSONB):
 *  - Appending to a JSONB column through a read-modify-write round-trip
 *    loses concurrent events. A dedicated table makes "append one row"
 *    the write, so two users logging a follow-up on the same lead can
 *    never overwrite each other.
 *  - The actor (`created_by`) and the event time (`created_at`) are
 *    written by the server only; there is no API that lets a client set
 *    them, so history can no longer be forged.
 *
 * Deliberately NOT populated from the legacy spreadsheet:
 *  the imported sheet is a CURRENT-STATE snapshot (one row per lead, the
 *  state it happened to be in), not a trustworthy event history. This
 *  table therefore starts empty for imported leads and only ever contains
 *  activity that LeadFlow itself observed. `leads.status_history` stays
 *  in place for backward compatibility - the API mirrors every new
 *  activity into it inside the same transaction so existing UI keeps
 *  working, but `lead_activities` is the single authoritative source for
 *  NEW activity.
 *
 * Every statement is idempotent (CREATE TABLE / INDEX IF NOT EXISTS and
 * guarded constraint creation, same style as 035/036) so re-running the
 * migration on a cold start is safe and never rewrites existing data.
 */
export async function up(): Promise<void> {
  // gen_random_uuid() lives in pgcrypto on older/self-hosted servers.
  // Managed providers pre-enable it, so this is normally a no-op; failure
  // is non-fatal because PG13+ also ships the function built in.
  try {
    await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  } catch (error: any) {
    console.warn("⚠️ 037: could not ensure pgcrypto extension:", error?.message || error);
  }

  await query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL,

      /* Event classification. Only 'status_update' is written today; the
         column exists so later activity kinds (note, document, call) can
         share the same append-only stream instead of a second history
         mechanism. */
      activity_type VARCHAR(50) NOT NULL DEFAULT 'status_update',

      /* Business payload of the follow-up (nullable: a follow-up may
         change only the next call date, for example). */
      status VARCHAR(255),
      remarks TEXT,
      next_follow_up_at TIMESTAMP,
      next_call_at TIMESTAMP,
      meeting_at TIMESTAMP,
      meeting_type VARCHAR(150),
      collected_ncp NUMERIC(14,2),
      projected_ncp NUMERIC(14,2),
      sum_assured NUMERIC(14,2),
      product_name VARCHAR(255),
      loss_reason VARCHAR(255),

      /* Audit - server-derived ONLY. There is no public write path that
         accepts these from a client. */
      created_by UUID,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),

      CONSTRAINT chk_lead_activities_collected_ncp
        CHECK (collected_ncp IS NULL OR collected_ncp >= 0),
      CONSTRAINT chk_lead_activities_projected_ncp
        CHECK (projected_ncp IS NULL OR projected_ncp >= 0),
      CONSTRAINT chk_lead_activities_sum_assured
        CHECK (sum_assured IS NULL OR sum_assured >= 0)
    )
  `);

  // ------------------------------------------------------------------
  // Foreign keys (guarded - the table may predate a constraint rename)
  // ------------------------------------------------------------------
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_activities_lead'
      ) THEN
        ALTER TABLE lead_activities
          ADD CONSTRAINT fk_lead_activities_lead
          FOREIGN KEY (lead_id) REFERENCES leads(id)
          ON UPDATE CASCADE ON DELETE CASCADE;
      END IF;
    END
    $$;
  `);
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_lead_activities_created_by'
      ) THEN
        ALTER TABLE lead_activities
          ADD CONSTRAINT fk_lead_activities_created_by
          FOREIGN KEY (created_by) REFERENCES users(id)
          ON UPDATE CASCADE ON DELETE SET NULL;
      END IF;
    END
    $$;
  `);

  // ------------------------------------------------------------------
  // Indexes: the only two read patterns are "a lead's timeline" and
  // "recent activity across the org".
  // ------------------------------------------------------------------
  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_created
    ON lead_activities(lead_id, created_at DESC, id DESC)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at
    ON lead_activities(created_at DESC)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_created_by
    ON lead_activities(created_by)
  `);

  console.log("✅ 037_lead_activities migrated");
}

export async function down(): Promise<void> {
  // Only this PR's new table is dropped - lead current-state and the
  // legacy status_history JSONB are untouched.
  await query(`DROP TABLE IF EXISTS lead_activities CASCADE;`);
  console.log("ℹ️ 037 down(): lead_activities dropped");
}
