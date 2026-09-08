import { query } from "../connection";

export const DEFAULT_ROLES: Array<{ code: string; name: string; level: number; description: string }> = [
    { code: "ADMIN", name: "Administrator", level: 1, description: "Full system access" },
    { code: "MANAGER", name: "Manager", level: 2, description: "Manages teams and team leads" },
    { code: "TEAM_LEAD", name: "Team Lead", level: 3, description: "Leads a team of employees" },
    { code: "EMPLOYEE", name: "Employee", level: 4, description: "Standard employee" },
    { code: "SM", name: "Sales Manager", level: 2, description: "Sales manager" },
    { code: "BDM", name: "Business Development Manager", level: 3, description: "Business development manager" },
    { code: "SBE", name: "Senior Business Executive", level: 4, description: "Senior business executive" },
    { code: "BE", name: "Business Executive", level: 5, description: "Business executive" },
];

/**
 * Seeds the default roles only when the roles table is empty.
 */
export async function seedRoles(): Promise<void> {

    const result = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM roles`);
    const count = result.rows[0]?.count ?? 0;

    if (count > 0) {
        console.log(`ℹ️  Roles already present (${count}). Skipping roles seed.`);
        return;
    }

    for (const role of DEFAULT_ROLES) {
        await query(
            `
            INSERT INTO roles (role_code, role_name, hierarchy_level, description, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
            ON CONFLICT (role_code) DO NOTHING
            `,
            [role.code, role.name, role.level, role.description]
        );
    }

    console.log(`✅ Roles seed completed (${DEFAULT_ROLES.length} roles).`);

}
