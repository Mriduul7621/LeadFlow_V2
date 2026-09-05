import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS roles (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            role_code VARCHAR(30) UNIQUE NOT NULL,

            role_name VARCHAR(100) NOT NULL,

            hierarchy_level INTEGER NOT NULL,

            description TEXT,

            is_active BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMP DEFAULT NOW(),

            updated_at TIMESTAMP DEFAULT NOW()

        );
    `);

    console.log("✅ 002_roles migrated");

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS roles CASCADE;
    `);

}