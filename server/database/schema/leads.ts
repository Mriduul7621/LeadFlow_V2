export const createLeadsTable = `

CREATE TABLE IF NOT EXISTS leads (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    lead_code VARCHAR(50) UNIQUE NOT NULL,

    full_name VARCHAR(255) NOT NULL,

    mobile VARCHAR(20) NOT NULL,

    alternate_mobile VARCHAR(20),

    email VARCHAR(255),

    gender VARCHAR(20),

    date_of_birth DATE,

    occupation VARCHAR(150),

    monthly_income NUMERIC(15,2),

    district VARCHAR(100),

    area VARCHAR(150),

    address TEXT,

    source VARCHAR(100),

    campaign VARCHAR(100),

    status VARCHAR(50) DEFAULT 'NEW',

    priority VARCHAR(20) DEFAULT 'NORMAL',

    assigned_to UUID,

    created_by UUID NOT NULL,

    department_id UUID,

    team_id UUID,

    remarks TEXT,

    next_follow_up TIMESTAMP,

    is_deleted BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_leads_created_by
        FOREIGN KEY (created_by)
        REFERENCES users(id)
        ON DELETE RESTRICT,

    CONSTRAINT fk_leads_assigned_to
        FOREIGN KEY (assigned_to)
        REFERENCES users(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_leads_department
        FOREIGN KEY (department_id)
        REFERENCES departments(id)
        ON DELETE SET NULL,

    CONSTRAINT fk_leads_team
        FOREIGN KEY (team_id)
        REFERENCES teams(id)
        ON DELETE SET NULL

);

`;

export const createLeadsIndexes = `

CREATE INDEX IF NOT EXISTS idx_leads_lead_code
ON leads(lead_code);

CREATE INDEX IF NOT EXISTS idx_leads_mobile
ON leads(mobile);

CREATE INDEX IF NOT EXISTS idx_leads_status
ON leads(status);

CREATE INDEX IF NOT EXISTS idx_leads_assigned_to
ON leads(assigned_to);

CREATE INDEX IF NOT EXISTS idx_leads_created_by
ON leads(created_by);

CREATE INDEX IF NOT EXISTS idx_leads_department
ON leads(department_id);

CREATE INDEX IF NOT EXISTS idx_leads_team
ON leads(team_id);

CREATE INDEX IF NOT EXISTS idx_leads_created_at
ON leads(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up
ON leads(next_follow_up);

`;
