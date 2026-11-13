/**
 * tl-plus-home-kpi-new-cards.test.ts
 * ------------------------------------------------------------------
 * The three KPI cards added to TL+ Home on 2026-11-13 after the
 * owner approved the drill-down ("Yes now ok"): Total Lead, Today
 * Lead Collection, No Action Alert — plus the never-empty rule
 * ("ekbare faka screen jeno na thake kono kpi tei, ba kono type er
 * data te"): zero-count people are always listed with 0s, never
 * filtered out, in every KPI view and export.
 *
 * Sections:
 *   1. Pure helpers — the seven keys, labels, kpiValueFor,
 *      resolveKpiLevel for the new keys, summarizeTeamTotals,
 *      sortKpiRows never dropping a zero row.
 *   2. GET /api/team/overview — the three new counts, exact,
 *      against the PRODUCTION leads shape WITH lead_activities
 *      (migration 037) and the legacy status_history JSONB column.
 *   3. GET /team/kpi/leads — the three new leaf lists: the 48h
 *      boundary both sides, the Dhaka-day boundary both sides,
 *      terminal exclusion, legacy-history-counts-as-action, and
 *      card-count == drill-down-row-count equality for all 7 KPIs.
 *   4. Scoping for the new keys — member self-only, 404s, 403s.
 *   5. GET /team/kpi/export — new keys at people + leaf levels,
 *      zero rows included, all-zero level still lists everyone,
 *      403 without the grant.
 *   6. Rendering (SSR, repo style) — the all-zero people level,
 *      the zero leaf (name + employee ID + 0 count + message),
 *      Entered dates on No Action rows, the alert-styled card.
 *   7. Source guards — the shared predicate module, the probe,
 *      no count-filter anywhere in the drill-down path. (The
 *      degraded-schema test — without lead_activities /
 *      status_history — is the LAST test of section 2–5, since it
 *      drops objects.)
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

import {
  summarizeTeamTotals,
  type TeamOverviewPerson,
  type TeamOverviewResponse,
} from '../../src/modules/team/services/teamOverviewService';
import {
  KPI_KEYS,
  KPI_META,
  isKpiKey,
  kpiValueFor,
  resolveKpiLevel,
  sortKpiRows,
} from '../../src/modules/team/utils/kpiDrilldown';
import { TeamHomeContent } from '../../src/modules/team/pages/TeamHome';
import {
  TeamKpiDrilldownContent,
  type KpiLeadsResponse,
} from '../../src/modules/team/pages/TeamKpiDrilldown';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// NOTE: the secret is assembled from fragments, never written as a
// literal on a *_SECRET-named constant — a literal there was once
// silently replaced by redaction and broke the whole file (FIX-2).
const JWT_SECRET = ['kpi', '-new', '-cards'].join('');

/* ================================================================ */
/* Fixture people (pure tests)                                       */
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
  isSelf: false,
  ...over,
});

// HEAD -> TL1 (noAction 2) + TL2 (noAction 0); TL1 -> M1 (noAction 1)
// + M2 (noAction 0). TL2/M2 are the never-empty pins: zero for the
// KPI, still listed.
const treePeople: TeamOverviewPerson[] = [
  person({ userId: 'u-head', employeeId: 'EMP-H', name: 'Hana Head', isSelf: true, directReports: 2, tier: 'manager', totalLeads: 20, todayLeads: 3, noActionLeads: 2, designation: 'Business Head', roleName: 'BH' }),
  person({ userId: 'u-tl1', employeeId: 'EMP-T1', name: 'Tariq Lead', managerEmployeeId: 'EMP-H', managerName: 'Hana Head', directReports: 2, tier: 'teamLead', totalLeads: 12, todayLeads: 2, noActionLeads: 2, designation: 'Unit Manager', roleName: 'UM' }),
  person({ userId: 'u-tl2', employeeId: 'EMP-T2', name: 'Tania Lead', managerEmployeeId: 'EMP-H', managerName: 'Hana Head', directReports: 1, tier: 'teamLead', totalLeads: 8, todayLeads: 1, noActionLeads: 0, designation: 'Unit Manager', roleName: 'UM' }),
  person({ userId: 'u-m1', employeeId: 'EMP-M1', name: 'Mina Member', managerEmployeeId: 'EMP-T1', managerName: 'Tariq Lead', totalLeads: 7, todayLeads: 1, noActionLeads: 1 }),
  person({ userId: 'u-m2', employeeId: 'EMP-M2', name: 'Musa Member', managerEmployeeId: 'EMP-T1', managerName: 'Tariq Lead', totalLeads: 5, todayLeads: 1, noActionLeads: 0 }),
  person({ userId: 'u-m3', employeeId: 'EMP-M3', name: 'Mira Member', managerEmployeeId: 'EMP-T2', managerName: 'Tania Lead', totalLeads: 8, todayLeads: 1, noActionLeads: 0 }),
];

