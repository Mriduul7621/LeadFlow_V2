import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS notifications (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            user_id UUID NOT NULL,

            title VARCHAR(255) NOT NULL,

            message TEXT NOT NULL,

            type VARCHAR(50) NOT NULL DEFAULT 'info',

            reference_type VARCHAR(100),

            reference_id UUID,

            is_read BOOLEAN NOT NULL DEFAULT FALSE,

            read_at TIMESTAMP,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT fk_notification_user
                FOREIGN KEY (user_id)
                REFERENCES users(id)
                ON DELETE CASCADE

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_notification_user
        ON notifications(user_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_notification_read
        ON notifications(is_read);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_notification_type
        ON notifications(type);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_notification_created
        ON notifications(created_at DESC);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS notifications CASCADE;
    `);

}