import { query } from "../connection.js";

/**
 * Lead-status seed is handled by metadata.seed.ts (options of type
 * FollowUpStatus). This module exists to keep the runSeeds contract
 * stable and is a no-op when data already exists.
 */
export async function seedLeadStatus(): Promise<void> {
  const count = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM options WHERE field_key = 'FollowUpStatus'`
  );
  const existing = count.rows[0]?.count ?? 0;
  if (existing === 0) {
    // metadata.seed.ts ran first and should have inserted the defaults;
    // if it did not (e.g. options existed for other types), log clearly
    // so operators know the status pipeline is admin-configured.
    console.log("⚠️ No lead status options found - UI will fall back to built-in defaults until an admin saves statuses.");
  } else {
    console.log(`ℹ️ Lead status options already present (${existing}). Skipping.`);
  }
}
