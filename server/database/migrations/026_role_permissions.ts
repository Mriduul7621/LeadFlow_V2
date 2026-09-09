import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS role_permissions (
            role_id UUID NOT NULL,
            permission_id UUID NOT NULL,
            is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (role_id, permission_id),
            CONSTRAINT fk_role_permissions_role
                FOREIGN KEY (role_id) REFERENCES roles(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT fk_role_permissions_permission
                FOREIGN KEY (permission_id) REFERENCES permissions(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        );
    `);

    await query(`
        INSERT INTO role_permissions (role_id, permission_id, is_allowed)
        SELECT r.id, p.id, TRUE
        FROM roles r
        CROSS JOIN permissions p
        WHERE UPPER(r.role_code) = 'ADMIN'
        ON CONFLICT (role_id, permission_id) DO UPDATE
        SET is_allowed = TRUE, updated_at = NOW();
    `);

    console.log("✅ 026_role_permissions migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS role_permissions;`);
}
