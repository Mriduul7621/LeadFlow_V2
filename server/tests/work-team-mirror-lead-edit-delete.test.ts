/**
 * work-team-mirror-lead-edit-delete.test.ts
 * ------------------------------------------------------------------
 * Owner work, 2026-11-18 — four parts, one branch, one PR:
 *
 *   A. My Work / Team mirror — both home pages render the SAME
 *      seven-card KPI row (shared HomeKpiRow, HOME_KPI_ORDER), all
 *      seven cards clickable through the existing drill-down
 *      (/team/kpi/:kpi, ?person=self on My Work).
 *   B. Execution queue — the team page shows a member-wise overview
 *      first; expanding a member loads THAT member's executions
 *      (GET /api/team/executions?person=, overdue first).
 *   C. Tomorrow preview on both pages — dueTomorrow is the eighth
 *      KPI key (drill-down only, never a card).
 *   D. Lead edit fix + delete with admin approval — a real
 *      /leads/:id/edit route (LeadGenerate in edit mode) and a
 *      delete-request workflow (migration 062): the requester files
 *      a request, ADMINS are notified in-app (no email), and only
 *      an admin's approval soft-deletes the lead. Counts change
 *      only after approval ("then main count hobe").
 *
 * Sections:
 *   1. Migration 062 — registered as the tail, table created,
 *      idempotent up, partial unique index.
 *   2. dueTomorrow — overview counts and the KPI drill-down leaf
 *      agree (terminal leads INCLUDED: a scheduling count, like
 *      dueToday — NOT an open-leads count).
 *   3. GET /team/executions — ordering (overdue → today →
 *      upcoming), terminal + dateless + deleted excluded,
 *      out-of-scope person 404, person=self.
 *   4. Delete requests — 201 + admins-only notifications, lead NOT
 *      deleted while pending (counts + flags), duplicate 409,
 *      out-of-scope 404, no-permission 403, non-admin list/review
 *      403, approve deletes, reject leaves, already-reviewed 409,
 *      re-request allowed after rejection, audit rows.
 *   5. Mirror rendering (SSR) — TeamHomeContent shows the Execution
 *      Queue + Tomorrow Preview sections; HomeKpiRow renders seven
 *      cards in HOME_KPI_ORDER with the right links for both
 *      personParam variants.
 *   6. Pure helpers — teamExecutionOverview ordering + never-empty,
 *      teamTomorrowPreview membership + ordering.
 *   7. Source guards — the edit route + edit mode, the delete icon
 *      + request flow on LeadList, the review page + its route and
 *      FeatureGate entry, notification routing to the review page.
 *
 * Test order matters: the delete-request flow (4) mutates leads, so
 * the count-sensitive sections (2, 3) run BEFORE it. The delete
 * targets carry no follow-up date, so they never enter the
 * executions or dueTomorrow counts either way.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import { _setTestPoolForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { getDhakaBusinessDayBounds } from '../utils/businessTime.js';
import { MIGRATION_IDS } from '../database/runMigrations.js';
import { up as migrate062 } from '../database/migrations/062_lead_delete_requests.js';

import {
  summarizeTeamTotals,
  teamExecutionOverview,
  teamTomorrowPreview,
  type TeamOverviewPerson,
} from '../../src/modules/team/services/teamOverviewService';
import {
  HOME_KPI_ORDER,
  KPI_KEYS,
  isKpiKey,
} from '../../src/modules/team/utils/kpiDrilldown';
import { TeamHomeContent } from '../../src/modules/team/pages/TeamHome';
import HomeKpiRow, { type HomeKpiValues } from '../../src/modules/team/components/HomeKpiRow';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// NOTE: the secret is assembled from fragments, never written as a
// literal on a *_SECRET-named constant — a literal there was once
// silently replaced by redaction and broke the whole file (FIX-2).
const JWT_SECRET = 'mirror-' + 'edit-' + 'delete-' + 'test-' + 'secret-' + '2026';

/* ================================================================ */
/* Fixture people (pure + SSR tests)                                */
/* ================================================================ */

const person = (over: Partial<TeamOverviewPerson>): TeamOverviewPerson => ({
  userId: over.employeeId || 'u-x',
  employeeId: 'EMP-X',
  name: 'Person X',
  designation: 'Relationship Officer',
  roleName: 'RO',
  department: 'DSF',
  managerEmployeeId: null,
  managerName: null,
  tier: 'teamMember',
  directReports: 0,
  openLeads: 0,
  convertedLeads: 0,
  dueToday: 0,
  overdue: 0,
  totalLeads: 0,
  todayLeads: 0,
  noActionLeads: 0,
  dueTomorrow: 0,
  isSelf: false,
  ...over,
});

// HEAD (self) -> TL1 + TL2; TL1 -> M1, M2. M2 is the never-empty pin:
// zero for every queue count, still listed in the Execution Queue.
const mirrorPeople: TeamOverviewPerson[] = [
  person({ userId: 'u-head', employeeId: 'EMP-H', name: 'Hana Head', isSelf: true, directReports: 2, tier: 'manager', openLeads: 2, dueToday: 1, overdue: 0, convertedLeads: 1, totalLeads: 4, todayLeads: 1, noActionLeads: 0, dueTomorrow: 1, designation: 'Business Head', roleName: 'BH' }),
  person({ userId: 'u-tl1', employeeId: 'EMP-T1', name: 'Tariq Lead', managerEmployeeId: 'EMP-H', managerName: 'Hana Head', directReports: 2, tier: 'teamLead', openLeads: 6, dueToday: 2, overdue: 3, convertedLeads: 1, totalLeads: 9, todayLeads: 2, noActionLeads: 1, dueTomorrow: 2, designation: 'Unit Manager', roleName: 'UM' }),
  person({ userId: 'u-tl2', employeeId: 'EMP-T2', name: 'Tania Lead', managerEmployeeId: 'EMP-H', managerName: 'Hana Head', directReports: 0, tier: 'teamLead', openLeads: 3, dueToday: 0, overdue: 1, convertedLeads: 0, totalLeads: 4, todayLeads: 0, noActionLeads: 0, dueTomorrow: 0, designation: 'Unit Manager', roleName: 'UM' }),
  person({ userId: 'u-m1', employeeId: 'EMP-M1', name: 'Mina Member', managerEmployeeId: 'EMP-T1', managerName: 'Tariq Lead', openLeads: 4, dueToday: 1, overdue: 2, convertedLeads: 0, totalLeads: 5, todayLeads: 1, noActionLeads: 2, dueTomorrow: 3 }),
  person({ userId: 'u-m2', employeeId: 'EMP-M2', name: 'Musa Member', managerEmployeeId: 'EMP-T1', managerName: 'Tariq Lead', openLeads: 0, dueToday: 0, overdue: 0, convertedLeads: 0, totalLeads: 0, todayLeads: 0, noActionLeads: 0, dueTomorrow: 0 }),
];

