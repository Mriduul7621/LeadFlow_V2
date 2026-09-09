import { query } from "../connection.js";

export async function up(): Promise<void> {

    // gen_random_uuid() (used as the PK default by nearly every table)
    // lives in pgcrypto. Managed providers pre-enable it, so this is a
    // no-op there; it only matters for fresh self-hosted databases.
    // Best-effort: without it the CREATE TABLE below fails loudly, as
    // before.
    try {
        await query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    } catch (error: any) {
        console.warn("⚠️ 001: could not ensure pgcrypto extension:", error?.message || error);
    }

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