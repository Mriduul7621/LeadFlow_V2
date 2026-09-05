export const createOptionsTable = `

CREATE TABLE IF NOT EXISTS options (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    option_type VARCHAR(100) NOT NULL,

    option_code VARCHAR(100),

    option_name VARCHAR(255) NOT NULL,

    option_value VARCHAR(255),

    parent_id UUID REFERENCES options(id)
        ON DELETE SET NULL,

    sort_order INTEGER DEFAULT 0,

    color VARCHAR(50),

    icon VARCHAR(100),

    description TEXT,

    is_system BOOLEAN DEFAULT FALSE,

    status VARCHAR(30) DEFAULT 'ACTIVE',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

`;

export const createOptionsIndexes = `

CREATE INDEX IF NOT EXISTS idx_options_type
ON options(option_type);

CREATE INDEX IF NOT EXISTS idx_options_code
ON options(option_code);

CREATE INDEX IF NOT EXISTS idx_options_name
ON options(option_name);

CREATE INDEX IF NOT EXISTS idx_options_parent
ON options(parent_id);

CREATE INDEX IF NOT EXISTS idx_options_status
ON options(status);

`;