/* ================================================================ */
/* DB harness — production shapes (current_status, UUID FKs,        */
/* notifications with event_type + partial unique idempotency       */
/* index, lead_delete_requests via the REAL migration 062)          */
/* ================================================================ */

let pool: any;
let app: any;
let headToken = '';
let tlToken = '';
let memToken = '';
let outToken = '';
let nogToken = '';
let adminToken = '';
let admin2Token = '';
let memId = '';
let adminId = '';
let admin2Id = '';
let inactiveAdminId = '';
let leadIds: Record<string, string> = {};
let leadCodes: Record<string, string> = {};

describe('work-team mirror + lead edit/delete — server', () => {
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
    // PRODUCTION leads shape: current_status, assigned_to a UUID FK
    // → users(id) (migration 014), assigned_by for LEAD_SELECT,
    // deleted_*/updated_* for the approve soft-delete, custom_fields
    // JSONB — and deliberately NO bare `status` column.
    await pool.query(`
      CREATE TABLE leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_code VARCHAR(50),
        customer_name VARCHAR(255),
        mobile VARCHAR(30),
        alternate_mobile VARCHAR(30),
        email VARCHAR(150),
        occupation VARCHAR(255),
        marital_status VARCHAR(50),
        address TEXT,
        area VARCHAR(255),
        district VARCHAR(100),
        division VARCHAR(100),
        source VARCHAR(100),
        priority VARCHAR(20),
        notes TEXT,
        current_status VARCHAR(255),
        assigned_to UUID REFERENCES users(id),
        assigned_by UUID REFERENCES users(id),
        assigned_at TIMESTAMP,
        created_by UUID REFERENCES users(id),
        expected_premium NUMERIC,
        expected_value NUMERIC,
        last_contacted_at TIMESTAMP,
        next_follow_up_at TIMESTAMP,
        status_history JSONB,
        assignment_history JSONB,
        documents JSONB,
        tags JSONB,
        custom_fields JSONB,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TIMESTAMP,
        deleted_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        updated_by UUID REFERENCES users(id)
      );
    `);
    // Notifications, production shape (migrations 010 + 035 + 040):
    // event_type + idempotency_key with the partial unique index the
    // insert's ON CONFLICT clause requires.
    await pool.query(`
      CREATE TABLE notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        recipient_key VARCHAR(255),
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'info',
        event_type VARCHAR(100),
        idempotency_key VARCHAR(500),
        lead_code VARCHAR(50),
        reference_type VARCHAR(100),
        reference_id UUID,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        read_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE UNIQUE INDEX idx_notifications_idempotency_key
        ON notifications(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    // Options (production shape) — left WITHOUT FollowUpStatus rows
    // so the terminal dictionary is empty and the canonical fallback
    // names (Converted, Not Interested) apply, as in the drill-down
    // tests.
    await pool.query(`
      CREATE TABLE options (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        field_key VARCHAR(100) NOT NULL,
        option_value VARCHAR(255) NOT NULL,
        option_label VARCHAR(255),
        sort_order INT DEFAULT 0,
        is_default BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(field_key, option_value)
      );
    `);
    // Minimal activity tables (production shapes) so the quality
    // signal queries run against real tables, not the catch path.
    await pool.query(`
      CREATE TABLE lead_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID REFERENCES leads(id),
        activity_type VARCHAR(50),
        status VARCHAR(255),
        remarks TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE scheduled_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID REFERENCES leads(id),
        scheduled_at TIMESTAMP,
        status VARCHAR(20) DEFAULT 'scheduled',
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // The REAL migration 062 — twice, to pin idempotency.
    await migrate062();
    await migrate062();

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
    const umRoleId = await mkRole('UM', 5, 'Own');
    const memRoleId = await mkRole('RO', 6, 'Own');
    const nogRole = await mkRole('NOG', 6, 'Own');
    const adminRole = await mkRole('ADMIN', 1, 'Organization');
    const hash = await bcrypt.hash('password123', 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null, active = true) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, hash, roleId, deptId, managerId, active]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const head = await mkUser('KHEAD', headRole, null);
    const tl = await mkUser('KTL', umRoleId, head.id);
    const mem = await mkUser('KMEM', memRoleId, tl.id);
    const sib = await mkUser('KSIB', umRoleId, head.id);
    const smem = await mkUser('KSMEM', memRoleId, sib.id);
    const out = await mkUser('KOUT', memRoleId, null);
    const nog = await mkUser('KNOG', nogRole, null);
    const admin = await mkUser('KADM', adminRole, null);
    const admin2 = await mkUser('KADM2', adminRole, null);
    const inactiveAdmin = await mkUser('KADMI', adminRole, null, false);
    memId = mem.id;
    adminId = admin.id;
    admin2Id = admin2.id;
    inactiveAdminId = inactiveAdmin.id;
    headToken = jwt.sign({ ...head, role: 'BH' }, JWT_SECRET, { expiresIn: '1h' });
    tlToken = jwt.sign({ ...tl, role: 'UM' }, JWT_SECRET, { expiresIn: '1h' });
    memToken = jwt.sign({ ...mem, role: 'RO' }, JWT_SECRET, { expiresIn: '1h' });
    outToken = jwt.sign({ ...out, role: 'RO' }, JWT_SECRET, { expiresIn: '1h' });
    nogToken = jwt.sign({ ...nog, role: 'NOG' }, JWT_SECRET, { expiresIn: '1h' });
    adminToken = jwt.sign({ ...admin, role: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
    admin2Token = jwt.sign({ ...admin2, role: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });

    const viewPerm: any = await pool.query(
      `INSERT INTO permissions (permission_code, permission_name) VALUES ('leads.view', 'View leads') RETURNING id`
    );
    const grant = async (roleId: string, permId: string) => {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [roleId, permId]);
    };
    await grant(headRole, viewPerm.rows[0].id);
    await grant(umRoleId, viewPerm.rows[0].id);
    await grant(memRoleId, viewPerm.rows[0].id);
    // NOG and ADMIN get no leads.view grant: NOG pins the 403, and
    // the admin review paths gate on the role, not the grant.

    const bounds = getDhakaBusinessDayBounds(new Date());
    const todayStart = new Date(bounds.todayStartIso).getTime();
    const tomorrowStart = new Date(bounds.tomorrowStartIso).getTime();
    const overdueAt = new Date(todayStart - 26 * 3600_000).toISOString();
    const overdueEarlier = new Date(todayStart - 27 * 3600_000).toISOString();
    const dueToday = new Date(todayStart + 2 * 3600_000).toISOString();
    const tomorrow1 = new Date(tomorrowStart + 1 * 3600_000).toISOString();
    const tomorrow2 = new Date(tomorrowStart + 2 * 3600_000).toISOString();
    const dayAfter = new Date(tomorrowStart + 26 * 3600_000).toISOString();
    const mkLead = async (name: string, assignedTo: string, status: string, nextFollowUpAt: string | null, deleted = false) => {
      const code = `LC-${name.replace(/[^A-Za-z0-9]/g, '')}`;
      const r: any = await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at, is_deleted)
         VALUES ($1, $2, '01700000000', $3, $4, $4, $5, $6) RETURNING id`,
        [code, name, status, assignedTo, nextFollowUpAt, deleted]
      );
      leadIds[name] = r.rows[0].id;
      leadCodes[name] = code;
    };
    // KMEM's book: 2 overdue (B earlier than A), 1 due today, 2 due
    // tomorrow (one terminal — the dueTomorrow KPI has NO terminal
    // filter), 1 dateless, 1 day-after, 1 deleted, 4 delete targets
    // (dateless, so they never enter executions/dueTomorrow).
    await mkLead('MEM Overdue B', mem.id, 'Follow-up Set', overdueEarlier);
    await mkLead('MEM Overdue A', mem.id, 'Interested', overdueAt);
    await mkLead('MEM Due Today', mem.id, 'Interested', dueToday);
    await mkLead('MEM Tomorrow 1', mem.id, 'Interested', tomorrow1);
    await mkLead('MEM Tomorrow 2', mem.id, 'Converted', tomorrow2);
    await mkLead('MEM No Date', mem.id, 'Interested', null);
    await mkLead('MEM Day After', mem.id, 'Interested', dayAfter);
    await mkLead('MEM Deleted', mem.id, 'Interested', overdueAt, true);
    await mkLead('MEM Delete Target 1', mem.id, 'Interested', null);
    await mkLead('MEM Delete Target 2', mem.id, 'Interested', null);
    await mkLead('MEM Delete Target 3', mem.id, 'Interested', null);
    await mkLead('MEM Delete Target 4', mem.id, 'Interested', null);
    await mkLead('TL Overdue', tl.id, 'New', overdueAt);
    await mkLead('SMEM Overdue', smem.id, 'Interested', overdueAt);
    await mkLead('OUT Overdue', out.id, 'Interested', overdueAt);
    await mkLead('ADMIN Only Lead', admin.id, 'New', null);

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  const overview = (token: string) =>
    request(app).get('/api/team/overview').set('Authorization', `Bearer ${token}`);
  const kpiLeads = (token: string, kpi: string, person: string) =>
    request(app).get(`/api/team/kpi/leads?kpi=${kpi}&person=${encodeURIComponent(person)}`).set('Authorization', `Bearer ${token}`);
  const executions = (token: string, person: string) =>
    request(app).get(`/api/team/executions?person=${encodeURIComponent(person)}`).set('Authorization', `Bearer ${token}`);
  const listLeads = (token: string) =>
    request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
  const getLead = (token: string, id: string) =>
    request(app).get(`/api/leads/${id}`).set('Authorization', `Bearer ${token}`);
  const requestDelete = (token: string, id: string, reason?: string) =>
    request(app).post(`/api/leads/${id}/delete-request`).set('Authorization', `Bearer ${token}`).send(reason ? { reason } : {});
  const listRequests = (token: string, status?: string) =>
    request(app).get(`/api/leads/delete-requests${status ? `?status=${status}` : ''}`).set('Authorization', `Bearer ${token}`);
  const reviewRequest = (token: string, requestId: string, action: string, note?: string) =>
    request(app).post(`/api/leads/delete-requests/${requestId}/review`).set('Authorization', `Bearer ${token}`).send(note ? { action, note } : { action });

  /* ============================================================ */
  /* 1. Migration 062                                             */
  /* ============================================================ */

  it('migration 062 is registered as the tail (061 stays reserved for the enterprise chain)', () => {
    assert.ok(MIGRATION_IDS.includes('062_lead_delete_requests'), '062 is registered');
    assert.ok(!MIGRATION_IDS.includes('061_rm_role_grant_scope'), '061 is not on main — no collision');
    assert.equal(MIGRATION_IDS[MIGRATION_IDS.length - 1], '062_lead_delete_requests', '062 is the migration tail');
    assert.ok(read('server/database/runMigrations.ts').includes('062_lead_delete_requests'), 'runner names migration 062');
  });

  it('migration 062 created lead_delete_requests with the pending-unique index (up ran twice)', async () => {
    const cols: any = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lead_delete_requests' ORDER BY column_name`
    );
    const names = cols.rows.map((r: any) => r.column_name);
    for (const col of ['id', 'lead_id', 'requested_by', 'reason', 'status', 'requested_at', 'reviewed_by', 'reviewed_at', 'review_note']) {
      assert.ok(names.includes(col), `lead_delete_requests carries ${col}`);
    }
    const idx: any = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'lead_delete_requests'`
    );
    const idxNames = idx.rows.map((r: any) => r.indexname);
    assert.ok(idxNames.includes('idx_lead_delete_requests_pending_unique'), 'the one-pending-request index exists');
    assert.ok(idxNames.includes('idx_lead_delete_requests_status'), 'the status index exists');
  });

  /* ============================================================ */
  /* 2. dueTomorrow — overview counts and the drill-down leaf     */
  /* ============================================================ */

  it('dueTomorrow: the overview counts tomorrow follow-ups per person, terminal included', async () => {
    const res = await overview(headToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const people = res.body.people as any[];
    const mem = people.find(p => p.employeeId === 'KMEM');
    assert.ok(mem, 'KMEM is in the head overview');
    // Tomorrow 1 (Interested) + Tomorrow 2 (Converted): the KPI is a
    // scheduling count, like dueToday — NO terminal filter. Day After
    // is the day after tomorrow, not tomorrow.
    assert.equal(mem.dueTomorrow, 2, 'both tomorrow leads count, terminal included');
    const tl = people.find(p => p.employeeId === 'KTL');
    assert.equal(tl.dueTomorrow, 0, 'a member with nothing tomorrow reports 0, never missing');
    assert.ok(people.every((p: any) => typeof p.dueTomorrow === 'number'), 'every person carries the field');
    const totals = summarizeTeamTotals(people as any);
    assert.equal(totals.dueTomorrow, 2, 'the team total is the sum of the members');
  });

  it('dueTomorrow: the drill-down leaf agrees with the overview count exactly', async () => {
    const res = await kpiLeads(headToken, 'dueTomorrow', 'KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2, 'the leaf total matches the overview count');
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName).sort(),
      ['MEM Tomorrow 1', 'MEM Tomorrow 2'],
      'terminal leads are IN the leaf, like dueToday'
    );
    const self = await kpiLeads(memToken, 'dueTomorrow', 'self');
    assert.equal(self.status, 200, JSON.stringify(self.body));
    assert.equal(self.body.total, 2, 'person=self reads the caller\'s own tomorrow leads');
    const empty = await kpiLeads(headToken, 'dueTomorrow', 'KTL');
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.total, 0, 'no tomorrow leads is an empty list, never an error');
    assert.deepEqual(empty.body.items, []);
  });

  /* ============================================================ */
  /* 3. GET /team/executions                                      */
  /* ============================================================ */

  it('executions: one member\'s queue, overdue first, then today, then upcoming', async () => {
    const res = await executions(headToken, 'KMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.person.employeeId, 'KMEM');
    assert.equal(res.body.total, 5);
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName),
      ['MEM Overdue B', 'MEM Overdue A', 'MEM Due Today', 'MEM Tomorrow 1', 'MEM Day After'],
      'chronological by next follow-up: overdue first, then today, then upcoming'
    );
    assert.deepEqual(
      res.body.items.map((l: any) => l.dueState),
      ['overdue', 'overdue', 'today', 'upcoming', 'upcoming'],
      'each row is classified for its pill'
    );
    for (const item of res.body.items) {
      assert.ok(item.id, 'rows carry the UUID for the Lead360 link');
      assert.ok(item.leadCode, 'rows carry the lead code');
      assert.ok(item.nextFollowUpAt, 'rows carry their follow-up date');
    }
  });

  it('executions: terminal, dateless and deleted leads are excluded', async () => {
    const res = await executions(headToken, 'KMEM');
    const names = res.body.items.map((l: any) => l.customerName);
    assert.ok(!names.includes('MEM Tomorrow 2'), 'a Converted lead is terminal, not an execution');
    assert.ok(!names.includes('MEM No Date'), 'a lead with no scheduled follow-up has no execution');
    assert.ok(!names.includes('MEM Deleted'), 'a deleted lead never appears');
    assert.ok(!names.includes('MEM Delete Target 1'), 'dateless delete targets never appear');
  });

  it('executions: person=self reads the caller, and a member with one execution shows one', async () => {
    const self = await executions(memToken, 'self');
    assert.equal(self.status, 200, JSON.stringify(self.body));
    assert.equal(self.body.total, 5, 'the member sees their own queue');
    const absent = await executions(memToken, '');
    assert.equal(absent.status, 200, JSON.stringify(absent.body));
    assert.equal(absent.body.total, 5, 'an absent person param is the caller too');
    const tl = await executions(headToken, 'KTL');
    assert.equal(tl.status, 200, JSON.stringify(tl.body));
    assert.equal(tl.body.total, 1);
    assert.equal(tl.body.items[0].customerName, 'TL Overdue');
  });

  it('executions: an out-of-scope person is 404, and so is an unknown one', async () => {
    const outOfScope = await executions(headToken, 'KOUT');
    assert.equal(outOfScope.status, 404, 'KOUT is outside the head\'s subtree');
    const reverse = await executions(outToken, 'KMEM');
    assert.equal(reverse.status, 404, 'an out-of-scope caller cannot read another member\'s queue');
    const bogus = await executions(headToken, 'NOBODY');
    assert.equal(bogus.status, 404, 'an unknown employee id is 404, not 500');
  });

  it('executions: leads.view is required', async () => {
    const res = await executions(nogToken, 'self');
    assert.equal(res.status, 403, 'a caller without leads.view cannot read executions');
  });

  /* ============================================================ */
  /* 4. Delete requests — request, notify, review                 */
  /* ============================================================ */

  // The flow tests below run in order and share state deliberately:
  // D1 is requested, then approved; D2 is requested, rejected, then
  // requested again. Each test asserts the state the previous one
  // left behind, so a failure points at the exact step that broke.
  let d1RequestId = '';
  let d2RequestId = '';

  it('delete request: 201 creates the request and notifies ACTIVE admins only', async () => {
    const res = await requestDelete(memToken, leadIds['MEM Delete Target 1'], 'Duplicate entry — same customer twice');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.request.status, 'pending');
    assert.equal(res.body.request.leadId, leadIds['MEM Delete Target 1']);
    d1RequestId = res.body.request.id;
    assert.ok(d1RequestId, 'the request id is returned');

    const rows: any = await pool.query(
      `SELECT user_id, title, message, event_type, idempotency_key FROM notifications
       WHERE event_type = 'lead-delete-request' ORDER BY created_at`
    );
    assert.equal(rows.rows.length, 2, 'exactly two notifications: one per ACTIVE admin');
    const recipients = rows.rows.map((r: any) => String(r.user_id)).sort();
    assert.deepEqual(recipients, [adminId, admin2Id].sort(), 'both active admins are notified');
    assert.ok(!recipients.includes(inactiveAdminId), 'an inactive admin is NOT notified');
    assert.ok(!recipients.includes(memId), 'the requester is not notified');
    for (const row of rows.rows) {
      assert.equal(row.title, 'Delete request: MEM Delete Target 1', 'the notification names the lead');
      assert.ok(row.message.includes('Name KMEM'), 'the notification names the requester');
      assert.ok(row.message.includes('(KMEM)'), 'the notification carries the requester\'s employee id');
      assert.ok(row.message.includes('LC-MEMDeleteTarget1'), 'the notification carries the lead code');
      assert.ok(row.message.includes('Duplicate entry'), 'the reason travels with the notification');
      assert.ok(row.idempotency_key, 'every notification carries an idempotency key');
    }
    const keys = rows.rows.map((r: any) => r.idempotency_key);
    assert.equal(new Set(keys).size, 2, 'each admin gets their own idempotency key');

    const audit: any = await pool.query(
      `SELECT action_code, entity_id, metadata FROM audit_logs WHERE action_code = 'leads.delete.request'`
    );
    assert.equal(audit.rows.length, 1, 'the request is audit-logged once');
    assert.equal(String(audit.rows[0].entity_id), leadIds['MEM Delete Target 1']);
    assert.equal(audit.rows[0].metadata.requestId, d1RequestId);
  });

  it('delete request: the lead is NOT deleted while pending — counts unchanged, flags set', async () => {
    const row: any = await pool.query(`SELECT is_deleted FROM leads WHERE id = $1`, [leadIds['MEM Delete Target 1']]);
    assert.equal(row.rows[0].is_deleted, false, 'is_deleted stays FALSE while the request is pending');

    const detail = await getLead(memToken, leadIds['MEM Delete Target 1']);
    assert.equal(detail.status, 200, 'the lead still opens while pending');
    assert.ok(detail.body.deleteRequest, 'the detail carries the pending request');
    assert.equal(detail.body.deleteRequest.id, d1RequestId);
    assert.equal(detail.body.deleteRequest.requestedBy, memId);

    const list = await listLeads(memToken);
    assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
    const rows = list.body as any[];
    assert.equal(rows.length, 11, 'the list count is unchanged while pending (11 non-deleted own leads)');
    const target = rows.find((l: any) => l.dbId === leadIds['MEM Delete Target 1']);
    assert.ok(target, 'the target is still listed');
    assert.equal(target.deleteRequested, true, 'the list row carries the pending marker');
    const other = rows.find((l: any) => l.dbId === leadIds['MEM Delete Target 2']);
    assert.equal(other.deleteRequested, false, 'a lead with no request carries no marker');

    const ov = await overview(memToken);
    const self = (ov.body.people as any[]).find((p: any) => p.employeeId === 'KMEM');
    assert.equal(self.totalLeads, 11, 'the overview total is unchanged while pending — counts move only on approval');
  });

  it('delete request: a second pending request for the same lead is refused (409)', async () => {
    const sameUser = await requestDelete(memToken, leadIds['MEM Delete Target 1']);
    assert.equal(sameUser.status, 409, 'the same requester cannot file twice');
    const otherUser = await requestDelete(tlToken, leadIds['MEM Delete Target 1']);
    assert.equal(otherUser.status, 409, 'another in-scope user cannot file while one is pending either');
    const rows: any = await pool.query(
      `SELECT COUNT(*)::int AS n FROM lead_delete_requests WHERE lead_id = $1 AND status = 'pending'`,
      [leadIds['MEM Delete Target 1']]
    );
    assert.equal(rows.rows[0].n, 1, 'exactly one pending request exists');
  });

  it('delete request: an out-of-scope lead is 404 (no existence leak), a lead without leads.view is 403', async () => {
    const outOfScope = await requestDelete(outToken, leadIds['MEM Delete Target 3']);
    assert.equal(outOfScope.status, 404, 'OUT cannot request for a lead they cannot see');
    const reverse = await requestDelete(headToken, leadIds['OUT Overdue']);
    assert.equal(reverse.status, 404, 'the head cannot request for OUT\'s lead either');
    const noPerm = await requestDelete(nogToken, leadIds['MEM Delete Target 4']);
    assert.equal(noPerm.status, 403, 'a caller without leads.view cannot request at all');
    const missing = await requestDelete(memToken, '00000000-0000-0000-0000-000000000000');
    assert.equal(missing.status, 404, 'a missing lead is 404');
  });

  it('delete requests: the review list is admin-only; the admin sees the pending request', async () => {
    const forbidden = await listRequests(memToken);
    assert.equal(forbidden.status, 403, 'a non-admin cannot list requests');
    const forbiddenReview = await reviewRequest(memToken, d1RequestId, 'approve');
    assert.equal(forbiddenReview.status, 403, 'a non-admin cannot review either');

    const res = await listRequests(adminToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pending = res.body.requests.filter((r: any) => r.status === 'pending');
    assert.equal(pending.length, 1, 'exactly one pending request so far');
    const req1 = pending[0];
    assert.equal(req1.id, d1RequestId);
    assert.equal(req1.leadName, 'MEM Delete Target 1');
    assert.equal(req1.leadCode, 'LC-MEMDeleteTarget1');
    assert.equal(req1.requestedByName, 'Name KMEM');
    assert.equal(req1.requestedByEmployeeId, 'KMEM');
    assert.equal(req1.reason, 'Duplicate entry — same customer twice');
    assert.equal(req1.leadDeleted, false, 'the lead is not deleted while pending');

    const filtered = await listRequests(adminToken, 'approved');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.requests.length, 0, 'the status filter works');
    const badFilter = await listRequests(adminToken, 'bogus');
    assert.equal(badFilter.status, 400, 'an unknown status filter is 400');
  });

  it('delete request: a request filed by lead code works, and REJECT leaves the lead untouched', async () => {
    const res = await requestDelete(tlToken, leadCodes['MEM Delete Target 2'], 'Requested by the team lead');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    d2RequestId = res.body.request.id;

    const reviewed = await reviewRequest(admin2Token, d2RequestId, 'reject', 'Still an active prospect');
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, 'rejected');
    assert.equal(reviewed.body.leadAlreadyDeleted, false);

    const row: any = await pool.query(`SELECT is_deleted FROM leads WHERE id = $1`, [leadIds['MEM Delete Target 2']]);
    assert.equal(row.rows[0].is_deleted, false, 'a rejected request leaves the lead untouched');
    const detail = await getLead(memToken, leadIds['MEM Delete Target 2']);
    assert.equal(detail.status, 200, 'the lead still opens after rejection');
    assert.equal(detail.body.deleteRequest, null, 'the pending marker is gone after rejection');

    const audit: any = await pool.query(
      `SELECT action_code FROM audit_logs WHERE action_code = 'leads.delete.reject' AND entity_id = $1`,
      [leadIds['MEM Delete Target 2']]
    );
    assert.equal(audit.rows.length, 1, 'the rejection is audit-logged');
  });

  it('delete request: an already-reviewed request cannot be reviewed again (409)', async () => {
    const again = await reviewRequest(adminToken, d2RequestId, 'approve');
    assert.equal(again.status, 409, 'a rejected request cannot be approved after the fact');
    const missing = await reviewRequest(adminToken, '00000000-0000-0000-0000-000000000000', 'approve');
    assert.equal(missing.status, 404, 'a missing request is 404');
    const badAction = await reviewRequest(adminToken, d1RequestId, 'maybe');
    assert.equal(badAction.status, 400, 'an unknown action is 400');
  });

  it('delete request: after a rejection a NEW request for the same lead is allowed', async () => {
    const res = await requestDelete(memToken, leadIds['MEM Delete Target 2']);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'pending');
    // Leave it pending: the final list test below counts it, and the
    // lead stays live (never approved).
    d2RequestId = res.body.request.id;
  });

  it('delete request: APPROVE soft-deletes the lead through the existing path — and only now do counts move', async () => {
    const reviewed = await reviewRequest(adminToken, d1RequestId, 'approve', 'Confirmed duplicate');
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.equal(reviewed.body.status, 'approved');
    assert.equal(reviewed.body.leadAlreadyDeleted, false, 'the lead was live when approved');

    const row: any = await pool.query(
      `SELECT is_deleted, deleted_at, deleted_by FROM leads WHERE id = $1`,
      [leadIds['MEM Delete Target 1']]
    );
    assert.equal(row.rows[0].is_deleted, true, 'approve sets is_deleted');
    assert.ok(row.rows[0].deleted_at, 'deleted_at is stamped');
    assert.equal(String(row.rows[0].deleted_by), adminId, 'deleted_by is the approving admin');

    const detail = await getLead(memToken, leadIds['MEM Delete Target 1']);
    assert.equal(detail.status, 404, 'the deleted lead no longer opens');
    const list = await listLeads(memToken);
    assert.equal((list.body as any[]).length, 10, 'the list count drops by one — only after approval');
    const ov = await overview(memToken);
    const self = (ov.body.people as any[]).find((p: any) => p.employeeId === 'KMEM');
    assert.equal(self.totalLeads, 10, 'the overview total drops by one — only after approval');

    const audit: any = await pool.query(
      `SELECT action_code, actor_user_id FROM audit_logs WHERE action_code = 'leads.delete.approve' AND entity_id = $1`,
      [leadIds['MEM Delete Target 1']]
    );
    assert.equal(audit.rows.length, 1, 'the approval is audit-logged');
    assert.equal(String(audit.rows[0].actor_user_id), adminId, 'the audit names the approver');

    const again = await reviewRequest(adminToken, d1RequestId, 'approve');
    assert.equal(again.status, 409, 'an approved request cannot be approved twice');
  });

  it('delete requests: the final list shows approved, rejected and pending in order', async () => {
    const res = await listRequests(adminToken);
    assert.equal(res.status, 200);
    const reqs = res.body.requests as any[];
    assert.equal(reqs.length, 3, 'three requests exist: D1 approved, D2 rejected, D2 re-requested pending');
    assert.equal(reqs[0].status, 'pending', 'pending requests come first');
    assert.equal(reqs[0].leadName, 'MEM Delete Target 2');
    const approved = reqs.find((r: any) => r.id === d1RequestId);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.leadDeleted, true, 'the approved row shows its lead as deleted');
    assert.equal(approved.reviewedByName, 'Name KADM');
    assert.equal(approved.reviewNote, 'Confirmed duplicate');
  });
});

/* ================================================================ */
/* 5. Mirror rendering (SSR, repo style)                            */
/* ================================================================ */

describe('work-team mirror — rendering', () => {
  const renderHome = (people: TeamOverviewPerson[]) =>
    renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TeamHomeContent, { people, scope: 'Team' })
      )
    );

  it('Team Home renders the Execution Queue with every member and their counts', () => {
    const html = renderHome(mirrorPeople);
    assert.ok(html.includes('Execution Queue'), 'the Execution Queue section is present');
    for (const name of ['Hana Head', 'Tariq Lead', 'Tania Lead', 'Mina Member', 'Musa Member']) {
      assert.ok(html.includes(name), `${name} is listed in the queue overview`);
    }
    // Musa has zero for every queue count — the never-empty rule says
    // he is still listed (his zero counts render, never hidden).
    const queue = html.slice(html.indexOf('Execution Queue'), html.indexOf('Team follow-ups today'));
    assert.ok(queue.includes('Musa Member'), 'a member with zero queue counts is still listed');
    assert.ok(queue.includes('EMP-M2'), 'member rows carry the employee ID');
    assert.ok(queue.includes('due today'), 'queue counts name due today');
    assert.ok(queue.includes('overdue'), 'queue counts name overdue');
    assert.ok(queue.includes('open'), 'queue counts name total open');
  });

  it('Team Home renders the Tomorrow Preview with the team total and member rows', () => {
    const html = renderHome(mirrorPeople);
    assert.ok(html.includes('Tomorrow Preview'), 'the Tomorrow Preview section is present');
    assert.ok(html.includes('6 follow-ups due tomorrow across the team'), 'the team total is shown (1+2+3)');
    assert.ok(html.includes('href="/team/kpi/dueTomorrow"'), 'View all opens the dueTomorrow drill-down');
    assert.ok(html.includes('Mina Member'), 'the member with the most tomorrow leads is listed');
    assert.ok(html.includes('3 due tomorrow'), 'member rows carry their tomorrow count');
    assert.ok(html.includes('/team/kpi/dueTomorrow?person=EMP-M1'), 'a member row opens that member\'s tomorrow leads');
    assert.ok(!html.includes('/team/kpi/dueTomorrow?person=EMP-M2'), 'a member with nothing tomorrow has no row');
    assert.ok(!html.includes('/team/kpi/dueTomorrow?person=EMP-T2'), 'ditto for Tania');
  });

  it('Team Home shows the all-clear state when nobody has anything tomorrow', () => {
    const quiet = mirrorPeople.map(p => ({ ...p, dueTomorrow: 0 }));
    const html = renderHome(quiet);
    assert.ok(html.includes('Tomorrow Preview'), 'the section still renders');
    assert.ok(html.includes('Nothing scheduled for tomorrow'), 'the all-clear state renders, never a blank section');
    assert.ok(!html.includes('href="/team/kpi/dueTomorrow"'), 'no View all link when there is nothing to view');
  });

  it('Team Home keeps the follow-ups and radar sections (nothing removed)', () => {
    const html = renderHome(mirrorPeople);
    assert.ok(html.includes('Team follow-ups today'), 'the follow-ups section stays');
    assert.ok(html.includes('Stale-lead radar'), 'the radar section stays');
    assert.ok(html.includes('Team') && html.includes('My work'), 'the Team / My work switch stays');
  });
});

describe('HomeKpiRow — the one shared KPI row', () => {
  const values: HomeKpiValues = {
    totalLeads: 12, todayCollection: 3, open: 8,
    dueToday: 2, overdue: 1, noAction: 4, converted: 5,
  };
  const renderRow = (props: { values: HomeKpiValues; personParam?: string }) =>
    renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(HomeKpiRow, props))
    );

  it('renders seven cards in HOME_KPI_ORDER with the owner\'s labels', () => {
    const html = renderRow({ values });
    const labels = ['Total Lead', 'Today Lead Collection', 'Open leads', 'Due today', 'Overdue', 'No Action Alert', 'Converted'];
    let last = -1;
    for (const label of labels) {
      const idx = html.indexOf(label);
      assert.ok(idx !== -1, `the ${label} card renders`);
      assert.ok(idx > last, `${label} follows the previous card in HOME_KPI_ORDER`);
      last = idx;
    }
    assert.ok(!html.includes('Due tomorrow'), 'dueTomorrow is a drill-down key, never an eighth card');
    // A zero renders as 0, never hidden (never-empty rule).
    const zeroes = renderRow({ values: { totalLeads: 0, todayCollection: 0, open: 0, dueToday: 0, overdue: 0, noAction: 0, converted: 0 } });
    for (const label of labels) {
      assert.ok(zeroes.includes(label), `the ${label} card still renders at 0`);
    }
  });

  it('My Work links every card to the caller\'s own leads (?person=self)', () => {
    const html = renderRow({ values, personParam: 'self' });
    for (const kpi of HOME_KPI_ORDER) {
      assert.ok(html.includes(`href="/team/kpi/${kpi}?person=self"`), `the ${kpi} card links ?person=self`);
    }
    assert.ok(html.includes('view my leads'), 'the self row labels its links as the caller\'s own');
  });

  it('Team Home links every card to the member-wise team drill-down', () => {
    const html = renderRow({ values });
    for (const kpi of HOME_KPI_ORDER) {
      assert.ok(html.includes(`href="/team/kpi/${kpi}"`), `the ${kpi} card links the team drill-down`);
    }
    assert.ok(!html.includes('?person='), 'the team row carries no person param');
    assert.ok(html.includes('view details'), 'the team row labels its links as details');
  });

  it('both pages render the SAME component (the mirror is structural, not copied markup)', () => {
    const workbench = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    const teamHome = read('src/modules/team/pages/TeamHome.tsx');
    assert.ok(workbench.includes('HomeKpiRow'), 'My Work renders HomeKpiRow');
    assert.ok(teamHome.includes('HomeKpiRow'), 'Team Home renders HomeKpiRow');
    assert.ok(!workbench.includes('KpiStripCard'), 'the old per-page strip is gone from My Work');
    assert.ok(!teamHome.includes('function StatCard'), 'the old per-page card is gone from Team Home');
  });
});

/* ================================================================ */
/* 6. Pure helpers — execution overview + tomorrow preview          */
/* ================================================================ */

describe('team overview helpers — execution queue + tomorrow preview', () => {
  it('teamExecutionOverview orders busiest first and never drops a member', () => {
    const rows = teamExecutionOverview(mirrorPeople);
    assert.equal(rows.length, 5, 'every member is listed, zero counts included');
    assert.deepEqual(
      rows.map(r => r.employeeId),
      ['EMP-T1', 'EMP-M1', 'EMP-T2', 'EMP-H', 'EMP-M2'],
      'overdue desc, then dueToday desc, then open desc, then name'
    );
    const musa = rows.find(r => r.employeeId === 'EMP-M2')!;
    assert.deepEqual(
      { dueToday: musa.dueToday, overdue: musa.overdue, open: musa.openLeads },
      { dueToday: 0, overdue: 0, open: 0 },
      'the zero-count member still carries all three counts'
    );
  });

  it('teamTomorrowPreview lists only members with tomorrow work, most first', () => {
    const rows = teamTomorrowPreview(mirrorPeople);
    assert.deepEqual(
      rows.map(r => r.employeeId),
      ['EMP-M1', 'EMP-T1', 'EMP-H'],
      'most tomorrow leads first'
    );
    assert.deepEqual(rows.map(r => r.dueTomorrow), [3, 2, 1]);
    assert.deepEqual(teamTomorrowPreview([]), [], 'an empty team previews empty');
    const quiet = mirrorPeople.map(p => ({ ...p, dueTomorrow: 0 }));
    assert.deepEqual(teamTomorrowPreview(quiet), [], 'nobody with tomorrow work previews empty');
  });

  it('dueTomorrow is the eighth KPI key, and the home row still shows seven cards', () => {
    assert.equal(KPI_KEYS.length, 8);
    assert.equal(isKpiKey('dueTomorrow'), true);
    assert.equal(HOME_KPI_ORDER.length, 7);
    assert.ok(!HOME_KPI_ORDER.includes('dueTomorrow' as any), 'dueTomorrow never renders as a card');
  });
});

/* ================================================================ */
/* 7. Source guards — edit route, delete icon, review page          */
/* ================================================================ */

describe('lead edit + delete — source guards', () => {
  it('the /leads/:id/edit route exists and renders LeadGenerate (the Lead360 home-redirect is fixed)', () => {
    const app = read('src/App.tsx');
    assert.ok(app.includes("path: '/leads/:id/edit'"), 'the edit route exists');
    assert.ok(app.includes('<FeatureGate route="/leads/:id/edit"><LazyPage page={<LeadGenerate />} /></FeatureGate>'),
      'the edit route renders LeadGenerate behind its FeatureGate');
    // The route sits between /leads/:id/update and /leads/:id so the
    // edit path is never swallowed by the detail route.
    const editIdx = app.indexOf("path: '/leads/:id/edit'");
    const detailIdx = app.indexOf("path: '/leads/:id'");
    assert.ok(editIdx !== -1 && detailIdx !== -1 && editIdx < detailIdx, 'the edit route precedes the detail route');
    const lead360 = read('src/modules/leads/pages/Lead360.tsx');
    assert.ok(lead360.includes('`/leads/${encodeURIComponent(lead.id)}/edit`'), 'Lead360\'s Edit button navigates to the real route');
  });

  it('LeadGenerate has a real edit mode gated on lead_tracking.edit', () => {
    const page = read('src/modules/leads/pages/LeadGenerate.tsx');
    assert.ok(page.includes('useParams'), 'edit mode reads the lead id from the route');
    assert.ok(page.includes("canAccess('lead_tracking', 'edit')"), 'edit mode gates on the edit capability');
    assert.ok(page.includes('Edit Lead'), 'the edit heading renders');
    assert.ok(page.includes('Save Changes'), 'the edit submit reads Save Changes');
    assert.ok(page.includes('leadService.updateLead'), 'edit mode saves through the existing update path');
    assert.ok(page.includes('prefillingRef'), 'the cascade guard keeps the pre-filled district/thana');
  });

  it('LeadList carries the delete icon next to Edit, with the request flow and pending marker', () => {
    const page = read('src/modules/leads/pages/LeadList.tsx');
    assert.ok(page.includes('Trash2'), 'the trash icon is imported');
    assert.ok(page.includes('requestDelete'), 'clicking it files a delete request');
    assert.ok(page.includes('Delete requested'), 'a pending lead shows its marker');
    assert.ok(page.includes('delete the lead right away'), 'the confirm copy says the lead is not deleted at once');
    assert.ok(page.includes('only their approval deletes the lead'), 'the confirm copy says only approval deletes');
    assert.ok(page.includes('deleteRequested'), 'the pending flag drives the icon state');
  });

  it('the admin review page exists, is routed, and is admin-gated', () => {
    const app = read('src/App.tsx');
    assert.ok(app.includes("path: '/leads/delete-requests'"), 'the review route exists');
    assert.ok(app.includes('DeleteRequests'), 'the review route renders the review page');
    const page = read('src/modules/leads/pages/DeleteRequests.tsx');
    assert.ok(page.includes('/api/leads/delete-requests'), 'the page reads the review list');
    assert.ok(page.includes("'approve'"), 'the page can approve');
    assert.ok(page.includes("'reject'"), 'the page can reject');
    const access = read('src/layouts/featureRouteAccess.ts');
    assert.ok(access.includes("'/leads/delete-requests'"), 'the review route is registered for access control');
    assert.ok(access.includes("'/leads/:id/edit'"), 'the edit route is registered for access control');
  });

  it('delete-request notifications route to the review page, not to a lead', () => {
    // The notifications inbox lives in MorePages.tsx (the More →
    // Notifications page), and the bell dropdown in AppLayout.
    const inbox = read('src/modules/navigation/pages/MorePages.tsx');
    assert.ok(inbox.includes("'lead-delete-request'"), 'the inbox recognises the delete-request event');
    assert.ok(inbox.includes("'/leads/delete-requests'"), 'the inbox routes it to the review page');
    assert.ok(inbox.includes('Delete Requests'), 'the Administration directory lists the review page');
    const layout = read('src/layouts/AppLayout.tsx');
    assert.ok(layout.includes('lead-delete-request'), 'the bell dropdown recognises the event too');
    assert.ok(layout.includes("'/leads/delete-requests'"), 'the bell dropdown routes it to the review page');
  });

  it('Lead360 shows the pending marker while a request waits', () => {
    const page = read('src/modules/leads/pages/Lead360.tsx');
    assert.ok(page.includes('deleteRequest'), 'Lead360 reads the pending request');
    assert.ok(page.includes('Delete requested'), 'Lead360 shows the pending banner');
  });

  it('the delete-request endpoints live in leads.routes.ts with the 062 guard', () => {
    const routes = read('server/routes/production/leads.routes.ts');
    assert.ok(routes.includes("router.post('/leads/:id/delete-request'"), 'the request endpoint exists');
    assert.ok(routes.includes("router.get('/leads/delete-requests'"), 'the review-list endpoint exists');
    assert.ok(routes.includes("router.post('/leads/delete-requests/:requestId/review'"), 'the review endpoint exists');
    assert.ok(routes.includes("DELETE_REQUEST_EVENT = 'lead-delete-request'"), 'the event name is one constant');
    assert.ok(routes.includes("'leads.delete.request'"), 'the request is audit-logged');
    assert.ok(routes.includes("'leads.delete.approve'"), 'the approval is audit-logged');
    assert.ok(routes.includes("'leads.delete.reject'"), 'the rejection is audit-logged');
    // The review list is registered BEFORE the detail route, or
    // "delete-requests" would be captured as a lead id.
    const listIdx = routes.indexOf("router.get('/leads/delete-requests'");
    const detailIdx = routes.indexOf("router.get('/leads/:id'");
    assert.ok(listIdx !== -1 && detailIdx !== -1 && listIdx < detailIdx, 'the review list precedes /leads/:id');
  });
});
