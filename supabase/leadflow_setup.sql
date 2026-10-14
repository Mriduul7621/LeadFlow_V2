-- LeadFlow_V2 Supabase schema setup / compatibility script
-- Source of truth: server/database/runMigrations.ts (migrations 001-014, 022-042).
--
-- Safe to run from Supabase SQL Editor more than once:
--   * Creates missing public tables and indexes.
--   * Adds missing compatibility columns without replacing existing values.
--   * Backfills employees from existing users only when an employee record is absent.
--   * Adds canonical permissions without overwriting existing permission rows.
--   * Grants the Roadshow permissions to ADMIN/SUPERADMIN roles.
--
-- Deliberately non-destructive: this script does not DROP tables/columns,
-- truncate data, or delete records. Review any desired cleanup separately
-- after taking a backup and confirming the live schema/data.

BEGIN;

-- ---------------------------------------------------------------------------
-- Core organization, access, and identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_code VARCHAR(30) UNIQUE NOT NULL,
  department_name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code VARCHAR(30) UNIQUE NOT NULL,
  role_name VARCHAR(100) NOT NULL,
  hierarchy_level INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  data_visibility VARCHAR(30) NOT NULL DEFAULT 'Own',
  menu_access JSONB,
  actions JSONB,
  feature_permissions JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS hierarchy_level INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS data_visibility VARCHAR(30) NOT NULL DEFAULT 'Own',
  ADD COLUMN IF NOT EXISTS menu_access JSONB,
  ADD COLUMN IF NOT EXISTS actions JSONB,
  ADD COLUMN IF NOT EXISTS feature_permissions JSONB,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id VARCHAR(30) UNIQUE NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  phone VARCHAR(20),
  password VARCHAR(255) NOT NULL,
  role_id UUID NOT NULL,
  department_id UUID,
  team_id UUID,
  manager_id UUID,
  designation VARCHAR(100),
  joining_date DATE,
  profile_photo TEXT,
  last_login TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  account_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until TIMESTAMP,
  password_changed_at TIMESTAMP,
  employee_record_id UUID,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  reporting_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  subordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS role_id UUID,
  ADD COLUMN IF NOT EXISTS department_id UUID,
  ADD COLUMN IF NOT EXISTS team_id UUID,
  ADD COLUMN IF NOT EXISTS manager_id UUID,
  ADD COLUMN IF NOT EXISTS designation VARCHAR(100),
  ADD COLUMN IF NOT EXISTS joining_date DATE,
  ADD COLUMN IF NOT EXISTS profile_photo TEXT,
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMP,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS employee_record_id UUID,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reporting_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS subordinates JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS public.teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_code VARCHAR(30) UNIQUE NOT NULL,
  team_name VARCHAR(100) NOT NULL,
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  leader_id UUID REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  member_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS leader_id UUID,
  ADD COLUMN IF NOT EXISTS member_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

UPDATE public.users
   SET account_status = CASE WHEN COALESCE(is_active, TRUE) THEN 'ACTIVE' ELSE 'INACTIVE' END
 WHERE account_status IS NULL;

ALTER TABLE public.users
  ALTER COLUMN account_status SET DEFAULT 'ACTIVE',
  ALTER COLUMN account_status SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id VARCHAR(30) UNIQUE NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  official_email VARCHAR(150),
  phone VARCHAR(20),
  designation VARCHAR(100),
  profile_photo TEXT,
  joining_date DATE,
  employment_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (employment_status IN ('ACTIVE','INACTIVE','ON_LEAVE','SUSPENDED','RESIGNED','TERMINATED','RETIRED')),
  branch VARCHAR(100),
  region VARCHAR(100),
  area VARCHAR(100),
  district VARCHAR(100),
  office VARCHAR(100),
  channel VARCHAR(100),
  unit VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.employee_departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_employee_department UNIQUE (employee_id, department_id)
);

CREATE TABLE IF NOT EXISTS public.hierarchies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  manager_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  level INTEGER NOT NULL DEFAULT 1,
  path TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.team_members (
  team_id UUID NOT NULL REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  is_leader BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
  left_at TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (team_id, employee_id)
);

