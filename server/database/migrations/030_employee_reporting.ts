import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS employee_reporting (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            employee_id UUID NOT NULL,
            manager_employee_id UUID,
            relationship_type VARCHAR(30) NOT NULL DEFAULT 'PRIMARY',
            effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
            effective_to DATE,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_employee_reporting_employee
                FOREIGN KEY (employee_id) REFERENCES employees(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT fk_employee_reporting_manager
                FOREIGN KEY (manager_employee_id) REFERENCES employees(id)
                ON UPDATE CASCADE ON DELETE SET NULL,
            CONSTRAINT chk_employee_reporting_dates
                CHECK (effective_to IS NULL OR effective_to >= effective_from)
        );
    `);

    await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_reporting_active
        ON employee_reporting(employee_id, relationship_type)
        WHERE is_active = TRUE;
    `);

    await query(`
        INSERT INTO employee_reporting (
            employee_id,
            manager_employee_id,
            relationship_type,
            is_active
        )
        SELECT child.employee_record_id,
               manager.employee_record_id,
               'PRIMARY',
               COALESCE(child.is_active, TRUE)
        FROM users child
        INNER JOIN users manager ON manager.id = child.manager_id
        WHERE child.employee_record_id IS NOT NULL
          AND manager.employee_record_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    `);

    console.log("✅ 030_employee_reporting migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS employee_reporting;`);
}
