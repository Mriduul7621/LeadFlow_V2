import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { _resetPoolsForTest, _setTestPoolForTest, closePool } from '../database/connection.js';
import { createPGlitePoolAsync, getPGliteInstanceAsync, resetPGlite } from '../database/pglitePool.js';
import { up as migrateRoadshows } from '../database/migrations/042_roadshows.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, unknown>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

async function createTestApp() {
  const routes = await import('../routes/production.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api', routes.default);
  return app;
}

describe('Roadshow Follow-up API', () => {
  let pool: any;
  let app: express.Express;
  let admin: { id: string; employeeId: string; email: string; role: string };
  let agent: { id: string; employeeId: string; email: string; role: string };
  let otherAgent: { id: string; employeeId: string; email: string; role: string };

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`CREATE TABLE IF NOT EXISTS roles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      role_code VARCHAR(100) UNIQUE NOT NULL,
      role_name VARCHAR(255)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id VARCHAR(30) UNIQUE NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role_id UUID REFERENCES roles(id),
      department_id UUID,
      is_active BOOLEAN DEFAULT TRUE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      permission_code VARCHAR(100) UNIQUE NOT NULL,
      module_name VARCHAR(100) NOT NULL DEFAULT '',
      action_name VARCHAR(30) NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
      role_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (role_id, permission_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_permissions (
      user_id UUID NOT NULL,
      permission_id UUID NOT NULL,
      is_allowed BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (user_id, permission_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_code VARCHAR(50) UNIQUE,
      customer_name VARCHAR(255) NOT NULL,
      mobile VARCHAR(30) NOT NULL,
      source VARCHAR(100),
      current_status VARCHAR(255) DEFAULT 'New',
      is_deleted BOOLEAN DEFAULT FALSE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS options (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      field_key VARCHAR(100) NOT NULL,
      option_value VARCHAR(255) NOT NULL,
      option_label VARCHAR(255),
      sort_order INT DEFAULT 0,
      is_default BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(field_key, option_value)
    )`);
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM options`);
    await pool.query(`DELETE FROM user_permissions`);
    await pool.query(`DELETE FROM role_permissions`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM permissions`);
    await pool.query(`DELETE FROM roles`);

    const adminRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name) VALUES ('ADMIN', 'Administrator') RETURNING id`)).rows[0].id;
    const agentRoleId = (await pool.query(`INSERT INTO roles (role_code, role_name) VALUES ('AGENT', 'Agent') RETURNING id`)).rows[0].id;
    await migrateRoadshows();
    const permissionCodes = ['roadshows.view', 'roadshows.create', 'roadshows.edit', 'roadshows.cancel', 'roadshows.report'];
    for (const code of permissionCodes) {
      const permissionId = (await pool.query(`SELECT id FROM permissions WHERE permission_code = $1`, [code])).rows[0].id;
      if (code !== 'roadshows.create' && code !== 'roadshows.cancel') {
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`,
          [agentRoleId, permissionId]
        );
      }
    }
    const adminId = (await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id) VALUES ('ADMIN1', 'Admin User', 'admin@roadshow.test', 'hash', $1) RETURNING id`,
      [adminRoleId]
    )).rows[0].id;
    const agentId = (await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id) VALUES ('AGENT1', 'Agent One', 'agent@roadshow.test', 'hash', $1) RETURNING id`,
      [agentRoleId]
    )).rows[0].id;
    const otherAgentId = (await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id) VALUES ('AGENT2', 'Agent Two', 'agent2@roadshow.test', 'hash', $1) RETURNING id`,
      [agentRoleId]
    )).rows[0].id;

    admin = { id: adminId, employeeId: 'ADMIN1', email: 'admin@roadshow.test', role: 'ADMIN' };
    agent = { id: agentId, employeeId: 'AGENT1', email: 'agent@roadshow.test', role: 'AGENT' };
    otherAgent = { id: otherAgentId, employeeId: 'AGENT2', email: 'agent2@roadshow.test', role: 'AGENT' };
    app = await createTestApp();
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    resetPGlite();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM roadshow_assignees`);
    await pool.query(`DELETE FROM roadshows`);
    await pool.query(`DELETE FROM roadshow_code_counters`);
    await pool.query(`DELETE FROM leads`);
    await pool.query(`DELETE FROM options`);
  });

  function auth(user: { id: string; employeeId: string; email: string; role: string }) {
    return `Bearer ${signToken(user)}`;
  }

  const input = (assignedUserIds: string[]) => ({
    organization: 'Bright Future',
    location: 'Dhaka',
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    assignedUserIds,
  });

  it('validates input, creates assigned roadshows, and filters My Work to assignees', async () => {
    const invalid = await request(app).post('/api/roadshows').set('Authorization', auth(admin)).send({ organization: 'Org' });
    assert.equal(invalid.status, 400);
    const forbiddenCreate = await request(app).post('/api/roadshows').set('Authorization', auth(agent)).send(input([agent.id]));
    assert.equal(forbiddenCreate.status, 403);

    const created = await request(app).post('/api/roadshows').set('Authorization', auth(admin)).send(input([agent.id]));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'pending');
    assert.equal(created.body.data.assignedUsers[0].id, agent.id);

    const mine = await request(app).get('/api/roadshows?mine=true').set('Authorization', auth(agent));
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(mine.body.data.map((row: any) => row.id), [created.body.data.id]);

    const otherMine = await request(app).get('/api/roadshows?mine=true').set('Authorization', auth(otherAgent));
    assert.equal(otherMine.status, 200);
    assert.deepEqual(otherMine.body.data, []);
  });

  it('generates a stable source code on execution, locks edits, and reports lead outcomes', async () => {
    const created = await request(app).post('/api/roadshows').set('Authorization', auth(admin)).send(input([agent.id]));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const roadshowId = created.body.data.id;

    const executed = await request(app).put(`/api/roadshows/${roadshowId}`).set('Authorization', auth(admin)).send({ status: 'execute' });
    assert.equal(executed.status, 200, JSON.stringify(executed.body));
    assert.equal(executed.body.data.status, 'execute');
    assert.equal(executed.body.data.sourceCode, 'bright_future_1');
    assert.equal(executed.body.data.scheduledAt.endsWith('Z'), true);

    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, source, current_status) VALUES
       ('RSL1', 'Converted Lead', '01710000001', $1, 'Converted'),
       ('RSL2', 'Interested Lead', '01710000002', $1, 'Interested'),
       ('OTHER', 'Other Source', '01710000003', 'Referral', 'Converted')`,
      [executed.body.data.sourceCode]
    );

    const locked = await request(app).put(`/api/roadshows/${roadshowId}`).set('Authorization', auth(agent)).send({ location: 'Changed' });
    assert.equal(locked.status, 409);

    const report = await request(app).get('/api/roadshows/performance').set('Authorization', auth(agent));
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.data.length, 1);
    assert.equal(report.body.data[0].totalLeads, 2);
    assert.equal(report.body.data[0].convertedLeads, 1);
    assert.deepEqual(report.body.data[0].stageBreakdown, [
      { status: 'Converted', count: 1 },
      { status: 'Interested', count: 1 },
    ]);

    const adminEdit = await request(app).put(`/api/roadshows/${roadshowId}`).set('Authorization', auth(admin)).send({ location: 'Admin Venue' });
    assert.equal(adminEdit.status, 200, JSON.stringify(adminEdit.body));
    assert.equal(adminEdit.body.data.location, 'Admin Venue');
    assert.equal(adminEdit.body.data.sourceCode, 'bright_future_1');

    const second = await request(app).post('/api/roadshows').set('Authorization', auth(admin)).send(input([otherAgent.id]));
    assert.equal(second.status, 201);
    const secondExecution = await request(app).put(`/api/roadshows/${second.body.data.id}`).set('Authorization', auth(admin)).send({ status: 'execute' });
    assert.equal(secondExecution.status, 200, JSON.stringify(secondExecution.body));
    assert.equal(secondExecution.body.data.sourceCode, 'bright_future_2');
  });

  it('requires the dedicated cancel permission and requires a new schedule for rescheduling', async () => {
    const created = await request(app).post('/api/roadshows').set('Authorization', auth(admin)).send(input([agent.id]));
    assert.equal(created.status, 201);
    const roadshowId = created.body.data.id;
    const date = created.body.data.scheduledAt;

    const cancelled = await request(app).put(`/api/roadshows/${roadshowId}`).set('Authorization', auth(agent)).send({ status: 'cancel' });
    assert.equal(cancelled.status, 403);

    const rescheduledWithoutNewDate = await request(app).put(`/api/roadshows/${roadshowId}`).set('Authorization', auth(agent)).send({ status: 'reschedule', scheduledAt: date });
    assert.equal(rescheduledWithoutNewDate.status, 400);

    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
       SELECT u.role_id, p.id, TRUE FROM users u CROSS JOIN permissions p
        WHERE u.id = $1 AND p.permission_code = 'roadshows.cancel'
       ON CONFLICT (role_id, permission_id) DO UPDATE SET is_allowed = TRUE`,
      [agent.id]
    );
    const cancelledWithPermission = await request(app).put(`/api/roadshows/${roadshowId}`).set('Authorization', auth(agent)).send({ status: 'cancel' });
    assert.equal(cancelledWithPermission.status, 200, JSON.stringify(cancelledWithPermission.body));
    assert.equal(cancelledWithPermission.body.data.status, 'cancel');
  });
});
