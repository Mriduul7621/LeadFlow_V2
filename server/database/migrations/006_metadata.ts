import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS metadata (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            category VARCHAR(100) NOT NULL,

            code VARCHAR(100) NOT NULL,

            name VARCHAR(255) NOT NULL,

            description TEXT,

            sort_order INTEGER DEFAULT 0,

            is_active BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMP DEFAULT NOW(),

            updated_at TIMESTAMP DEFAULT NOW(),

            CONSTRAINT uq_metadata UNIQUE(category, code)

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_metadata_category
        ON metadata(category);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_metadata_active
        ON metadata(is_active);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_metadata_sort
        ON metadata(sort_order);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS metadata CASCADE;
    `);

}