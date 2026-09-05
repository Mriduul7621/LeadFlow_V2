import { query } from "../connection";

const permissions = [
    ["dashboard.view", "Dashboard", "VIEW"],
    ["leads.view", "Leads", "VIEW"],
    ["leads.create", "Leads", "CREATE"],
    ["leads.edit", "Leads", "EDIT"],
    ["leads.delete", "Leads", "DELETE"],
    ["leads.assign", "Leads", "ASSIGN"],
    ["leads.transfer", "Leads", "TRANSFER"],
    ["leads.import", "Leads", "IMPORT"],
    ["leads.export", "Leads", "EXPORT"],
    ["campaigns.view", "Campaigns", "VIEW"],
    ["products.view", "Products", "VIEW"],
    ["users.view", "Users", "VIEW"],
    ["users.create", "Users", "CREATE"],
    ["users.edit", "Users", "EDIT"],
    ["users.delete", "Users", "DELETE"],
    ["users.activate", "Users", "EDIT"],
    ["users.lock", "Users", "EDIT"],
    ["departments.view", "Departments", "VIEW"],
    ["departments.manage", "Departments", "EDIT"],
    ["teams.view", "Teams", "VIEW"],
    ["teams.manage", "Teams", "EDIT"],
    ["roles.view", "Roles", "VIEW"],
    ["roles.manage", "Roles", "EDIT"],
    ["permissions.manage", "Roles", "EDIT"],
    ["reports.view", "Reports", "VIEW"],
    ["workflow.manage", "Workflow", "EDIT"],
    ["notifications.view", "Notifications", "VIEW"],
    ["settings.manage", "Settings", "EDIT"],
    ["hierarchy.manage", "Users", "EDIT"],
    ["audit.view", "Users", "VIEW"],
];

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS permissions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            permission_code VARCHAR(100) UNIQUE NOT NULL,
            module_name VARCHAR(100) NOT NULL,
            action_name VARCHAR(30) NOT NULL,
            description TEXT,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_permissions_module
        ON permissions(module_name);
    `);

    for (const [code, moduleName, actionName] of permissions) {
        await query(
            `
            INSERT INTO permissions (permission_code, module_name, action_name)
            VALUES ($1, $2, $3)
            ON CONFLICT (permission_code) DO NOTHING;
            `,
            [code, moduleName, actionName]
        );
    }

    console.log("✅ 025_permissions migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS permissions;`);
}
