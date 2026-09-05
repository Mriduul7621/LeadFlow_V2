export const createWorkflowsTable = `

CREATE TABLE IF NOT EXISTS workflows (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workflow_name VARCHAR(150) NOT NULL,

    from_status VARCHAR(100) NOT NULL,

    to_status VARCHAR(100) NOT NULL,

    action_name VARCHAR(150),

    requires_note BOOLEAN DEFAULT FALSE,

    requires_followup BOOLEAN DEFAULT FALSE,

    requires_meeting BOOLEAN DEFAULT FALSE,

    requires_loss_reason BOOLEAN DEFAULT FALSE,

    auto_assign BOOLEAN DEFAULT FALSE,

    allow_reopen BOOLEAN DEFAULT FALSE,

    is_default BOOLEAN DEFAULT FALSE,

    sort_order INTEGER DEFAULT 0,

    status VARCHAR(30) DEFAULT 'ACTIVE',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

`;

export const createWorkflowsIndexes = `

CREATE INDEX IF NOT EXISTS idx_workflows_from_status
ON workflows(from_status);

CREATE INDEX IF NOT EXISTS idx_workflows_to_status
ON workflows(to_status);

CREATE INDEX IF NOT EXISTS idx_workflows_status
ON workflows(status);

`;