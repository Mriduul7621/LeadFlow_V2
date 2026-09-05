import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS hierarchies (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            user_id UUID NOT NULL UNIQUE,

            manager_id UUID,

            level INTEGER NOT NULL DEFAULT 1,

            path TEXT,

            created_at TIMESTAMP DEFAULT NOW(),

            updated_at TIMESTAMP DEFAULT NOW(),

            CONSTRAINT fk_hierarchy_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE,

            CONSTRAINT fk_hierarchy_manager
                FOREIGN KEY (manager_id)
                REFERENCES users(id)
                ON DELETE SET NULL

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_hierarchy_user
        ON hierarchies(user_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_hierarchy_manager
        ON hierarchies(manager_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_hierarchy_level
        ON hierarchies(level);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS hierarchies CASCADE;
    `);

}