import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS campaigns (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            campaign_code VARCHAR(50) NOT NULL UNIQUE,

            campaign_name VARCHAR(255) NOT NULL,

            campaign_type VARCHAR(100),

            source VARCHAR(100),

            start_date DATE,

            end_date DATE,

            budget NUMERIC(14,2) DEFAULT 0,

            description TEXT,

            is_active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW()

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_campaign_code
        ON campaigns(campaign_code);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_campaign_name
        ON campaigns(campaign_name);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_campaign_active
        ON campaigns(is_active);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_campaign_source
        ON campaigns(source);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS campaigns CASCADE;
    `);

}