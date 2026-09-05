export const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    employee_id VARCHAR(50) NOT NULL UNIQUE,

    name VARCHAR(150) NOT NULL,

    email VARCHAR(150) UNIQUE,

    mobile VARCHAR(30),

    password_hash TEXT NOT NULL,

    designation VARCHAR(120),

    status VARCHAR(30) DEFAULT 'ACTIVE',

    photo_url TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);
`;

export const createUsersIndexes = `

CREATE INDEX IF NOT EXISTS idx_users_employee_id
ON users(employee_id);

CREATE INDEX IF NOT EXISTS idx_users_email
ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_status
ON users(status);

`;