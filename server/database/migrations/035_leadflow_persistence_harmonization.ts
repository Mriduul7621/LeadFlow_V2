import { query } from "../connection.js";

/**
 * 035 - LeadFlow persistence harmonization
 * ------------------------------------------------------------------
 * Ensures every table used by the mounted API (`production.routes.ts`)
 * has the exact columns the API needs, regardless of which historical
 * shape the database was first initialized with.
 *
 * Every statement is idempotent (CREATE TABLE IF NOT EXISTS /
 * ADD COLUMN IF NOT EXISTS / guarded constraint creation) so it is safe
 * to run on every cold start without touching existing production data.
 */
export async function up(): Promise<void> {
  // ------------------------------------------------------------------
  // users: password/status/hierarchy support columns
  // ------------------------------------------------------------------
  await query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reporting_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS subordinates JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_users_account_status ON users(account_status)`);

  // ------------------------------------------------------------------
  // roles: persist the RolePermission profile (menu/visibility/actions)
  // ------------------------------------------------------------------
  await query(`
    ALTER TABLE roles
      ADD COLUMN IF NOT EXISTS menu_access JSONB,
      ADD COLUMN IF NOT EXISTS data_visibility VARCHAR(30) NOT NULL DEFAULT 'Own',
      ADD COLUMN IF NOT EXISTS actions JSONB,
      ADD COLUMN IF NOT EXISTS feature_permissions JSONB
  `);

  // ------------------------------------------------------------------
  // teams: leader + membership storage used by the Teams workspace
  // ------------------------------------------------------------------
  await query(`
    ALTER TABLE teams
      ADD COLUMN IF NOT EXISTS leader_id UUID,
      ADD COLUMN IF NOT EXISTS member_ids JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_teams_leader_user'
      ) THEN
        ALTER TABLE teams
          ADD CONSTRAINT fk_teams_leader_user
          FOREIGN KEY (leader_id) REFERENCES users(id)
          ON UPDATE CASCADE ON DELETE SET NULL;
      END IF;
    END
    $$;
  `);

  // ------------------------------------------------------------------
  // leads: status / history / documents columns used by the UI
  // ------------------------------------------------------------------
  await query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS current_status VARCHAR(255),
      ADD COLUMN IF NOT EXISTS status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS assignment_history JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS documents JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_leads_current_status
    ON leads(current_status) WHERE is_deleted = FALSE
  `);

  // ------------------------------------------------------------------
  // notifications: recipient employee key + lead code for the FE shape
  // ------------------------------------------------------------------
  await query(`
    ALTER TABLE notifications
      ADD COLUMN IF NOT EXISTS recipient_key VARCHAR(255),
      ADD COLUMN IF NOT EXISTS lead_code VARCHAR(50)
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient_key
    ON notifications(recipient_key)
  `);

  // ------------------------------------------------------------------
  // Metadata engine: type registry + per-option meta
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS metadata_types (
      key VARCHAR(100) PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      description TEXT,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    ALTER TABLE options
      ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  // ------------------------------------------------------------------
  // Workflow rules (status-level rules driving the Workflow Engine)
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS workflow_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status VARCHAR(255) NOT NULL UNIQUE,
      allowed_next_statuses JSONB,
      requires_loss_reason BOOLEAN NOT NULL DEFAULT FALSE,
      requires_meeting_type BOOLEAN NOT NULL DEFAULT FALSE,
      requires_followup_type BOOLEAN NOT NULL DEFAULT FALSE,
      requires_note BOOLEAN NOT NULL DEFAULT FALSE,
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_workflow_rules_status ON workflow_rules(status)`);

  // ------------------------------------------------------------------
  // Form builder fields (per-field configuration)
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS form_fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL UNIQUE,
      label VARCHAR(255) NOT NULL,
      field_type VARCHAR(50) NOT NULL DEFAULT 'text',
      section VARCHAR(100),
      is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
      is_visible BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      metadata_type_key VARCHAR(100),
      placeholder VARCHAR(255),
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // ------------------------------------------------------------------
  // Department hierarchy documents (department-scoped role trees)
  // ------------------------------------------------------------------
  await query(`
    CREATE TABLE IF NOT EXISTS department_hierarchies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      department_id UUID NOT NULL UNIQUE,
      layers JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT fk_department_hierarchies_department
        FOREIGN KEY (department_id) REFERENCES departments(id)
        ON UPDATE CASCADE ON DELETE CASCADE
    )
  `);

  console.log("✅ 035_leadflow_persistence_harmonization migrated");
}

export async function down(): Promise<void> {
  // Intentionally non-destructive; nothing is dropped.
  console.log("ℹ️ 035 down() is a no-op to protect production data.");
}
