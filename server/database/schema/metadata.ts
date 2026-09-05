export const createMetadataTable = `

CREATE TABLE IF NOT EXISTS metadata (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    metadata_type VARCHAR(100) NOT NULL,

    metadata_code VARCHAR(100),

    metadata_name VARCHAR(255) NOT NULL,

    parent_id UUID REFERENCES metadata(id)
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

export const createMetadataIndexes = `

CREATE INDEX IF NOT EXISTS idx_metadata_type
ON metadata(metadata_type);

CREATE INDEX IF NOT EXISTS idx_metadata_name
ON metadata(metadata_name);

CREATE INDEX IF NOT EXISTS idx_metadata_code
ON metadata(metadata_code);

CREATE INDEX IF NOT EXISTS idx_metadata_parent
ON metadata(parent_id);

CREATE INDEX IF NOT EXISTS idx_metadata_status
ON metadata(status);

`;