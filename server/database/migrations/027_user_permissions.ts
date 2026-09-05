import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS user_permissions (
            user_id UUID NOT NULL,
            permission_id UUID NOT NULL,
            is_allowed BOOLEAN NOT NULL,
            reason TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, permission_id),
            CONSTRAINT fk_user_permissions_user
                FOREIGN KEY (user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT fk_user_permissions_permission
                FOREIGN KEY (permission_id) REFERENCES permissions(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_user_permissions_user
        ON user_permissions(user_id);
    `);

    console.log("✅ 027_user_permissions migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS user_permissions;`);
}
