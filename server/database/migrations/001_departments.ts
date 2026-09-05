import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS departments (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            department_code VARCHAR(30) UNIQUE NOT NULL,

            department_name VARCHAR(100) NOT NULL,

            description TEXT,

            is_active BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMP DEFAULT NOW(),

            updated_at TIMESTAMP DEFAULT NOW()

        );
    `);

    console.log("✅ 001_departments migrated");

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS departments CASCADE;
    `);

}