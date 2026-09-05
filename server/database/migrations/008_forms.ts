import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS forms (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            form_key VARCHAR(100) NOT NULL UNIQUE,

            form_name VARCHAR(255) NOT NULL,

            description TEXT,

            fields JSONB NOT NULL DEFAULT '[]'::jsonb,

            version INTEGER NOT NULL DEFAULT 1,

            is_active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW()

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_forms_key
        ON forms(form_key);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_forms_active
        ON forms(is_active);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS forms CASCADE;
    `);

}