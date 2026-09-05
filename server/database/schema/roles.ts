export const createRolesTable = `
CREATE TABLE IF NOT EXISTS roles (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    role_name VARCHAR(150) NOT NULL UNIQUE,

    role_code VARCHAR(50) UNIQUE,

    description TEXT,

    hierarchy_level INTEGER DEFAULT 1,

    data_scope VARCHAR(30) DEFAULT 'SELF',

    menu_permissions JSONB DEFAULT '{}'::jsonb,

    feature_permissions JSONB DEFAULT '{}'::jsonb,

    action_permissions JSONB DEFAULT '{}'::jsonb,

    is_system BOOLEAN DEFAULT FALSE,

    status VARCHAR(30) DEFAULT 'ACTIVE'
        CHECK(status IN ('ACTIVE','INACTIVE')),

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP

);
`;

export const createRolesIndexes = `

CREATE INDEX IF NOT EXISTS idx_roles_name
ON roles(role_name);

CREATE INDEX IF NOT EXISTS idx_roles_code
ON roles(role_code);

CREATE INDEX IF NOT EXISTS idx_roles_level
ON roles(hierarchy_level);

`;