CREATE TABLE IF NOT EXISTS public.employee_reporting (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  manager_employee_id UUID REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE SET NULL,
  relationship_type VARCHAR(30) NOT NULL DEFAULT 'PRIMARY',
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_employee_reporting_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- Merge only missing employee rows; never overwrite an existing employee record.
INSERT INTO public.employees (
  employee_id, full_name, official_email, phone, designation, profile_photo,
  joining_date, employment_status, created_at, updated_at
)
SELECT u.employee_id, u.full_name, u.email, u.phone, u.designation, u.profile_photo,
       u.joining_date,
       CASE WHEN COALESCE(u.is_active, TRUE) THEN 'ACTIVE' ELSE 'INACTIVE' END,
       COALESCE(u.created_at, NOW()), COALESCE(u.updated_at, NOW())
  FROM public.users u
 WHERE NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.employee_id = u.employee_id)
ON CONFLICT (employee_id) DO NOTHING;

UPDATE public.users u
   SET employee_record_id = e.id
  FROM public.employees e
 WHERE u.employee_record_id IS NULL
   AND e.employee_id = u.employee_id;

INSERT INTO public.employee_departments (employee_id, department_id, is_primary, assigned_at, is_active)
SELECT e.id, u.department_id, TRUE, COALESCE(u.created_at, NOW()), COALESCE(u.is_active, TRUE)
  FROM public.users u
  JOIN public.employees e ON e.employee_id = u.employee_id
 WHERE u.department_id IS NOT NULL
ON CONFLICT (employee_id, department_id) DO NOTHING;

INSERT INTO public.team_members (team_id, employee_id, is_active)
SELECT u.team_id, u.employee_record_id, COALESCE(u.is_active, TRUE)
  FROM public.users u
 WHERE u.team_id IS NOT NULL AND u.employee_record_id IS NOT NULL
ON CONFLICT (team_id, employee_id) DO NOTHING;

INSERT INTO public.employee_reporting (employee_id, manager_employee_id, relationship_type, is_active)
SELECT child.employee_record_id, manager.employee_record_id, 'PRIMARY', COALESCE(child.is_active, TRUE)
  FROM public.users child
  JOIN public.users manager ON manager.id = child.manager_id
 WHERE child.employee_record_id IS NOT NULL AND manager.employee_record_id IS NOT NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_role') THEN
    ALTER TABLE public.users ADD CONSTRAINT fk_users_role
      FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_department') THEN
    ALTER TABLE public.users ADD CONSTRAINT fk_users_department
      FOREIGN KEY (department_id) REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_team') THEN
    ALTER TABLE public.users ADD CONSTRAINT fk_users_team
      FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_manager') THEN
    ALTER TABLE public.users ADD CONSTRAINT fk_users_manager
      FOREIGN KEY (manager_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_employee_record') THEN
    ALTER TABLE public.users ADD CONSTRAINT fk_users_employee_record
      FOREIGN KEY (employee_record_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_teams_leader_user') THEN
    ALTER TABLE public.teams ADD CONSTRAINT fk_teams_leader_user
      FOREIGN KEY (leader_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Lead data, metadata, product/campaign, workflow and form builder
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code VARCHAR(50) NOT NULL UNIQUE,
  product_name VARCHAR(255) NOT NULL,
  short_name VARCHAR(100),
  description TEXT,
  category VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_code VARCHAR(50) NOT NULL UNIQUE,
  campaign_name VARCHAR(255) NOT NULL,
  campaign_type VARCHAR(100),
  source VARCHAR(100),
  start_date DATE,
  end_date DATE,
  budget NUMERIC(14,2) DEFAULT 0,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.lead_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status_code VARCHAR(50) NOT NULL UNIQUE,
  status_name VARCHAR(100) NOT NULL,
  color VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_closed BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_code VARCHAR(50) UNIQUE,
  customer_name VARCHAR(255) NOT NULL,
  mobile VARCHAR(30) NOT NULL,
  alternate_mobile VARCHAR(30),
  email VARCHAR(255),
  date_of_birth DATE,
  gender VARCHAR(50),
  marital_status VARCHAR(50),
  occupation VARCHAR(150),
  education VARCHAR(150),
  monthly_income NUMERIC(14,2),
  address TEXT,
  area VARCHAR(150),
  district VARCHAR(100),
  division VARCHAR(100),
  postal_code VARCHAR(20),
  source VARCHAR(100),
  priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL',
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  status_id UUID REFERENCES public.lead_status(id) ON DELETE SET NULL,
  expected_premium NUMERIC(14,2),
  expected_value NUMERIC(14,2),
  policy_term INTEGER,
  notes TEXT,
  assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMP,
  previous_assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
  last_contacted_at TIMESTAMP,
  next_follow_up_at TIMESTAMP,
  next_action VARCHAR(255),
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  converted_at TIMESTAMP,
  lost_at TIMESTAMP,
  lost_reason TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at TIMESTAMP,
  deleted_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  current_status VARCHAR(255),
  status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  assignment_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_call_at TIMESTAMP,
  CONSTRAINT chk_lead_follow_up_count CHECK (follow_up_count >= 0),
  CONSTRAINT chk_lead_policy_term CHECK (policy_term IS NULL OR policy_term > 0),
  CONSTRAINT chk_lead_expected_premium CHECK (expected_premium IS NULL OR expected_premium >= 0),
  CONSTRAINT chk_lead_expected_value CHECK (expected_value IS NULL OR expected_value >= 0)
);

-- Compatibility additions for installations whose leads table predates the current app shape.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS current_status VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS assignment_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS follow_up_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_call_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(100) NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT uq_metadata UNIQUE (category, code)
);

CREATE TABLE IF NOT EXISTS public.options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_key VARCHAR(100) NOT NULL,
  option_value VARCHAR(255) NOT NULL,
  option_label VARCHAR(255) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT uq_field_option UNIQUE (field_key, option_value)
);

