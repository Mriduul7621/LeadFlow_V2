import { query } from "../connection";

export async function up(): Promise<void> {

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS account_status VARCHAR(20);
    `);

    await query(`
        UPDATE users
        SET account_status = CASE
            WHEN COALESCE(is_active, TRUE) THEN 'ACTIVE'
            ELSE 'INACTIVE'
        END
        WHERE account_status IS NULL;
    `);

    await query(`
        ALTER TABLE users
        ALTER COLUMN account_status SET DEFAULT 'ACTIVE';
    `);

    await query(`
        ALTER TABLE users
        ALTER COLUMN account_status SET NOT NULL;
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;
    `);

    await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS employee_record_id UUID;
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_account_status
        ON users(account_status);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_users_employee_record_id
        ON users(employee_record_id);
    `);

    await query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'chk_users_failed_login_attempts'
            ) THEN
                ALTER TABLE users
                ADD CONSTRAINT chk_users_failed_login_attempts
                CHECK (failed_login_attempts >= 0);
            END IF;
        END
        $$;
    `);

    console.log("✅ 022_identity_compatibility migrated");

}

export async function down(): Promise<void> {

    await query(`
        ALTER TABLE users
        DROP CONSTRAINT IF EXISTS chk_users_failed_login_attempts;
    `);

    await query(`
        DROP INDEX IF EXISTS idx_users_account_status;
    `);

    await query(`
        DROP INDEX IF EXISTS idx_users_employee_record_id;
    `);

    await query(`
        ALTER TABLE users
        DROP COLUMN IF EXISTS employee_record_id,
        DROP COLUMN IF EXISTS password_changed_at,
        DROP COLUMN IF EXISTS locked_until,
        DROP COLUMN IF EXISTS failed_login_attempts,
        DROP COLUMN IF EXISTS account_status;
    `);

}
