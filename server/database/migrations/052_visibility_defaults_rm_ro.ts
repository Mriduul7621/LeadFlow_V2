import { query } from "../connection.js";

/**
 * 052 — narrow the RM / RO default data visibility (organogram fix 1 of 3).
 * ------------------------------------------------------------------
 * The organogram review found the shipped defaults wider than the jobs:
 *
 *   - RM (Relationship Manager) is the FIRST-LINE supervisor — it sits
 *     directly above the RO base agents and manages its own downline.
 *     Its default was 'FullTeam', i.e. EVERY lead in the department,
 *     including sibling managers' teams. It now defaults to 'DownTeam'
 *     (self + reporting subtree).
 *   - RO (Relationship Officer) is the base field agent. Its default
 *     was 'DownTeam'; it now defaults to 'Own', like EMPLOYEE/SBE/BE.
 *
 * MANAGER / SM ('FullTeam', the department-wide roles) and CEO / BH
 * ('Organization') are deliberately untouched.
 *
 * Why a migration at all: the defaults table
 * (src/modules/shared/access/roleGrantDefaults.ts) is only ever APPLIED
 * to rows still holding 'Own' (see roleAccessDefaults.ts), so editing
 * the table fixes fresh installs and untouched roles but can never
 * narrow a database where migration 045 / the seed already WROTE
 * 'FullTeam' (RM) and 'DownTeam' (RO) into the roles table. This
 * migration performs that one-time narrowing on existing data.
 *
 * ADMIN OVERRIDES ARE SACRED: each UPDATE matches ONLY rows still
 * holding the exact old default value. A row an administrator set to
 * anything else — wider OR narrower — is left exactly as they chose.
 * (A stored value identical to the old default is indistinguishable
 * from the untouched default; an admin who wants RM at 'FullTeam'
 * after this deploy can simply re-set it in Roles & Access — nothing
 * will narrow it again: this migration runs once from the ledger, and
 * the defaults applier only ever lifts rows off 'Own'.)
 *
 * Idempotent: a re-run matches no rows. down() is symmetric — it only
 * restores rows still holding exactly the value up() set (the same
 * rule migration 045's rollback follows).
 */

const NARROWINGS: ReadonlyArray<{ roleCode: string; from: string; to: string }> = [
    { roleCode: "RM", from: "FullTeam", to: "DownTeam" },
    { roleCode: "RO", from: "DownTeam", to: "Own" },
];

async function hasVisibilityColumn(): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
        `SELECT EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = 'roles' AND column_name = 'data_visibility'
         ) AS exists`
    );
    return Boolean(result.rows[0]?.exists);
}

export async function up(): Promise<void> {
    if (!(await hasVisibilityColumn())) {
        console.log("⏭️  052_visibility_defaults_rm_ro skipped (roles.data_visibility not present)");
        return;
    }
    for (const { roleCode, from, to } of NARROWINGS) {
        await query(
            `UPDATE roles
                SET data_visibility = $3, updated_at = NOW()
              WHERE UPPER(role_code) = $1
                AND data_visibility = $2`,
            [roleCode, from, to]
        );
    }
    console.log("✅ 052_visibility_defaults_rm_ro migrated");
}

export async function down(): Promise<void> {
    if (!(await hasVisibilityColumn())) return;
    for (const { roleCode, from, to } of [...NARROWINGS].reverse()) {
        await query(
            `UPDATE roles
                SET data_visibility = $2, updated_at = NOW()
              WHERE UPPER(role_code) = $1
                AND data_visibility = $3`,
            [roleCode, from, to]
        );
    }
    console.log("↩️  052_visibility_defaults_rm_ro reverted");
}