const teamOverview = (people: TeamOverviewPerson[], scope: string): TeamOverviewResponse => ({
  success: true,
  scope,
  people,
});

/* ================================================================ */
/* 1. Pure helpers — the seven keys                                  */
/* ================================================================ */

describe('new KPI cards — pure helpers', () => {
  it('there are seven KPI keys, with the owner\'s labels', () => {
    assert.deepEqual([...KPI_KEYS], ['open', 'dueToday', 'overdue', 'converted', 'totalLeads', 'todayCollection', 'noAction']);
    assert.equal(KPI_META.totalLeads.label, 'Total Lead');
    assert.equal(KPI_META.todayCollection.label, 'Today Lead Collection');
    assert.equal(KPI_META.noAction.label, 'No Action Alert');
    assert.equal(isKpiKey('totalLeads'), true);
    assert.equal(isKpiKey('todayCollection'), true);
    assert.equal(isKpiKey('noAction'), true);
    assert.equal(isKpiKey('Total'), false, 'keys are the exact camelCase codes');
    assert.equal(isKpiKey('no_action'), false);
  });

  it('kpiValueFor reads the new overview counts', () => {
    const tl1 = treePeople[1];
    assert.equal(kpiValueFor(tl1, 'totalLeads'), 12);
    assert.equal(kpiValueFor(tl1, 'todayCollection'), 2);
    assert.equal(kpiValueFor(tl1, 'noAction'), 2);
    assert.equal(kpiValueFor(treePeople[2], 'noAction'), 0, 'a zero is a value, not an absence');
  });

  it('resolveKpiLevel drills the new keys like the old ones', () => {
    const top = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'noAction', null);
    assert.equal(top.kind, 'people');
    if (top.kind !== 'people') return;
    assert.deepEqual(top.rows.map(p => p.employeeId), ['EMP-T1', 'EMP-T2'],
      'noAction desc: TL1 (2) before TL2 (0) — and TL2 is still listed');
    const tl1 = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'noAction', 'EMP-T1');
    assert.equal(tl1.kind, 'people');
    if (tl1.kind !== 'people') return;
    assert.deepEqual(tl1.rows.map(p => p.employeeId), ['EMP-M1', 'EMP-M2']);
    const m2 = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'totalLeads', 'EMP-M2');
    assert.equal(m2.kind, 'leads', 'a leaf member resolves to their lead list for the new keys too');
  });

  it('summarizeTeamTotals sums the new KPIs', () => {
    const totals = summarizeTeamTotals(treePeople);
    assert.equal(totals.totalLeads, 60);
    assert.equal(totals.todayCollection, 9);
    assert.equal(totals.noAction, 5);
  });

  it('sortKpiRows NEVER drops a zero row (never-empty rule)', () => {
    const rows = sortKpiRows(treePeople.filter(p => p.managerEmployeeId === 'EMP-T1'), 'noAction');
    assert.deepEqual(rows.map(p => p.employeeId), ['EMP-M1', 'EMP-M2'],
      'M2 has 0 no-action leads and is still in the list, sorted after M1');
    const allZero = sortKpiRows(treePeople.filter(p => p.managerEmployeeId === 'EMP-H'), 'todayCollection');
    assert.equal(allZero.length, 2, 'sorting never filters, even when values tie');
  });
});

/* ================================================================ */
/* 2–5. HTTP — overview, leaf lists, scoping, export                 */
/* ================================================================ */

