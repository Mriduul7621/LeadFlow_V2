import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS team_members (
            team_id UUID NOT NULL,
            employee_id UUID NOT NULL,
            is_leader BOOLEAN NOT NULL DEFAULT FALSE,
            joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
            left_at TIMESTAMP,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            PRIMARY KEY (team_id, employee_id),
            CONSTRAINT fk_team_members_team
                FOREIGN KEY (team_id) REFERENCES teams(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT fk_team_members_employee
                FOREIGN KEY (employee_id) REFERENCES employees(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        );
    `);

    await query(`
        INSERT INTO team_members (team_id, employee_id, is_active)
        SELECT u.team_id, u.employee_record_id, COALESCE(u.is_active, TRUE)
        FROM users u
        WHERE u.team_id IS NOT NULL
          AND u.employee_record_id IS NOT NULL
        ON CONFLICT (team_id, employee_id) DO UPDATE
        SET is_active = EXCLUDED.is_active;
    `);

    console.log("✅ 029_team_members migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS team_members;`);
}
