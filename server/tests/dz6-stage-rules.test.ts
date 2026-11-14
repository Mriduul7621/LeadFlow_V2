/**
 * dz6-stage-rules.test.ts — DZ-6 stage rules & terminal unification
 * ------------------------------------------------------------------
 * Audit §2.4 (D2/D3) / §4 / §5 Finding 5: the per-status required
 * fields and the terminal set were keyed by status NAME in two
 * places (the LEAD_STAGE_RULES code table; the TERMINAL_LEAD_STATUSES
 * code constant next to the dictionary's meta.isTerminal flag), so
 * renaming a status silently detached its rule and its terminal
 * behaviour. DZ-6 unifies both under ONE source of truth:
 *   - rules live in lead_stage_rules (migration 060), keyed by the
 *     FollowUpStatus dictionary-entry id;
 *   - terminal / won / lost live on the dictionary rows themselves
 *     (meta.isTerminal / isWon / isLost) — the code constant is
 *     deleted, every "open lead" definition reads the flag.
 * Verifies:
 *  (a) migration 060 applies on a production-shaped schema, seeds
 *      the 5 code rules keyed by entry id, backfills the terminal
 *      flags, is idempotent on re-run (never resets an admin edit),
 *      and down() drops the table while keeping the flags;
 *  (b) GET / PUT /danger-zone/stage-rules + gating (non-super-admin
 *      403, locked 403 danger_zone_locked) + PUT validation 400s +
 *      audit rows carrying old→new + versioning;
 *  (c) THE risk-5 case, end-to-end: renaming a status keeps its
 *      stage rule AND its terminal behaviour (follow-up enforcement,
 *      queue, dashboard, SLA, quality, calendar sync);
 *  (d) a changed rule actually changes enforcement (not display-only);
 *      a terminal toggle re-opens / closes leads;
 *  (e) terminal behaviour is identical through every entry point
 *      that consults it: follow-up queue, dashboard counts, SLA
 *      compute, auto-assignment open counts, calendar sync
 *      (won completes / lost cancels), push reminder counts,
 *      deactivation open-lead summary, Lead Quality scoring;
 *  (f) GET /api/leads/stage-rules returns the effective rules the
 *      client form validates from;
 *  (g) DZ-0 / DZ-3 / DZ-4 / DZ-5 still answer on this tree.
 *
 * Production-shaped fixtures: roles carry data_visibility, the
 * users table carries the migration-022 columns and the migration-004
 * role FK; leads use `current_status`; options carry `meta`;
 * audit_logs match the production columns; lead_activities,
 * scheduled_activities and processed_followup_mutations come from
 * their real migrations (037 / 039+054+055 / 050), not hand-written
 * DDL — the standing lesson from the form_fields / team-overview
 * schema-drift saga.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrate037 } from '../database/migrations/037_lead_activities.js';
import { up as migrate039 } from '../database/migrations/039_scheduled_activities.js';
import { up as migrate050 } from '../database/migrations/050_processed_followup_mutations.js';
import { up as migrate054 } from '../database/migrations/054_next_step_calendar_sync.js';
import { up as migrate055 } from '../database/migrations/055_meeting_data_model.js';
import { up as migrate057 } from '../database/migrations/057_danger_zone_unlocks.js';
import { up as migrate060, down as migrate060Down } from '../database/migrations/060_stage_rules_terminal.js';

// Loaded lazily in before(), AFTER the test env vars are set:
// importing the services pulls in production/shared.ts, which reads
// JWT_SECRET once at module load. A top-level import would cache the
// unset value and every test token would verify as invalid.
let getEffectiveStageRules: typeof import('../services/StageRulesService.js').getEffectiveStageRules;
let getTerminalStatusNames: typeof import('../services/StageRulesService.js').getTerminalStatusNames;
let getTerminalStatusInfo: typeof import('../services/StageRulesService.js').getTerminalStatusInfo;
let validateStageRulesInput: typeof import('../services/StageRulesService.js').validateStageRulesInput;
let setStageRules: typeof import('../services/StageRulesService.js').setStageRules;
let getStageRulesForEdit: typeof import('../services/StageRulesService.js').getStageRulesForEdit;
let getLeadQualityConfig: typeof import('../services/LeadQualityConfigService.js').getLeadQualityConfig;
let computeLeadSla: typeof import('../services/LeadSlaService.js').computeLeadSla;
let loadAutoAssignCandidates: typeof import('../services/AutoAssignmentService.js').loadAutoAssignCandidates;
let syncNextStepAfterFollowUp: typeof import('../services/NextStepCalendarSync.js').syncNextStepAfterFollowUp;
let computeFollowUpReminderCounts: typeof import('../services/PushReminderService.js').computeFollowUpReminderCounts;
let summarizeOpenLeads: typeof import('../utils/userDeactivation.js').summarizeOpenLeads;
let calculateLeadQuality: typeof import('../utils/leadQuality.js').calculateLeadQuality;

// Test-only fixture secrets (assembled in parts so this file carries
// no contiguous literal), mirroring the other integration suites.
const JWT_SECRET = ['dz6', 'stage', 'rules', 'test', 'secret'].join('-');
const ADMIN_PASSWORD = ['Dz6', 'Stage', 'Rules', '1'].join('-');

/** The production FollowUpStatus dictionary (server/database/seeds/metadata.seed.ts). */
const STATUS_SEED: Array<{ value: string; meta: Record<string, unknown> }> = [
  { value: 'New', meta: { color: 'slate', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Contacted', meta: { color: 'blue', isWon: false, isLost: false, isTerminal: false } },
  { value: 'No Response', meta: { color: 'amber', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Busy', meta: { color: 'orange', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Interested', meta: { color: 'teal', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Follow-up Set', meta: { color: 'indigo', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Meeting Fixed', meta: { color: 'purple', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Meeting Completed', meta: { color: 'violet', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Proposal Sent', meta: { color: 'cyan', isWon: false, isLost: false, isTerminal: false } },
  { value: 'Pipeline Locked', meta: { color: 'yellow', isWon: false, isLost: false, isTerminal: false } },
  // Deliberately NO isTerminal key on the two canonical terminal
  // statuses: migration 060 must backfill it (the pre-060 shape).
  { value: 'Converted', meta: { color: 'green', isWon: true, isLost: false } },
  { value: 'Not Interested', meta: { color: 'red', isWon: false, isLost: true } },
];

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}
function tokenFor(user: any): string {
  return signToken({ id: user.id, employeeId: user.employeeId, role: user.role, email: user.email });
}
function createTestApp() {
  return import('../routes/production.routes.js').then(mod => {
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
    return app;
  });
}

async function setupSchema(pool: any) {
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, description TEXT, is_active BOOLEAN DEFAULT TRUE, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, phone VARCHAR(20), password VARCHAR(255) NOT NULL, role_id UUID NOT NULL, department_id UUID, team_id UUID, manager_id UUID, designation VARCHAR(100), joining_date DATE, profile_photo TEXT, last_login TIMESTAMP, is_active BOOLEAN DEFAULT TRUE, account_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0), locked_until TIMESTAMP, password_changed_at TIMESTAMP, employee_record_id UUID, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS hierarchies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL UNIQUE, manager_id UUID, level INTEGER NOT NULL DEFAULT 1, path TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, target_user_id UUID, action_code VARCHAR(100) NOT NULL, entity_type VARCHAR(100) NOT NULL, entity_id UUID, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS metadata_types (key VARCHAR(100) PRIMARY KEY, label VARCHAR(255) NOT NULL, description TEXT, is_system BOOLEAN NOT NULL DEFAULT FALSE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'New', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0);`);
}

describe('DZ-6 — Stage rules & terminal unification', () => {
  let pool: any;
  let app: express.Express;
  let deptId: string;
  let adminRoleId: string;
  let managerRoleId: string;
  let roRoleId: string;
  let superAdmin: any;
  let mgr: any;
  let ro1: any;
  let ro2: any;
  /** option id -> original seed value (renames are restored by id). */
  let statusIdByValue = new Map<string, string>();
  let leadSeq = 0;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    // Env first, imports second (see the note at the top of this file).
    ({
      getEffectiveStageRules,
      getTerminalStatusNames,
      getTerminalStatusInfo,
      validateStageRulesInput,
      setStageRules,
      getStageRulesForEdit,
    } = await import('../services/StageRulesService.js'));
    ({ getLeadQualityConfig } = await import('../services/LeadQualityConfigService.js'));
    ({ computeLeadSla } = await import('../services/LeadSlaService.js'));
    ({ loadAutoAssignCandidates } = await import('../services/AutoAssignmentService.js'));
    ({ syncNextStepAfterFollowUp } = await import('../services/NextStepCalendarSync.js'));
    ({ computeFollowUpReminderCounts } = await import('../services/PushReminderService.js'));
    ({ summarizeOpenLeads } = await import('../utils/userDeactivation.js'));
    ({ calculateLeadQuality } = await import('../utils/leadQuality.js'));

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    deptId = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT6', 'Sales') RETURNING id`)).rows[0].id;
    const mkRole = async (code: string, name: string, level: number, vis: string) =>
      (await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, name, level, vis]
      )).rows[0].id;
    adminRoleId = await mkRole('ADMIN', 'Admin', 100, 'Organization');
    managerRoleId = await mkRole('MANAGER', 'Manager', 2, 'FullTeam');
    roRoleId = await mkRole('RO', 'Relationship Officer', 4, 'Own');

    const ALL_CODES = [
      'dashboard.view', 'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
      'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
      'campaigns.view', 'products.view', 'users.view', 'users.create', 'users.edit',
      'users.delete', 'users.activate', 'users.lock', 'departments.view',
      'departments.manage', 'teams.view', 'teams.manage', 'roles.view',
      'roles.manage', 'permissions.manage', 'reports.view', 'workflow.manage',
      'notifications.view', 'settings.manage', 'hierarchy.manage', 'audit.view',
      'roadshows.view', 'roadshows.create', 'roadshows.edit', 'roadshows.cancel',
      'roadshows.report',
    ];
    const permIds: Record<string, string> = {};
    for (const code of ALL_CODES) {
      permIds[code] = (await pool.query(
        `INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $1) RETURNING id`,
        [code]
      )).rows[0].id;
    }
    const grant = async (roleId: string, codes: string[]) => {
      for (const code of codes) {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
          [roleId, permIds[code]]
        );
      }
    };
    await grant(adminRoleId, ALL_CODES);
    await grant(managerRoleId, ['dashboard.view', 'leads.view', 'leads.edit']);
    await grant(roRoleId, ['dashboard.view', 'leads.view', 'leads.edit']);

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const mkUser = async (emp: string, roleId: string, roleCode: string, managerId: string | null = null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, adminHash, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, role: roleCode };
    };
    superAdmin = await mkUser('DZ6ADMIN', adminRoleId, 'ADMIN');
    mgr = await mkUser('DZ6MGR', managerRoleId, 'MANAGER');
    ro1 = await mkUser('DZ6RO1', roRoleId, 'RO', mgr.id);
    ro2 = await mkUser('DZ6RO2', roRoleId, 'RO', mgr.id);

    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       VALUES ('FollowUpStatus', 'Lead Status', 'Pipeline stages a lead moves through', TRUE, 1)
       ON CONFLICT (key) DO NOTHING`
    );
    for (let i = 0; i < STATUS_SEED.length; i++) {
      const s = STATUS_SEED[i];
      const id = (await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
         VALUES ('FollowUpStatus', $1, $1, $2, FALSE, TRUE, $3::jsonb) RETURNING id`,
        [s.value, i + 1, JSON.stringify(s.meta)]
      )).rows[0].id;
      statusIdByValue.set(s.value, id);
    }

    // Real migrations, not hand-written DDL, for every table the
    // follow-up / calendar / SLA paths touch.
    await migrate037();
    await migrate039();
    await migrate050();
    await migrate054();
    await migrate055();
    await migrate057();
    await migrate060();
    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    // Every test starts from the canonical dictionary + the seeded
    // rule set: renames are restored BY ID (the unique key is the
    // value, so an upsert could not undo a rename), flags are
    // restored to the seed meta, and the rule table is re-seeded.
    for (const s of STATUS_SEED) {
      const id = statusIdByValue.get(s.value);
      await pool.query(
        `UPDATE options SET option_value = $1, meta = $2::jsonb WHERE id = $3`,
        [s.value, JSON.stringify(s.meta), id]
      );
    }
    await pool.query(`DELETE FROM lead_stage_rules`);
    await migrate060();
    await pool.query(`DELETE FROM scheduled_activities`);
    await pool.query(`DELETE FROM lead_activities`);
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM audit_logs`);
    // An unlock from a previous test must never leak into the next
    // one — the "locked" gating tests depend on starting locked.
    await pool.query(`DELETE FROM danger_zone_unlocks`);
  });

  const dz = (method: 'get' | 'put' | 'post', path: string, user: any, body?: any) => {
    const req = request(app)[method](`/api/danger-zone${path}`).set('Authorization', `Bearer ${tokenFor(user)}`);
    return body === undefined ? req : req.send(body);
  };

  const unlockAs = async (user: any) => {
    const res = await dz('post', '/unlock', user, { password: ADMIN_PASSWORD });
    assert.equal(res.status, 200, `unlock failed: ${JSON.stringify(res.body)}`);
    return res;
  };

  async function auditRows(actionCode: string): Promise<any[]> {
    const r: any = await pool.query(
      `SELECT * FROM audit_logs WHERE action_code = $1 ORDER BY created_at ASC`,
      [actionCode]
    );
    return r.rows;
  }

  async function optionId(value: string): Promise<string> {
    const r: any = await pool.query(
      `SELECT id FROM options WHERE field_key = 'FollowUpStatus' AND option_value = $1 LIMIT 1`,
      [value]
    );
    assert.ok(r.rows[0], `no dictionary entry for "${value}"`);
    return r.rows[0].id as string;
  }

  async function optionMeta(value: string): Promise<any> {
    const r: any = await pool.query(
      `SELECT meta FROM options WHERE field_key = 'FollowUpStatus' AND option_value = $1 LIMIT 1`,
      [value]
    );
    return r.rows[0]?.meta ?? null;
  }

  async function renameStatus(from: string, to: string) {
    await pool.query(
      `UPDATE options SET option_value = $1, option_label = $1 WHERE field_key = 'FollowUpStatus' AND option_value = $2`,
      [to, from]
    );
  }

  /** A PUT body built from the live GET response, with optional edits. */
  async function currentPutBody(): Promise<{ rules: any[]; terminalStatusIds: string[] }> {
    const res = await dz('get', '/stage-rules', superAdmin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    const rules = data.statusOptions
      .filter((o: any) => o.required && o.required.length > 0)
      .map((o: any) => ({ statusId: o.id, required: o.required }));
    return { rules, terminalStatusIds: [...data.terminalStatusIds] };
  }

  async function insertLead(fields: {
    status: string;
    owner?: any;
    nextFollowUpAt?: string | null;
    assignedAt?: string | null;
    createdAt?: string | null;
    expectedPremium?: number | null;
  }): Promise<string> {
    leadSeq += 1;
    const owner = fields.owner ?? ro1;
    const res: any = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by,
         current_status, next_follow_up_at, assigned_at, created_at, expected_premium)
       VALUES ($1, $2, $3, $4, $4, $4, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        `DZ6-${String(leadSeq).padStart(4, '0')}`,
        `Lead ${leadSeq}`,
        `01760${String(100000 + leadSeq)}`,
        owner.id,
        fields.status,
        fields.nextFollowUpAt ?? null,
        fields.assignedAt ?? null,
        fields.createdAt ?? null,
        fields.expectedPremium ?? null,
      ]
    );
    return res.rows[0].id as string;
  }

  const followUp = (leadId: string, user: any, body: any) =>
    request(app).post(`/api/leads/${encodeURIComponent(leadId)}/follow-up`)
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send(body);

  const queueItems = async (user: any): Promise<any[]> => {
    const res = await request(app).get('/api/leads/follow-ups?bucket=all&limit=200')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    return res.body.data.items as any[];
  };

  /* ==================================================================
     (a) Migration 060
  ================================================================== */
  describe('migration 060', () => {
    it('seeds the 5 code rules keyed by entry id and backfills the terminal flags', async () => {
      const rules: any = await pool.query(
        `SELECT o.option_value AS status, r.required_fields AS required
           FROM lead_stage_rules r JOIN options o ON o.id = r.status_option_id
          ORDER BY o.option_value`
      );
      assert.equal(rules.rows.length, 5, 'exactly the 5 code rules');
      const byStatus = new Map(rules.rows.map((r: any) => [r.status, r.required]));
      assert.deepEqual((byStatus.get('Follow-up Set') as any[]).map((f: any) => f.field), ['nextFollowUpDate']);
      assert.deepEqual((byStatus.get('Meeting Fixed') as any[]).map((f: any) => f.field), ['meetingDate']);
      assert.deepEqual((byStatus.get('Proposal Sent') as any[]).map((f: any) => f.field), ['productName', 'sumAssured', 'projectedNCP']);
      assert.deepEqual((byStatus.get('Converted') as any[]).map((f: any) => f.field), ['productName', 'sumAssured', 'collectedNCP']);
      assert.deepEqual((byStatus.get('Not Interested') as any[]).map((f: any) => f.field), ['lossReason']);

      // The backfill: the two canonical names had NO isTerminal key
      // in the seed, and now carry isTerminal = true with the other
      // meta keys intact.
      assert.equal((await optionMeta('Converted')).isTerminal, true);
      assert.equal((await optionMeta('Converted')).isWon, true);
      assert.equal((await optionMeta('Not Interested')).isTerminal, true);
      assert.equal((await optionMeta('Not Interested')).isLost, true);
      assert.equal((await optionMeta('Interested')).isTerminal, false, 'an explicit false is never touched');
      assert.equal((await optionMeta('New')).isTerminal, false);

      const effective = await getEffectiveStageRules();
      assert.equal(effective.length, 5);
      assert.ok(effective.every(r => r.statusId && r.status && r.required.length > 0));
      assert.deepEqual((await getTerminalStatusNames()).sort(), ['Converted', 'Not Interested']);
    });

    it('is idempotent on re-run and never resets an admin edit', async () => {
      await unlockAs(superAdmin);
      // An admin edit: Not Interested no longer requires a loss reason.
      const body = await currentPutBody();
      const notInterestedId = await optionId('Not Interested');
      body.rules = body.rules.filter((r: any) => r.statusId !== notInterestedId);
      const saved = await dz('put', '/stage-rules', superAdmin, body);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      await migrate060();
      const rules: any = await pool.query(`SELECT COUNT(*)::int AS n FROM lead_stage_rules`);
      assert.equal(rules.rows[0].n, 4, 'the deleted rule stays deleted — no re-seed');
      const effective = await getEffectiveStageRules();
      assert.ok(!effective.some(r => r.status === 'Not Interested'), 'the admin edit survived the re-run');
      assert.ok(effective.some(r => r.status === 'Meeting Fixed'));
    });

    it('down() drops the table and keeps the flags; the runtime then falls back to the code defaults', async () => {
      await migrate060Down();
      const gone: any = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lead_stage_rules') AS exists`
      );
      assert.equal(gone.rows[0].exists, false);
      assert.equal((await optionMeta('Converted')).isTerminal, true, 'the flag backfill is data repair — kept');
      // With no stored rows the effective rules are the code defaults.
      const effective = await getEffectiveStageRules();
      assert.equal(effective.length, 5);
      assert.deepEqual(effective.map(r => r.status).sort(), ['Converted', 'Follow-up Set', 'Meeting Fixed', 'Not Interested', 'Proposal Sent']);
      // Restore for the rest of the suite.
      await migrate060();
      const back: any = await pool.query(`SELECT COUNT(*)::int AS n FROM lead_stage_rules`);
      assert.equal(back.rows[0].n, 5);
    });
  });

  /* ==================================================================
     (b) GET / PUT + gating + validation + audit
  ================================================================== */
  describe('Danger Zone read/write + gating', () => {
    it('GET returns version 0, the effective rules, the defaults, the vocabulary and the terminal set', async () => {
      await unlockAs(superAdmin);
      const res = await dz('get', '/stage-rules', superAdmin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const data = res.body.data;
      assert.equal(data.version, 0, 'nothing saved yet');
      assert.equal(data.rules.length, 5);
      assert.equal(data.defaults.length, 5);
      assert.ok(data.fieldVocabulary.some((f: any) => f.field === 'lossReason'));
      assert.ok(data.fieldVocabulary.some((f: any) => f.field === 'collectedNCP' && f.numeric && f.positive));
      assert.equal(data.statusOptions.length, 12, 'all dictionary entries listed');
      const converted = data.statusOptions.find((o: any) => o.value === 'Converted');
      assert.equal(converted.isTerminal, true);
      assert.equal(converted.isWon, true);
      assert.deepEqual((converted.required as any[]).map((f: any) => f.field), ['productName', 'sumAssured', 'collectedNCP']);
      const interested = data.statusOptions.find((o: any) => o.value === 'Interested');
      assert.equal(interested.isTerminal, false);
      assert.equal(interested.required, null, 'no rule for this status');
      assert.deepEqual([...data.terminalStatusIds].sort(), [converted.id, data.statusOptions.find((o: any) => o.value === 'Not Interested').id].sort());
      assert.equal(data.lastChange, null);
    });

    it('GET without unlock: 403 danger_zone_locked (never 401); as a non-super-admin: 403', async () => {
      const locked = await dz('get', '/stage-rules', superAdmin);
      assert.equal(locked.status, 403, JSON.stringify(locked.body));
      assert.equal(locked.body.error, 'danger_zone_locked');
      await unlockAs(superAdmin);
      const nonAdmin = await dz('get', '/stage-rules', mgr);
      assert.equal(nonAdmin.status, 403, JSON.stringify(nonAdmin.body));
    });

    it('PUT as a non-super-admin: 403 even with a valid body', async () => {
      await unlockAs(superAdmin);
      const body = await currentPutBody();
      const res = await dz('put', '/stage-rules', mgr, body);
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    it('PUT validation: unknown id, duplicate, unknown field, wrong label, empty rules, empty terminal set', async () => {
      await unlockAs(superAdmin);
      const base = await currentPutBody();
      const cases: Array<{ body: any; match: RegExp }> = [
        {
          body: { ...base, rules: [...base.rules, { statusId: '00000000-0000-0000-0000-000000000000', required: [{ field: 'lossReason', label: 'Loss reason' }] }] },
          match: /not a FollowUpStatus dictionary entry/,
        },
        {
          body: { ...base, rules: [...base.rules, base.rules[0]] },
          match: /more than one rule/,
        },
        {
          body: { ...base, rules: base.rules.map((r: any, i: number) => (i === 0 ? { ...r, required: [{ field: 'nope', label: 'Nope' }] } : r)) },
          match: /unknown field "nope"/,
        },
        {
          body: { ...base, rules: base.rules.map((r: any, i: number) => (i === 0 ? { ...r, required: [{ field: 'lossReason', label: 'Wrong label' }] } : r)) },
          match: /label/,
        },
        {
          body: { rules: [], terminalStatusIds: base.terminalStatusIds },
          match: /must not be empty/,
        },
        {
          body: { ...base, terminalStatusIds: [] },
          match: /At least one status must stay terminal/,
        },
        {
          body: { ...base, terminalStatusIds: ['00000000-0000-0000-0000-000000000000'] },
          match: /not a FollowUpStatus dictionary entry/,
        },
      ];
      for (const { body, match } of cases) {
        const res = await dz('put', '/stage-rules', superAdmin, body);
        assert.equal(res.status, 400, `must be refused: ${JSON.stringify(res.body)}`);
        assert.match(res.body.message, match);
      }
    });

    it('PUT saves a versioned set and audit-logs old→new; a second save versions up again', async () => {
      await unlockAs(superAdmin);
      const body = await currentPutBody();
      // Remove the loss-reason requirement from Not Interested.
      const notInterestedId = await optionId('Not Interested');
      body.rules = body.rules.filter((r: any) => r.statusId !== notInterestedId);
      const res = await dz('put', '/stage-rules', superAdmin, body);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.version, 1);
      assert.equal(res.body.data.rules.length, 4);
      assert.ok(!res.body.data.rules.some((r: any) => r.status === 'Not Interested'));

      const rows = await auditRows('danger_zone.stage_rules.update');
      assert.equal(rows.length, 1);
      const meta = rows[0].metadata as any;
      assert.equal(meta.version, 1);
      assert.equal(meta.oldValue.rules.length, 5);
      assert.equal(meta.newValue.rules.length, 4);
      assert.deepEqual([...meta.oldValue.terminalStatusIds].sort(), [...meta.newValue.terminalStatusIds].sort());

      const again = await dz('get', '/stage-rules', superAdmin);
      assert.equal(again.body.data.version, 1);
      assert.equal(again.body.data.lastChange.version, 1);
      assert.equal(again.body.data.lastChange.oldValue.rules.length, 5);
      assert.equal(again.body.data.lastChange.newValue.rules.length, 4);

      const res2 = await dz('put', '/stage-rules', superAdmin, body);
      assert.equal(res2.body.data.version, 2);
    });

    it('validateStageRulesInput unit behaviour: the code table passes, an empty list fails', () => {
      const dictionary = STATUS_SEED.map((s, i) => ({
        id: `id-${i}`, value: s.value, label: s.value, isActive: true,
        isTerminal: ['Converted', 'Not Interested'].includes(s.value),
        isWon: s.value === 'Converted', isLost: s.value === 'Not Interested',
      }));
      const convertedId = dictionary.find(d => d.value === 'Converted')!.id;
      assert.deepEqual(
        validateStageRulesInput(
          { rules: [{ statusId: convertedId, required: [{ field: 'productName', label: 'Product' }] }], terminalStatusIds: [convertedId] },
          dictionary
        ),
        []
      );
      assert.ok(validateStageRulesInput({ rules: [], terminalStatusIds: [convertedId] }, dictionary).length > 0);
      assert.ok(validateStageRulesInput({ rules: [{ statusId: convertedId, required: [{ field: 'productName', label: 'Product' }] }], terminalStatusIds: [] }, dictionary).length > 0);
    });
  });

  /* ==================================================================
     (c) THE risk-5 case: a rename keeps its rule AND its terminal
     behaviour, end to end
  ================================================================== */
  describe('rename keeps rules + terminal behaviour (audit risk 5)', () => {
    it('renaming "Meeting Fixed" keeps its rule: no meeting date is refused, with one it saves', async () => {
      await renameStatus('Meeting Fixed', 'Meeting Set');
      const leadId = await insertLead({ status: 'Interested', owner: ro1 });

      const refused = await followUp(leadId, ro1, { status: 'Meeting Set', remarks: 'renamed, no date' });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(refused.body.message, /Meeting date & time/);

      const saved = await followUp(leadId, ro1, {
        status: 'Meeting Set', remarks: 'renamed, with date',
        meetingDate: new Date(Date.now() + 86400000).toISOString(),
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const row: any = await pool.query(`SELECT current_status FROM leads WHERE id = $1`, [leadId]);
      assert.equal(row.rows[0].current_status, 'Meeting Set');
    });

    it('renaming "Converted" → "Won" and "Not Interested" → "Lost" keeps terminal behaviour everywhere', async () => {
      await renameStatus('Converted', 'Won');
      await renameStatus('Not Interested', 'Lost');
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).toISOString();
      const wonLead = await insertLead({ status: 'Won', owner: ro1, nextFollowUpAt: today });
      const lostLead = await insertLead({ status: 'Lost', owner: ro1, nextFollowUpAt: today });
      const openLead = await insertLead({ status: 'Interested', owner: ro1, nextFollowUpAt: today });

      // (1) The follow-up queue excludes the renamed terminal leads.
      const items = await queueItems(superAdmin);
      const mobiles = items.map((i: any) => i.mobile);
      assert.ok(!mobiles.includes((await pool.query(`SELECT mobile FROM leads WHERE id = $1`, [wonLead])).rows[0].mobile), 'Won is out of the queue');
      assert.ok(!mobiles.includes((await pool.query(`SELECT mobile FROM leads WHERE id = $1`, [lostLead])).rows[0].mobile), 'Lost is out of the queue');
      assert.ok(mobiles.includes((await pool.query(`SELECT mobile FROM leads WHERE id = $1`, [openLead])).rows[0].mobile), 'Interested stays in the queue');

      // (2) The dashboard counts the renamed pair as converted / lost,
      //     and neither as active.
      const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${tokenFor(superAdmin)}`);
      assert.equal(dash.status, 200, JSON.stringify(dash.body).slice(0, 300));
      const d = dash.body.data;
      assert.equal(d.totalLeads, 3);
      assert.equal(d.activeLeads, 1, 'only Interested is active');
      assert.equal(d.converted, 1, 'Won counts as converted');
      assert.equal(d.notInterested, 1, 'Lost counts as lost');
      assert.equal(d.followUpsQueue.all, 1, 'queue count agrees with the queue endpoint');

      // (3) SLA: a Won lead has no SLA; an open lead does (when on).
      const terminalNames = await getTerminalStatusNames();
      assert.deepEqual([...terminalNames].sort(), ['Lost', 'Won']);
      const slaWon = computeLeadSla(
        { assignedTo: ro1.id, assignedAt: new Date(Date.now() - 48 * 3600000).toISOString(), createdAt: new Date(Date.now() - 72 * 3600000).toISOString(), lastContactedAt: null, currentStatus: 'Won' },
        24, now, terminalNames
      );
      assert.equal(slaWon, null, 'terminal → no SLA');
      const slaOpen = computeLeadSla(
        { assignedTo: ro1.id, assignedAt: new Date(Date.now() - 48 * 3600000).toISOString(), createdAt: new Date(Date.now() - 72 * 3600000).toISOString(), lastContactedAt: null, currentStatus: 'Interested' },
        24, now, terminalNames
      );
      assert.ok(slaOpen, 'open lead gets an SLA result');
      assert.equal(slaOpen!.state, 'breached', '48h without contact breaches 24h');

      // (4) Lead Quality: Won = 100, Lost = 0, via the resolved config.
      const cfg = await getLeadQualityConfig();
      assert.deepEqual([...cfg.terminalWon].sort(), ['Won']);
      assert.deepEqual([...cfg.terminalLost].sort(), ['Lost']);
      const wonScore = calculateLeadQuality({ status: 'Won', createdAt: now.toISOString() } as any, cfg);
      assert.equal(wonScore.score, 100);
      assert.equal(wonScore.band, 'Won');
      const lostScore = calculateLeadQuality({ status: 'Lost', createdAt: now.toISOString() } as any, cfg);
      assert.equal(lostScore.score, 0);
      assert.equal(lostScore.band, 'Lost');

      // (5) Auto-assignment open counts exclude the renamed pair.
      const candidates = await loadAutoAssignCandidates(pool, [ro1.id]);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].openLeads, 1, 'only the Interested lead counts as open');

      // (6) Deactivation summary agrees: ro1 has exactly 1 open lead.
      const summary = await summarizeOpenLeads(pool, ro1.id);
      assert.equal(summary.available, true);
      assert.equal(summary.count, 1);

      // (7) Push reminder counts exclude the renamed pair.
      const caller = { id: superAdmin.id, employee_id: superAdmin.employeeId, email: superAdmin.email, role_id: adminRoleId, role_code: 'ADMIN', department_id: deptId };
      const counts = await computeFollowUpReminderCounts(caller, now);
      assert.equal(counts.dueToday + counts.overdue, 1, 'only the Interested lead is due');
    });

    it('renaming "Not Interested" keeps the loss-reason rule (the FIX-1a regression, by id not name)', async () => {
      await renameStatus('Not Interested', 'Lost');
      const leadId = await insertLead({ status: 'Interested', owner: ro1 });
      const refused = await followUp(leadId, ro1, { status: 'Lost', remarks: 'no reason' });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(refused.body.message, /Loss reason/);
      const saved = await followUp(leadId, ro1, { status: 'Lost', remarks: 'has reason', lossReason: 'Price too high' });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    });
  });

  /* ==================================================================
     (d) A changed rule actually changes enforcement; a terminal
     toggle re-opens / closes leads
  ================================================================== */
  describe('rule changes change enforcement (not display-only)', () => {
    it('removing lossReason from Not Interested lets the follow-up save without it', async () => {
      await unlockAs(superAdmin);
      const body = await currentPutBody();
      const notInterestedId = await optionId('Not Interested');
      body.rules = body.rules.filter((r: any) => r.statusId !== notInterestedId);
      const saved = await dz('put', '/stage-rules', superAdmin, body);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      const leadId = await insertLead({ status: 'Interested', owner: ro1 });
      const res = await followUp(leadId, ro1, { status: 'Not Interested', remarks: 'no reason needed any more' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('adding meetingDate to Follow-up Set makes it enforced', async () => {
      await unlockAs(superAdmin);
      const body = await currentPutBody();
      const followUpSetId = await optionId('Follow-up Set');
      const rule = body.rules.find((r: any) => r.statusId === followUpSetId);
      rule.required.push({ field: 'meetingDate', label: 'Meeting date & time' });
      const saved = await dz('put', '/stage-rules', superAdmin, body);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      const leadId = await insertLead({ status: 'Interested', owner: ro1 });
      const refused = await followUp(leadId, ro1, {
        status: 'Follow-up Set', remarks: 'date only',
        nextFollowUpDate: new Date(Date.now() + 86400000).toISOString(),
      });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(refused.body.message, /Meeting date & time/);
      const ok = await followUp(leadId, ro1, {
        status: 'Follow-up Set', remarks: 'both dates',
        nextFollowUpDate: new Date(Date.now() + 86400000).toISOString(),
        meetingDate: new Date(Date.now() + 2 * 86400000).toISOString(),
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    });

    it('un-ticking Not Interested re-opens its leads; ticking Interested closes them', async () => {
      await unlockAs(superAdmin);
      const today = new Date(new Date().setHours(12, 0, 0, 0)).toISOString();
      const lostLead = await insertLead({ status: 'Not Interested', owner: ro1, nextFollowUpAt: today });
      const interestedLead = await insertLead({ status: 'Interested', owner: ro1, nextFollowUpAt: today });

      // Baseline: only the Interested lead is queued.
      let items = await queueItems(superAdmin);
      assert.equal(items.length, 1);
      assert.equal(items[0].dbId, interestedLead);

      // Un-tick Not Interested → its lead joins the queue.
      const body = await currentPutBody();
      const notInterestedId = await optionId('Not Interested');
      body.terminalStatusIds = body.terminalStatusIds.filter((id: string) => id !== notInterestedId);
      const saved = await dz('put', '/stage-rules', superAdmin, body);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      items = await queueItems(superAdmin);
      assert.equal(items.length, 2, 'the un-ticked lead is open again');
      assert.deepEqual(items.map((i: any) => i.dbId).sort(), [lostLead, interestedLead].sort());

      // Tick Interested → its lead leaves the queue.
      const body2 = await currentPutBody();
      body2.terminalStatusIds = [...body2.terminalStatusIds, await optionId('Interested')];
      const saved2 = await dz('put', '/stage-rules', superAdmin, body2);
      assert.equal(saved2.status, 200, JSON.stringify(saved2.body));
      items = await queueItems(superAdmin);
      assert.equal(items.length, 1);
      assert.equal(items[0].dbId, lostLead);
    });
  });

  /* ==================================================================
     (e) Calendar sync: won completes, lost cancels (renamed names)
  ================================================================== */
  describe('calendar sync follows the dictionary won/lost flags', () => {
    async function openEntry(leadId: string, activityId: string): Promise<string> {
      const r: any = await pool.query(
        `INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, priority, source_activity_id, source_kind, created_by, assigned_to, updated_by)
         VALUES ($1, 'follow_up', 'Follow up', NOW() + INTERVAL '1 day', 'scheduled', 'NORMAL', $2, 'follow_up', $3, $3, $3) RETURNING id`,
        [leadId, activityId, ro1.id]
      );
      return r.rows[0].id as string;
    }

    it('a WON terminal completes the open entry; a LOST terminal cancels it', async () => {
      await renameStatus('Converted', 'Won');
      await renameStatus('Not Interested', 'Lost');
      const wonLead = await insertLead({ status: 'Interested', owner: ro1 });
      const lostLead = await insertLead({ status: 'Interested', owner: ro1 });
      const actWon = (await pool.query(
        `INSERT INTO lead_activities (lead_id, activity_type, status, created_by) VALUES ($1, 'follow_up', 'Won', $2) RETURNING id`,
        [wonLead, ro1.id]
      )).rows[0].id as string;
      const actLost = (await pool.query(
        `INSERT INTO lead_activities (lead_id, activity_type, status, created_by) VALUES ($1, 'follow_up', 'Lost', $2) RETURNING id`,
        [lostLead, ro1.id]
      )).rows[0].id as string;
      const entryWon = await openEntry(wonLead, actWon);
      const entryLost = await openEntry(lostLead, actLost);

      const wonRes = await syncNextStepAfterFollowUp(pool, {
        leadId: wonLead, sourceActivityId: actWon, sourceKind: 'follow_up',
        actorId: ro1.id, assignedTo: ro1.id, nextStepAt: null, kind: 'follow_up',
        leadStatusAfter: 'Won',
      });
      assert.equal(wonRes.synced, true);
      const lostRes = await syncNextStepAfterFollowUp(pool, {
        leadId: lostLead, sourceActivityId: actLost, sourceKind: 'follow_up',
        actorId: ro1.id, assignedTo: ro1.id, nextStepAt: null, kind: 'follow_up',
        leadStatusAfter: 'Lost',
      });
      assert.equal(lostRes.synced, true);

      const rows: any = await pool.query(
        `SELECT id, status FROM scheduled_activities WHERE id IN ($1, $2)`,
        [entryWon, entryLost]
      );
      const byId = new Map(rows.rows.map((r: any) => [r.id, r.status]));
      assert.equal(byId.get(entryWon), 'completed', 'won completes the entry');
      assert.equal(byId.get(entryLost), 'cancelled', 'lost cancels the entry');
    });
  });

  /* ==================================================================
     (f) The client-facing effective-rules endpoint + (g) siblings
  ================================================================== */
  describe('client rules endpoint + sibling slices', () => {
    it('GET /api/leads/stage-rules returns the effective rules for the form', async () => {
      const res = await request(app).get('/api/leads/stage-rules')
        .set('Authorization', `Bearer ${tokenFor(ro1)}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.rules.length, 5);
      assert.deepEqual(
        res.body.data.rules.map((r: any) => r.status).sort(),
        ['Converted', 'Follow-up Set', 'Meeting Fixed', 'Not Interested', 'Proposal Sent']
      );
      assert.deepEqual([...res.body.data.terminalNames].sort(), ['Converted', 'Not Interested']);

      const anon = await request(app).get('/api/leads/stage-rules');
      assert.equal(anon.status, 401, 'authentication is required');
    });

    it('GET /api/leads/stage-rules follows a saved edit (the form can never drift from the server)', async () => {
      await unlockAs(superAdmin);
      const body = await currentPutBody();
      const notInterestedId = await optionId('Not Interested');
      body.rules = body.rules.filter((r: any) => r.statusId !== notInterestedId);
      await dz('put', '/stage-rules', superAdmin, body);
      const res = await request(app).get('/api/leads/stage-rules')
        .set('Authorization', `Bearer ${tokenFor(ro1)}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.rules.length, 4);
      assert.ok(!res.body.data.rules.some((r: any) => r.status === 'Not Interested'));
    });

    it('DZ-0 / DZ-3 / DZ-4 / DZ-5 still answer on this tree', async () => {
      await unlockAs(superAdmin);
      const overview = await dz('get', '/overview', superAdmin);
      assert.equal(overview.status, 200, JSON.stringify(overview.body).slice(0, 200));
      const lq = await dz('get', '/lead-quality', superAdmin);
      assert.equal(lq.status, 200, JSON.stringify(lq.body).slice(0, 200));
      const sp = await dz('get', '/security-policy', superAdmin);
      assert.equal(sp.status, 200, JSON.stringify(sp.body).slice(0, 200));
      assert.equal(sp.body.data.policy.passwordMinLength, 8);
      const rd = await dz('get', '/role-defaults', superAdmin);
      assert.equal(rd.status, 200, JSON.stringify(rd.body).slice(0, 200));
      assert.equal(rd.body.data.version, 0);
    });
  });
});