ALTER TABLE public.options ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.metadata_types (
  key VARCHAR(100) PRIMARY KEY,
  label VARCHAR(255) NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_key VARCHAR(100) NOT NULL UNIQUE,
  form_name VARCHAR(255) NOT NULL,
  description TEXT,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.form_fields (
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
);

CREATE TABLE IF NOT EXISTS public.workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_key VARCHAR(100) NOT NULL,
  workflow_name VARCHAR(255) NOT NULL,
  from_status VARCHAR(100) NOT NULL,
  to_status VARCHAR(100) NOT NULL,
  allowed_role_id UUID REFERENCES public.roles(id) ON DELETE SET NULL,
  auto_assign BOOLEAN NOT NULL DEFAULT FALSE,
  send_notification BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_workflow_transition UNIQUE (workflow_key, from_status, to_status)
);

CREATE TABLE IF NOT EXISTS public.workflow_rules (
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
);

CREATE TABLE IF NOT EXISTS public.department_hierarchies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL UNIQUE REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE CASCADE,
  layers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Lead activities and scheduled work
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up',
  status VARCHAR(255),
  remarks TEXT,
  next_follow_up_at TIMESTAMP,
  next_call_at TIMESTAMP,
  meeting_at TIMESTAMP,
  meeting_type VARCHAR(255),
  collected_ncp NUMERIC(14,2),
  projected_ncp NUMERIC(14,2),
  sum_assured NUMERIC(14,2),
  product_name VARCHAR(255),
  loss_reason TEXT,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.scheduled_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call','meeting','follow_up','task')),
  title VARCHAR(255),
  scheduled_at TIMESTAMP NOT NULL,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  remarks TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL',
  meeting_type VARCHAR(255),
  location VARCHAR(255),
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  completed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  completed_activity_id UUID REFERENCES public.lead_activities(id) ON DELETE SET NULL
);

ALTER TABLE public.scheduled_activities
  ADD COLUMN IF NOT EXISTS priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS meeting_type VARCHAR(255),
  ADD COLUMN IF NOT EXISTS location VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completed_activity_id UUID REFERENCES public.lead_activities(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Notifications, audit, sessions, territories
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  reference_type VARCHAR(100),
  reference_id UUID,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMP,
  recipient_key VARCHAR(255),
  lead_code VARCHAR(50),
  event_type VARCHAR(100),
  idempotency_key VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS recipient_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS lead_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(500);

CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  token_hash VARCHAR(255),
  ip_address INET,
  user_agent TEXT,
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  target_user_id UUID REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  action_code VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.territories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id UUID REFERENCES public.territories(id) ON UPDATE CASCADE ON DELETE SET NULL,
  territory_type VARCHAR(30) NOT NULL CHECK (territory_type IN ('REGION','AREA','DISTRICT','BRANCH','OFFICE','CHANNEL','UNIT')),
  territory_code VARCHAR(50) NOT NULL,
  territory_name VARCHAR(150) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_territory_code UNIQUE (territory_type, territory_code)
);

