import pg from 'pg';
const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (!pool) {
    const rawConnectionString = process.env.DATABASE_URL;
    if (!rawConnectionString) {
      console.warn("⚠️ DATABASE_URL environment variable is not defined. Supabase PostgreSQL is not connected. Fallback to in-memory/local mock mode.");
      return null;
    }
    try {
      // Strip any conflicting sslmode=... parameters to prevent pg-connection-string from overriding our ssl option
      const connectionString = rawConnectionString.replace(/[\?&]sslmode=[^&]+/g, '');
      
      pool = new Pool({
        connectionString,
        ssl: {
          rejectUnauthorized: false // Safe and required for Supabase Cloud Database connections
        }
      });
      console.log("🔌 Supabase PostgreSQL connection pool initialized with SSL.");
    } catch (err) {
      console.error("❌ Failed to create Supabase PostgreSQL connection pool:", err);
      return null;
    }
  }
  return pool;
}

// Automatically create tables if they do not exist
export async function initializeDatabase() {
  const activePool = getPool();
  if (!activePool) {
    console.warn("⚠️ Skipping table initialization: no active database connection.");
    return;
  }

  try {
    const client = await activePool.connect();
    console.log("🚀 Connected to Supabase PostgreSQL. Running schema initialization...");
    try {
      // Create Users table
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255),
          employee_id VARCHAR(255) UNIQUE,
          email VARCHAR(255),
          role VARCHAR(100),
          designation VARCHAR(255),
          status VARCHAR(100),
          created_date VARCHAR(255),
          password VARCHAR(255)
        )
      `);
      // Migrate in the enterprise hierarchy columns for pre-existing databases.
      // (CREATE TABLE IF NOT EXISTS above won't add columns to a table that
      // already exists, so these ALTERs keep older deployments up to date.)
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS department_id VARCHAR(255),
          ADD COLUMN IF NOT EXISTS team_id VARCHAR(255),
          ADD COLUMN IF NOT EXISTS manager_id VARCHAR(255),
          ADD COLUMN IF NOT EXISTS employment_status VARCHAR(50),
          ADD COLUMN IF NOT EXISTS joining_date VARCHAR(255),
          ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS avatar_url TEXT,
          ADD COLUMN IF NOT EXISTS mobile VARCHAR(50)
      `);
      console.log("✅ Users table verification complete.");

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_users_manager_id ON users(manager_id);
        CREATE INDEX IF NOT EXISTS idx_users_department_id ON users(department_id);
        CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);
      `);

      // Create Leads table
      await client.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id VARCHAR(255) PRIMARY KEY,
          prospect_name VARCHAR(255),
          mobile_number VARCHAR(100),
          campaign_name VARCHAR(255),
          current_status VARCHAR(100),
          collected_ncp NUMERIC,
          projected_ncp NUMERIC,
          sum_assured NUMERIC,
          product_name VARCHAR(255),
          assigned_to VARCHAR(255),
          assigned_by VARCHAR(255),
          assigned_date VARCHAR(255),
          creation_date VARCHAR(255),
          last_follow_up_date VARCHAR(255),
          next_follow_up_date VARCHAR(255),
          next_call_date VARCHAR(255),
          meeting_date VARCHAR(255),
          priority VARCHAR(100),
          district VARCHAR(255),
          upazila VARCHAR(255),
          address TEXT,
          status_history TEXT, -- Store JSON string representation
          timestamp VARCHAR(255)
        )
      `);
      await client.query(`
        ALTER TABLE leads
          ADD COLUMN IF NOT EXISTS mobile VARCHAR(100),
          ADD COLUMN IF NOT EXISTS email VARCHAR(255),
          ADD COLUMN IF NOT EXISTS profession VARCHAR(255),
          ADD COLUMN IF NOT EXISTS occupation VARCHAR(255),
          ADD COLUMN IF NOT EXISTS residence_address TEXT,
          ADD COLUMN IF NOT EXISTS office_address TEXT,
          ADD COLUMN IF NOT EXISTS family_member VARCHAR(100),
          ADD COLUMN IF NOT EXISTS marital_status VARCHAR(100),
          ADD COLUMN IF NOT EXISTS has_child BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS no_of_children VARCHAR(50),
          ADD COLUMN IF NOT EXISTS area VARCHAR(255),
          ADD COLUMN IF NOT EXISTS division VARCHAR(255),
          ADD COLUMN IF NOT EXISTS source VARCHAR(255),
          ADD COLUMN IF NOT EXISTS other_info TEXT,
          ADD COLUMN IF NOT EXISTS meeting_type VARCHAR(255),
          ADD COLUMN IF NOT EXISTS loss_reason VARCHAR(255),
          ADD COLUMN IF NOT EXISTS followup_type VARCHAR(255)
      `);
      console.log("✅ Leads table verification complete.");

      // Create Options table
      await client.query(`
        CREATE TABLE IF NOT EXISTS options (
          id VARCHAR(255) PRIMARY KEY,
          type VARCHAR(100),
          value VARCHAR(255),
          status VARCHAR(100)
        )
      `);
      await client.query(`
        ALTER TABLE options
          ADD COLUMN IF NOT EXISTS label VARCHAR(255),
          ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0,
          ADD COLUMN IF NOT EXISTS meta TEXT,
          ADD COLUMN IF NOT EXISTS created_date VARCHAR(255)
      `);
      console.log("✅ Options table verification complete.");

      // Create Form Fields table (drives the Dynamic Form Builder - Phase 2).
      // Each row describes one field on the Lead Generate form: whether
      // it's mandatory, visible, its display order, and (for dropdown
      // fields) which Metadata Engine type supplies its values.
      await client.query(`
        CREATE TABLE IF NOT EXISTS form_fields (
          id VARCHAR(255) PRIMARY KEY,
          field_key VARCHAR(100) UNIQUE,
          label VARCHAR(255),
          field_type VARCHAR(50),
          section VARCHAR(100),
          is_mandatory BOOLEAN DEFAULT FALSE,
          is_visible BOOLEAN DEFAULT TRUE,
          sort_order INTEGER DEFAULT 0,
          metadata_type_key VARCHAR(100),
          placeholder VARCHAR(255),
          is_system BOOLEAN DEFAULT FALSE,
          created_date VARCHAR(255)
        )
      `);
      console.log("✅ Form fields table verification complete.");

      // Create Workflow Rules table (drives the Workflow Engine - Phase 3).
      // One row per lead status: which statuses it's allowed to move to
      // next (NULL = unrestricted, preserving current behavior by
      // default), and which extra fields are required when a lead moves
      // INTO that status (e.g. Not Interested -> must provide a Loss
      // Reason; Meeting Fixed -> must provide a Meeting Type).
      await client.query(`
        CREATE TABLE IF NOT EXISTS workflow_rules (
          id VARCHAR(255) PRIMARY KEY,
          status VARCHAR(255) UNIQUE,
          allowed_next_statuses TEXT,
          requires_loss_reason BOOLEAN DEFAULT FALSE,
          requires_meeting_type BOOLEAN DEFAULT FALSE,
          requires_followup_type BOOLEAN DEFAULT FALSE,
          requires_note BOOLEAN DEFAULT FALSE,
          is_system BOOLEAN DEFAULT FALSE,
          created_date VARCHAR(255)
        )
      `);
      console.log("✅ Workflow rules table verification complete.");

      // Seed sensible defaults (only if empty) - deliberately permissive
      // (allowed_next_statuses = NULL means "any status") so existing
      // deployments keep working exactly as before unless the admin
      // explicitly tightens the rules. The two requirement flags below
      // encode business rules that already existed informally (Loss
      // Reason / Meeting Type weren't previously wired into the UI).
      const existingRules = await client.query('SELECT COUNT(*) as count FROM workflow_rules');
      if (parseInt(existingRules.rows[0].count, 10) === 0) {
        const defaultRules: Array<{ status: string; requiresLossReason?: boolean; requiresMeetingType?: boolean }> = [
          { status: 'Not Interested', requiresLossReason: true },
          { status: 'Meeting Fixed', requiresMeetingType: true },
        ];
        for (const r of defaultRules) {
          await client.query(
            `INSERT INTO workflow_rules (id, status, allowed_next_statuses, requires_loss_reason, requires_meeting_type, is_system, created_date)
             VALUES ($1, $2, NULL, $3, $4, TRUE, $5)
             ON CONFLICT (status) DO NOTHING`,
            [`wf_${r.status.replace(/\s+/g, '_')}`, r.status, !!r.requiresLossReason, !!r.requiresMeetingType, new Date().toISOString()]
          );
        }
        console.log("🌱 Seeded default workflow rules.");
      }

      // custom_fields holds values for any admin-added (non-system) field,
      // as a JSON blob keyed by field_key - since those don't get their
      // own dedicated column.
      await client.query(`
        ALTER TABLE leads ADD COLUMN IF NOT EXISTS custom_fields TEXT
      `);

      // Lead Timeline (Phase 4): assignment change log and lightweight
      // document references (metadata only - no binary file storage is
      // wired up yet; `note`/`name` can hold a reference or link).
      await client.query(`
        ALTER TABLE leads
          ADD COLUMN IF NOT EXISTS assignment_history TEXT,
          ADD COLUMN IF NOT EXISTS documents TEXT
      `);

      // Seed the default field set (only if empty) matching the fields the
      // Lead Generate form already has, marked is_system so they can't be
      // deleted - but their mandatory/visible/order can still be changed
      // by the admin through the Form Builder screen.
      const existingFields = await client.query('SELECT COUNT(*) as count FROM form_fields');
      if (parseInt(existingFields.rows[0].count, 10) === 0) {
        const defaultFields: Array<{
          key: string; label: string; type: string; section: string;
          mandatory: boolean; metadataType?: string; order: number;
        }> = [
          { key: 'prospectName', label: 'Prospect Name', type: 'text', section: 'Identity', mandatory: true, order: 1 },
          { key: 'mobile', label: 'Mobile Number', type: 'text', section: 'Identity', mandatory: true, order: 2 },
          { key: 'profession', label: 'Profession', type: 'dropdown', section: 'Identity', mandatory: true, metadataType: 'Profession', order: 3 },
          { key: 'occupation', label: 'Occupation', type: 'dropdown', section: 'Identity', mandatory: false, metadataType: 'Occupation', order: 4 },
          { key: 'priority', label: 'Priority', type: 'dropdown', section: 'Identity', mandatory: false, metadataType: 'Priority', order: 5 },
          { key: 'maritalStatus', label: 'Marital Status', type: 'dropdown', section: 'Identity', mandatory: true, metadataType: 'MaritalStatus', order: 6 },
          { key: 'noOfChildren', label: 'Number of Children', type: 'text', section: 'Identity', mandatory: false, order: 7 },
          { key: 'familyMember', label: 'Family Members', type: 'text', section: 'Identity', mandatory: false, order: 8 },
          { key: 'division', label: 'Division', type: 'dropdown', section: 'Location', mandatory: true, order: 1 },
          { key: 'district', label: 'District', type: 'dropdown', section: 'Location', mandatory: true, order: 2 },
          { key: 'thana', label: 'Thana / Upazila', type: 'dropdown', section: 'Location', mandatory: true, order: 3 },
          { key: 'residenceAddress', label: 'Residence Address', type: 'textarea', section: 'Location', mandatory: false, order: 4 },
          { key: 'officeAddress', label: 'Office Address', type: 'textarea', section: 'Location', mandatory: false, order: 5 },
          { key: 'source', label: 'Lead Source', type: 'dropdown', section: 'Business', mandatory: true, metadataType: 'Source', order: 1 },
          { key: 'productName', label: 'Product', type: 'dropdown', section: 'Business', mandatory: true, metadataType: 'Product', order: 2 },
          { key: 'campaignName', label: 'Campaign', type: 'dropdown', section: 'Business', mandatory: true, metadataType: 'Campaign', order: 3 },
          { key: 'otherInfo', label: 'Other Information', type: 'textarea', section: 'Business', mandatory: false, order: 4 },
        ];
        for (const f of defaultFields) {
          await client.query(
            `INSERT INTO form_fields (id, field_key, label, field_type, section, is_mandatory, is_visible, sort_order, metadata_type_key, is_system, created_date)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, TRUE, $9)
             ON CONFLICT (field_key) DO NOTHING`,
            [`ff_${f.key}`, f.key, f.label, f.type, f.section, f.mandatory, f.order, f.metadataType || null, new Date().toISOString()]
          );
        }
        console.log("🌱 Seeded default form field configuration.");
      }

      // Create Metadata Types registry table (drives the Metadata Engine -
      // this is what the Admin "Metadata Manager" screen lists and lets
      // the admin manage; `options` rows above hold each type's values).
      await client.query(`
        CREATE TABLE IF NOT EXISTS metadata_types (
          key VARCHAR(100) PRIMARY KEY,
          label VARCHAR(255),
          description VARCHAR(500),
          is_system BOOLEAN DEFAULT FALSE,
          sort_order INTEGER DEFAULT 0
        )
      `);
      console.log("✅ Metadata types table verification complete.");

      // Seed the standard metadata types (only if the registry is empty,
      // so this never overwrites an admin's existing configuration).
      // IMPORTANT: keys reuse the exact type strings the app already
      // queries via settingsService/metadataService.getOptionsByType()
      // (e.g. 'FollowUpStatus' is what the UI has always called "lead
      // status" internally) so existing dropdowns keep working.
      const existingTypes = await client.query('SELECT COUNT(*) as count FROM metadata_types');
      if (parseInt(existingTypes.rows[0].count, 10) === 0) {
        const defaultTypes: Array<{ key: string; label: string; description: string; isSystem: boolean; order: number }> = [
          { key: 'Profession', label: 'Profession', description: 'Prospect profession list', isSystem: false, order: 1 },
          { key: 'Occupation', label: 'Occupation', description: 'Prospect occupation list', isSystem: false, order: 2 },
          { key: 'Source', label: 'Lead Source', description: 'Where the lead originated from', isSystem: false, order: 3 },
          { key: 'Campaign', label: 'Campaign', description: 'Marketing / acquisition campaigns', isSystem: false, order: 4 },
          { key: 'Product', label: 'Product', description: 'Insurance / financial products sold', isSystem: false, order: 5 },
          { key: 'FollowUpStatus', label: 'Lead Status', description: 'Pipeline stages a lead moves through', isSystem: true, order: 6 },
          { key: 'MeetingType', label: 'Meeting Type', description: 'Type of client meeting', isSystem: false, order: 7 },
          { key: 'LossReason', label: 'Loss Reason', description: 'Why a lead was marked as lost / not interested', isSystem: false, order: 8 },
          { key: 'FollowUpType', label: 'Follow-up Type', description: 'Call / SMS / Visit / Email etc.', isSystem: false, order: 9 },
          { key: 'Priority', label: 'Priority', description: 'Lead priority level', isSystem: false, order: 10 },
          { key: 'Area', label: 'Area', description: 'Geographic area list', isSystem: false, order: 11 },
          { key: 'MaritalStatus', label: 'Marital Status', description: 'Prospect marital status', isSystem: false, order: 12 },
        ];
        for (const t of defaultTypes) {
          await client.query(
            `INSERT INTO metadata_types (key, label, description, is_system, sort_order) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (key) DO NOTHING`,
            [t.key, t.label, t.description, t.isSystem, t.order]
          );
        }
        console.log("🌱 Seeded default metadata types.");
      }

      // Seed default Lead Status pipeline values (only if none exist yet)
      // with the same order/colors the app used to have hardcoded.
      // Stored under type='FollowUpStatus' - the key the app has always
      // used internally for the lead-status dropdown/pipeline.
      const existingStatuses = await client.query("SELECT COUNT(*) as count FROM options WHERE type = 'FollowUpStatus'");
      if (parseInt(existingStatuses.rows[0].count, 10) === 0) {
        const defaultStatuses: Array<{ value: string; color: string; isWon?: boolean; isLost?: boolean; isTerminal?: boolean }> = [
          { value: 'Untouched', color: 'slate' },
          { value: 'Contacted', color: 'blue' },
          { value: 'No Response', color: 'amber' },
          { value: 'Busy', color: 'orange' },
          { value: 'Interested', color: 'teal' },
          { value: 'Follow-up Set', color: 'indigo' },
          { value: 'Meeting Fixed', color: 'purple' },
          { value: 'Meeting Completed', color: 'violet' },
          { value: 'Pipeline Locked', color: 'yellow' },
          { value: 'Converted', color: 'green', isWon: true, isTerminal: true },
          { value: 'Not Interested', color: 'red', isLost: true, isTerminal: true },
        ];
        let order = 1;
        for (const s of defaultStatuses) {
          const meta = JSON.stringify({ color: s.color, isWon: !!s.isWon, isLost: !!s.isLost, isTerminal: !!s.isTerminal });
          await client.query(
            `INSERT INTO options (id, type, value, label, status, sort_order, meta, created_date)
             VALUES ($1, 'FollowUpStatus', $2, $2, 'Active', $3, $4, $5)`,
            [`opt_status_${order}`, s.value, order, meta, new Date().toISOString()]
          );
          order++;
        }
        console.log("🌱 Seeded default lead status pipeline.");
      }

      // Create Departments table
      await client.query(`
        CREATE TABLE IF NOT EXISTS departments (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255),
          created_date VARCHAR(255)
        )
      `);
      console.log("✅ Departments table verification complete.");

      // Create Hierarchies table
      await client.query(`
        CREATE TABLE IF NOT EXISTS hierarchies (
          id VARCHAR(255) PRIMARY KEY,
          department_id VARCHAR(255),
          layers TEXT, -- Store JSON representation
          updated_at VARCHAR(255)
        )
      `);
      console.log("✅ Hierarchies table verification complete.");

      // Create Roles/Permissions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS roles (
          role_id VARCHAR(255) PRIMARY KEY,
          role_name VARCHAR(255),
          menu_access TEXT, -- Store JSON representation
          data_visibility VARCHAR(100),
          actions TEXT, -- Store JSON representation
          feature_permissions TEXT -- Store JSON representation
        )
      `);
      console.log("✅ Roles table verification complete.");

      // Create Teams table
      await client.query(`
        CREATE TABLE IF NOT EXISTS teams (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255),
          leader_id VARCHAR(255),
          leader_name VARCHAR(255),
          member_ids TEXT, -- Store JSON array representation
          created_date VARCHAR(255),
          department_id VARCHAR(255)
        )
      `);
      console.log("✅ Teams table verification complete.");

      // Create Notifications table
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id VARCHAR(255) PRIMARY KEY,
          user_id VARCHAR(255),
          title VARCHAR(255),
          message TEXT,
          lead_id VARCHAR(255),
          read BOOLEAN DEFAULT FALSE,
          date VARCHAR(255)
        )
      `);
      console.log("✅ Notifications table verification complete.");
      
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Critical database initialization error:", err);
  }
}
