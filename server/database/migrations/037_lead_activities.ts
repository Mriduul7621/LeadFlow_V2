import { query } from "../connection.js";

/**
 * 037 - Lead Activities (server-authoritative follow-up history)
 * ------------------------------------------------------------------
 * Append-only dedicated table for NEW LeadFlow activities created
 * after the bulk-import snapshot. Each row is tied to a lead and
 * records the business fields of a follow-up event with server-
 * derived actor and timestamp.
 *
 * Idempotent: safe to run on every cold start / migration batch.
 */
export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up',
      status VARCHAR(255),
      remarks TEXT,
      next_follow_up_at TIMESTAMP,
      next_call_at TIMESTAMP,
      meeting_at TIMESTAMP,
      meeting_type VARCHAR(255),
      collected_ncp NUMERIC(14,2),
      projected_ncp NUMERIC(14,2),
      sum_assured NUMERIC(14,2),
      product_name VARCHAR(255),
      loss_reason TEXT,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id
    ON lead_activities(lead_id);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_created_at
    ON lead_activities(lead_id, created_at DESC);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at
    ON lead_activities(created_at DESC);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_created_by
    ON lead_activities(created_by);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_status
    ON lead_activities(status);
  `);

  // Production schema safety: some databases upgraded from main may lack
  // follow_up_count if they predated 014 or were provisioned via a
  // minimal bootstrap. The follow-up route increments this counter, so
  // ensure it exists idempotently without requiring a separate migration.
  await query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS follow_up_count INTEGER NOT NULL DEFAULT 0
  `);

  console.log("✅ 037_lead_activities migrated");
}

export async function down(): Promise<void> {
  await query(`DROP TABLE IF EXISTS lead_activities CASCADE;`);
}