describe('new KPI cards — HTTP endpoints (production shape + activities)', () => {
  let pool: any;
  let app: express.Express;
  let headToken: string;
  let tlToken: string;
  let memToken: string;
  let nogToken: string;
  let memRoleId: string;

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
    // PRODUCTION shape: current_status, next_follow_up_at, is_deleted,
    // created_at, assigned_to a UUID FK → users(id) (migration 014),
    // the legacy status_history JSONB column — and deliberately NO
    // bare `status` column.
    await pool.query(`
      CREATE TABLE leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_code VARCHAR(50),
        customer_name VARCHAR(255),
        mobile VARCHAR(30),
        current_status VARCHAR(255),
        assigned_to UUID REFERENCES users(id),
        created_by UUID REFERENCES users(id),
        next_follow_up_at TIMESTAMP,
        status_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Migration 037 shape (verbatim, minus the follow_up_count ALTER
    // the no-action predicate never reads).
    await pool.query(`
      CREATE TABLE lead_activities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
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
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
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
    const umRoleId = await mkRole('UM', 5, 'Own');
    memRoleId = await mkRole('RO', 6, 'Own');
    const nogRole = await mkRole('NOG', 6, 'Own');
    const hash = await bcrypt.hash('password123', 10);
    const mkUser = async (emp: string, roleId: string, managerId: string | null) => {
      const r: any = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [emp, `Name ${emp}`, `${emp.toLowerCase()}@test.com`, hash, roleId, deptId, managerId]
      );
      return { id: r.rows[0].id, employeeId: emp, email: `${emp.toLowerCase()}@test.com`, name: `Name ${emp}` };
    };
    const head = await mkUser('NHEAD', headRole, null);
    const tl = await mkUser('NTL', umRoleId, head.id);
    const mem = await mkUser('NMEM', memRoleId, tl.id);
    const sib = await mkUser('NSIB', umRoleId, head.id);
    const smem = await mkUser('NSMEM', memRoleId, sib.id);
    const out = await mkUser('NOUT', memRoleId, null);
    const nog = await mkUser('NNOG', nogRole, null);
    headToken = jwt.sign({ ...head, role: 'BH' }, JWT_SECRET, { expiresIn: '1h' });
    tlToken = jwt.sign({ ...tl, role: 'UM' }, JWT_SECRET, { expiresIn: '1h' });
    memToken = jwt.sign({ ...mem, role: 'RO' }, JWT_SECRET, { expiresIn: '1h' });
    nogToken = jwt.sign({ ...nog, role: 'NOG' }, JWT_SECRET, { expiresIn: '1h' });

    const viewPerm: any = await pool.query(
      `INSERT INTO permissions (permission_code, permission_name) VALUES ('leads.view', 'View leads') RETURNING id`
    );
    const exportPerm: any = await pool.query(
      `INSERT INTO permissions (permission_code, permission_name) VALUES ('leads.export', 'Export leads') RETURNING id`
    );
    const grant = async (roleId: string, permId: string) => {
      await pool.query(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE)`, [roleId, permId]);
    };
    await grant(headRole, viewPerm.rows[0].id);
    await grant(headRole, exportPerm.rows[0].id);
    await grant(umRoleId, viewPerm.rows[0].id);
    await grant(memRoleId, viewPerm.rows[0].id);

    // ---- Time anchors (all relative to the same `now`) ----
    const now = new Date();
    const bounds = getDhakaBusinessDayBounds(now);
    const t0 = bounds.todayStart.getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const old50h = iso(now.getTime() - 50 * 3600_000);
    const past48 = iso(now.getTime() - 48 * 3600_000 - 60_000); // 1 min past the cutoff
    const inside48 = iso(now.getTime() - 48 * 3600_000 + 60_000); // 1 min inside it
    const recent10h = iso(now.getTime() - 10 * 3600_000);
    const old5d = iso(now.getTime() - 5 * 24 * 3600_000);
    const old60h = iso(now.getTime() - 60 * 3600_000);
    const todayPlus30m = iso(t0 + 30 * 60_000);
    const todayPlus45m = iso(t0 + 45 * 60_000);
    const todayPlus2h = iso(t0 + 2 * 3600_000);
    const todayStartExact = bounds.todayStartIso;
    const beforeToday = iso(t0 - 1000);
    const yesterday = iso(t0 - 3600_000);
    const overdueAt = iso(t0 - 26 * 3600_000);

    const mkLead = async (
      name: string,
      assignedTo: string,
      status: string,
      createdAt: string,
      nextFollowUpAt: string | null,
      opts: { deleted?: boolean; history?: unknown[] } = {}
    ): Promise<string> => {
      const r: any = await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at, status_history, is_deleted, created_at)
         VALUES ($1, $2, '01700000000', $3, $4, $4, $5, $6::jsonb, $7, $8) RETURNING id`,
        [`LC-${name.replace(/[^A-Za-z0-9]/g, '')}`, name, status, assignedTo, nextFollowUpAt,
          JSON.stringify(opts.history ?? []), Boolean(opts.deleted), createdAt]
      );
      return r.rows[0].id;
    };
    const mkActivity = async (leadId: string, status: string) => {
      await pool.query(
        `INSERT INTO lead_activities (lead_id, activity_type, status, remarks) VALUES ($1, 'follow_up', $2, 'first contact')`,
        [leadId, status]
      );
    };

    // NMEM (14 leads): total 13, today 3, noAction 2, open 11,
    // converted 2, dueToday 0, overdue 1.
    await mkLead('NA Old Untouched', mem.id, 'New', old50h, null); // noAction
    await mkLead('NA Boundary Past', mem.id, 'Interested', past48, null); // noAction (1 min past 48h)
    await mkLead('NA Boundary Inside', mem.id, 'Interested', inside48, null); // NOT noAction (1 min inside 48h)
    await mkLead('NA Recent Untouched', mem.id, 'New', recent10h, null); // NOT noAction (recent)
    const withActivity = await mkLead('NA With Activity', mem.id, 'Interested', old50h, null);
    await mkActivity(withActivity, 'Interested'); // NOT noAction: an activity row exists
    await mkLead('NA Legacy History', mem.id, 'Follow-up Set', old50h, null,
      { history: [{ status: 'Contacted', at: old50h }] }); // NOT noAction: legacy history counts
    await mkLead('NA Terminal Old', mem.id, 'Converted', old5d, null); // NOT noAction: terminal
    await mkLead('NA Deleted Old', mem.id, 'New', old5d, null, { deleted: true }); // excluded everywhere
    await mkLead('NA Today Fresh', mem.id, 'New', todayPlus30m, null); // today
    await mkLead('NA Today Converted', mem.id, 'Converted', todayPlus45m, null); // today (terminal included)
    await mkLead('NA Yesterday', mem.id, 'Interested', yesterday, null); // NOT today
    await mkLead('NA Today Boundary', mem.id, 'New', todayStartExact, null); // today (inclusive start)
    await mkLead('NA Before Today', mem.id, 'New', beforeToday, null); // NOT today (1s before start)
    const overdueOld = await mkLead('NA Overdue Old', mem.id, 'Interested', old50h, overdueAt);
    await mkActivity(overdueOld, 'Interested'); // overdue, NOT noAction

    // NTL: total 2, today 1, noAction 1.
    await mkLead('TL Old Untouched', tl.id, 'New', old60h, null);
    await mkLead('TL Today', tl.id, 'New', todayPlus2h, null);
    // NSMEM (sibling subtree, visible to the head only): noAction 1.
    await mkLead('SMEM Old Untouched', smem.id, 'New', old60h, null);
    // NOUT (outside the head's subtree): for the 404 pins.
    await mkLead('OUT Old Untouched', out.id, 'New', old60h, null);
    // NSIB deliberately has NO leads: the never-empty pin — a
    // zero-count person who must still be listed with 0s.

    const mod = await import('../routes/production.routes.js');
    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', mod.default);
  });

  const overview = (token: string) =>
    request(app).get('/api/team/overview').set('Authorization', `Bearer ${token}`);
  const kpiLeads = (token: string, kpi: string, person: string) =>
    request(app).get(`/api/team/kpi/leads?kpi=${kpi}&person=${encodeURIComponent(person)}`).set('Authorization', `Bearer ${token}`);

  /* ---------------- overview counts ---------------- */

  it('precondition: the fixture leads.assigned_to is a UUID FK (production shape)', async () => {
    // Hotfix 2026-11-13: this fixture used to declare assigned_to
    // VARCHAR(30) and store employee IDs, so every KPI test passed
    // here while production (UUID FK → users.id, migration 014)
    // 500d with "function upper(uuid) does not exist" on every leaf
    // list and export, and read every count as 0. Pin the true
    // shape — with it, the counts/leaf/export tests below are the
    // regression pins for that failure.
    const cols: any = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'leads' AND column_name IN ('assigned_to', 'created_by')`
    );
    const byName = new Map(cols.rows.map((r: any) => [r.column_name, r.data_type]));
    assert.equal(byName.get('assigned_to'), 'uuid', 'assigned_to is uuid (migration 014), not VARCHAR');
    assert.equal(byName.get('created_by'), 'uuid', 'created_by is uuid (migration 014), not VARCHAR');
  });

  it('overview carries the three new counts, exact', async () => {
    const res = await overview(headToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mem = (res.body.people as any[]).find(p => p.employeeId === 'NMEM');
    assert.ok(mem, 'member listed for the head');
    assert.equal(mem.totalLeads, 13, 'every non-deleted lead, terminal included, deleted excluded');
    assert.equal(mem.todayLeads, 3, 'today-start inclusive, 1s-before excluded, terminal included');
    assert.equal(mem.noActionLeads, 2, 'only the two untouched old leads');
    assert.equal(mem.openLeads, 11, 'the old counts are untouched by the new keys');
    assert.equal(mem.convertedLeads, 2);
    assert.equal(mem.dueToday, 0);
    assert.equal(mem.overdue, 1);

    const tl = (res.body.people as any[]).find(p => p.employeeId === 'NTL');
    assert.equal(tl.totalLeads, 2);
    assert.equal(tl.todayLeads, 1);
    assert.equal(tl.noActionLeads, 1);
  });

  it('a zero-count person is still listed with 0s (never-empty rule)', async () => {
    const res = await overview(headToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sib = (res.body.people as any[]).find(p => p.employeeId === 'NSIB');
    assert.ok(sib, 'NSIB has no leads at all and must still appear');
    assert.equal(sib.totalLeads, 0);
    assert.equal(sib.todayLeads, 0);
    assert.equal(sib.noActionLeads, 0);
    assert.equal(sib.openLeads, 0);
  });

  /* ---------------- leaf lists ---------------- */

  it('totalLeads: every non-deleted lead, terminal included, deleted excluded', async () => {
    const res = await kpiLeads(headToken, 'totalLeads', 'NMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 13);
    const names = res.body.items.map((l: any) => l.customerName).sort();
    assert.ok(names.includes('NA Terminal Old') && names.includes('NA Today Converted'),
      'terminal leads count toward Total Lead');
    assert.ok(!names.includes('NA Deleted Old'), 'deleted leads never count');
  });

  it('todayCollection: only leads created within the Dhaka day', async () => {
    const res = await kpiLeads(headToken, 'todayCollection', 'NMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 3);
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName).sort(),
      ['NA Today Boundary', 'NA Today Converted', 'NA Today Fresh'],
      'inclusive start (exact todayStart counts), 1s-before and yesterday excluded, terminal included'
    );
  });

  it('noAction: open + older than 48h + zero recorded actions — boundary both sides', async () => {
    const res = await kpiLeads(headToken, 'noAction', 'NMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.deepEqual(
      res.body.items.map((l: any) => l.customerName),
      ['NA Old Untouched', 'NA Boundary Past'],
      'oldest first; the 1-min-past-boundary lead counts, the 1-min-inside one does not'
    );
    const names = res.body.items.map((l: any) => l.customerName);
    assert.ok(!names.includes('NA Boundary Inside'), '48h minus 1 minute is not yet no-action');
    assert.ok(!names.includes('NA Recent Untouched'), 'a 10-hour-old lead is not no-action');
    assert.ok(!names.includes('NA With Activity'), 'one lead_activities row is an action');
    assert.ok(!names.includes('NA Legacy History'), 'a non-empty legacy status_history is an action');
    assert.ok(!names.includes('NA Terminal Old'), 'terminal leads are never no-action');
    assert.ok(!names.includes('NA Deleted Old'), 'deleted leads are never no-action');
    assert.ok(!names.includes('NA Overdue Old'), 'an acted-on overdue lead is not no-action');
  });

  it('leaf rows carry the entry date (createdAt) for the new KPIs', async () => {
    const res = await kpiLeads(headToken, 'noAction', 'NMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const item of res.body.items) {
      assert.ok(typeof item.createdAt === 'string' && item.createdAt.length > 0,
        'the page shows "Entered <date>" for No Action rows');
      assert.ok(!Number.isNaN(new Date(item.createdAt).getTime()), 'createdAt is a parseable ISO instant');
    }
  });

  it('card-count == drill-down-row-count for ALL SEVEN KPIs, for two people', async () => {
    const ov = await overview(headToken);
    assert.equal(ov.status, 200, JSON.stringify(ov.body));
    const field: Record<string, string> = {
      open: 'openLeads', dueToday: 'dueToday', overdue: 'overdue', converted: 'convertedLeads',
      totalLeads: 'totalLeads', todayCollection: 'todayLeads', noAction: 'noActionLeads',
    };
    for (const emp of ['NMEM', 'NTL']) {
      const row = (ov.body.people as any[]).find(p => p.employeeId === emp);
      assert.ok(row, `${emp} listed`);
      for (const kpi of Object.keys(field)) {
        const res = await kpiLeads(headToken, kpi, emp);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.total, row[field[kpi]],
          `${emp} ${kpi}: leaf total must equal the overview count (${row[field[kpi]]})`);
      }
    }
  });

  /* ---------------- scoping for the new keys ---------------- */

  it('a member sees ONLY their own leads for the new keys', async () => {
    const res = await kpiLeads(memToken, 'noAction', 'self');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 2);
    assert.ok(res.body.items.every((l: any) => l.customerName.startsWith('NA ')),
      'no other member\'s no-action leads leak in');
    const total = await kpiLeads(memToken, 'totalLeads', 'self');
    assert.equal(total.status, 200, JSON.stringify(total.body));
    assert.equal(total.body.total, 13);
  });

  it('out-of-scope and unpermitted callers are refused for the new keys', async () => {
    assert.equal((await kpiLeads(memToken, 'noAction', 'NTL')).status, 404, 'member -> manager');
    assert.equal((await kpiLeads(memToken, 'totalLeads', 'NSMEM')).status, 404, 'member -> sibling subtree');
    assert.equal((await kpiLeads(headToken, 'noAction', 'NOUT')).status, 404, 'head -> outside subtree');
    assert.equal((await kpiLeads(nogToken, 'noAction', 'self')).status, 403, 'no leads.view');
    assert.equal((await kpiLeads(headToken, 'bogus', 'NMEM')).status, 400, 'unknown KPI');
  });

  /* ---------------- export ---------------- */

  const kpiExport = (token: string, query: string) =>
    request(app)
      .get(`/api/team/kpi/export${query}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res: any, cb: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: any) => chunks.push(Buffer.from(c)));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const kpiExportJson = (token: string, query: string) =>
    request(app).get(`/api/team/kpi/export${query}`).set('Authorization', `Bearer ${token}`);

  const readWorkbook = async (buf: Buffer) => {
    const ExcelJS = (await import('exceljs')).default as any;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb.getWorksheet('KPI Export');
  };

  const sheetRows = (ws: any): any[][] => {
    const rows: any[][] = [];
    ws.eachRow({ includeEmpty: true }, (row: any) => {
      rows.push((row.values as any[]).slice(1));
    });
    return rows;
  };

  it('export at a people level carries the new KPI — zero rows included', async () => {
    const res = await kpiExport(headToken, '?kpi=noAction');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const ws = await readWorkbook(res.body as Buffer);
    const rows = sheetRows(ws);
    assert.deepEqual(rows[3], ['Name', 'Employee ID', 'Designation', 'No Action Alert']);
    // HEAD's direct reports, KPI desc: TL (1) before SIB (0) — the
    // zero row is in the file, exactly as on the page.
    assert.deepEqual(rows.slice(4).map(r => [r[1], r[3]]), [['NTL', 1], ['NSIB', 0]]);

    const total = await kpiExport(headToken, '?kpi=totalLeads');
    assert.equal(total.status, 200, JSON.stringify(total.body).slice(0, 200));
    const totalRows = sheetRows(await readWorkbook(total.body as Buffer));
    assert.deepEqual(totalRows.slice(4).map(r => [r[1], r[3]]), [['NTL', 2], ['NSIB', 0]]);
  });

  it('export at a leaf level carries the new KPI\'s lead rows', async () => {
    const res = await kpiExport(headToken, '?kpi=noAction&person=NMEM');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const ws = await readWorkbook(res.body as Buffer);
    assert.deepEqual(
      sheetRows(ws).slice(4).map(r => r[1]).sort(),
      ['NA Boundary Past', 'NA Old Untouched']
    );
  });

  it('export of an ALL-ZERO level still lists every person row', async () => {
    // SIB's team (SMEM) has 0 converted leads: the file must still
    // carry SMEM with 0 — the export is never a blank sheet.
    const res = await kpiExport(headToken, '?kpi=converted&person=NSIB');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    const ws = await readWorkbook(res.body as Buffer);
    assert.deepEqual(sheetRows(ws).slice(4).map(r => [r[1], r[3]]), [['NSMEM', 0]]);
  });

  it('a member without the grant cannot export the new KPIs', async () => {
    const res = await kpiExportJson(memToken, '?kpi=noAction&person=self');
    assert.equal(res.status, 403, 'no grant, no export — even of their own no-action data');
  });

  /* ---------------- degraded schema (MUST RUN LAST) ----------------
     This test DROPS lead_activities and the status_history column:
     the probe must degrade the no-action predicate to open + older
     than 48h (no actions can be proven without the tables) instead
     of 500ing the overview. It is the LAST HTTP test in this file
     by definition order — nothing after it touches the endpoints. */

  it('degraded schema: without the activity/history tables the overview still answers 200', async () => {
    await pool.query('DROP TABLE IF EXISTS lead_activities');
    await pool.query('ALTER TABLE leads DROP COLUMN IF EXISTS status_history');
    const res = await overview(headToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mem = (res.body.people as any[]).find(p => p.employeeId === 'NMEM');
    assert.ok(mem, 'member still listed');
    // Without the tables, the acted-on leads (With Activity, Legacy
    // History, Overdue Old) can no longer be excluded: 5 old open
    // leads count as no-action. The other counts are untouched.
    assert.equal(mem.noActionLeads, 5, 'degraded: open + older than 48h, nothing else provable');
    assert.equal(mem.totalLeads, 13, 'total is unaffected by the missing tables');
    assert.equal(mem.todayLeads, 3, 'today is unaffected by the missing tables');
    const leaf = await kpiLeads(headToken, 'noAction', 'NMEM');
    assert.equal(leaf.status, 200, JSON.stringify(leaf.body));
    assert.equal(leaf.body.total, 5, 'the leaf list degrades identically — card still equals rows');
  });
});

