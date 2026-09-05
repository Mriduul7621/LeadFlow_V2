export const createHierarchiesTable = `
CREATE TABLE IF NOT EXISTS hierarchies (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID
        REFERENCES users(id)
        ON DELETE CASCADE,

    manager_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    department_id UUID
        REFERENCES departments(id)
        ON DELETE SET NULL,

    team_id UUID
        REFERENCES teams(id)
        ON DELETE SET NULL,

    role_id UUID
        REFERENCES roles(id)
        ON DELETE SET NULL,

    hierarchy_level INTEGER DEFAULT 1,

    hierarchy_path TEXT,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP

);
`;

export const createHierarchiesIndexes = `

CREATE INDEX IF NOT EXISTS idx_hierarchy_user
ON hierarchies(user_id);

CREATE INDEX IF NOT EXISTS idx_hierarchy_manager
ON hierarchies(manager_id);

CREATE INDEX IF NOT EXISTS idx_hierarchy_department
ON hierarchies(department_id);

`;