CREATE TABLE IF NOT EXISTS public.user_territories (
  user_id UUID NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  territory_id UUID NOT NULL REFERENCES public.territories(id) ON UPDATE CASCADE ON DELETE CASCADE,
  access_level VARCHAR(20) NOT NULL DEFAULT 'VIEW' CHECK (access_level IN ('VIEW','MANAGE')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, territory_id)
);

CREATE TABLE IF NOT EXISTS public.user_visibility (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  visibility_level VARCHAR(30) NOT NULL DEFAULT 'SELF'
    CHECK (visibility_level IN ('SELF','TEAM','TEAM_TREE','DEPARTMENT','BRANCH','REGION','ORGANIZATION','CUSTOM')),
  custom_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.fine_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code VARCHAR(30) NOT NULL UNIQUE REFERENCES public.roles(role_code) ON UPDATE CASCADE ON DELETE CASCADE,
  role_name VARCHAR(100) NOT NULL DEFAULT '',
  modules JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Canonical action permissions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_code VARCHAR(100) UNIQUE NOT NULL,
  module_name VARCHAR(100) NOT NULL,
  action_name VARCHAR(30) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id UUID NOT NULL REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.user_permissions (
  user_id UUID NOT NULL REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  is_allowed BOOLEAN NOT NULL,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, permission_id)
);

INSERT INTO public.permissions (permission_code, module_name, action_name) VALUES
  ('dashboard.view','Dashboard','VIEW'),
  ('leads.view','Leads','VIEW'), ('leads.create','Leads','CREATE'),
  ('leads.edit','Leads','EDIT'), ('leads.delete','Leads','DELETE'),
  ('leads.assign','Leads','ASSIGN'), ('leads.transfer','Leads','TRANSFER'),
  ('leads.import','Leads','IMPORT'), ('leads.export','Leads','EXPORT'),
  ('campaigns.view','Campaigns','VIEW'), ('products.view','Products','VIEW'),
  ('users.view','Users','VIEW'), ('users.create','Users','CREATE'),
  ('users.edit','Users','EDIT'), ('users.delete','Users','DELETE'),
  ('users.activate','Users','EDIT'), ('users.lock','Users','EDIT'),
  ('departments.view','Departments','VIEW'), ('departments.manage','Departments','EDIT'),
  ('teams.view','Teams','VIEW'), ('teams.manage','Teams','EDIT'),
  ('roles.view','Roles','VIEW'), ('roles.manage','Roles','EDIT'),
  ('permissions.manage','Roles','EDIT'), ('reports.view','Reports','VIEW'),
  ('workflow.manage','Workflow','EDIT'), ('notifications.view','Notifications','VIEW'),
  ('settings.manage','Settings','EDIT'), ('hierarchy.manage','Users','EDIT'),
  ('audit.view','Users','VIEW'),
  ('roadshows.view','Roadshows','VIEW'), ('roadshows.create','Roadshows','CREATE'),
  ('roadshows.edit','Roadshows','EDIT'), ('roadshows.cancel','Roadshows','CANCEL'),
  ('roadshows.report','Roadshows','REPORT')
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id, is_allowed)
SELECT r.id, p.id, TRUE
  FROM public.roles r
  CROSS JOIN public.permissions p
  WHERE UPPER(r.role_code) = 'ADMIN'
ON CONFLICT (role_id, permission_id) DO UPDATE
   SET is_allowed = TRUE, updated_at = NOW();

INSERT INTO public.role_permissions (role_id, permission_id, is_allowed)
SELECT r.id, p.id, TRUE
   FROM public.roles r
   CROSS JOIN public.permissions p
  WHERE UPPER(r.role_code) = 'SUPERADMIN'
    AND p.permission_code LIKE 'roadshows.%'
ON CONFLICT (role_id, permission_id) DO UPDATE
   SET is_allowed = TRUE, updated_at = NOW();

