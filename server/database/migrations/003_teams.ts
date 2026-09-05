import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS teams (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            team_code VARCHAR(30) UNIQUE NOT NULL,

            team_name VARCHAR(100) NOT NULL,

            department_id UUID NOT NULL,

            description TEXT,

            is_active BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMP DEFAULT NOW(),

            updated_at TIMESTAMP DEFAULT NOW(),

            CONSTRAINT fk_team_department
                FOREIGN KEY (department_id)
                REFERENCES departments(id)
                ON DELETE RESTRICT
                ON UPDATE CASCADE

        );
    `);

    console.log("✅ 003_teams migrated");

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS teams CASCADE;
    `);

}