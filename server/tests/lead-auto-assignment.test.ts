/**
 * Phase 3 PR #1 — opt-in auto-assignment for unassigned leads.
 *
 * What is pinned here is the shipped behaviour, end to end:
 *
 *   - the pure rule (pickAutoAssignee): least OPEN load wins, ties go
 *     to the least-recently assigned, then employee_id — deterministic;
 *   - the switch: a Metadata Engine option ('LeadAutoAssignment' /
 *     'enabled'), seeded INACTIVE by migration 049. OFF (or missing)
 *     means the lead write paths behave EXACTLY as before this feature;
 *   - POST /leads with no assignee + switch ON routes to the
 *     least-loaded active member of the creator's assignment scope,
 *     with the canonical assignment-history entry, the same
 *     'lead-assigned' notification a manual assignment creates, and an
 *     audit_logs row (action 'leads.auto_assign');
 *   - explicit assignments are never overridden; deactivated users
 *     are never picked; terminal-status leads never count as load;
 *   - POST /leads/bulk routes blank-assignee INSERT rows the same way,
 *     distributes a batch across the team, and reports `autoAssigned`.
 *
 * The HTTP suite drives the real chain — runMigrations() (001→049) +
 * seedRoles() + default role grants — against PGlite, mirroring
 * user-deactivation-lead-transfer.test.ts.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import { JWT_SECRET } from '../routes/production/shared.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { seedRoles } from '../database/seeds/roles.seed.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';
import { fallbackStore } from '../fallbackStore.js';
import {
  AUTO_ASSIGN_HISTORY_NOTE,
  buildDemoAutoAssignCandidates,
  isAutoAssignmentEnabled,
  loadAutoAssignCandidates,
  pickAutoAssignee,
  type AutoAssignCandidate,
} from '../services/AutoAssignmentService.js';

// Sign with the server's own secret (shared.js captures it at module
// load, before any test-time env assignment can take effect — the
// convention push-reminders.test.ts documents).
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

const cand = (employeeId: string, openLeads: number, lastAssignedAt: string | null = null): AutoAssignCandidate => ({
  userId: `uid-${employeeId}`,
  employeeId,
  openLeads,
  lastAssignedAt,
});

describe('Auto-assignment rule — pure decision function', () => {
  it('empty pool picks nobody', () => {
    assert.equal(pickAutoAssignee([]), null);
  });

  it('least open load wins', () => {
    const pick = pickAutoAssignee([cand('EMP001', 3), cand('EMP002', 1), cand('EMP003', 2)]);
    assert.equal(pick?.employeeId, 'EMP002');
  });

  it('a tie goes to the member who was never assigned over a recently assigned one', () => {
    const pick = pickAutoAssignee([
      cand('EMP001', 0, '2026-04-01T10:00:00.000Z'),
      cand('EMP002', 0, null),
    ]);
    assert.equal(pick?.employeeId, 'EMP002');
  });

  it('a tie goes to the least-recently assigned member', () => {
    const pick = pickAutoAssignee([
      cand('EMP001', 1, '2026-04-02T10:00:00.000Z'),
      cand('EMP002', 1, '2026-03-01T10:00:00.000Z'),
    ]);
    assert.equal(pick?.employeeId, 'EMP002');
  });

  it('a full tie is deterministic by employee_id, and the input is not mutated', () => {
    const input = [cand('TL001', 0), cand('EMP002', 0), cand('EMP001', 0)];
    const snapshot = [...input];
    const pick = pickAutoAssignee(input);
    assert.equal(pick?.employeeId, 'EMP001');
    assert.deepEqual(input, snapshot);
  });

  it('demo candidates count only open leads of active, in-pool users', () => {
    const usersBefore = fallbackStore.users.length;
    const leadsBefore = fallbackStore.leads.length;
    try {
      (fallbackStore.users as any[]).push(
        { id: 'demo-u1', employeeId: 'DEMO1', email: 'd1@test', status: 'Active', role: 'EMPLOYEE' },
        { id: 'demo-u2', employeeId: 'DEMO2', email: 'd2@test', status: 'Active', role: 'EMPLOYEE' },
        { id: 'demo-u3', employeeId: 'DEMO3', email: 'd3@test', status: 'Inactive', role: 'EMPLOYEE' },
      );
      (fallbackStore.leads as any[]).push(
        { id: 'demo-l1', prospectName: 'A', mobile: '01', assignedTo: 'DEMO1', currentStatus: 'New', timestamp: '2026-01-01T00:00:00.000Z' },
        { id: 'demo-l2', prospectName: 'B', mobile: '02', assignedTo: 'DEMO1', currentStatus: 'Converted', timestamp: '2026-01-02T00:00:00.000Z' },
        { id: 'demo-l3', prospectName: 'C', mobile: '03', assignedTo: 'DEMO2', currentStatus: 'Contacted', timestamp: '2026-01-03T00:00:00.000Z' },
      );
      const candidates = buildDemoAutoAssignCandidates(['demo-u1', 'demo-u2', 'demo-u3']);
      assert.equal(candidates.length, 2, 'the inactive user is excluded');
      const d1 = candidates.find(c => c.employeeId === 'DEMO1');
      const d2 = candidates.find(c => c.employeeId === 'DEMO2');
      assert.equal(d1?.openLeads, 1, 'the Converted lead does not count as load');
      assert.equal(d2?.openLeads, 1);
      assert.equal(d1?.lastAssignedAt, '2026-01-02T00:00:00.000Z');
      assert.equal(pickAutoAssignee(candidates)?.employeeId, 'DEMO1', 'tie on load: least-recently assigned (2026-01-02 < 2026-01-03) wins');
      assert.equal(buildDemoAutoAssignCandidates([]).length, 0);
      assert.equal(buildDemoAutoAssignCandidates(null).length >= 2, true, 'null pool = everyone active');
    } finally {
      (fallbackStore.users as any[]).splice(usersBefore);
      (fallbackStore.leads as any[]).splice(leadsBefore);
    }
  });
});

describe('Auto-assignment — HTTP (PGlite, real migrations)', () => {
  let pool: any;
  let app: express.Express;
  let adminId = '';
  let deptId = '';
  let ceo: any;
  let tl: any;
  let e1: any;
  let e2: any;

  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });
  const tokenFor = (u: any, role: string) => sign({ id: u.id, employeeId: u.employeeId, role, email: u.email });

  async function setFlag(on: boolean | null) {
    if (on === null) {
      await pool.query(`DELETE FROM options WHERE field_key = 'LeadAutoAssignment'`);
      return;
    }
    await pool.query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ('LeadAutoAssignment', 'enabled', 'Auto-assign unassigned leads', 1, FALSE, $1, '{"featureFlag":true}'::jsonb, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET is_active = EXCLUDED.is_active`,
      [on]
    );
  }

  const addUser = async (employeeId: string, role: string, managerId?: string) => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId,
        fullName: `Person ${employeeId}`,
        email: `${employeeId.toLowerCase()}@test.com`,
        role,
        departmentId: deptId,
        managerId: role === 'CEO' ? undefined : (managerId || ceo.id),
        status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  const addLeadDirect = async (mobile: string, ownerId: string, status = 'New', assignedAt?: string) => {
    const res = await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, assigned_by, created_by, updated_by, current_status, assigned_at)
       VALUES ($1, $2, $3, $4, $4, $4, $4, $5, $6) RETURNING id`,
      [`lead_${mobile}`, `Customer ${mobile}`, mobile, ownerId, status, assignedAt || new Date().toISOString()]
    );
    return res.rows[0].id;
  };

  const leadByMobile = async (mobile: string) => {
    const res = await pool.query(
      `SELECT l.*, u.employee_id AS owner_employee_id FROM leads l
        LEFT JOIN users u ON u.id = l.assigned_to WHERE l.mobile = $1 AND l.is_deleted = FALSE`,
      [mobile]
    );
    return res.rows[0] || null;
  };

  const createLeadAs = async (user: any, role: string, mobile: string, extra: Record<string, any> = {}) => {
    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenFor(user, role)}`)
      .send({ prospectName: `Prospect ${mobile}`, mobile, ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  };

  before(async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();
    await applyDefaultRoleAccess();

    const adminRole = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = 'ADMIN' LIMIT 1`);
    const admin = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('ADMIN1', 'System Admin', 'admin@test.com', 'x', $1, TRUE) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminId = admin.rows[0].id;

    app = express();
    app.use(express.json());
    app.use('/api', productionRoutes);
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM audit_logs');
    await pool.query('DELETE FROM leads');
    await pool.query('DELETE FROM department_members');
    await pool.query(`DELETE FROM teams WHERE is_department_mirror`);
    await pool.query(`DELETE FROM users WHERE employee_id <> 'ADMIN1'`);
    await pool.query('DELETE FROM departments');
    await setFlag(null);

    const dept = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    deptId = dept.body.id;

    ceo = await addUser('CEO1', 'CEO');
    tl = await addUser('TL001', 'TEAM_LEAD');
    e1 = await addUser('EMP001', 'EMPLOYEE', tl.id);
    e2 = await addUser('EMP002', 'EMPLOYEE', tl.id);
  });

  it('migration 049 is registered as the last migration', () => {
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '049_lead_auto_assignment_flag');
    assert.ok(readFileSync('server/database/runMigrations.ts', 'utf8').includes('049_lead_auto_assignment_flag'));
  });

  it('migration 049 seeds the switch OFF and is idempotent', async () => {
    const { up } = await import('../database/migrations/049_lead_auto_assignment_flag.js');
    await up();
    await up();
    const rows = await pool.query(
      `SELECT is_active FROM options WHERE field_key = 'LeadAutoAssignment' AND option_value = 'enabled'`
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].is_active, false, 'seeded inactive — OFF until an admin enables it');
    assert.equal(await isAutoAssignmentEnabled(), false);
    const type = await pool.query(`SELECT is_system FROM metadata_types WHERE key = 'LeadAutoAssignment'`);
    assert.equal(type.rows.length, 1);
    assert.equal(type.rows[0].is_system, true);
  });

  it('switch OFF: a lead with no assignee keeps the creator default, untouched', async () => {
    await setFlag(false);
    const res = await createLeadAs(tl, 'TEAM_LEAD', '01710000001');
    assert.equal(res.body.autoAssigned, false);
    assert.equal(res.body.data.assignedTo, 'TL001', 'today\'s behaviour: creator owns it');
    const row = await leadByMobile('01710000001');
    assert.equal(row.owner_employee_id, 'TL001');
    const history = Array.isArray(row.assignment_history) ? row.assignment_history : [];
    assert.ok(!history.some((h: any) => h.note === AUTO_ASSIGN_HISTORY_NOTE), 'no auto history entry');
    const audit = await pool.query(`SELECT * FROM audit_logs WHERE action_code = 'leads.auto_assign'`);
    assert.equal(audit.rows.length, 0);
  });

  it('switch ON: routes to the least-loaded team member, with history, notification and audit', async () => {
    await setFlag(true);
    await addLeadDirect('01710000011', e1.id, 'New');
    await addLeadDirect('01710000012', e1.id, 'Contacted');
    // Loads: TL001 = 0, EMP001 = 2, EMP002 = 0. Tie TL/EMP002 on load and
    // on recency (neither ever assigned) -> employee_id decides: EMP002.
    const res = await createLeadAs(tl, 'TEAM_LEAD', '01710000002');
    assert.equal(res.body.autoAssigned, true);
    assert.equal(res.body.data.assignedTo, 'EMP002');

    const row = await leadByMobile('01710000002');
    assert.equal(row.owner_employee_id, 'EMP002');
    const history = Array.isArray(row.assignment_history) ? row.assignment_history : [];
    const entry = history[history.length - 1];
    assert.equal(entry?.note, AUTO_ASSIGN_HISTORY_NOTE);
    assert.equal(entry?.toEmployeeId, 'EMP002');
    assert.equal(entry?.changedBy, 'TL001');

    const notif = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 AND event_type = 'lead-assigned'`,
      [e2.id]
    );
    assert.ok(notif.rows.length >= 1, 'the assignee is notified like a manual assignment');

    const audit = await pool.query(
      `SELECT * FROM audit_logs WHERE action_code = 'leads.auto_assign' AND entity_type = 'lead'`
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].target_user_id, e2.id);
    const meta = typeof audit.rows[0].metadata === 'string' ? JSON.parse(audit.rows[0].metadata) : audit.rows[0].metadata;
    assert.equal(meta.rule, 'least_loaded');
    assert.equal(meta.poolSize, 3);
  });

  it('switch ON: an explicit assignee is never overridden', async () => {
    await setFlag(true);
    const res = await createLeadAs(tl, 'TEAM_LEAD', '01710000003', { assignedTo: 'EMP001' });
    assert.equal(res.body.autoAssigned, false);
    assert.equal(res.body.data.assignedTo, 'EMP001');
    const audit = await pool.query(`SELECT * FROM audit_logs WHERE action_code = 'leads.auto_assign'`);
    assert.equal(audit.rows.length, 0);
  });

  it('switch ON: terminal-status leads do not count as load', async () => {
    await setFlag(true);
    await addLeadDirect('01710000021', e1.id, 'Converted');
    await addLeadDirect('01710000022', e1.id, 'Converted');
    await addLeadDirect('01710000023', e1.id, 'Not Interested');
    await addLeadDirect('01710000024', e2.id, 'New');
    await addLeadDirect('01710000025', tl.id, 'New');
    // Open loads: EMP001 = 0 (all terminal), EMP002 = 1, TL001 = 1.
    const res = await createLeadAs(tl, 'TEAM_LEAD', '01710000004');
    assert.equal(res.body.data.assignedTo, 'EMP001');
  });

  it('switch ON: a deactivated team member is never picked', async () => {
    await setFlag(true);
    await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [e2.id]);
    await addLeadDirect('01710000031', e1.id, 'New');
    await addLeadDirect('01710000032', tl.id, 'New');
    await addLeadDirect('01710000033', tl.id, 'Contacted');
    // EMP002 has load 0 but is deactivated; EMP001 (1) beats TL001 (2).
    const res = await createLeadAs(tl, 'TEAM_LEAD', '01710000005');
    assert.equal(res.body.data.assignedTo, 'EMP001');
    const candidates = await loadAutoAssignCandidates(pool, [e2.id]);
    assert.equal(candidates.length, 0, 'the loader itself filters deactivated users out of the pool');
  });

  it('switch ON: an Own-scope creator is their own pool (self-create unchanged)', async () => {
    await setFlag(true);
    const res = await createLeadAs(e1, 'EMPLOYEE', '01710000006');
    assert.equal(res.body.data.assignedTo, 'EMP001');
    assert.equal(res.body.autoAssigned, false, 'the rule selected the creator = the existing default');
  });

  it('loader: recency tie-break uses leads.assigned_at', async () => {
    await addLeadDirect('01710000041', e1.id, 'New', '2026-01-01T00:00:00.000Z');
    await addLeadDirect('01710000042', e2.id, 'New', '2026-03-01T00:00:00.000Z');
    await addLeadDirect('01710000043', e1.id, 'Converted', '2026-02-01T00:00:00.000Z');
    const candidates = await loadAutoAssignCandidates(pool, [e1.id, e2.id]);
    assert.equal(candidates.length, 2);
    const c1 = candidates.find(c => c.employeeId === 'EMP001');
    const c2 = candidates.find(c => c.employeeId === 'EMP002');
    assert.equal(c1?.openLeads, 1, 'Converted lead excluded from load');
    assert.equal(c2?.openLeads, 1);
    assert.equal(pickAutoAssignee(candidates)?.employeeId, 'EMP001', 'equal load: least-recently assigned wins');
    assert.deepEqual(await loadAutoAssignCandidates(pool, []), [], 'empty id set = empty pool');
  });

  it('bulk import, switch ON: blank rows are distributed and counted, explicit rows untouched', async () => {
    await setFlag(true);
    await addLeadDirect('01710000051', e1.id, 'New');
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(tl, 'TEAM_LEAD')}`)
      .send({
        leads: [
          { Name: 'Import A', Phone: '01710000052', 'Assigned To': '' },
          { Name: 'Import B', Phone: '01710000053', 'Assigned To': '' },
          { Name: 'Import C', Phone: '01710000054', 'Assigned To': 'EMP001' },
        ],
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.inserted, 3, JSON.stringify(res.body.data.errors));
    assert.equal(res.body.data.autoAssigned, 2, 'only the two blank rows were auto-routed');

    // Loads at import start: TL001 = 0, EMP001 = 1, EMP002 = 0.
    // Row A -> EMP002 (tie broken by employee_id); loads advance, so
    // Row B -> TL001 (the only member still at 0). Row C is explicit.
    assert.equal((await leadByMobile('01710000052')).owner_employee_id, 'EMP002');
    assert.equal((await leadByMobile('01710000053')).owner_employee_id, 'TL001');
    assert.equal((await leadByMobile('01710000054')).owner_employee_id, 'EMP001');

    const rowA = await leadByMobile('01710000052');
    const historyA = Array.isArray(rowA.assignment_history) ? rowA.assignment_history : [];
    assert.ok(historyA.some((h: any) => h.note === AUTO_ASSIGN_HISTORY_NOTE), 'imported auto lead carries the history entry');

    const audit = await pool.query(
      `SELECT * FROM audit_logs WHERE action_code = 'leads.auto_assign' AND entity_type = 'lead_import'`
    );
    assert.equal(audit.rows.length, 1, 'one summary audit entry for the import');
    const meta = typeof audit.rows[0].metadata === 'string' ? JSON.parse(audit.rows[0].metadata) : audit.rows[0].metadata;
    assert.equal(meta.autoAssigned, 2);
  });

  it('bulk import, switch OFF: blank rows stay unassigned, exactly as before', async () => {
    await setFlag(false);
    const res = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenFor(tl, 'TEAM_LEAD')}`)
      .send({ leads: [{ Name: 'Import Off', Phone: '01710000061', 'Assigned To': '' }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.inserted, 1);
    assert.equal(res.body.data.autoAssigned, 0);
    const row = await leadByMobile('01710000061');
    assert.equal(row.assigned_to, null, 'blank stays blank while the switch is off');
  });
});
