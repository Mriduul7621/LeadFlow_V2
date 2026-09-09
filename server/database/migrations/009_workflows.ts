import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS workflows (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            workflow_key VARCHAR(100) NOT NULL,

            workflow_name VARCHAR(255) NOT NULL,

            from_status VARCHAR(100) NOT NULL,

            to_status VARCHAR(100) NOT NULL,

            allowed_role_id UUID,

            auto_assign BOOLEAN NOT NULL DEFAULT FALSE,

            send_notification BOOLEAN NOT NULL DEFAULT TRUE,

            is_active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            CONSTRAINT uq_workflow_transition
                UNIQUE (
                    workflow_key,
                    from_status,
                    to_status
                ),

            CONSTRAINT fk_workflow_role
                FOREIGN KEY (allowed_role_id)
                REFERENCES roles(id)
                ON DELETE SET NULL

        );

    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_key
        ON workflows(workflow_key);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_from_status
        ON workflows(from_status);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_to_status
        ON workflows(to_status);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_role
        ON workflows(allowed_role_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_workflow_active
        ON workflows(is_active);
    `);

}

export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS workflows CASCADE;
    `);

}