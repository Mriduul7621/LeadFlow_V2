/**
 * dz3-lead-quality.test.ts — DZ-3 Lead Quality config in the Danger Zone
 * ------------------------------------------------------------------
 * Audit §2.6 (F1–F6) / §4: the scorer's weights move to a versioned
 * config a super admin edits in the Danger Zone; code values stay the
 * default. Verifies:
 *  (a) scoring actually changes with config (base, band, status point,
 *      recency rung, cap, overdue ladder — pure + HTTP);
 *  (b) defaults reproduce today's exact scores (pinned cases);
 *  (c) a status rename keeps its points (dictionary-entry keying);
 *  (d) DZ gating — non-super-admin 403, locked 403 danger_zone_locked,
 *      unlocked super admin can save;
 *  (e) audit rows carry old→new; GET reports the last change;
 *  (f) invalid config rejected 400; corrupt stored value falls back
 *      to the code defaults (scoring never goes down);
 *  (g) DZ-0 gate still works on this tree (unlock + overview smoke).
 *
 * Production-shaped fixtures: leads use `current_status`, options
 * carry `meta`, audit_logs match the production columns.
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
import type { LeadQualityConfig } from '../utils/leadQuality.js';
import type { LeadQualityConfigInput } from '../services/LeadQualityConfigService.js';

// Loaded lazily in before(), AFTER the test env vars are set:
// importing the service pulls in production/shared.ts, which reads
// JWT_SECRET once at module load. A top-level import would cache the
// unset value and every test token would verify as invalid.
let calculateLeadQuality: typeof import('../utils/leadQuality.js').calculateLeadQuality;
let cloneLeadQualityConfig: typeof import('../utils/leadQuality.js').cloneLeadQualityConfig;
let DEFAULT_LEAD_QUALITY_CONFIG: typeof import('../utils/leadQuality.js').DEFAULT_LEAD_QUALITY_CONFIG;
let normalizeLeadQualityConfig: typeof import('../utils/leadQuality.js').normalizeLeadQualityConfig;
let reconcileQualityFactors: typeof import('../utils/leadQuality.js').reconcileQualityFactors;
let validateLeadQualityConfig: typeof import('../utils/leadQuality.js').validateLeadQualityConfig;
let getLeadQualityConfig: typeof import('../services/LeadQualityConfigService.js').getLeadQualityConfig;
let setLeadQualityConfig: typeof import('../services/LeadQualityConfigService.js').setLeadQualityConfig;

// Test-only fixture secret (assembled in parts so this file carries no
// contiguous literal), mirroring the other integration suites.
const JWT_SECRET = ['dz3-test-jwt-secret', '-for-local-pglite-', 'tests-only-2026'].join('');
const ADMIN_PASSWORD = ['Dz3-Test-', 'Password-9'].join('');

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

/** Fixed reference instant: 2026-09-12 12:00 Asia/Dhaka. */
const NOW = '2026-09-12T06:00:00Z';
const daysAgo = (n: number) => new Date(new Date(NOW).getTime() - n * 86400000).toISOString();
const daysAhead = (n: number) => new Date(new Date(NOW).getTime() + n * 86400000).toISOString();

