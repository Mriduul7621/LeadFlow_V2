import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS employee_departments (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            employee_id UUID NOT NULL,

            department_id UUID NOT NULL,

            is_primary BOOLEAN NOT NULL DEFAULT FALSE,

            assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),

            ended_at TIMESTAMP,

            is_active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT fk_employee_departments_employee
                FOREIGN KEY (employee_id)
                REFERENCES employees(id)
                ON UPDATE CASCADE
                ON DELETE CASCADE,

            CONSTRAINT fk_employee_departments_department
                FOREIGN KEY (department_id)
                REFERENCES departments(id)
                ON UPDATE CASCADE
                ON DELETE RESTRICT,

            CONSTRAINT uq_employee_department
                UNIQUE (employee_id, department_id)

        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_employee_departments_employee
        ON employee_departments(employee_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_employee_departments_department
        ON employee_departments(department_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_employee_departments_active
        ON employee_departments(is_active);
    `);

    await query(`
        INSERT INTO employee_departments (
            employee_id,
            department_id,
            is_primary,
            assigned_at,
            is_active
        )
        SELECT
            e.id,
            u.department_id,
            TRUE,
            COALESCE(u.created_at, NOW()),
            COALESCE(u.is_active, TRUE)
        FROM users u
        INNER JOIN employees e
            ON e.employee_id = u.employee_id
        WHERE u.department_id IS NOT NULL
        ON CONFLICT (employee_id, department_id) DO UPDATE
        SET is_primary = TRUE,
            is_active = EXCLUDED.is_active,
            updated_at = NOW();
    `);

    console.log("✅ 024_employee_departments migrated");

}

export async function down(): Promise<void> {

    await query(`
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM employee_departments) THEN
                RAISE EXCEPTION
                    'Cannot rollback 024_employee_departments while assignments exist.';
            END IF;
        END
        $$;
    `);

    await query(`
        DROP TABLE IF EXISTS employee_departments;
    `);

}
