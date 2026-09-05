import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS user_territories (
            user_id UUID NOT NULL,
            territory_id UUID NOT NULL,
            access_level VARCHAR(20) NOT NULL DEFAULT 'VIEW',
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, territory_id),
            CONSTRAINT fk_user_territories_user
                FOREIGN KEY (user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT fk_user_territories_territory
                FOREIGN KEY (territory_id) REFERENCES territories(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT chk_user_territories_access_level
                CHECK (access_level IN ('VIEW', 'MANAGE'))
        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_user_territories_user
        ON user_territories(user_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_user_territories_territory
        ON user_territories(territory_id);
    `);

    console.log("✅ 034_user_territories migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS user_territories;`);
}
