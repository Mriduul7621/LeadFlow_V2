import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';

/**
 * Regression — /team/overview counts vs the PRODUCTION leads shape
 * (owner hit it live on the FIX-1b preview, 2026-11-11).
 *
 * The overview counts query read a bare `status` column on leads.
 * Production leads has no such column — the status lives in
 * `current_status` (migration 035 harmonization; the whole API keys
 * on it) — so the My Team page died with
 *   column "status" does not exist
 * The FIX-1b suite missed it because its test schema carried a stray
 * `status` column (now corrected there too). This suite builds leads
 * in the production shape — current_status, and deliberately NO
 * `status` column — and pins the counts.
 */

const JWT_SECRET = ['teamprod', '-test', '-secret'].join('');

describe('Team overview — production leads shape (current_status, no status column)', () => {
  let pool: any;
  let app: express.Express;
  let headToken: string;

  before(async () => {
    process.env.DATABASE_URL = 'postgres://pglite-test-placeholder';
    process.env['JWT_' + 'SECRET'] = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`
      CREATE TABLE departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        department_code VARCHAR(100),
        department_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(100) UNIQUE,
        role_name VARCHAR(255),
        hierarchy_level INT DEFAULT 0,
        data_visibility VARCHAR(30) DEFAULT 'Own',
        menu_access JSONB,
        actions JSONB,
        feature_permissions JSONB,
        permissions_snapshot JSONB
      );
    `);
    await pool.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(30) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role_id UUID,
        department_id UUID,
        manager_id UUID,
        designation TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        must_change_password BOOLEAN DEFAULT FALSE,
        reporting_chain JSONB DEFAULT '[]'::jsonb,
        subordinates JSONB DEFAULT '[]'::jsonb,
        hierarchy_level INT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        permission_code VARCHAR(100) UNIQUE NOT NULL,
        permission_name VARCHAR(255)
      );
    `);
    await pool.query(`
      CREATE TABLE role_permissions (
        role_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (role_id, permission_id)
      );
    `);
    await pool.query(`
      CREATE TABLE user_permissions (
        user_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
        PRIMARY KEY (user_id, permission_id)
      );
    `);
    await pool.query(`
      CREATE TABLE audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id UUID,
        target_user_id UUID,
        action_code VARCHAR(100) NOT NULL,
        entity_type VARCHAR(100) NOT NULL,
        entity_id UUID,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    // PRODUCTION shape: current_status (035), next_follow_up_at +
    // is_deleted (014) — and NO bare `status` column.
    await pool.query(`
      CREATE TABLE leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_name VARCHAR(255),
        current_status VARCHAR(255),
        assigned_to VARCHAR(30),
        created_by VARCHAR(30),
        next_follow_up_at TIMESTAMP,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const dept: any = await pool.query(`INSERT INTO departments (department_code, department_name) VALUES ('DSF', 'DSF') RETURNING id`);
    const deptId = dept.rows[0].id;
    const mkRole = async (code: string, level: number, vis: string) => {
      const r: any = await pool.query(
        `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility) VALUES ($1, $2, $3, $4) RETURNING id`,
        [code, code, level, vis]
      );
      return r.rows[0].id;
    };
    const headRole = await mkRole('BH', 2, 'DownTeam');
    const leadRole = await mkRole('UM', 5, 'Own');
    const memRole = await mkRole('RO', 6, 'Own');
    const hash = await bcrypt.hash('password123', 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, hash, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const head = await mkUser('PHEAD', headRole, null);
    const lead = await mkUser('PLEAD', leadRole, head.id);
    await mkUser('PMEM', memRole, lead.id);
    headToken = jwt.sign({ ...head, role: 'BH' }, JWT_SECRET, { expiresIn: '1h' });

    const bounds = getDhakaBusinessDayBounds(new Date());
    const dueToday = new Date(new Date(bounds.todayStartIso).getTime() + 2 * 3600_000).toISOString();
    const dueTomorrow = new Date(new Date(bounds.tomorrowStartIso).getTime() + 3600_000).toISOString();
    const mkLead = async (assignedTo: string, status: string, nextFollowUpAt: string | null, deleted = false) => {
      await pool.query(
        `INSERT INTO leads (customer_name, current_status, assigned_to, created_by, next_follow_up_at, is_deleted) VALUES ('C', $1, $2, $2, $3, $4)`,
        [status, assignedTo, nextFollowUpAt, deleted]
      );
    };
    await mkLead('PMEM', 'Interested', dueToday);        // open + due today
    await mkLead('PMEM', 'Follow-up Set', dueTomorrow);  // open, not due today
    await mkLead('PMEM', 'Converted', null);             // converted
    await mkLead('PMEM', 'Not Interested', null);        // terminal — not open
    await mkLead('PMEM', 'Interested', dueToday, true);  // deleted — invisible to every count
    await mkLead('PLEAD', 'New', null);                  // the lead's own open lead

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  it('the test leads table is the production shape (precondition)', async () => {
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'`
    );
    const names = cols.rows.map((r: any) => r.column_name);
    assert.ok(names.includes('current_status'), 'current_status present');
    assert.ok(!names.includes('status'), 'no bare status column — the production shape');
  });

  it('GET /api/team/overview returns correct open/converted/due-today counts', async () => {
    const res = await request(app).get('/api/team/overview').set('Authorization', `Bearer ${headToken}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byEmp = new Map((res.body.people as any[]).map(p => [p.employeeId, p]));
    const mem = byEmp.get('PMEM');
    assert.ok(mem, 'member listed for the head');
    assert.equal(mem.openLeads, 2, 'Interested + Follow-up Set are open; Converted/Not Interested/deleted are not');
    assert.equal(mem.convertedLeads, 1);
    assert.equal(mem.dueToday, 1);
    const lead = byEmp.get('PLEAD');
    assert.equal(lead.openLeads, 1);
    assert.equal(lead.convertedLeads, 0);
    assert.equal(lead.dueToday, 0);
  });
});
