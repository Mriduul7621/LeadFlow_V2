export const createEmployeeDepartmentsTable = `
CREATE TABLE IF NOT EXISTS employee_departments (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    department_id UUID NOT NULL
        REFERENCES departments(id)
        ON DELETE CASCADE,

    is_primary BOOLEAN DEFAULT FALSE,

    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(employee_id, department_id)

);
`;

export const createEmployeeDepartmentsIndexes = `

CREATE INDEX IF NOT EXISTS idx_empdept_employee
ON employee_departments(employee_id);

CREATE INDEX IF NOT EXISTS idx_empdept_department
ON employee_departments(department_id);

CREATE INDEX IF NOT EXISTS idx_empdept_primary
ON employee_departments(is_primary);

`;