-- Preserve existing user scopes; add a baseline only when missing.
INSERT INTO public.user_visibility (user_id, visibility_level)
SELECT u.id, CASE WHEN UPPER(r.role_code) = 'ADMIN' THEN 'ORGANIZATION' ELSE 'SELF' END
  FROM public.users u
  JOIN public.roles r ON r.id = u.role_id
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Roadshow Follow-up (migration 042)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roadshows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization VARCHAR(255) NOT NULL,
  location VARCHAR(255) NOT NULL,
  scheduled_at TIMESTAMP NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','execute','reschedule','cancel')),
  source_code VARCHAR(100) UNIQUE,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  executed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.roadshow_assignees (
  roadshow_id UUID NOT NULL REFERENCES public.roadshows(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (roadshow_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.roadshow_code_counters (
  organization_key VARCHAR(100) PRIMARY KEY,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

-- ---------------------------------------------------------------------------
-- Supporting indexes used by app queries
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_employee_id ON public.users(employee_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON public.users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_manager ON public.users(manager_id);
CREATE INDEX IF NOT EXISTS idx_users_department ON public.users(department_id);
CREATE INDEX IF NOT EXISTS idx_users_team ON public.users(team_id);
CREATE INDEX IF NOT EXISTS idx_users_account_status ON public.users(account_status);
CREATE INDEX IF NOT EXISTS idx_users_employee_record_id ON public.users(employee_record_id);
CREATE INDEX IF NOT EXISTS idx_leads_code ON public.leads(lead_code);
CREATE INDEX IF NOT EXISTS idx_leads_mobile ON public.leads(mobile);
CREATE INDEX IF NOT EXISTS idx_leads_email ON public.leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_product ON public.leads(product_id);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON public.leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads(status_id);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_to ON public.leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_by ON public.leads(assigned_by);
CREATE INDEX IF NOT EXISTS idx_leads_source ON public.leads(source);
CREATE INDEX IF NOT EXISTS idx_leads_priority ON public.leads(priority);
CREATE INDEX IF NOT EXISTS idx_leads_district ON public.leads(district);
CREATE INDEX IF NOT EXISTS idx_leads_division ON public.leads(division);
CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up ON public.leads(next_follow_up_at);
CREATE INDEX IF NOT EXISTS idx_leads_last_contacted ON public.leads(last_contacted_at);
CREATE INDEX IF NOT EXISTS idx_leads_created_by ON public.leads(created_by);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON public.leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_deleted ON public.leads(is_deleted);
CREATE INDEX IF NOT EXISTS idx_leads_assignment_status ON public.leads(assigned_to, current_status);
CREATE INDEX IF NOT EXISTS idx_leads_followup_active ON public.leads(next_follow_up_at) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_leads_current_status ON public.leads(current_status) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up_active ON public.leads(next_follow_up_at) WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_assigned_next_follow_up_active ON public.leads(assigned_to, next_follow_up_at) WHERE is_deleted = FALSE AND next_follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_custom_fields ON public.leads USING GIN (custom_fields);
CREATE INDEX IF NOT EXISTS idx_leads_tags ON public.leads USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_options_field ON public.options(field_key);
CREATE INDEX IF NOT EXISTS idx_options_active ON public.options(is_active);
CREATE INDEX IF NOT EXISTS idx_options_sort ON public.options(sort_order);
CREATE INDEX IF NOT EXISTS idx_metadata_category ON public.metadata(category);
CREATE INDEX IF NOT EXISTS idx_metadata_active ON public.metadata(is_active);
CREATE INDEX IF NOT EXISTS idx_metadata_sort ON public.metadata(sort_order);
CREATE INDEX IF NOT EXISTS idx_forms_key ON public.forms(form_key);
CREATE INDEX IF NOT EXISTS idx_forms_active ON public.forms(is_active);
CREATE INDEX IF NOT EXISTS idx_workflow_rules_status ON public.workflow_rules(status);
CREATE INDEX IF NOT EXISTS idx_employee_departments_employee ON public.employee_departments(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_departments_department ON public.employee_departments(department_id);
CREATE INDEX IF NOT EXISTS idx_employee_departments_active ON public.employee_departments(is_active);
CREATE INDEX IF NOT EXISTS idx_employees_employee_id ON public.employees(employee_id);
CREATE INDEX IF NOT EXISTS idx_employees_email ON public.employees(official_email);
CREATE INDEX IF NOT EXISTS idx_employees_status ON public.employees(employment_status);
CREATE INDEX IF NOT EXISTS idx_permissions_module ON public.permissions(module_name);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON public.user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_hierarchy_user ON public.hierarchies(user_id);
CREATE INDEX IF NOT EXISTS idx_hierarchy_manager ON public.hierarchies(manager_id);
CREATE INDEX IF NOT EXISTS idx_hierarchy_level ON public.hierarchies(level);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON public.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON public.sessions(expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON public.audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action_code);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_territories_parent ON public.territories(parent_id);
CREATE INDEX IF NOT EXISTS idx_territories_type ON public.territories(territory_type);
CREATE INDEX IF NOT EXISTS idx_user_territories_user ON public.user_territories(user_id);
CREATE INDEX IF NOT EXISTS idx_user_territories_territory ON public.user_territories(territory_id);
CREATE INDEX IF NOT EXISTS idx_fine_permissions_updated ON public.fine_permissions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON public.lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_created_at ON public.lead_activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON public.lead_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_by ON public.lead_activities(created_by);
CREATE INDEX IF NOT EXISTS idx_lead_activities_status ON public.lead_activities(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_lead_id ON public.scheduled_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_scheduled_at ON public.scheduled_activities(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_lead_scheduled ON public.scheduled_activities(lead_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_status ON public.scheduled_activities(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_type ON public.scheduled_activities(activity_type);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_created_by ON public.scheduled_activities(created_by);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_assigned_to ON public.scheduled_activities(assigned_to);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_updated_by ON public.scheduled_activities(updated_by);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_completed_by ON public.scheduled_activities(completed_by);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_completed_activity ON public.scheduled_activities(completed_activity_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_scheduled_at_status ON public.scheduled_activities(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_priority ON public.scheduled_activities(priority);
CREATE INDEX IF NOT EXISTS idx_scheduled_activities_open_lead ON public.scheduled_activities(lead_id, scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON public.notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON public.notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON public.notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_key ON public.notifications(recipient_key);
CREATE INDEX IF NOT EXISTS idx_notifications_event_type ON public.notifications(event_type) WHERE event_type IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency_key ON public.notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_roadshows_scheduled_status ON public.roadshows(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_roadshows_created_by ON public.roadshows(created_by);
CREATE INDEX IF NOT EXISTS idx_roadshow_assignees_user ON public.roadshow_assignees(user_id, roadshow_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_reporting_active ON public.employee_reporting(employee_id, relationship_type) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_products_code ON public.products(product_code);
CREATE INDEX IF NOT EXISTS idx_products_name ON public.products(product_name);
CREATE INDEX IF NOT EXISTS idx_products_active ON public.products(is_active);
CREATE INDEX IF NOT EXISTS idx_campaign_code ON public.campaigns(campaign_code);
CREATE INDEX IF NOT EXISTS idx_campaign_name ON public.campaigns(campaign_name);
CREATE INDEX IF NOT EXISTS idx_campaign_active ON public.campaigns(is_active);
CREATE INDEX IF NOT EXISTS idx_campaign_source ON public.campaigns(source);
CREATE INDEX IF NOT EXISTS idx_lead_status_code ON public.lead_status(status_code);
CREATE INDEX IF NOT EXISTS idx_lead_status_active ON public.lead_status(is_active);
CREATE INDEX IF NOT EXISTS idx_lead_status_sort ON public.lead_status(sort_order);
CREATE INDEX IF NOT EXISTS idx_workflow_key ON public.workflows(workflow_key);
CREATE INDEX IF NOT EXISTS idx_workflow_from_status ON public.workflows(from_status);
CREATE INDEX IF NOT EXISTS idx_workflow_to_status ON public.workflows(to_status);
CREATE INDEX IF NOT EXISTS idx_workflow_role ON public.workflows(allowed_role_id);
CREATE INDEX IF NOT EXISTS idx_workflow_active ON public.workflows(is_active);

COMMIT;