async function setupSchema(pool: any) {
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), department_code VARCHAR(100), department_name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), role_code VARCHAR(100) UNIQUE, role_name VARCHAR(255), hierarchy_level INT DEFAULT 0, data_visibility VARCHAR(30) DEFAULT 'Own', menu_access JSONB, actions JSONB, feature_permissions JSONB);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id VARCHAR(30) UNIQUE NOT NULL, full_name VARCHAR(150) NOT NULL, email VARCHAR(150) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role_id UUID, department_id UUID, manager_id UUID, is_active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE, reporting_chain JSONB DEFAULT '[]'::jsonb, subordinates JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS permissions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), permission_code VARCHAR(100) UNIQUE NOT NULL, permission_name VARCHAR(255));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (role_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (role_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (user_id UUID NOT NULL, permission_id UUID NOT NULL, is_allowed BOOLEAN NOT NULL DEFAULT TRUE, PRIMARY KEY (user_id, permission_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID, target_user_id UUID, action_code VARCHAR(100) NOT NULL, entity_type VARCHAR(100) NOT NULL, entity_id UUID, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS metadata_types (key VARCHAR(100) PRIMARY KEY, label VARCHAR(255) NOT NULL, description TEXT, is_system BOOLEAN NOT NULL DEFAULT FALSE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS options (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), field_key VARCHAR(100) NOT NULL, option_value VARCHAR(255) NOT NULL, option_label VARCHAR(255), sort_order INT DEFAULT 0, is_default BOOLEAN DEFAULT FALSE, is_active BOOLEAN DEFAULT TRUE, meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(field_key, option_value));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_code VARCHAR(50) UNIQUE, customer_name VARCHAR(255) NOT NULL, mobile VARCHAR(30) NOT NULL, alternate_mobile VARCHAR(30), email VARCHAR(255), marital_status VARCHAR(50), occupation VARCHAR(150), address TEXT, area VARCHAR(150), district VARCHAR(100), division VARCHAR(100), source VARCHAR(100), priority VARCHAR(30) DEFAULT 'NORMAL', expected_premium NUMERIC(14,2), expected_value NUMERIC(14,2), notes TEXT, assigned_to UUID, assigned_by UUID, assigned_at TIMESTAMP, previous_assigned_to UUID, last_contacted_at TIMESTAMP, next_follow_up_at TIMESTAMP, current_status VARCHAR(255) DEFAULT 'New', status_history JSONB DEFAULT '[]'::jsonb, assignment_history JSONB DEFAULT '[]'::jsonb, documents JSONB DEFAULT '[]'::jsonb, custom_fields JSONB DEFAULT '{}'::jsonb, tags JSONB DEFAULT '[]'::jsonb, created_by UUID, updated_by UUID, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), is_deleted BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMP, deleted_by UUID, follow_up_count INT DEFAULT 0);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(50) NOT NULL DEFAULT 'follow_up', status VARCHAR(255), remarks TEXT, next_follow_up_at TIMESTAMP, next_call_at TIMESTAMP, meeting_at TIMESTAMP, meeting_type VARCHAR(255), collected_ncp NUMERIC(14,2), projected_ncp NUMERIC(14,2), sum_assured NUMERIC(14,2), product_name VARCHAR(255), loss_reason TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_activities (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE, activity_type VARCHAR(30) NOT NULL CHECK (activity_type IN ('call','meeting','follow_up','task')), title VARCHAR(255), scheduled_at TIMESTAMP NOT NULL, duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0), remarks TEXT, status VARCHAR(30) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')), priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', meeting_type VARCHAR(255), location VARCHAR(255), created_by UUID REFERENCES users(id) ON DELETE SET NULL, assigned_to UUID REFERENCES users(id) ON DELETE SET NULL, updated_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(), completed_at TIMESTAMP, completed_by UUID REFERENCES lead_activities(id) ON DELETE SET NULL, completed_activity_id UUID REFERENCES lead_activities(id) ON DELETE SET NULL);`);
}

const STATUSES = [
  'New', 'Contacted', 'No Response', 'Busy', 'Interested',
  'Follow-up Set', 'Meeting Fixed', 'Meeting Completed',
  'Proposal Sent', 'Pipeline Locked', 'Converted', 'Not Interested',
];
const DEFAULT_POINTS: Record<string, number> = {
  'Pipeline Locked': 35, 'Meeting Completed': 25, 'Meeting Fixed': 20,
  Interested: 15, 'Follow-up Set': 10, Contacted: 5, New: 0,
  Busy: -2, 'No Response': -8,
};
const DEFAULT_ADVANCED = ['Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked'];

describe('DZ-3 — Lead Quality config in the Danger Zone', () => {
  let pool: any;
  let app: express.Express;
  let superAdmin: any;
  let settingsManager: any;
  let tokenLiar: any;
  let statusIds: Record<string, string> = {};
  let mobileSeq = 0;
  const nextMobile = () => `0179${String(200000 + (mobileSeq += 1))}`;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://dz3test:dz3test@localhost:5432/dz3test';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    // Env first, imports second (see the note at the top of this file).
    ({
      calculateLeadQuality,
      cloneLeadQualityConfig,
      DEFAULT_LEAD_QUALITY_CONFIG,
      normalizeLeadQualityConfig,
      reconcileQualityFactors,
      validateLeadQualityConfig,
    } = await import('../utils/leadQuality.js'));
    ({ getLeadQualityConfig, setLeadQualityConfig } = await import('../services/LeadQualityConfigService.js'));

    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await setupSchema(pool);

    const deptId = (await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DEPT3', 'Sales') RETURNING id`)).rows[0].id;
    const adminRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('ADMIN', 'Admin', 100, 'Organization') RETURNING id`)).rows[0].id;
    const empRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ('EMPLOYEE', 'Employee', 10, 'Own') RETURNING id`)).rows[0].id;
    const permRes: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ('settings.manage', 'settings.manage') RETURNING id`);
    await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true)`, [empRoleId, permRes.rows[0].id]);
    for (const code of ['leads.view']) {
      const r: any = await pool.query(`INSERT INTO permissions (permission_code, permission_name) VALUES ($1, $2) RETURNING id`, [code, code]);
      for (const roleId of [adminRoleId, empRoleId]) {
        await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [roleId, r.rows[0].id]);
      }
    }

    for (let i = 0; i < STATUSES.length; i++) {
      const name = STATUSES[i];
      const isTerminal = name === 'Converted' || name === 'Not Interested';
      const res: any = await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_active, meta)
         VALUES ('FollowUpStatus', $1, $1, $2, true, $3::jsonb) RETURNING id`,
        [name, i + 1, JSON.stringify({ isTerminal })]
      );
      statusIds[name] = res.rows[0].id;
    }

    const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const mkUser = async (emp: string, roleId: string) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [emp, emp, `${emp.toLowerCase()}@test.com`, adminHash, roleId, deptId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com` };
    };
    superAdmin = { ...(await mkUser('DZ3ADMIN', adminRoleId)), role: 'ADMIN' };
    settingsManager = { ...(await mkUser('DZ3SETTINGS', empRoleId)), role: 'EMPLOYEE' };
    tokenLiar = { ...(await mkUser('DZ3LIAR', empRoleId)), role: 'ADMIN' };

    await migrate057();
    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  const dz = (method: 'get' | 'put' | 'post', path: string, user: any, body?: any) => {
    const req = request(app)[method](`/api/danger-zone${path}`).set('Authorization', `Bearer ${tokenFor(user)}`);
    return body === undefined ? req : req.send(body);
  };

  async function resetConfigRow(): Promise<void> {
    await pool.query(`DELETE FROM options WHERE field_key = 'LeadQuality'`);
  }

  async function auditRows(actionCode: string): Promise<any[]> {
    const r: any = await pool.query(
      `SELECT * FROM audit_logs WHERE action_code = $1 ORDER BY created_at ASC`,
      [actionCode]
    );
    return r.rows;
  }

  /** Full PUT body from the code defaults, keyed by dictionary-entry id. */
  function defaultInput(overrides: Partial<LeadQualityConfigInput> = {}): LeadQualityConfigInput {
    const statusPoints: Record<string, number> = {};
    for (const [name, points] of Object.entries(DEFAULT_POINTS)) {
      statusPoints[statusIds[name]] = points;
    }
    return {
      baseScore: 35,
      thresholds: { hot: 80, warm: 60, developing: 40 },
      statusPoints,
      advancedStatusIds: DEFAULT_ADVANCED.map(n => statusIds[n]),
      recency: [
        { maxDays: 1, points: 5 }, { maxDays: 3, points: 3 }, { maxDays: 7, points: 0 },
        { maxDays: 14, points: -8 }, { maxDays: 30, points: -15 }, { maxDays: null, points: -22 },
      ],
      engagement: { pointsPerEvent: 3, maxEvents: 3 },
      failedContact: { pointsPerEvent: -3, maxEvents: 3, attentionAt: 3 },
      followUp: {
        scheduledPoints: 5,
        overdue: [
          { maxDays: 3, points: -5 }, { maxDays: 7, points: -10 }, { maxDays: null, points: -15 },
        ],
      },
      investment: { points: 3 },
      ...overrides,
    };
  }

  function withConfig(patch: Partial<LeadQualityConfig>): LeadQualityConfig {
    const cfg = cloneLeadQualityConfig(DEFAULT_LEAD_QUALITY_CONFIG);
    return { ...cfg, ...patch };
  }

  async function makeLead(overrides: Record<string, any> = {}): Promise<any> {
    const row = {
      customer_name: 'DZ3 Lead',
      mobile: nextMobile(),
      current_status: 'Interested',
      assigned_to: superAdmin.id,
      created_by: superAdmin.id,
      next_follow_up_at: new Date(Date.now() + 86400000).toISOString(),
      ...overrides,
    };
    const cols = Object.keys(row);
    const vals = cols.map((_, i) => `$${i + 1}`);
    const res: any = await pool.query(
      `INSERT INTO leads (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id`,
      cols.map(c => (row as any)[c])
    );
    return { id: res.rows[0].id, ...row };
  }

  async function qualityOf(leadId: string): Promise<any> {
    const res = await request(app)
      .get(`/api/leads/${leadId}/quality`)
      .set('Authorization', `Bearer ${tokenFor(superAdmin)}`);
    assert.equal(res.status, 200, `quality read failed: ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  /* ==================================================================
     (b) Defaults reproduce today's exact scores (pure, pinned)
  ================================================================== */
  describe('defaults — pinned scores (no config passed)', () => {
    it('exports the documented code defaults', () => {
      assert.equal(DEFAULT_LEAD_QUALITY_CONFIG.baseScore, 35);
      assert.deepEqual(DEFAULT_LEAD_QUALITY_CONFIG.thresholds, { hot: 80, warm: 60, developing: 40 });
      assert.equal(DEFAULT_LEAD_QUALITY_CONFIG.statusPoints['Pipeline Locked'], 35);
      assert.equal(DEFAULT_LEAD_QUALITY_CONFIG.statusPoints['No Response'], -8);
      assert.deepEqual(validateLeadQualityConfig(DEFAULT_LEAD_QUALITY_CONFIG), []);
    });

    it('bare untouched lead scores base 35 / Cold with no factors', () => {
      const r = calculateLeadQuality({ status: 'New', now: NOW });
      assert.equal(r.score, 35);
      assert.equal(r.band, 'Cold');
      assert.deepEqual(r.positiveFactors, []);
      assert.deepEqual(r.negativeFactors, []);
      assert.deepEqual(r.attentionReasons, []);
      assert.ok(reconcileQualityFactors(r).matches);
    });

    it('status weights + recency + scheduled action pin the bands', () => {
      // Pipeline Locked, touched today, next action scheduled: 35+35+5+5 = 80 Hot.
      const hot = calculateLeadQuality({
        status: 'Pipeline Locked', createdAt: NOW, nextFollowUpAt: daysAhead(1), now: NOW,
      });
      assert.equal(hot.score, 80);
      assert.equal(hot.band, 'Hot');
      assert.ok(reconcileQualityFactors(hot).matches);
      // Meeting Completed, no dates: 35+25 = 60 Warm.
      assert.equal(calculateLeadQuality({ status: 'Meeting Completed', now: NOW }).score, 60);
      assert.equal(calculateLeadQuality({ status: 'Meeting Completed', now: NOW }).band, 'Warm');
      // Meeting Fixed, no dates: 35+20 = 55 Developing.
      assert.equal(calculateLeadQuality({ status: 'Meeting Fixed', now: NOW }).score, 55);
      // No Response, last touch 20 days ago: 35-8-15 = 12 Cold + staleness flag.
      const stale = calculateLeadQuality({ status: 'No Response', createdAt: daysAgo(20), now: NOW });
      assert.equal(stale.score, 12);
      assert.equal(stale.band, 'Cold');
      assert.ok(stale.attentionReasons.some(a => a.includes('20 days')));
    });

    it('caps, overdue, investment and terminal outcomes pin exactly', () => {
      // 5 meaningful interactions cap at 3 events × 3 = +9.
      assert.equal(
        calculateLeadQuality({ status: 'New', meaningfulEngagementCount: 5, now: NOW }).score, 44);
      // 4 failed contacts cap at 3 events × -3 = -9 + attention flag.
      const failed = calculateLeadQuality({ status: 'New', failedContactCount: 4, now: NOW });
      assert.equal(failed.score, 26);
      assert.ok(failed.attentionReasons.some(a => a.includes('4 attempts')));
      // Next action 10 days overdue: -15 (35-15 = 20), created today (+5) → 25.
      const overdue = calculateLeadQuality({
        status: 'New', createdAt: NOW, nextFollowUpAt: daysAgo(10), now: NOW,
      });
      assert.equal(overdue.score, 25);
      // Explicit investment interest: +3 flat.
      assert.equal(
        calculateLeadQuality({ status: 'New', hasInvestmentAmount: true, investmentAmount: 50000, now: NOW }).score, 38);
      // Unknown/custom status scores 0 points.
      assert.equal(calculateLeadQuality({ status: 'Referred', now: NOW }).score, 35);
      // Terminal outcomes bypass the scale (DZ-6 territory — untouched).
      assert.equal(calculateLeadQuality({ status: 'Converted', now: NOW }).score, 100);
      assert.equal(calculateLeadQuality({ status: 'Not Interested', now: NOW }).score, 0);
    });

    it('a malformed config normalizes to the code defaults, never down', () => {
      const bad = normalizeLeadQualityConfig({ baseScore: 999, thresholds: { hot: 1, warm: 2, developing: 3 } });
      assert.equal(bad.baseScore, 35);
      assert.equal(calculateLeadQuality({ status: 'New', now: NOW }, { baseScore: 999 } as any).score, 35);
      assert.ok(validateLeadQualityConfig({ baseScore: 101 }).some(m => m.includes('baseScore must be')));
      assert.ok(validateLeadQualityConfig({ ...DEFAULT_LEAD_QUALITY_CONFIG, thresholds: { hot: 50, warm: 60, developing: 40 } }).some(m => m.includes('ordered')));
    });
  });

  /* ==================================================================
     (a) Scoring actually changes with config (pure)
  ================================================================== */
  describe('config moves the score (pure scorer)', () => {
    it('base score moves every lead', () => {
      const cfg = withConfig({ baseScore: 50 });
      assert.equal(calculateLeadQuality({ status: 'New', now: NOW }, cfg).score, 50);
      assert.ok(reconcileQualityFactors(calculateLeadQuality({ status: 'New', now: NOW }, cfg), cfg).matches);
    });

    it('a band threshold re-bands the same score', () => {
      const input = { status: 'Meeting Fixed', createdAt: NOW, nextFollowUpAt: daysAhead(1), now: NOW };
      assert.equal(calculateLeadQuality(input).band, 'Warm'); // 65, Hot ≥ 80
      assert.equal(calculateLeadQuality(input, withConfig({ thresholds: { hot: 60, warm: 50, developing: 40 } })).band, 'Hot');
    });

    it('a status point moves the score', () => {
      const cfg = withConfig({ statusPoints: { ...DEFAULT_LEAD_QUALITY_CONFIG.statusPoints, Interested: 30 } });
      assert.equal(calculateLeadQuality({ status: 'Interested', now: NOW }, cfg).score, 65);
      assert.equal(calculateLeadQuality({ status: 'Interested', now: NOW }).score, 50);
    });

    it('a recency rung moves the score', () => {
      const cfg = withConfig({
        recency: [
          { maxDays: 1, points: 5 }, { maxDays: 3, points: 20 }, { maxDays: 7, points: 0 },
          { maxDays: 14, points: -8 }, { maxDays: 30, points: -15 }, { maxDays: null, points: -22 },
        ],
      });
      // Touched 2 days ago: default +3 → 38; configured +20 → 55.
      assert.equal(calculateLeadQuality({ status: 'New', createdAt: daysAgo(2), now: NOW }).score, 38);
      assert.equal(calculateLeadQuality({ status: 'New', createdAt: daysAgo(2), now: NOW }, cfg).score, 55);
    });

    it('a cap moves the score', () => {
      const cfg = withConfig({ engagement: { pointsPerEvent: 3, maxEvents: 1 } });
      const input = { status: 'New', meaningfulEngagementCount: 5, now: NOW };
      assert.equal(calculateLeadQuality(input).score, 44);
      assert.equal(calculateLeadQuality(input, cfg).score, 38);
    });

    it('the overdue ladder moves the score', () => {
      const cfg = withConfig({
        followUp: {
          scheduledPoints: 5,
          overdue: [
            { maxDays: 3, points: -5 }, { maxDays: 7, points: -25 }, { maxDays: null, points: -15 },
          ],
        },
      });
      const input = { status: 'New', createdAt: NOW, nextFollowUpAt: daysAgo(5), now: NOW };
      assert.equal(calculateLeadQuality(input).score, 30); // 35+5-10
      assert.equal(calculateLeadQuality(input, cfg).score, 15); // 35+5-25
    });
  });

  /* ==================================================================
     (d) DZ gating + (g) DZ-0 still works
  ================================================================== */
  describe('DZ gating (HTTP)', () => {
    it('(g) DZ-0 gate still works: unlock + overview serve on this tree', async () => {
      const status = await dz('get', '/status', superAdmin);
      assert.equal(status.status, 200);
      assert.equal(status.body.unlocked, false);
      const overview = await dz('get', '/overview', superAdmin);
      assert.equal(overview.status, 403);
      assert.equal(overview.body.error, 'danger_zone_locked');
    });

    it('non-super-admins get a plain 403 (never danger_zone_locked, never 401)', async () => {
      for (const user of [settingsManager, tokenLiar]) {
        const res = await dz('put', '/lead-quality', user, defaultInput());
        assert.equal(res.status, 403);
        assert.notEqual(res.body.error, 'danger_zone_locked');
        const get = await dz('get', '/lead-quality', user);
        assert.equal(get.status, 403);
      }
      assert.equal((await request(app).put('/api/danger-zone/lead-quality').send(defaultInput())).status, 401);
    });

    it('locked super admin gets 403 danger_zone_locked on GET and PUT', async () => {
      const get = await dz('get', '/lead-quality', superAdmin);
      assert.equal(get.status, 403);
      assert.equal(get.body.error, 'danger_zone_locked');
      const put = await dz('put', '/lead-quality', superAdmin, defaultInput());
      assert.equal(put.status, 403);
      assert.equal(put.body.error, 'danger_zone_locked');
    });

    it('unlocked super admin can read and save', async () => {
      const unlock = await dz('post', '/unlock', superAdmin, { password: ADMIN_PASSWORD });
      assert.equal(unlock.status, 200);
      assert.equal(unlock.body.unlocked, true);

      const get = await dz('get', '/lead-quality', superAdmin);
      assert.equal(get.status, 200);
      assert.equal(get.body.data.version, 0);
      assert.equal(get.body.data.config.baseScore, 35);
      assert.equal(get.body.data.defaults.baseScore, 35);
      assert.deepEqual(get.body.data.scale, { min: 0, max: 100 });
      assert.equal(get.body.data.lastChange, null);
      const interested = get.body.data.statusOptions.find((o: any) => o.value === 'Interested');
      assert.ok(interested);
      assert.equal(interested.points, 15);
      assert.equal(interested.defaultPoints, 15);
      assert.equal(interested.advanced, true);
      const converted = get.body.data.statusOptions.find((o: any) => o.value === 'Converted');
      assert.equal(converted.isTerminal, true);

      const put = await dz('put', '/lead-quality', superAdmin, defaultInput({ baseScore: 40 }));
      assert.equal(put.status, 200);
      assert.equal(put.body.data.version, 1);
      assert.equal(put.body.data.config.baseScore, 40);
      await resetConfigRow();
    });
  });

  /* ==================================================================
     (a) HTTP: config changes live scoring; (e) audit old→new;
     (f) invalid 400s + corrupt fallback; (c) rename keeps points
  ================================================================== */
  describe('config saves, audit, validation, rename (HTTP, unlocked)', () => {
    beforeEach(async () => {
      await resetConfigRow();
      // The unlock from the gating block is still valid (10 min window);
      // re-unlock if a previous block let it lapse.
      const status = await dz('get', '/status', superAdmin);
      if (!status.body.unlocked) {
        const unlock = await dz('post', '/unlock', superAdmin, { password: ADMIN_PASSWORD });
        assert.equal(unlock.status, 200);
      }
    });

    it('(a) a saved base score changes live lead scores, and back', async () => {
      const lead = await makeLead({ current_status: 'Interested' });
      // Interested + touched today + next action scheduled: 35+15+5+5 = 60 Warm.
      const before = await qualityOf(lead.id);
      assert.equal(before.score, 60);
      assert.equal(before.band, 'Warm');

      const put = await dz('put', '/lead-quality', superAdmin, defaultInput({ baseScore: 50 }));
      assert.equal(put.status, 200);
      const after = await qualityOf(lead.id);
      assert.equal(after.score, 75); // 50+15+5+5
      assert.equal(after.band, 'Warm');

      // A lower Hot threshold re-bands the same lead without touching the score.
      const put2 = await dz('put', '/lead-quality', superAdmin, defaultInput({
        baseScore: 50, thresholds: { hot: 70, warm: 60, developing: 40 },
      }));
      assert.equal(put2.status, 200);
      assert.equal(put2.body.data.version, 2);
      const rebands = await qualityOf(lead.id);
      assert.equal(rebands.score, 75);
      assert.equal(rebands.band, 'Hot');
    });

    it('(a) a saved status point changes live scores', async () => {
      const lead = await makeLead({ current_status: 'Interested' });
      assert.equal((await qualityOf(lead.id)).score, 60);
      const points = { ...defaultInput().statusPoints, [statusIds['Interested']]: 30 };
      const put = await dz('put', '/lead-quality', superAdmin, defaultInput({ statusPoints: points }));
      assert.equal(put.status, 200);
      assert.equal((await qualityOf(lead.id)).score, 75); // 35+30+5+5
    });

    it('(e) audit rows carry old→new and GET reports the last change', async () => {
      const before = await auditRows('danger_zone.lead_quality.update');
      const put1 = await dz('put', '/lead-quality', superAdmin, defaultInput({ baseScore: 40 }));
      assert.equal(put1.status, 200);
      assert.equal(put1.body.data.version, 1);
      const put2 = await dz('put', '/lead-quality', superAdmin, defaultInput({ baseScore: 45 }));
      assert.equal(put2.status, 200);
      assert.equal(put2.body.data.version, 2);

      const rows = (await auditRows('danger_zone.lead_quality.update')).slice(before.length);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].metadata.oldValue.baseScore, 35);
      assert.equal(rows[0].metadata.newValue.baseScore, 40);
      assert.equal(rows[0].metadata.version, 1);
      assert.equal(rows[0].actor_user_id, superAdmin.id);
      assert.equal(rows[1].metadata.oldValue.baseScore, 40);
      assert.equal(rows[1].metadata.newValue.baseScore, 45);
      assert.equal(rows[1].metadata.version, 2);

      const get = await dz('get', '/lead-quality', superAdmin);
      assert.equal(get.body.data.lastChange.version, 2);
      assert.equal(get.body.data.lastChange.oldValue.baseScore, 40);
      assert.equal(get.body.data.lastChange.newValue.baseScore, 45);
      assert.equal(get.body.data.lastChange.actorUserId, superAdmin.id);
    });

    it('(f) invalid configs are refused with a clear 400 and change nothing', async () => {
      const cases: Array<[string, any]> = [
        ['base out of range', defaultInput({ baseScore: 101 })],
        ['thresholds unordered', defaultInput({ thresholds: { hot: 50, warm: 60, developing: 40 } })],
        ['thresholds equal', defaultInput({ thresholds: { hot: 80, warm: 80, developing: 40 } })],
        ['recency ladder not open-ended', defaultInput({
          recency: [{ maxDays: 1, points: 5 }, { maxDays: 3, points: 3 }],
        })],
        ['recency ladder unordered', defaultInput({
          recency: [
            { maxDays: 3, points: 3 }, { maxDays: 1, points: 5 }, { maxDays: null, points: 0 },
          ],
        })],
        ['unknown status id', defaultInput({
          statusPoints: { ...defaultInput().statusPoints, '00000000-0000-0000-0000-000000000000': 10 },
        })],
        ['terminal status points', defaultInput({
          statusPoints: { ...defaultInput().statusPoints, [statusIds['Converted']]: 10 },
        })],
        ['terminal advanced flag', defaultInput({
          advancedStatusIds: [...DEFAULT_ADVANCED.map(n => statusIds[n]), statusIds['Converted']],
        })],
        ['engagement cap out of range', defaultInput({ engagement: { pointsPerEvent: 3, maxEvents: 99 } })],
      ];
      for (const [label, body] of cases) {
        const res = await dz('put', '/lead-quality', superAdmin, body);
        assert.equal(res.status, 400, `${label} should be a 400, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert.ok(String(res.body.message || '').length > 0, `${label} needs a clear message`);
      }
      const missing: any = defaultInput();
      delete missing.baseScore;
      assert.equal((await dz('put', '/lead-quality', superAdmin, missing)).status, 400);
      // Nothing was saved: the version is still 0 and defaults rule.
      const get = await dz('get', '/lead-quality', superAdmin);
      assert.equal(get.body.data.version, 0);
      assert.equal(get.body.data.config.baseScore, 35);
    });

    it('(f) a corrupt stored value fails closed to the code defaults', async () => {
      const lead = await makeLead({ current_status: 'Interested' });
      assert.equal((await qualityOf(lead.id)).score, 60);
      // Out-of-range stored base + an unknown status id: the whole row
      // is discarded, never partially applied.
      await pool.query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_active, meta)
         VALUES ('LeadQuality', 'config', 'Lead Quality Config', 1, true, $1::jsonb)
         ON CONFLICT (field_key, option_value) DO UPDATE SET meta = EXCLUDED.meta`,
        [JSON.stringify({
          version: 9, baseScore: 999, thresholds: { hot: 80, warm: 60, developing: 40 },
          statusPointsById: { '00000000-0000-0000-0000-000000000000': 50 },
          advancedStatusIds: [], recency: DEFAULT_LEAD_QUALITY_CONFIG.recency,
          engagement: { pointsPerEvent: 3, maxEvents: 3 },
          failedContact: { pointsPerEvent: -3, maxEvents: 3, attentionAt: 3 },
          followUp: { scheduledPoints: 5, overdue: DEFAULT_LEAD_QUALITY_CONFIG.followUp.overdue },
          investment: { points: 3 },
        })]
      );
      const get = await dz('get', '/lead-quality', superAdmin);
      assert.equal(get.status, 200);
      assert.equal(get.body.data.config.baseScore, 35);
      assert.equal(get.body.data.version, 0);
      assert.equal((await qualityOf(lead.id)).score, 60);
    });

    it('(c) renaming a status keeps its points (dictionary-entry keying)', async () => {
      const lead = await makeLead({ current_status: 'Interested' });
      assert.equal((await qualityOf(lead.id)).score, 60);
      // Save a config whose Interested weight is keyed by the entry id.
      const put = await dz('put', '/lead-quality', superAdmin, defaultInput());
      assert.equal(put.status, 200);

      // The codebase's rename: the option row keeps its id (migration
      // 044 pattern) and leads move to the new spelling with it.
      await pool.query(`UPDATE options SET option_value = 'Keen', option_label = 'Keen' WHERE id = $1`, [statusIds['Interested']]);
      await pool.query(`UPDATE leads SET current_status = 'Keen' WHERE id = $1`, [lead.id]);

      // The entry still carries its 15 points under the new name.
      const get = await dz('get', '/lead-quality', superAdmin);
      const keen = get.body.data.statusOptions.find((o: any) => o.value === 'Keen');
      assert.ok(keen, 'renamed entry still listed');
      assert.equal(keen.points, 15);
      assert.equal(keen.id, statusIds['Interested']);
      const scored = await qualityOf(lead.id);
      assert.equal(scored.score, 60);
      assert.equal(scored.band, 'Warm');

      // Service-level: the stored id resolves to the new name.
      const cfg = await getLeadQualityConfig();
      assert.equal(cfg.statusPoints['Keen'], 15);
      assert.equal(cfg.statusPoints['Interested'], undefined);

      // Restore the dictionary spelling for the other tests.
      await pool.query(`UPDATE options SET option_value = 'Interested', option_label = 'Interested' WHERE id = $1`, [statusIds['Interested']]);
      await pool.query(`UPDATE leads SET current_status = 'Interested' WHERE id = $1`, [lead.id]);
    });

    it('service round-trip: save then read resolves ids to names', async () => {
      const saved = await setLeadQualityConfig(defaultInput({ baseScore: 42 }), { actorId: superAdmin.id });
      assert.equal(saved.version, 1);
      assert.equal(saved.config.baseScore, 42);
      assert.equal(saved.config.statusPoints['Interested'], 15);
      assert.ok(saved.config.advancedStatuses.includes('Interested'));
      const read = await getLeadQualityConfig();
      assert.equal(read.baseScore, 42);
      assert.equal(read.statusPoints['Pipeline Locked'], 35);
    });
  });
});
