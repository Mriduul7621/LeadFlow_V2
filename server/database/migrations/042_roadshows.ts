import { query } from "../connection.js";

const roadshowPermissions = [
  ["roadshows.view", "Roadshows", "VIEW"],
  ["roadshows.create", "Roadshows", "CREATE"],
  ["roadshows.edit", "Roadshows", "EDIT"],
  ["roadshows.cancel", "Roadshows", "CANCEL"],
  ["roadshows.report", "Roadshows", "REPORT"],
];

export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS roadshows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization VARCHAR(255) NOT NULL,
      location VARCHAR(255) NOT NULL,
      scheduled_at TIMESTAMP NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'execute', 'reschedule', 'cancel')),
      source_code VARCHAR(100) UNIQUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      executed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS roadshow_assignees (
      roadshow_id UUID NOT NULL REFERENCES roadshows(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (roadshow_id, user_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS roadshow_code_counters (
      organization_key VARCHAR(100) PRIMARY KEY,
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_roadshows_scheduled_status ON roadshows(scheduled_at, status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_roadshows_created_by ON roadshows(created_by)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_roadshow_assignees_user ON roadshow_assignees(user_id, roadshow_id)`);

  for (const [code, moduleName, actionName] of roadshowPermissions) {
    await query(
      `INSERT INTO permissions (permission_code, module_name, action_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (permission_code) DO NOTHING`,
      [code, moduleName, actionName]
    );
  }

  await query(`
    INSERT INTO role_permissions (role_id, permission_id, is_allowed)
    SELECT r.id, p.id, TRUE
      FROM roles r CROSS JOIN permissions p
     WHERE UPPER(r.role_code) IN ('ADMIN', 'SUPERADMIN')
       AND p.permission_code LIKE 'roadshows.%'
    ON CONFLICT (role_id, permission_id) DO UPDATE
      SET is_allowed = TRUE, updated_at = NOW()
  `);
}

export async function down(): Promise<void> {
  await query(`DROP TABLE IF EXISTS roadshow_assignees CASCADE`);
  await query(`DROP TABLE IF EXISTS roadshows CASCADE`);
  await query(`DROP TABLE IF EXISTS roadshow_code_counters CASCADE`);
  await query(`DELETE FROM permissions WHERE permission_code LIKE 'roadshows.%'`);
}
