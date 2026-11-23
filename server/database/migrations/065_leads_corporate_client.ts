import { query } from "../connection.js";

/**
 * 065 — Corporate Group Leads: client link on leads + source seed
 * (Mahadi, 2026-11-24).
 * ------------------------------------------------------------------
 * Shanta Life holds group insurance with a set of companies; the
 * field force sells individual policies to those companies'
 * employees, and management wants per-company tracking: how many
 * employees took a policy, which policy, how much premium. MIS
 * keeps a company-name-wise unique ID for every corporate client.
 *
 * The company MASTER lives in a Google Sheet tab ('Corporate
 * Clients', same workbook as the policy lookup) maintained by MIS —
 * the sheet is read LIVE, so there is deliberately NO corporate
 * clients table here. What the leads table needs is the link:
 *   - `corporate_client_code VARCHAR(50)` — the MIS code, NULL for
 *     ordinary leads. Indexed: the Corporate Group Lead page
 *     filters and groups on it.
 *   - `corporate_client_name VARCHAR(200)` — the company name as a
 *     SNAPSHOT at lead creation, so history survives a later rename
 *     or removal of the client from the sheet.
 *
 * The new Source value is seeded into the options table so the Add
 * Lead form offers it with no manual step (the preview must work
 * end-to-end): field_key 'Source', option_value
 * 'Corporate Client Group Insurance' — ON CONFLICT DO NOTHING, so a
 * re-run (or an admin who already added it by hand) is a no-op.
 *
 * Additive only: no column is renamed, dropped or rewritten, no
 * existing row changes, and the statements are idempotent
 * (IF NOT EXISTS / ON CONFLICT DO NOTHING), so a preview boot
 * running this against the production database is safe — the
 * columns simply appear empty on existing leads.
 *
 * Registration note: 065 has no legacy-adoption sentinel (like 061,
 * 062 and 064), so runMigrations.ts excludes it from the adoption
 * id list — an adopted legacy database still runs it once
 * afterwards.
 */
export async function up(): Promise<void> {
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS corporate_client_code VARCHAR(50)`);
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS corporate_client_name VARCHAR(200)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_leads_corporate_client_code ON leads (corporate_client_code)`);
    await query(`
        INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active)
        SELECT 'Source', 'Corporate Client Group Insurance', 'Corporate Client Group Insurance',
               COALESCE((SELECT MAX(sort_order) + 1 FROM options WHERE field_key = 'Source'), 1),
               FALSE, TRUE
        WHERE NOT EXISTS (
            SELECT 1 FROM options
            WHERE field_key = 'Source' AND option_value = 'Corporate Client Group Insurance'
        )
    `);
}
