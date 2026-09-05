import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS options (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            field_key VARCHAR(100) NOT NULL,

            option_value VARCHAR(255) NOT NULL,

            option_label VARCHAR(255) NOT NULL,

            sort_order INTEGER DEFAULT 0,

            is_default BOOLEAN DEFAULT FALSE,

            is_active BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMP DEFAULT NOW(),

            updated_at TIMESTAMP DEFAULT NOW(),

            CONSTRAINT uq_field_option
                UNIQUE(field_key, option_value)

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_options_field
        ON options(field_key);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_options_active
        ON options(is_active);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_options_sort
        ON options(sort_order);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS options CASCADE;
    `);

}