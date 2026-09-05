export const createNotificationsTable = `

CREATE TABLE IF NOT EXISTS notifications (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID,

    title VARCHAR(255) NOT NULL,

    message TEXT NOT NULL,

    notification_type VARCHAR(100) NOT NULL,

    reference_type VARCHAR(100),

    reference_id UUID,

    is_read BOOLEAN DEFAULT FALSE,

    priority VARCHAR(20) DEFAULT 'NORMAL',

    status VARCHAR(20) DEFAULT 'ACTIVE',

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_notifications_user
        FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE

);

`;

export const createNotificationsIndexes = `

CREATE INDEX IF NOT EXISTS idx_notifications_user
ON notifications(user_id);

CREATE INDEX IF NOT EXISTS idx_notifications_is_read
ON notifications(is_read);

CREATE INDEX IF NOT EXISTS idx_notifications_status
ON notifications(status);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at
ON notifications(created_at DESC);

`;