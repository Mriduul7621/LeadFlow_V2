import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS lead_status (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            status_code VARCHAR(50) NOT NULL UNIQUE,

            status_name VARCHAR(100) NOT NULL,

            color VARCHAR(20),

            sort_order INTEGER NOT NULL DEFAULT 0,

            is_closed BOOLEAN NOT NULL DEFAULT FALSE,

            is_default BOOLEAN NOT NULL DEFAULT FALSE,

            is_active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW()

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_lead_status_code
        ON lead_status(status_code);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_lead_status_active
        ON lead_status(is_active);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_lead_status_sort
        ON lead_status(sort_order);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS lead_status CASCADE;
    `);

}