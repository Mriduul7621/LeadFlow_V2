import { query } from "../connection.js";

/**
 * 064 — IDRA FA Code on users (Mahadi, 2026-11-21).
 * ------------------------------------------------------------------
 * Payroll (DSF) staff carry TWO identifiers: the HR Employee ID and
 * the IDRA FA Code under which all of their policy sales are booked.
 * The field force likewise sells under FA codes. Until now LeadFlow
 * stored only the Employee ID, so the conversion policy lookup
 * compared the sheet's FA Code against the assignee's Employee ID
 * and warned on every DSF conversion even when the sale was correct.
 *
 * This migration adds the optional column:
 *   - `idra_fa_code VARCHAR(30)` — NULL means "not recorded yet"
 *     (the field is optional at user creation; existing users are
 *     filled in later, one by one or by bulk import).
 *   - UNIQUE (via a unique index): one person = one FA code, so the
 *     code can also serve as a login identifier alongside the
 *     Employee ID and the email. PostgreSQL unique indexes allow
 *     any number of NULLs, so "optional" and "unique" coexist.
 *
 * Additive only: no column is renamed, dropped or rewritten, no
 * existing row changes, and the statements are idempotent
 * (IF NOT EXISTS), so a preview boot running this against the
 * production database is safe — the column simply appears empty.
 *
 * Registration note: 064 has no legacy-adoption sentinel (like 061
 * and 062), so runMigrations.ts excludes it from the adoption id
 * list — an adopted legacy database still runs it once afterwards.
 */
export async function up(): Promise<void> {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS idra_fa_code VARCHAR(30)`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_idra_fa_code ON users (idra_fa_code)`);
}
