import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS users (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            employee_id VARCHAR(30) UNIQUE NOT NULL,

            full_name VARCHAR(150) NOT NULL,

            email VARCHAR(150) UNIQUE NOT NULL,

            phone VARCHAR(20),

            password VARCHAR(255) NOT NULL,

            role_id UUID NOT NULL,

            department_id UUID,

            team_id UUID,

            manager_id UUID,

            designation VARCHAR(100),

            joining_date DATE,

            profile_photo TEXT,

            last_login TIMESTAMP,

            is_active BOOLEAN DEFAULT TRUE,

            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            CONSTRAINT fk_users_role
                FOREIGN KEY (role_id)
                REFERENCES roles(id)
                ON UPDATE CASCADE
                ON DELETE RESTRICT,

            CONSTRAINT fk_users_department
                FOREIGN KEY (department_id)
                REFERENCES departments(id)
                ON UPDATE CASCADE
                ON DELETE SET NULL,

            CONSTRAINT fk_users_team
                FOREIGN KEY (team_id)
                REFERENCES teams(id)
                ON UPDATE CASCADE
                ON DELETE SET NULL,

            CONSTRAINT fk_users_manager
                FOREIGN KEY (manager_id)
                REFERENCES users(id)
                ON UPDATE CASCADE
                ON DELETE SET NULL

        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_employee_id
        ON users(employee_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_email
        ON users(email);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_role
        ON users(role_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_manager
        ON users(manager_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_department
        ON users(department_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_team
        ON users(team_id);
    `);

    console.log("✅ 004_users migrated");

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS users CASCADE;
    `);

}