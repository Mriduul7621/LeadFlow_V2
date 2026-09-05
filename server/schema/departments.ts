export const createDepartmentsTable = `
CREATE TABLE IF NOT EXISTS departments (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    department_name VARCHAR(150) NOT NULL,

    department_code VARCHAR(30) UNIQUE,

    parent_department_id UUID REFERENCES departments(id)
        ON DELETE SET NULL,

    description TEXT,

    status VARCHAR(30) DEFAULT 'ACTIVE',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);
`;

export const createDepartmentsIndexes = `

CREATE INDEX IF NOT EXISTS idx_departments_name
ON departments(department_name);

CREATE INDEX IF NOT EXISTS idx_departments_code
ON departments(department_code);

CREATE INDEX IF NOT EXISTS idx_departments_parent
ON departments(parent_department_id);

`;