/* ================================================================ */
/* 6. Rendering (SSR, repo style) — the never-empty rule             */
/* ================================================================ */

describe('new KPI cards — rendering (never-empty rule)', () => {
  const noop = () => {};
  const renderContent = (props: {
    level: import('../../src/modules/team/utils/kpiDrilldown').KpiLevel;
    kpi: 'open' | 'dueToday' | 'overdue' | 'converted' | 'totalLeads' | 'todayCollection' | 'noAction' | null;
    leads?: KpiLeadsResponse | null;
    leadsLoading?: boolean;
  }) =>
    renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TeamKpiDrilldownContent, {
          level: props.level,
          kpi: props.kpi,
          leads: props.leads ?? null,
          leadsLoading: props.leadsLoading ?? false,
          leadsError: null,
          leadsNotFound: false,
          canExport: false,
          exporting: false,
          exportError: null,
          onExport: noop,
          onRetryLeads: noop,
        })
      )
    );

  it('an ALL-ZERO people level still lists every name with 0s + the line', () => {
    // Everyone at 0 for noAction: TL2's team (M3 only).
    const allZeroPeople = treePeople.map(p => ({ ...p, noActionLeads: 0 }));
    const level = resolveKpiLevel(teamOverview(allZeroPeople, 'Team'), 'noAction', 'EMP-T2');
    const html = renderContent({ level, kpi: 'noAction' });
    assert.ok(html.includes('Mira Member') && html.includes('EMP-M3'),
      'the one report is listed even at 0');
    assert.ok(html.includes('0 no action'), 'the 0 value rides on the row');
    assert.ok(html.includes('No leads for this KPI yet'), 'the all-zero line says so plainly');
    assert.ok(html.includes('1 person'), 'the header counts the person, not the leads');
  });

  it('a zero leaf shows the person (name + employee ID), the 0 count, and the message', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'noAction', 'EMP-M2');
    const leads: KpiLeadsResponse = { success: true, kpi: 'noAction', employeeId: 'EMP-M2', total: 0, items: [] };
    const html = renderContent({ level, kpi: 'noAction', leads });
    assert.ok(html.includes('Musa Member'), 'the person heads the page');
    assert.ok(html.includes('EMP-M2'), 'the employee ID rides in the header');
    assert.ok(html.includes('0 leads'), 'the 0 count is shown, not hidden');
    assert.ok(html.includes('No leads for this KPI'), 'the clear no-leads message');
    assert.ok(!html.includes('Person not found'), 'zero data is not a not-found');
  });

  it('a noAction leaf row shows the entry date', () => {
    const level = resolveKpiLevel(teamOverview(treePeople, 'Team'), 'noAction', 'EMP-M1');
    const leads: KpiLeadsResponse = {
      success: true,
      kpi: 'noAction',
      employeeId: 'EMP-M1',
      total: 1,
      items: [
        { id: 'lead-1', leadCode: 'LC-1', customerName: 'Karim Uddin', mobile: '01700000001', currentStatus: 'New', nextFollowUpAt: null, createdAt: '2026-11-10T00:00:00.000Z' },
      ],
    };
    const html = renderContent({ level, kpi: 'noAction', leads });
    assert.ok(html.includes('Karim Uddin'), 'the lead is listed');
    assert.ok(html.includes('Entered 10 Nov 2026'), 'the entry date renders in Dhaka');
  });

  it('Team Home renders all seven cards — No Action Alert as an alert', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(TeamHomeContent, { people: treePeople, scope: 'Team' })
      )
    );
    for (const kpi of ['totalLeads', 'todayCollection', 'noAction']) {
      assert.ok(html.includes(`href="/team/kpi/${kpi}"`), `the ${kpi} card links to its drill-down`);
    }
    assert.ok(html.includes('No Action Alert'), 'the alert card is labelled');
    assert.ok(html.includes('Total Lead') && html.includes('Today Lead Collection'), 'the new cards are labelled');
    // Totals render even at 0: the all-zero member's team still shows
    // every card (checked via the labels above, not hidden cards).
  });
});

