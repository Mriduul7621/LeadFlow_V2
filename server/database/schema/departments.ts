export const createDepartmentsTable = `
CREATE TABLE IF NOT EXISTS departments (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    department_name VARCHAR(150) NOT NULL,

    department_code VARCHAR(30) NOT NULL UNIQUE,

    parent_department_id UUID,

    description TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

    created_by UUID,

    updated_by UUID,

    CONSTRAINT chk_department_status
        CHECK (status IN ('ACTIVE','INACTIVE')),

    CONSTRAINT fk_department_parent
        FOREIGN KEY (parent_department_id)
        REFERENCES departments(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_department_created_by
        FOREIGN KEY (created_by)
        REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_department_updated_by
        FOREIGN KEY (updated_by)
        REFERENCES users(id)
        ON DELETE SET NULL

);
`;

export const createDepartmentsIndexes = `

CREATE INDEX IF NOT EXISTS idx_departments_name
ON departments(department_name);

CREATE INDEX IF NOT EXISTS idx_departments_code
ON departments(department_code);

CREATE INDEX IF NOT EXISTS idx_departments_parent
ON departments(parent_department_id);

CREATE INDEX IF NOT EXISTS idx_departments_status
ON departments(status);

CREATE INDEX IF NOT EXISTS idx_departments_created_at
ON departments(created_at);

`;