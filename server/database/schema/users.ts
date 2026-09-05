export const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_id VARCHAR(30) NOT NULL UNIQUE,

    full_name VARCHAR(150) NOT NULL,

    email VARCHAR(150) UNIQUE,

    mobile VARCHAR(20),

    password_hash TEXT NOT NULL,

    department_id UUID,

    role_id UUID,

    team_id UUID,

    manager_id UUID,

    designation VARCHAR(120),

    employment_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',

    avatar_url TEXT,

    last_login_at TIMESTAMP,

    password_changed_at TIMESTAMP,

    failed_login_attempts INTEGER NOT NULL DEFAULT 0,

    account_locked_until TIMESTAMP,

    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMP NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

    created_by UUID,

    updated_by UUID,

    CONSTRAINT fk_users_department
        FOREIGN KEY (department_id)
        REFERENCES departments(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_users_role
        FOREIGN KEY (role_id)
        REFERENCES roles(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_users_team
        FOREIGN KEY (team_id)
        REFERENCES teams(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_users_manager
        FOREIGN KEY (manager_id)
        REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_users_created_by
        FOREIGN KEY (created_by)
        REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_users_updated_by
        FOREIGN KEY (updated_by)
        REFERENCES users(id)
        ON DELETE SET NULL

);
`;
export const createUsersIndexes = `

CREATE INDEX IF NOT EXISTS idx_users_employee_id
ON users(employee_id);

CREATE INDEX IF NOT EXISTS idx_users_email
ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_department
ON users(department_id);

CREATE INDEX IF NOT EXISTS idx_users_role
ON users(role_id);

CREATE INDEX IF NOT EXISTS idx_users_team
ON users(team_id);

CREATE INDEX IF NOT EXISTS idx_users_manager
ON users(manager_id);

CREATE INDEX IF NOT EXISTS idx_users_status
ON users(employment_status);

CREATE INDEX IF NOT EXISTS idx_users_created_at
ON users(created_at);

`;