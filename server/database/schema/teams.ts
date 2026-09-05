export const createTeamsTable = `
CREATE TABLE IF NOT EXISTS teams (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    team_name VARCHAR(150) NOT NULL,

    team_code VARCHAR(50) UNIQUE,

    department_id UUID
        REFERENCES departments(id)
        ON DELETE SET NULL,

    leader_id UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    description TEXT,

    status VARCHAR(30) DEFAULT 'ACTIVE'
        CHECK(status IN ('ACTIVE','INACTIVE')),

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP

);
`;

export const createTeamsIndexes = `

CREATE INDEX IF NOT EXISTS idx_teams_department
ON teams(department_id);

CREATE INDEX IF NOT EXISTS idx_teams_leader
ON teams(leader_id);

`;