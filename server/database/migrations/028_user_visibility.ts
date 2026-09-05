import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS user_visibility (
            user_id UUID PRIMARY KEY,
            visibility_level VARCHAR(30) NOT NULL DEFAULT 'SELF',
            custom_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_user_visibility_user
                FOREIGN KEY (user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT chk_user_visibility_level
                CHECK (visibility_level IN (
                    'SELF', 'TEAM', 'TEAM_TREE', 'DEPARTMENT',
                    'BRANCH', 'REGION', 'ORGANIZATION', 'CUSTOM'
                ))
        );
    `);

    await query(`
        INSERT INTO user_visibility (user_id, visibility_level)
        SELECT u.id,
            CASE
                WHEN UPPER(r.role_code) = 'ADMIN' THEN 'ORGANIZATION'
                ELSE 'SELF'
            END
        FROM users u
        INNER JOIN roles r ON r.id = u.role_id
        ON CONFLICT (user_id) DO NOTHING;
    `);

    console.log("✅ 028_user_visibility migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS user_visibility;`);
}
