import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS products (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            product_code VARCHAR(50) NOT NULL UNIQUE,

            product_name VARCHAR(255) NOT NULL,

            short_name VARCHAR(100),

            description TEXT,

            category VARCHAR(100),

            is_active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW()

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_products_code
        ON products(product_code);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_products_name
        ON products(product_name);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_products_active
        ON products(is_active);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS products CASCADE;
    `);

}