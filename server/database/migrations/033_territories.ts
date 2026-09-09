import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS territories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            parent_id UUID,
            territory_type VARCHAR(30) NOT NULL,
            territory_code VARCHAR(50) NOT NULL,
            territory_name VARCHAR(150) NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_territories_parent
                FOREIGN KEY (parent_id) REFERENCES territories(id)
                ON UPDATE CASCADE ON DELETE SET NULL,
            CONSTRAINT uq_territory_code UNIQUE (territory_type, territory_code),
            CONSTRAINT chk_territory_type
                CHECK (territory_type IN (
                    'REGION', 'AREA', 'DISTRICT', 'BRANCH',
                    'OFFICE', 'CHANNEL', 'UNIT'
                ))
        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_territories_parent
        ON territories(parent_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_territories_type
        ON territories(territory_type);
    `);

    console.log("✅ 033_territories migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS territories;`);
}
