import { query } from "../connection.js";

/**
 * 058 — UM-1: designation is the person's JOB TITLE, kept separate
 * from the access role (owner's role-model fix, 2026-11-11).
 * ------------------------------------------------------------------
 * The `users.designation` column itself is NOT new — it has existed
 * since migration 004. What was broken is how it was filled: the
 * create paths defaulted an empty designation to the literal
 * placeholder 'Officer' for EVERYONE, so the stored title said
 * nothing about the person and the form conflated title with role.
 *
 * UM-1 separates the two concepts:
 *   - designation = job title (FA / UM / BM / "Relationship Officer" /
 *     whatever HR calls the job) — free text on the user record;
 *   - role        = the access bundle (what the person can do and,
 *     via its data_visibility, the ceiling of what they can see).
 *
 * This migration only repairs stored data:
 *   1. ADD COLUMN IF NOT EXISTS — a no-op on every real database
 *      (the column exists since 004); it keeps a hypothetical
 *      pre-004 schema from breaking the backfill below.
 *   2. Backfill: users whose designation is NULL or empty receive
 *      their role's display name (roles.role_name, falling back to
 *      the role code) — the same default new users get from UM-1 on.
 *
 * Deliberately NOT touched: rows holding the legacy 'Officer'
 * placeholder. A real title can legitimately contain "Officer"
 * (Relationship Officer is a genuine Shanta Life title), so the
 * placeholder cannot be told apart from a real value — those rows
 * stay for an admin to correct in the user form, where UM-1 now
 * shows Designation as its own field.
 *
 * Idempotent: the backfill only fills NULL/empty values, so a
 * re-run changes nothing. down() is a deliberate no-op — restoring
 * empty titles would undo data repair with no benefit.
 */
export async function up(): Promise<void> {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS designation VARCHAR(100)`);
    await query(
        `UPDATE users u
            SET designation = COALESCE(NULLIF(TRIM(r.role_name), ''), r.role_code)
           FROM roles r
          WHERE u.role_id = r.id
            AND (u.designation IS NULL OR TRIM(u.designation) = '')`
    );
}

export async function down(): Promise<void> {
    // Deliberate no-op (see header): the backfilled titles are real
    // data the moment this ships.
}
