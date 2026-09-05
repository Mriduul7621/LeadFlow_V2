export const createFormsTable = `

CREATE TABLE IF NOT EXISTS forms (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    form_key VARCHAR(100) NOT NULL UNIQUE,

    field_key VARCHAR(100) NOT NULL,

    field_label VARCHAR(255) NOT NULL,

    field_type VARCHAR(50) NOT NULL,

    section_name VARCHAR(100),

    placeholder VARCHAR(255),

    default_value TEXT,

    metadata_type VARCHAR(100),

    validation_rule TEXT,

    is_required BOOLEAN DEFAULT FALSE,

    is_visible BOOLEAN DEFAULT TRUE,

    is_system BOOLEAN DEFAULT FALSE,

    sort_order INTEGER DEFAULT 0,

    status VARCHAR(30) DEFAULT 'ACTIVE',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

`;

export const createFormsIndexes = `

CREATE INDEX IF NOT EXISTS idx_forms_form_key
ON forms(form_key);

CREATE INDEX IF NOT EXISTS idx_forms_field_key
ON forms(field_key);

CREATE INDEX IF NOT EXISTS idx_forms_status
ON forms(status);

`;