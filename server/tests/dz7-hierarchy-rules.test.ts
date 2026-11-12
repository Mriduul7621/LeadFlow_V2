/**
 * dz7-hierarchy-rules.test.ts — DZ-7 hierarchy knobs in the Danger Zone
 * ------------------------------------------------------------------
 * Audit §2.3 (C2/C4) / §4: the maximum reporting gap (bounded 1–3)
 * and the same-department requirement become settings read by
 * `reportingRules`, while the Level-1 (CEO) root rule and the
 * Level-1 cross-department exception stay in code.
 * Verifies:
 *  (a) pure rule behaviour — a changed knob actually changes the
 *      health-check outcome (gap 3 accepted at bound 3, flagged at
 *      bound 2; cross-department flagged while the requirement is
 *      on, silent while off; the Level-1 exception never flags
 *      department shape; allowedManagerLevels follows the bound);
 *  (b) the service — defaults when unset, set/get round-trip,
 *      validation 400s, fail-closed normalisation of stored garbage,
 *      versioning, audit rows carrying old→new;
 *  (c) HTTP gating — non-super-admin 403, missing/expired unlock
 *      403 danger_zone_locked (never 401), super admin + unlock 200;
 *  (d) THE end-to-end case — GET /hierarchy-config returns the LIVE
 *      knobs in its `rules` block and its warnings change when the
 *      knobs change (gap-3 link flagged at bound 2, silent at 3);
 *  (e) bulk import — validateBulkRows flags link shapes against the
 *      live knobs, and a flagged row is still VALID (warnings are
 *      never errors — UM-1);
 *  (f) UM-1 preserved — validateReportingLink still accepts any
 *      active user as manager whatever the knobs say (gap 4,
 *      cross-department), the CEO self-heal hard rule is untouched,
 *      and the picker behaviour (any active user except self /
 *      cycle / Level-1-CEO-none) is unchanged;
 *  (g) DZ-0 / DZ-3 / DZ-4 / DZ-5 / DZ-6 still answer on this tree.
 *
 * Production-shaped fixtures: roles carry data_visibility, the
 * users table carries the migration-022 columns and the migration-004
 * role FK; leads use `current_status`; options carry `meta`;
 * audit_logs match the production columns; danger_zone_unlocks comes
 * from its real migration (057); lead_stage_rules from migration
 * 060 — the standing lesson from the form_fields / team-overview
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
import { up as migrate057 } from '../database/migrations/057_danger_zone_unlocks.js';
import { up as migrate060 } from '../database/migrations/060_stage_rules_terminal.js';
import {
  DEFAULT_HIERARCHY_RULES,
  MAX_REPORTING_GAP,
  allowedManagerLevels,
  reportingLinkWarnings,
  validateReportingManagerCandidate,
  type HierarchyRulesShape,
} from '../utils/reportingRules.js';
import { computeHierarchyHealth } from '../utils/hierarchyHealth.js';
import {
  buildReferenceMaps,
  normalizeUserBulkRow,
  validateBulkRows,
} from '../routes/userBulkImport.js';

// Loaded lazily in before(), AFTER the test env vars are set:
// importing the services pulls in production/shared.ts, which reads
// JWT_SECRET once at module load. A top-level import would cache the
// unset value and every test token would verify as invalid.
let getHierarchyRules: typeof import('../services/HierarchyRulesService.js').getHierarchyRules;
let setHierarchyRules: typeof import('../services/HierarchyRulesService.js').setHierarchyRules;
let getHierarchyRulesForEdit: typeof import('../services/HierarchyRulesService.js').getHierarchyRulesForEdit;
let validateHierarchyRulesInput: typeof import('../services/HierarchyRulesService.js').validateHierarchyRulesInput;
let normalizeHierarchyRules: typeof import('../services/HierarchyRulesService.js').normalizeHierarchyRules;
let HIERARCHY_RULES_AUDIT_ACTION: typeof import('../services/HierarchyRulesService.js').HIERARCHY_RULES_AUDIT_ACTION;
let validateReportingLink: typeof import('../routes/production/users.routes.js').validateReportingLink;

// Test-only fixture secrets, assembled from fragments at runtime
// (a contiguous literal would be mangled by secret redaction).
const JWT_SECRET = ['dz7-test-', 'jwt-secret-', 'value'].join('');
const ADMIN_PASSWORD = ['dz7-admin-', 'password'].join('');

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
  { value: 'Converted', meta: { color: 'green', isWon: true, isLost: false, isTerminal: true } },
  { value: 'Not Interested', meta: { color: 'red', isWon: false, isLost: true, isTerminal: true } },
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
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, description TEXT, is_active BOOLEAN DEFAULT TRUE, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, phone VARCHAR(20), password VARCHAR(255) NOT NULL, role_id UUID NOT NULL, department_id UUID, team_id UUID, manager_id UUID, designation VARCHAR(100), joining_date DATE, profile_photo TEXT, last_login TIMESTAMP, is_active BOOLEAN DEFAULT TRUE, account_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0), locked_until TIMESTAMP, password_changed_at TIMESTAMP, employee_record_id UUID, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, target_user_id UUID, action_code VARCHAR(100) NOT NULL, entity_type VARCHAR(100) NOT NULL, entity_id UUID, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS metadata_types (key VARCHAR(100) PRIMARY KEY, label VARCHAR(255) NOT NULL, description TEXT, is_system BOOLEAN NOT NULL DEFAULT FALSE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'New', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0);`);
}

describe('DZ-7 — Hierarchy knobs in the Danger Zone', () => {
  let pool: any;
  let app: express.Express;
  let deptAId: string;
  let deptBId: string;
  let roleIds: Record<string, string> = {};
  let superAdmin: any;
  let manager: any;
  let ceo: any;
  let headA: any;
  let beA: any;
  let gmA: any;
  let dgmA: any;
  let agmA: any;
  let umA: any;
  let roGap3: any;
  let roGap4: any;
  let roCross: any;
  let beCrossCeo: any;
  let allUsers: any[] = [];

  before(async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    // Env first, imports second (see the note at the top of this file).
    ({
      getHierarchyRules,
      setHierarchyRules,
      getHierarchyRulesForEdit,
      validateHierarchyRulesInput,
      normalizeHierarchyRules,
      HIERARCHY_RULES_AUDIT_ACTION,
    } = await import('../services/HierarchyRulesService.js'));
    ({ validateReportingLink } = await import('../routes/production/users.routes.js'));

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    deptAId = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('SALES', 'Sales') RETURNING id`)).rows[0].id;
    deptBId = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('OPS', 'Operations') RETURNING id`)).rows[0].id;
    const mkRole = async (code: string, name: string, level: number, vis: string) =>
      (await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, name, level, vis]
      )).rows[0].id;
    roleIds.ADMIN = await mkRole('ADMIN', 'Admin', 100, 'Organization');
    roleIds.CEO = await mkRole('CEO', 'Chief Executive Officer', 1, 'Organization');
    roleIds.HEAD = await mkRole('HEAD', 'Head of Department', 2, 'FullTeam');
    roleIds.BE = await mkRole('BE', 'Business Executive', 3, 'DownTeam');
    roleIds.GM = await mkRole('GM', 'General Manager', 4, 'DownTeam');
    roleIds.DGM = await mkRole('DGM', 'Deputy General Manager', 5, 'DownTeam');
    roleIds.AGM = await mkRole('AGM', 'Assistant General Manager', 6, 'DownTeam');
    roleIds.BM = await mkRole('BM', 'Branch Manager', 7, 'DownTeam');
    roleIds.UM = await mkRole('UM', 'Unit Manager', 8, 'DownTeam');
    roleIds.RO = await mkRole('RO', 'Relationship Officer', 9, 'Own');
    roleIds.MANAGER = await mkRole('MANAGER', 'Manager', 2, 'FullTeam');

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
    await grant(roleIds.ADMIN, ALL_CODES);
    await grant(roleIds.MANAGER, ['dashboard.view', 'leads.view', 'leads.edit', 'users.view', 'hierarchy.manage']);

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const mkUser = async (emp: string, roleCode: string, deptId: string | null, managerId: string | null = null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, adminHash, roleIds[roleCode], deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, role: roleCode };
    };
    superAdmin = await mkUser('DZ7ADMIN', 'ADMIN', null);
    ceo = await mkUser('DZ7CEO', 'CEO', deptAId);
    manager = await mkUser('DZ7MGR', 'MANAGER', deptAId, ceo.id);
    headA = await mkUser('DZ7HEAD', 'HEAD', deptAId, ceo.id);
    beA = await mkUser('DZ7BE', 'BE', deptAId, headA.id);
    gmA = await mkUser('DZ7GM', 'GM', deptAId, beA.id);
    dgmA = await mkUser('DZ7DGM', 'DGM', deptAId, gmA.id);
    agmA = await mkUser('DZ7AGM', 'AGM', deptAId, dgmA.id);
    umA = await mkUser('DZ7UM', 'UM', deptAId, agmA.id);
    // Gap 3: RO (9) under AGM (6). Gap 4: RO (9) under DGM (5).
    roGap3 = await mkUser('DZ7RO3', 'RO', deptAId, agmA.id);
    roGap4 = await mkUser('DZ7RO4', 'RO', deptAId, dgmA.id);
    // Cross-department, gap 1: RO (9, OPS) under UM (8, Sales).
    roCross = await mkUser('DZ7ROX', 'RO', deptBId, umA.id);
    // Cross-department under the CEO: BE (3, OPS) under CEO (1) — the
    // Level-1 exception means department shape is never flagged here.
    beCrossCeo = await mkUser('DZ7BEX', 'BE', deptBId, ceo.id);
    allUsers = [superAdmin, ceo, manager, headA, beA, gmA, dgmA, agmA, umA, roGap3, roGap4, roCross, beCrossCeo];

    await pool.query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
       VALUES ('FollowUpStatus', 'Lead Status', 'Pipeline stages a lead moves through', TRUE, 1)
       ON CONFLICT (key) DO NOTHING`
    );
    for (let i = 0; i < STATUS_SEED.length; i++) {
      const s = STATUS_SEED[i];
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
         VALUES ('FollowUpStatus', $1, $1, $2, FALSE, TRUE, $3::jsonb)`,
        [s.value, i + 1, JSON.stringify(s.meta)]
      );
    }

    // Real migrations, not hand-written DDL, for the unlock ledger and
    // the DZ-6 rule table (the (g) regression reads both).
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
    // Every test starts from the code defaults: no stored rules row.
    await pool.query(`DELETE FROM options WHERE field_key = 'HierarchyRules'`);
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

  /** Health-screen rows for the fixture tree (manager departments as stored seats). */
  function healthRows() {
    const levelByEmp: Record<string, number> = {
      DZ7CEO: 1, DZ7HEAD: 2, DZ7BE: 3, DZ7GM: 4, DZ7DGM: 5, DZ7AGM: 6, DZ7UM: 8, DZ7RO3: 9, DZ7RO4: 9, DZ7ROX: 9, DZ7BEX: 3,
    };
    const deptByEmp: Record<string, string> = {
      DZ7CEO: deptAId, DZ7HEAD: deptAId, DZ7BE: deptAId, DZ7GM: deptAId, DZ7DGM: deptAId,
      DZ7AGM: deptAId, DZ7UM: deptAId, DZ7RO3: deptAId, DZ7RO4: deptAId, DZ7ROX: deptBId, DZ7BEX: deptBId,
    };
    const mgrByEmp: Record<string, string | null> = {
      DZ7CEO: null, DZ7HEAD: 'DZ7CEO', DZ7BE: 'DZ7HEAD', DZ7GM: 'DZ7BE', DZ7DGM: 'DZ7GM',
      DZ7AGM: 'DZ7DGM', DZ7UM: 'DZ7AGM', DZ7RO3: 'DZ7AGM', DZ7RO4: 'DZ7DGM', DZ7ROX: 'DZ7UM', DZ7BEX: 'DZ7CEO',
    };
    const userByEmp = new Map(allUsers.map(u => [u.employeeId, u]));
    const rows = Object.keys(levelByEmp).map(emp => {
      const u = userByEmp.get(emp)!;
      const mgrEmp = mgrByEmp[emp];
      const mgr = mgrEmp ? userByEmp.get(mgrEmp)! : null;
      return {
        id: u.id,
        employee_id: emp,
        full_name: emp,
        manager_id: mgr ? mgr.id : null,
        department_id: deptByEmp[emp],
        department_ids: [deptByEmp[emp]],
        is_active: true,
        role_code: emp === 'DZ7CEO' ? 'CEO' : emp === 'DZ7HEAD' ? 'HEAD' : emp === 'DZ7BE' || emp === 'DZ7BEX' ? 'BE'
          : emp === 'DZ7GM' ? 'GM' : emp === 'DZ7DGM' ? 'DGM' : emp === 'DZ7AGM' ? 'AGM'
          : emp === 'DZ7UM' ? 'UM' : 'RO',
        hierarchy_level: levelByEmp[emp],
      };
    });
    const levelByRoleCode = new Map<string, number>([
      ['CEO', 1], ['HEAD', 2], ['BE', 3], ['GM', 4], ['DGM', 5],
      ['AGM', 6], ['BM', 7], ['UM', 8], ['RO', 9],
    ]);
    return { rows, levelByRoleCode };
  }

  /* ==================================================================
     (a) Pure rule behaviour — the knobs drive the warnings
  ================================================================== */

  it('(a1) code defaults are gap 2 with the department requirement on', () => {
    assert.equal(MAX_REPORTING_GAP, 2);
    assert.deepEqual(DEFAULT_HIERARCHY_RULES, { maxReportingGap: 2, requireSameDepartment: true });
  });

  it('(a2) gap 3 is flagged at bound 2 and silent at bound 3; gap 4 is flagged at both', () => {
    const candidate = {
      employeeLevel: 9, managerLevel: 6,
      employeeDepartmentId: deptAId, managerDepartmentId: deptAId,
    };
    const atDefault = reportingLinkWarnings(candidate);
    assert.equal(atDefault.length, 1);
    assert.match(atDefault[0], /3 levels above.*more than the usual 2/);
    assert.deepEqual(reportingLinkWarnings(candidate, { maxReportingGap: 3, requireSameDepartment: true }), []);
    const gap4 = { ...candidate, managerLevel: 5 };
    assert.match(reportingLinkWarnings(gap4)[0], /4 levels above.*more than the usual 2/);
    assert.match(reportingLinkWarnings(gap4, { maxReportingGap: 3, requireSameDepartment: true })[0], /more than the usual 3/);
  });

  it('(a3) gap 1 is never flagged, and a same/lower-level manager is flagged at any bound', () => {
    const ok = {
      employeeLevel: 9, managerLevel: 8,
      employeeDepartmentId: deptAId, managerDepartmentId: deptAId,
    };
    assert.deepEqual(reportingLinkWarnings(ok), []);
    assert.deepEqual(reportingLinkWarnings(ok, { maxReportingGap: 1, requireSameDepartment: true }), []);
    const inverted = { ...ok, managerLevel: 9 };
    assert.match(reportingLinkWarnings(inverted)[0], /not above/);
    assert.match(reportingLinkWarnings(inverted, { maxReportingGap: 3, requireSameDepartment: false })[0], /not above/);
  });

  it('(a4) cross-department is flagged while the requirement is on and silent while off', () => {
    const candidate = {
      employeeLevel: 9, managerLevel: 8,
      employeeDepartmentId: deptBId, managerDepartmentId: deptAId, managerDepartmentIds: [deptAId],
    };
    assert.match(reportingLinkWarnings(candidate)[0], /different department/);
    assert.deepEqual(reportingLinkWarnings(candidate, { maxReportingGap: 2, requireSameDepartment: false }), []);
  });

  it('(a5) the Level-1 cross-department exception stays in code at any knob value', () => {
    const candidate = {
      employeeLevel: 3, managerLevel: 1,
      employeeDepartmentId: deptBId, managerDepartmentId: deptAId, managerDepartmentIds: [deptAId],
    };
    // Default knobs: gap 2 is within the bound AND the CEO manager is
    // never flagged for department shape — no warning at all.
    assert.deepEqual(reportingLinkWarnings(candidate), []);
    // The exception covers DEPARTMENT shape only, not the gap: at
    // bound 1 the 2-level gap is flagged, but still no department flag.
    const atGap1 = reportingLinkWarnings(candidate, { maxReportingGap: 1, requireSameDepartment: true });
    assert.equal(atGap1.length, 1);
    assert.match(atGap1[0], /2 levels above.*more than the usual 1/);
    assert.ok(!atGap1.some(w => /different department/.test(w)));
  });

  it('(a6) allowedManagerLevels follows the bound', () => {
    assert.deepEqual(allowedManagerLevels(4), [3, 2]);
    assert.deepEqual(allowedManagerLevels(4, 3), [3, 2, 1]);
    assert.deepEqual(allowedManagerLevels(4, 1), [3]);
    assert.deepEqual(allowedManagerLevels(1), []);
  });

  it('(a7) the Level-1 hard rule is untouched: a CEO with a manager is still an error', () => {
    const err = validateReportingManagerCandidate({
      employeeLevel: 1, managerLevel: 2,
      employeeDepartmentId: deptAId, managerDepartmentId: deptAId,
    });
    assert.match(err || '', /Level-1 \(CEO\) employee cannot report to anyone/);
    assert.equal(validateReportingManagerCandidate({
      employeeLevel: 3, managerLevel: 2,
      employeeDepartmentId: deptAId, managerDepartmentId: deptAId,
    }), null);
  });

  it('(a8) computeHierarchyHealth flags with the live knobs, and warnings are never invalid links', () => {
    const { rows, levelByRoleCode } = healthRows();
    const atDefault = computeHierarchyHealth(rows as any, levelByRoleCode);
    assert.deepEqual(atDefault.invalidLinks, []);
    const warnedDefault = new Set(atDefault.warnings.map(w => w.employeeId));
    assert.ok(warnedDefault.has('DZ7RO3'), 'gap-3 link flagged at bound 2');
    assert.ok(warnedDefault.has('DZ7RO4'), 'gap-4 link flagged at bound 2');
    assert.ok(warnedDefault.has('DZ7ROX'), 'cross-department link flagged while requirement on');
    assert.ok(!warnedDefault.has('DZ7BEX'), 'CEO-managed link never flagged for department');

    const atGap3 = computeHierarchyHealth(rows as any, levelByRoleCode, { maxReportingGap: 3, requireSameDepartment: true });
    const warnedGap3 = new Set(atGap3.warnings.map(w => w.employeeId));
    assert.ok(!warnedGap3.has('DZ7RO3'), 'gap-3 link silent at bound 3');
    assert.ok(warnedGap3.has('DZ7RO4'), 'gap-4 link still flagged at bound 3');
    assert.ok(warnedGap3.has('DZ7ROX'), 'cross-department still flagged');

    const relaxed = computeHierarchyHealth(rows as any, levelByRoleCode, { maxReportingGap: 3, requireSameDepartment: false });
    const warnedRelaxed = new Set(relaxed.warnings.map(w => w.employeeId));
    assert.ok(!warnedRelaxed.has('DZ7ROX'), 'cross-department silent with the requirement off');
    assert.deepEqual(relaxed.invalidLinks, []);
  });

  /* ==================================================================
     (b) The service — defaults, validation, fail-closed reads, audit
  ================================================================== */

  it('(b1) defaults apply when no row is stored, and the GET payload carries bounds + version 0', async () => {
    assert.deepEqual(await getHierarchyRules(), { version: 0, maxReportingGap: 2, requireSameDepartment: true });
    const edit = await getHierarchyRulesForEdit();
    assert.equal(edit.version, 0);
    assert.deepEqual(edit.defaults, { version: 0, maxReportingGap: 2, requireSameDepartment: true });
    assert.deepEqual(edit.bounds, { maxReportingGap: { min: 1, max: 3 } });
    assert.equal(edit.lastChange, null);
  });

  it('(b2) set/get round-trips, versions increment, and the audit row carries old→new', async () => {
    const saved = await setHierarchyRules(
      { maxReportingGap: 3, requireSameDepartment: false },
      { actorId: superAdmin.id, ip: '127.0.0.1' }
    );
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.rules, { version: 1, maxReportingGap: 3, requireSameDepartment: false });
    assert.deepEqual(await getHierarchyRules(), { version: 1, maxReportingGap: 3, requireSameDepartment: false });
    const rows = await auditRows(HIERARCHY_RULES_AUDIT_ACTION);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].metadata.oldValue, { version: 0, maxReportingGap: 2, requireSameDepartment: true });
    assert.deepEqual(rows[0].metadata.newValue, { version: 1, maxReportingGap: 3, requireSameDepartment: false });

    const saved2 = await setHierarchyRules(
      { maxReportingGap: 1, requireSameDepartment: true },
      { actorId: superAdmin.id }
    );
    assert.equal(saved2.version, 2);
    const rows2 = await auditRows(HIERARCHY_RULES_AUDIT_ACTION);
    assert.equal(rows2.length, 2);
    assert.deepEqual(rows2[1].metadata.oldValue, { version: 1, maxReportingGap: 3, requireSameDepartment: false });
  });

  it('(b3) validation refuses out-of-range gaps and non-boolean requirements', () => {
    assert.deepEqual(validateHierarchyRulesInput({ maxReportingGap: 3, requireSameDepartment: true }), []);
    for (const bad of [
      { maxReportingGap: 0, requireSameDepartment: true },
      { maxReportingGap: 4, requireSameDepartment: true },
      { maxReportingGap: 2.5, requireSameDepartment: true },
      { maxReportingGap: '3', requireSameDepartment: true },
      { maxReportingGap: 2, requireSameDepartment: 'yes' },
      { maxReportingGap: 2 },
      { requireSameDepartment: true },
      null,
      'nope',
    ]) {
      assert.ok(validateHierarchyRulesInput(bad).length > 0, `expected a problem for ${JSON.stringify(bad)}`);
    }
  });

  it('(b4) stored garbage fails closed to the code defaults (never throws, never takes health down)', async () => {
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta)
       VALUES ('HierarchyRules', 'config', 'Hierarchy Rules Config', 1, FALSE, TRUE, $1::jsonb)`,
      [JSON.stringify({ version: 9, maxReportingGap: 99, requireSameDepartment: 'no' })]
    );
    assert.deepEqual(await getHierarchyRules(), { version: 9, maxReportingGap: 3, requireSameDepartment: true });
    await pool.query(`UPDATE options SET meta = $1::jsonb WHERE field_key = 'HierarchyRules'`, [JSON.stringify({})]);
    assert.deepEqual(await getHierarchyRules(), { version: 0, maxReportingGap: 2, requireSameDepartment: true });
    await pool.query(`UPDATE options SET meta = $1::jsonb WHERE field_key = 'HierarchyRules'`, [JSON.stringify('not-an-object')]);
    assert.deepEqual(await getHierarchyRules(), { version: 0, maxReportingGap: 2, requireSameDepartment: true });
  });

  /* ==================================================================
     (c) HTTP gating + GET/PUT
  ================================================================== */

  it('(c1) a non-super-admin gets 403 on both endpoints', async () => {
    const getRes = await dz('get', '/hierarchy-rules', manager);
    assert.equal(getRes.status, 403);
    const putRes = await dz('put', '/hierarchy-rules', manager, { maxReportingGap: 3, requireSameDepartment: true });
    assert.equal(putRes.status, 403);
  });

  it('(c2) a super admin without an unlock gets 403 danger_zone_locked, never 401', async () => {
    const getRes = await dz('get', '/hierarchy-rules', superAdmin);
    assert.equal(getRes.status, 403);
    assert.equal(getRes.body.error, 'danger_zone_locked');
    const putRes = await dz('put', '/hierarchy-rules', superAdmin, { maxReportingGap: 3, requireSameDepartment: true });
    assert.equal(putRes.status, 403);
    assert.equal(putRes.body.error, 'danger_zone_locked');
  });

  it('(c3) unlocked GET returns defaults; PUT persists, validates, and audit-logs old→new', async () => {
    await unlockAs(superAdmin);
    const getRes = await dz('get', '/hierarchy-rules', superAdmin);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.data.rules.maxReportingGap, 2);
    assert.equal(getRes.body.data.rules.requireSameDepartment, true);
    assert.equal(getRes.body.data.version, 0);

    const badRes = await dz('put', '/hierarchy-rules', superAdmin, { maxReportingGap: 4, requireSameDepartment: true });
    assert.equal(badRes.status, 400);
    assert.match(badRes.body.message, /between 1 and 3/);

    const putRes = await dz('put', '/hierarchy-rules', superAdmin, { maxReportingGap: 3, requireSameDepartment: false });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.body.data.version, 1);
    assert.deepEqual(putRes.body.data.rules, { version: 1, maxReportingGap: 3, requireSameDepartment: false });
    assert.equal(putRes.body.data.lastChange.oldValue.maxReportingGap, 2);
    assert.equal(putRes.body.data.lastChange.newValue.maxReportingGap, 3);
    const rows = await auditRows(HIERARCHY_RULES_AUDIT_ACTION);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata.oldValue.maxReportingGap, 2);
    assert.equal(rows[0].metadata.newValue.maxReportingGap, 3);
  });

  /* ==================================================================
     (d) End-to-end — the hierarchy screen follows the knobs
  ================================================================== */

  it('(d1) GET /hierarchy-config reports the live knobs and flags against them', async () => {
    const cfg = await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${tokenFor(superAdmin)}`);
    assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
    assert.equal(cfg.body.rules.levelGap, 2);
    assert.equal(cfg.body.rules.sameDepartmentRequired, true);
    assert.match(cfg.body.rules.description, /more than 2 levels up, or across departments, are allowed/);
    const warnedDefault = new Set(cfg.body.setup.warnings.map((w: any) => w.employeeId));
    assert.ok(warnedDefault.has('DZ7RO3'), 'gap-3 flagged at bound 2');
    assert.ok(warnedDefault.has('DZ7RO4'), 'gap-4 flagged at bound 2');
    assert.ok(warnedDefault.has('DZ7ROX'), 'cross-department flagged while requirement on');
    assert.ok(!warnedDefault.has('DZ7BEX'), 'CEO-managed link never flagged for department');
    assert.deepEqual(cfg.body.setup.invalidLinks, []);

    // Save the knobs, then re-read the same screen: the flags move.
    await unlockAs(superAdmin);
    const putRes = await dz('put', '/hierarchy-rules', superAdmin, { maxReportingGap: 3, requireSameDepartment: false });
    assert.equal(putRes.status, 200);
    const cfg2 = await request(app).get('/api/hierarchy-config').set('Authorization', `Bearer ${tokenFor(superAdmin)}`);
    assert.equal(cfg2.status, 200);
    assert.equal(cfg2.body.rules.levelGap, 3);
    assert.equal(cfg2.body.rules.sameDepartmentRequired, false);
    assert.match(cfg2.body.rules.description, /more than 3 levels up are allowed/);
    assert.doesNotMatch(cfg2.body.rules.description, /across departments/);
    const warnedAfter = new Set(cfg2.body.setup.warnings.map((w: any) => w.employeeId));
    assert.ok(!warnedAfter.has('DZ7RO3'), 'gap-3 silent at bound 3');
    assert.ok(warnedAfter.has('DZ7RO4'), 'gap-4 still flagged at bound 3');
    assert.ok(!warnedAfter.has('DZ7ROX'), 'cross-department silent with the requirement off');
  });

  /* ==================================================================
     (e) Bulk import — warnings follow the knobs, rows stay valid
  ================================================================== */

  function bulkMaps() {
    const roleRows = Object.entries(roleIds).map(([code, id]) => ({
      id,
      role_code: code,
      role_name: code,
      hierarchy_level: code === 'ADMIN' ? 100 : code === 'CEO' ? 1 : code === 'HEAD' ? 2
        : code === 'BE' ? 3 : code === 'GM' ? 4 : code === 'DGM' ? 5 : code === 'AGM' ? 6
        : code === 'BM' ? 7 : code === 'UM' ? 8 : code === 'RO' ? 9 : 2,
    }));
    return buildReferenceMaps({
      roles: roleRows,
      departments: [
        { id: deptAId, department_code: 'SALES', department_name: 'Sales' },
        { id: deptBId, department_code: 'OPS', department_name: 'Operations' },
      ],
      teams: [],
      existingUsers: allUsers.map(u => {
        const byEmp: Record<string, any> = {
          DZ7CEO: { role_code: 'CEO', hierarchy_level: 1, department_id: deptAId },
          DZ7HEAD: { role_code: 'HEAD', hierarchy_level: 2, department_id: deptAId },
          DZ7BE: { role_code: 'BE', hierarchy_level: 3, department_id: deptAId },
          DZ7GM: { role_code: 'GM', hierarchy_level: 4, department_id: deptAId },
          DZ7DGM: { role_code: 'DGM', hierarchy_level: 5, department_id: deptAId },
          DZ7AGM: { role_code: 'AGM', hierarchy_level: 6, department_id: deptAId },
          DZ7UM: { role_code: 'UM', hierarchy_level: 8, department_id: deptAId },
          DZ7RO3: { role_code: 'RO', hierarchy_level: 9, department_id: deptAId },
          DZ7RO4: { role_code: 'RO', hierarchy_level: 9, department_id: deptAId },
          DZ7ROX: { role_code: 'RO', hierarchy_level: 9, department_id: deptBId },
          DZ7BEX: { role_code: 'BE', hierarchy_level: 3, department_id: deptBId },
          DZ7ADMIN: { role_code: 'ADMIN', hierarchy_level: 100, department_id: null },
          DZ7MGR: { role_code: 'MANAGER', hierarchy_level: 2, department_id: deptAId },
        };
        const info = byEmp[u.employeeId];
        const mgrEmp: Record<string, string | null> = {
          DZ7CEO: null, DZ7HEAD: 'DZ7CEO', DZ7BE: 'DZ7HEAD', DZ7GM: 'DZ7BE', DZ7DGM: 'DZ7GM',
          DZ7AGM: 'DZ7DGM', DZ7UM: 'DZ7AGM', DZ7RO3: 'DZ7AGM', DZ7RO4: 'DZ7DGM',
          DZ7ROX: 'DZ7UM', DZ7BEX: 'DZ7CEO', DZ7ADMIN: null, DZ7MGR: 'DZ7CEO',
        };
        const mgr = mgrEmp[u.employeeId] ? allUsers.find(x => x.employeeId === mgrEmp[u.employeeId]) : null;
        return {
          id: u.id, employee_id: u.employeeId, email: u.email,
          role_id: roleIds[info.role_code], department_id: info.department_id,
          department_ids: info.department_id ? [info.department_id] : [],
          team_id: null, manager_id: mgr ? mgr.id : null, is_active: true,
          role_code: info.role_code, hierarchy_level: info.hierarchy_level,
        };
      }),
      allUsers: allUsers.map(u => ({ id: u.id, employee_id: u.employeeId, manager_id: null })),
    });
  }

  it('(e1) bulk validate flags gap-3 and cross-department under the defaults, and stays silent under the relaxed knobs — rows stay valid either way', () => {
    const maps = bulkMaps();
    const mkRow = (emp: string, dept: string, mgrEmp: string) => normalizeUserBulkRow({
      rowNumber: 1, employeeId: emp, fullName: 'Test', email: `${emp.toLowerCase()}@test.com`,
      phone: '', designation: '', department: dept, role: 'RO',
      reportingManagerEmployeeId: mgrEmp, team: '', temporaryPassword: 'TempPass123',
      mustChangePassword: '', status: 'Active',
    } as any);
    const gap3 = validateBulkRows({
      rows: [mkRow('DZ7NEW1', 'SALES', 'DZ7AGM')],
      maps, mode: 'createOnly', permissions: { canCreate: true, canEdit: false },
    });
    assert.equal(gap3.rows[0].isValid, true);
    assert.ok(gap3.rows[0].warnings.some((w: string) => /3 levels above.*more than the usual 2/.test(w)), JSON.stringify(gap3.rows[0].warnings));
    const gap3Relaxed = validateBulkRows({
      rows: [mkRow('DZ7NEW1', 'SALES', 'DZ7AGM')],
      maps, mode: 'createOnly', permissions: { canCreate: true, canEdit: false },
      hierarchyRules: { maxReportingGap: 3, requireSameDepartment: true },
    });
    assert.equal(gap3Relaxed.rows[0].isValid, true);
    assert.deepEqual(gap3Relaxed.rows[0].warnings, []);

    const cross = validateBulkRows({
      rows: [mkRow('DZ7NEW2', 'OPS', 'DZ7UM')],
      maps, mode: 'createOnly', permissions: { canCreate: true, canEdit: false },
    });
    assert.equal(cross.rows[0].isValid, true);
    assert.ok(cross.rows[0].warnings.some((w: string) => /different department/.test(w)), JSON.stringify(cross.rows[0].warnings));
    const crossRelaxed = validateBulkRows({
      rows: [mkRow('DZ7NEW2', 'OPS', 'DZ7UM')],
      maps, mode: 'createOnly', permissions: { canCreate: true, canEdit: false },
      hierarchyRules: { maxReportingGap: 2, requireSameDepartment: false },
    });
    assert.equal(crossRelaxed.rows[0].isValid, true);
    assert.deepEqual(crossRelaxed.rows[0].warnings, []);
  });

  /* ==================================================================
     (f) UM-1 preserved — the knobs never block, CEO rule untouched
  ================================================================== */

  it('(f1) validateReportingLink accepts any active manager whatever the knobs say', async () => {
    // Gap 4, same department: accepted (a warning on the health
    // screen, never a write-path block).
    const gap4 = await validateReportingLink(pool, {
      selfId: roGap4.id, roleId: roleIds.RO, departmentId: deptAId,
      managerId: dgmA.id, managerIsRequired: true,
    });
    assert.equal(gap4, null);
    // Cross-department, gap 1: accepted.
    const cross = await validateReportingLink(pool, {
      selfId: roCross.id, roleId: roleIds.RO, departmentId: deptBId,
      managerId: umA.id, managerIsRequired: true,
    });
    assert.equal(cross, null);
    // The hard rules are unchanged: self, inactive, missing, cycle.
    const self = await validateReportingLink(pool, {
      selfId: roGap3.id, roleId: roleIds.RO, departmentId: deptAId,
      managerId: roGap3.id, managerIsRequired: true,
    });
    assert.match(self || '', /cannot report to themselves/);
    // Level 1 (CEO) with a manager is still refused — the self-heal
    // guard the edit path relies on (PR #107).
    const ceoWithMgr = await validateReportingLink(pool, {
      selfId: ceo.id, roleId: roleIds.CEO, departmentId: deptAId,
      managerId: headA.id, managerIsRequired: false,
    });
    assert.match(ceoWithMgr || '', /Level-1 \(CEO\) employee cannot report to anyone/);
    const ceoWithoutMgr = await validateReportingLink(pool, {
      selfId: ceo.id, roleId: roleIds.CEO, departmentId: deptAId,
      managerId: null, managerIsRequired: false,
    });
    assert.equal(ceoWithoutMgr, null);
  });

  /* ==================================================================
     (g) DZ-0..DZ-6 still answer on this tree
  ================================================================== */

  it('(g1) the earlier Danger Zone slices still answer when unlocked', async () => {
    await unlockAs(superAdmin);
    for (const path of ['/lead-quality', '/security-policy', '/role-defaults', '/stage-rules']) {
      const res = await dz('get', path, superAdmin);
      assert.equal(res.status, 200, `${path}: ${JSON.stringify(res.body)}`);
    }
    const overview = await dz('get', '/overview', superAdmin);
    assert.equal(overview.status, 200);
    const status = await dz('get', '/status', superAdmin);
    assert.equal(status.status, 200);
    assert.equal(status.body.unlocked, true);
  });
});
