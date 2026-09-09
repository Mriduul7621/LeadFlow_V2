import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL,
            token_hash VARCHAR(255),
            ip_address INET,
            user_agent TEXT,
            last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMP NOT NULL,
            revoked_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_sessions_user
                FOREIGN KEY (user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_sessions_active
        ON sessions(expires_at, revoked_at);
    `);

    console.log("✅ 031_sessions migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS sessions;`);
}
