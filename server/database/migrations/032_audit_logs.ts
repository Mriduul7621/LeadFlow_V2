import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            actor_user_id UUID,
            target_user_id UUID,
            action_code VARCHAR(100) NOT NULL,
            entity_type VARCHAR(100) NOT NULL,
            entity_id UUID,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            ip_address INET,
            user_agent TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT fk_audit_actor
                FOREIGN KEY (actor_user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE SET NULL,
            CONSTRAINT fk_audit_target
                FOREIGN KEY (target_user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE SET NULL
        );
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
        ON audit_logs(actor_user_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_audit_logs_target
        ON audit_logs(target_user_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_audit_logs_action
        ON audit_logs(action_code);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created
        ON audit_logs(created_at DESC);
    `);

    console.log("✅ 032_audit_logs migrated");
}

export async function down(): Promise<void> {
    await query(`DROP TABLE IF EXISTS audit_logs;`);
}