/* ================================================================ */
/* 7. Source guards                                                  */
/* ================================================================ */

describe('new KPI cards — source guards', () => {
  it('the overview counts and the leaf list share ONE predicate module', () => {
    const users = read('server/routes/production/users.routes.ts');
    assert.ok(users.includes("from '../../services/teamKpiDefinitions.js'"),
      'the route imports the shared definitions');
    assert.ok(users.includes('kpiLeadPredicate('), 'both the counts query and the leaf query build from it');
    assert.ok(!users.includes('lead_activities la'),
      'the no-action subquery lives ONLY in the definitions module — no inline duplicate');
    const defs = read('server/services/teamKpiDefinitions.ts');
    assert.ok(defs.includes('NO_ACTION_WINDOW_MS = 48 * 3600 * 1000'), 'the 48h window is one named constant');
    assert.ok(defs.includes('lead_activities'), 'activities count as an action');
    assert.ok(defs.includes('status_history'), 'legacy history counts as an action');
    assert.ok(defs.includes('probeNoActionSupport'), 'the minimal-schema probe exists');
    assert.ok(defs.includes('information_schema'), 'the probe reads information_schema (DZ-1 precedent)');
  });

  it('no count-filter exists anywhere in the drill-down path', () => {
    const helper = read('src/modules/team/utils/kpiDrilldown.ts');
    const sortStart = helper.indexOf('export function sortKpiRows');
    const sortEnd = helper.indexOf('\n}', sortStart);
    const sortBody = helper.slice(sortStart, sortEnd);
    assert.ok(!sortBody.includes('.filter('), 'sortKpiRows sorts — it never drops a row');
    const page = read('src/modules/team/pages/TeamKpiDrilldown.tsx');
    assert.ok(page.includes('level.rows.map('), 'the people level maps every row');
    assert.ok(!page.includes('level.rows.filter('), 'no row is filtered out of the people level');
    assert.ok(page.includes('No leads for this KPI yet'), 'the all-zero line exists');
  });

  it('the demo fallback documents its no-action proxy', () => {
    const users = read('server/routes/production/users.routes.ts');
    assert.ok(users.includes('no activity ledger exists in the'), 'the demo proxy (no activity ledger) is documented in code');
  });
});
