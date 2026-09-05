import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS employees (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            employee_id VARCHAR(30) UNIQUE NOT NULL,

            full_name VARCHAR(150) NOT NULL,

            official_email VARCHAR(150),

            phone VARCHAR(20),

            designation VARCHAR(100),

            profile_photo TEXT,

            joining_date DATE,

            employment_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',

            branch VARCHAR(100),

            region VARCHAR(100),

            area VARCHAR(100),

            district VARCHAR(100),

            office VARCHAR(100),

            channel VARCHAR(100),

            unit VARCHAR(100),

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT chk_employees_employment_status
                CHECK (
                    employment_status IN (
                        'ACTIVE',
                        'INACTIVE',
                        'ON_LEAVE',
                        'SUSPENDED',
                        'RESIGNED',
                        'TERMINATED',
                        'RETIRED'
                    )
                )

        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_employees_employee_id
        ON employees(employee_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_employees_email
        ON employees(official_email);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_employees_status
        ON employees(employment_status);
    `);

    await query(`
        INSERT INTO employees (
            employee_id,
            full_name,
            official_email,
            phone,
            designation,
            profile_photo,
            joining_date,
            employment_status,
            created_at,
            updated_at
        )
        SELECT
            u.employee_id,
            u.full_name,
            u.email,
            u.phone,
            u.designation,
            u.profile_photo,
            u.joining_date,
            CASE
                WHEN COALESCE(u.is_active, TRUE) THEN 'ACTIVE'
                ELSE 'INACTIVE'
            END,
            COALESCE(u.created_at, NOW()),
            COALESCE(u.updated_at, NOW())
        FROM users u
        WHERE NOT EXISTS (
            SELECT 1
            FROM employees e
            WHERE e.employee_id = u.employee_id
        );
    `);

    await query(`
        UPDATE users u
        SET employee_record_id = e.id
        FROM employees e
        WHERE u.employee_record_id IS NULL
          AND e.employee_id = u.employee_id;
    `);

    await query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'fk_users_employee_record'
            ) THEN
                ALTER TABLE users
                ADD CONSTRAINT fk_users_employee_record
                FOREIGN KEY (employee_record_id)
                REFERENCES employees(id)
                ON UPDATE CASCADE
                ON DELETE RESTRICT;
            END IF;
        END
        $$;
    `);

    console.log("✅ 023_employees migrated");

}

export async function down(): Promise<void> {

    await query(`
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM employees) THEN
                RAISE EXCEPTION
                    'Cannot rollback 023_employees while employee records exist.';
            END IF;
        END
        $$;
    `);

    await query(`
        ALTER TABLE users
        DROP CONSTRAINT IF EXISTS fk_users_employee_record;
    `);

    await query(`
        DROP TABLE IF EXISTS employees;
    `);

}
