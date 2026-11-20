import { query } from "../connection.js";

/**
 * 063_users_add_employee (2026-11-20, Team Lead / Manager workspace)
 * ------------------------------------------------------------------
 * Definition only: inserts the `users.add_employee` permission code
 * into the `permissions` catalog seeded by migration 025, so the
 * Roles & Access editor can grant it per role and the server can
 * enforce it on POST /api/users/employee.
 *
 * NO default grants are created here — no role holds the code until
 * an admin grants it in Roles & Access (the editor's
 * saveRolePermissions call ignores unknown codes server-side, so
 * the definition must exist first). Additive and idempotent: the
 * ON CONFLICT clause makes re-runs a no-op. Safe to run on the
 * production database from a preview boot.
 *
 * Numbering note: 061 is reserved for the enterprise chain's
 * rm_role_grant_scope and 062 (delete-requests table) lives on the
 * work/team-mirror branch — neither exists in this chain's runner,
 * so 063 is the next id here. Ledger ids are independent, so 061 /
 * 062 slot in before it when the chains merge.
 */
export async function up(): Promise<void> {
    await query(
        `
        INSERT INTO permissions (permission_code, module_name, action_name, description)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (permission_code) DO NOTHING;
        `,
        [
            "users.add_employee",
            "Users",
            "ADD_EMPLOYEE",
            "Add Employee-role users reporting to the caller (Team Lead / Manager, admin-granted).",
        ]
    );

    console.log("✅ 063_users_add_employee migrated");
}

export async function down(): Promise<void> {
    await query(`DELETE FROM permissions WHERE permission_code = 'users.add_employee';`);
}
