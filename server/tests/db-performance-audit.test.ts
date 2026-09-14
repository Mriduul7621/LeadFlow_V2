/**
 * db-performance-audit.test.ts — evidence-based index & query-shape audit
 * ------------------------------------------------------------------
 * Proves the database performance hardening (docs/DATABASE_PERFORMANCE_AUDIT.md):
 *
 *   SCHEMA (full migration suite on isolated PGlite)
 *    1. migrations are idempotent (run twice, both green)
 *    2. the new partial index idx_scheduled_activities_open_lead exists
 *    3. every critical hot-path index exists after migrations
 *    4. no duplicate index definitions
 *    5. critical uniqueness constraints remain (users/leads/notifications)
 *    6. the PR #40/#44 notification idempotency UNIQUE partial index remains
 *
 *   RESULT-SET EQUIVALENCE (synthetic data — legacy vs shipped SQL)
 *    7. visibility scoping: ::text casts vs uuid ANY return identical leads
 *    8. follow-up queue rows/counts/order identical before/after
 *    9. queue assignedTo filter identical + uses the 038 partial index
 *   10. lead quality planned-action signals identical (LOWER vs equality)
 *   11. scheduled list type/status filters identical (CHECK domain)
 *   12. notification user queries identical with the redundant branch gone
 *   13. pagination ordering unchanged (ORDER BY next_follow_up_at ASC)
 *   14. hierarchy visibility unchanged (recursive CTE == BFS ground truth)
 *   15. lead assignment/reassignment flips queue membership correctly
 *
 *   PLAN EVIDENCE (PGlite EXPLAIN)
 *   16. queue assignedTo plan uses idx_leads_assigned_next_follow_up_active
 *   17. visibility scope plan is index-driven (no leads seq scan)
 *   18. quality signals plan uses idx_scheduled_activities_open_lead
 *   19. notification list plan is index-driven (no notifications seq scan)
 *
 *   NO N+1
 *   20. quality aggregation stays at a constant number of queries
 *
 *   SOURCE GUARDS (query-shape regression)
 *   21. no ::text casts remain on visibility / assignedTo hot predicates
 *   22. notification queries keep the redundant ::text branch removed
 *   23. lead quality uses sargable status equality
 *
 * RBAC / Data Visibility semantics, notification atomicity, observability
 * and production-readiness behavior remain the contract of their own
 * suites, which must stay green alongside this one.
 *
 * NOTE: PGlite is real PostgreSQL semantics but different cost calibration
 * than Supabase — timing claims are never asserted here; only plan shape
 * and exact result-set equality.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { runMigrations } from '../database/runMigrations.js';
import {
  fetchActivityQualitySignals,
  fetchScheduledQualitySignals,
  aggregateQualityForScope,
} from '../utils/leadQualitySignals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const TERMINAL = ['Converted', 'Not Interested'];
const ACTIVE = ['Untouched', 'Contacted', 'No Response', 'Busy', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked'];

/* ====================================================================
   Shared isolated database
==================================================================== */

describe('Database performance audit — migrations, indexes, query shapes', () => {
  let pool: any;

  const users: Array<{ id: string; employeeId: string; managerId: string | null; dept: number }> = [];
  const leads: Array<{
    id: string; leadCode: string; assignedTo: string | null; createdBy: string;
    status: string; nextFu: string | null; createdAt: string;
  }> = [];

  const now = Date.now();
  const iso = (offsetDays: number, hourShift = 0) =>
    new Date(now + offsetDays * 86400000 + hourShift * 3600000).toISOString();

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    // Full production migration suite, twice — proves idempotent re-run.
    await runMigrations();
    await runMigrations();

    /* ---- synthetic org: 3 departments, shallow manager trees ---- */
    const roles = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility)
       VALUES ('ADMIN', 'Administrator', 0, 'Organization'),
              ('MANAGER', 'Manager', 3, 'DownTeam'),
              ('EMPLOYEE', 'Employee', 5, 'Own')
       RETURNING id, role_code`
    );
    const roleByCode = new Map<string, string>(
      roles.rows.map((r: any) => [String(r.role_code), String(r.id)] as [string, string])
    );

    const depts: string[] = [];
    for (let d = 0; d < 3; d++) {
      const r = await pool.query(
        `INSERT INTO departments (department_code, department_name) VALUES ($1, $2) RETURNING id`,
        ['D' + d, 'Dept ' + d]
      );
      depts.push(r.rows[0].id);
    }

    const mkUser = async (emp: string, roleId: string, dept: string, managerId: string | null) => {
      const r = await pool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'x', $4, $5, $6, TRUE) RETURNING id`,
        [emp, 'Name ' + emp, emp.toLowerCase() + '@test.local', roleId, dept, managerId]
      );
      const id = r.rows[0].id;
      users.push({ id, employeeId: emp, managerId, dept: Number(emp.slice(-1)) % 3 });
      return id;
    };

    // 3 managers, each with 5 direct reports (who each have 2 reports).
    const managerIds: string[] = [];
    for (let m = 0; m < 3; m++) {
      managerIds.push(await mkUser('MGR' + m, roleByCode.get('MANAGER')!, depts[m], null));
    }
    for (let m = 0; m < 3; m++) {
      for (let e = 0; e < 5; e++) {
        const empId = await mkUser(`EMP${m}${e}`, roleByCode.get('EMPLOYEE')!, depts[m], managerIds[m]);
        for (let g = 0; g < 2; g++) {
          await mkUser(`SUB${m}${e}${g}`, roleByCode.get('EMPLOYEE')!, depts[m], empId);
        }
      }
    }

    /* ---- synthetic leads: assignment spread across the org ----
       Batched multi-row inserts; volume chosen so the PGlite planner's
       index-vs-seq-scan decisions mirror real PostgreSQL behavior. */
    const assignables = users.map(u => u.id);
    const LEAD_COUNT = 12000;
    const BATCH = 1500;
    for (let start = 0; start < LEAD_COUNT; start += BATCH) {
      const vals: string[] = [];
      const params: any[] = [];
      for (let i = start; i < Math.min(start + BATCH, LEAD_COUNT); i++) {
        const assigned = i % 5 === 0 ? null : assignables[i % assignables.length];
        const creator = assignables[(i * 7 + 3) % assignables.length];
        const status = i % 4 === 0 ? TERMINAL[i % TERMINAL.length] : ACTIVE[i % ACTIVE.length];
        const nextFu = i % 3 === 0 ? null : iso((i % 20) - 5, i % 24);
        const createdAt = iso(-(i % 60));
        params.push(`LC${i}`, `Customer ${i}`, `0171${String(10000000 + i)}`, status, assigned, creator, nextFu, createdAt);
        const o = params.length;
        vals.push(`($${o - 7},$${o - 6},$${o - 5},$${o - 4},$${o - 3},$${o - 2},$${o - 1},$${o},FALSE)`);
        leads.push({
          id: '', // backfilled from RETURNING below
          leadCode: `LC${i}`,
          assignedTo: assigned,
          createdBy: creator,
          status,
          nextFu,
          createdAt,
        });
      }
      const r = await pool.query(
        `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, next_follow_up_at, created_at, is_deleted)
         VALUES ${vals.join(',')} RETURNING id`,
        params
      );
      r.rows.forEach((row: any, idx: number) => { leads[start + idx].id = String(row.id); });
    }
    // A soft-deleted row that must NEVER surface.
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, current_status, assigned_to, created_by, is_deleted)
       VALUES ('DEL1', 'Deleted One', '01719999999', 'Untouched', $1, $1, TRUE)`,
      [assignables[0]]
    );

    /* ---- synthetic scheduled activities: open + history per lead ---- */
    const saTypes = ['call', 'meeting', 'follow_up', 'task'];
    const saStatuses = ['scheduled', 'scheduled', 'completed', 'cancelled'];
    for (let start = 0; start < leads.length; start += BATCH) {
      const vals: string[] = [];
      const params: any[] = [];
      for (let i = start; i < Math.min(start + BATCH, leads.length); i += 2) {
        for (let k = 0; k < 3; k++) {
          params.push(leads[i].id, saTypes[(i + k) % 4], `SA ${i}-${k}`, iso((i % 10) - 2 + k, k), saStatuses[(i + k) % saStatuses.length], leads[i].assignedTo);
          const o = params.length;
          vals.push(`($${o - 5},$${o - 4},$${o - 3},$${o - 2},$${o - 1},$${o})`);
        }
      }
      if (vals.length) {
        await pool.query(
          `INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, assigned_to)
           VALUES ${vals.join(',')}`,
          params
        );
      }
    }

    /* ---- synthetic lead activities (quality history) ---- */
    const actStatuses = ['No Response', 'Interested', 'Contacted', 'Meeting Fixed', 'Unreachable', 'Converted'];
    for (let start = 0; start < leads.length; start += BATCH) {
      const vals: string[] = [];
      const params: any[] = [];
      for (let i = start; i < Math.min(start + BATCH, leads.length); i += 3) {
        for (let k = 0; k < 2; k++) {
          params.push(leads[i].id, actStatuses[(i + k) % actStatuses.length], `r${i}-${k}`, iso(-(k + 1), i % 12));
          const o = params.length;
          vals.push(`($${o - 3},'follow_up',$${o - 2},$${o - 1},$${o})`);
        }
      }
      if (vals.length) {
        await pool.query(
          `INSERT INTO lead_activities (lead_id, activity_type, status, remarks, created_at)
           VALUES ${vals.join(',')}`,
          params
        );
      }
    }

    /* ---- synthetic notifications (uuid-keyed + employee-keyed rows) ---- */
    const NOTIF_COUNT = 4000;
    const empById = new Map(users.map((u) => [u.id, u.employeeId]));
    for (let start = 0; start < NOTIF_COUNT; start += BATCH) {
      const vals: string[] = [];
      const params: any[] = [];
      for (let i = start; i < Math.min(start + BATCH, NOTIF_COUNT); i++) {
        const u = assignables[i % assignables.length];
        params.push(u, empById.get(u) || null, `T${i}`, `M${i}`, i % 2 === 0, iso(-(i % 9), i % 12));
        const o = params.length;
        vals.push(`($${o - 5},$${o - 4},$${o - 3},$${o - 2},'info',$${o - 1},$${o})`);
      }
      await pool.query(
        `INSERT INTO notifications (user_id, recipient_key, title, message, type, is_read, created_at)
         VALUES ${vals.join(',')}`,
        params
      );
    }

    await pool.query(`ANALYZE leads`);
    await pool.query(`ANALYZE scheduled_activities`);
    await pool.query(`ANALYZE lead_activities`);
    await pool.query(`ANALYZE notifications`);
  });

  after(async () => {
    try { await closePool(); } catch { /* ignore */ }
    _resetPoolsForTest();
    resetPGlite();
  });

  /* ==================================================================
     SCHEMA: migrations idempotent + index inventory
  ================================================================== */

  it('1. migration suite is idempotent (ran twice in setup without error)', async () => {
    // A third run must also be a no-op success (cold-start behavior).
    await runMigrations();
    const t = await pool.query(`SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public' AND table_name='leads'`);
    assert.equal(Number(t.rows[0].c), 1);
  });

  it('2. migration 041 created the partial open-activity index', async () => {
    const r = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_scheduled_activities_open_lead'`);
    assert.equal(r.rows.length, 1, 'idx_scheduled_activities_open_lead must exist');
    const def = String(r.rows[0].indexdef);
    assert.ok(def.includes('lead_id, scheduled_at'), `index must cover (lead_id, scheduled_at): ${def}`);
    assert.ok(/WHERE.*status.*=.*'scheduled'/.test(def), `index must be partial on status='scheduled': ${def}`);
  });

  it('3. all critical hot-path indexes exist after migrations', async () => {
    const critical = [
      'idx_leads_assigned_to',
      'idx_leads_created_by',
      'idx_leads_created_at',
      'idx_leads_next_follow_up_active',
      'idx_leads_assigned_next_follow_up_active',
      'idx_leads_current_status',
      'idx_lead_activities_lead_created_at',
      'idx_scheduled_activities_lead_scheduled',
      'idx_scheduled_activities_scheduled_at',
      'idx_scheduled_activities_open_lead',
      'idx_users_manager',
      'idx_users_department',
      'idx_users_role',
      'idx_notification_user',
      'idx_notifications_recipient_key',
      'idx_audit_logs_created',
    ];
    const r = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`);
    const present = new Set(r.rows.map((x: any) => String(x.indexname)));
    const missing = critical.filter((i) => !present.has(i));
    assert.deepEqual(missing, [], `missing critical indexes: ${missing.join(', ')}`);
  });

  it('4. no duplicate index definitions (same table + definition under two names)', async () => {
    const r = await pool.query(
      `SELECT tablename, indexdef, COUNT(*)::int AS c
         FROM pg_indexes WHERE schemaname='public'
        GROUP BY tablename, indexdef HAVING COUNT(*) > 1`
    );
    assert.deepEqual(r.rows, [], `duplicate index definitions found: ${JSON.stringify(r.rows)}`);
  });

  it('5. critical uniqueness constraints remain intact', async () => {
    // users.employee_id / users.email / leads.lead_code unique constraints
    const uq = await pool.query(
      `SELECT conrelid::regclass::text AS tbl, conname
         FROM pg_constraint
        WHERE contype = 'u'`
    );
    const names = new Set(uq.rows.map((x: any) => `${x.tbl}:${x.conname}`));
    for (const expected of ['users:users_employee_id_key', 'users:users_email_key', 'leads:leads_lead_code_key']) {
      assert.ok(names.has(expected), `unique constraint ${expected} must remain`);
    }
    // composite PKs backing RBAC lookups
    const pk = await pool.query(
      `SELECT conrelid::regclass::text AS tbl FROM pg_constraint WHERE contype='p' AND conrelid::regclass::text IN ('role_permissions','user_permissions')`
    );
    assert.equal(pk.rows.length, 2, 'role_permissions and user_permissions PKs must remain');
  });

  it('6. notification idempotency UNIQUE partial index remains (PR #40/#44)', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_notifications_idempotency_key'`
    );
    assert.equal(r.rows.length, 1);
    const def = String(r.rows[0].indexdef);
    assert.ok(/UNIQUE/i.test(def), 'must stay UNIQUE');
    assert.ok(/idempotency_key IS NOT NULL/.test(def), 'must stay partial on non-null keys');
    // Enforced at the DB level:
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, idempotency_key) VALUES ($1,'a','b','info','dup-key-1')`,
      [users[0].id]
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO notifications (user_id, title, message, type, idempotency_key) VALUES ($1,'a','b','info','dup-key-1')`,
        [users[0].id]
      ),
      /duplicate key|duplicate/i
    );
  });

  /* ==================================================================
     RESULT-SET EQUIVALENCE: legacy vs shipped predicates
  ================================================================== */

  const scopeIds = () => users.slice(0, 8).map((u) => u.id);

  it('7. visibility scoping: text-cast vs uuid ANY return identical leads', async () => {
    const ids = scopeIds();
    const legacy = await pool.query(
      `SELECT id FROM leads l WHERE l.is_deleted = FALSE
        AND (l.assigned_to::text = ANY($1::text[]) OR l.created_by::text = ANY($1::text[]))`,
      [ids]
    );
    const shipped = await pool.query(
      `SELECT id FROM leads l WHERE l.is_deleted = FALSE
        AND (l.assigned_to = ANY($1::uuid[]) OR l.created_by = ANY($1::uuid[]))`,
      [ids]
    );
    const a = legacy.rows.map((r: any) => String(r.id)).sort();
    const b = shipped.rows.map((r: any) => String(r.id)).sort();
    assert.deepEqual(b, a, 'uuid ANY must match exactly the legacy text-cast rows');
    assert.ok(a.length > 0, 'scope must be non-trivial for the test to mean anything');
  });

  it('8. follow-up queue rows/counts/order identical before/after', async () => {
    const ids = scopeIds();
    const whereLegacy =
      `l.is_deleted = FALSE AND l.next_follow_up_at IS NOT NULL
       AND l.current_status <> ALL($1::text[])
       AND (l.assigned_to::text = ANY($2::text[]) OR l.created_by::text = ANY($2::text[]))`;
    const whereShipped =
      `l.is_deleted = FALSE AND l.next_follow_up_at IS NOT NULL
       AND l.current_status <> ALL($1::text[])
       AND (l.assigned_to = ANY($2::uuid[]) OR l.created_by = ANY($2::uuid[]))`;
    // lead_code tie-break makes the LIMIT cutoff deterministic for the
    // comparison (production keeps its single-key ordering unchanged).
    const orderBy = ` ORDER BY l.next_follow_up_at ASC, l.lead_code ASC LIMIT 50 OFFSET 0`;
    const legacy = await pool.query(
      `SELECT l.id, l.next_follow_up_at FROM leads l WHERE ${whereLegacy}${orderBy}`, [TERMINAL, ids]);
    const shipped = await pool.query(
      `SELECT l.id, l.next_follow_up_at FROM leads l WHERE ${whereShipped}${orderBy}`, [TERMINAL, ids]);
    assert.deepEqual(
      shipped.rows.map((r: any) => [String(r.id), String(r.next_follow_up_at)]),
      legacy.rows.map((r: any) => [String(r.id), String(r.next_follow_up_at)]),
      'queue page rows and ordering must be byte-identical'
    );
    const cntLegacy = await pool.query(`SELECT COUNT(*)::int c FROM leads l WHERE ${whereLegacy}`, [TERMINAL, ids]);
    const cntShipped = await pool.query(`SELECT COUNT(*)::int c FROM leads l WHERE ${whereShipped}`, [TERMINAL, ids]);
    assert.equal(Number(cntShipped.rows[0].c), Number(cntLegacy.rows[0].c));
  });

  it('9. queue assignedTo filter identical (uuid vs text) for every sampled assignee', async () => {
    const sampled = [...new Set(leads.map((l) => l.assignedTo).filter(Boolean))].slice(0, 12);
    for (const uid of sampled) {
      // lead_code tie-break keeps the LIMIT cutoff deterministic.
      const legacy = await pool.query(
        `SELECT id FROM leads l WHERE l.is_deleted=FALSE AND l.next_follow_up_at IS NOT NULL
          AND l.assigned_to::text = $1 ORDER BY l.next_follow_up_at ASC, l.lead_code ASC LIMIT 50`, [uid]);
      const shipped = await pool.query(
        `SELECT id FROM leads l WHERE l.is_deleted=FALSE AND l.next_follow_up_at IS NOT NULL
          AND l.assigned_to = $1::uuid ORDER BY l.next_follow_up_at ASC, l.lead_code ASC LIMIT 50`, [uid]);
      assert.deepEqual(
        shipped.rows.map((r: any) => String(r.id)),
        legacy.rows.map((r: any) => String(r.id)),
        `assignedTo=${uid} must return identical rows`
      );
    }
  });

  it('10. lead quality planned-action signals identical (LOWER vs equality)', async () => {
    const ids = leads.filter((_, i) => i % 2 === 0).map((l) => l.id);
    const legacy = await pool.query(
      `SELECT s.lead_id::text AS lead_id, MIN(s.scheduled_at) AS next_scheduled_at
         FROM scheduled_activities s
        WHERE s.lead_id = ANY($1::uuid[]) AND LOWER(s.status) = 'scheduled'
        GROUP BY s.lead_id`, [ids]);
    const shipped = await pool.query(
      `SELECT s.lead_id::text AS lead_id, MIN(s.scheduled_at) AS next_scheduled_at
         FROM scheduled_activities s
        WHERE s.lead_id = ANY($1::uuid[]) AND s.status = 'scheduled'
        GROUP BY s.lead_id`, [ids]);
    const norm = (rows: any[]) =>
      rows.map((r: any) => [r.lead_id, String(r.next_scheduled_at)]).sort();
    assert.deepEqual(norm(shipped.rows), norm(legacy.rows));
    // And the shipped bulk helper must agree with the raw legacy SQL.
    const viaHelper = await fetchScheduledQualitySignals(pool, ids);
    for (const row of legacy.rows) {
      assert.equal(
        viaHelper.get(String(row.lead_id))?.nextScheduledAt ?? null,
        row.next_scheduled_at ? new Date(row.next_scheduled_at).toISOString() : null,
        `helper vs legacy SQL mismatch for lead ${row.lead_id}`
      );
    }
    // Activity signals likewise unchanged.
    const acts = await fetchActivityQualitySignals(pool, ids);
    assert.ok(acts.size > 0, 'activity signals must resolve for seeded history');
  });

  it('11. scheduled list type/status filters identical across the CHECK domain', async () => {
    for (const st of ['scheduled', 'completed', 'cancelled']) {
      const legacy = await pool.query(
        `SELECT id FROM scheduled_activities WHERE LOWER(status) = LOWER($1)`, [st]);
      const shipped = await pool.query(
        `SELECT id FROM scheduled_activities WHERE status = $1`, [st]);
      assert.deepEqual(
        shipped.rows.map((r: any) => String(r.id)).sort(),
        legacy.rows.map((r: any) => String(r.id)).sort(),
        `status filter ${st} must be identical`
      );
    }
    for (const tp of ['call', 'meeting', 'follow_up', 'task']) {
      const legacy = await pool.query(
        `SELECT id FROM scheduled_activities WHERE LOWER(activity_type) = LOWER($1)`, [tp]);
      const shipped = await pool.query(
        `SELECT id FROM scheduled_activities WHERE activity_type = $1`, [tp]);
      assert.deepEqual(
        shipped.rows.map((r: any) => String(r.id)).sort(),
        legacy.rows.map((r: any) => String(r.id)).sort(),
        `type filter ${tp} must be identical`
      );
    }
  });

  it('12. notification user queries identical with the redundant branch removed', async () => {
    const cases = [
      { param: users[0].id, uuid: users[0].id },                 // uuid by users.id
      { param: users[1].employeeId, uuid: null },                 // employee key
      { param: users[2].id.toUpperCase(), uuid: users[2].id },    // uppercase uuid (asUuid accepts)
      { param: 'NO-SUCH-EMPLOYEE', uuid: null },                  // nothing matches
    ];
    for (const { param, uuid } of cases) {
      const legacy = await pool.query(
        `SELECT id FROM notifications
          WHERE recipient_key = $1 OR user_id::text = $1 OR user_id = $2
             OR user_id IN (SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1))
          ORDER BY created_at DESC`, [param, uuid]);
      // Shipped shape: the employee subquery pre-resolved to one users.id
      // (employee_id is UNIQUE) and the redundant cast branch removed.
      const emp = await pool.query(
        `SELECT id FROM users WHERE UPPER(employee_id) = UPPER($1) LIMIT 1`, [param]);
      const empUserId = emp.rows[0]?.id || null;
      const shipped = await pool.query(
        `SELECT id FROM notifications
          WHERE recipient_key = $1 OR user_id = $2 OR user_id = $3
          ORDER BY created_at DESC`, [param, uuid, empUserId]);
      assert.deepEqual(
        shipped.rows.map((r: any) => String(r.id)),
        legacy.rows.map((r: any) => String(r.id)),
        `notification match set must be identical for param=${param}`
      );
    }
  });

  it('13. pagination ordering unchanged for the follow-up queue', async () => {
    for (const offset of [0, 25]) {
      const r = await pool.query(
        `SELECT next_follow_up_at FROM leads l
          WHERE l.is_deleted = FALSE AND l.next_follow_up_at IS NOT NULL
            AND l.current_status <> ALL($1::text[])
          ORDER BY l.next_follow_up_at ASC LIMIT 25 OFFSET ${offset}`,
        [TERMINAL]
      );
      const ts = r.rows.map((x: any) => new Date(x.next_follow_up_at).getTime());
      for (let i = 1; i < ts.length; i++) {
        assert.ok(ts[i] >= ts[i - 1], 'queue must stay ordered by next_follow_up_at ASC');
      }
    }
  });

  it('14. hierarchy visibility unchanged (recursive CTE == BFS ground truth)', async () => {
    // Ground truth BFS over the seeded manager graph.
    const bfsDownline = (rootId: string): Set<string> => {
      const out = new Set<string>([rootId]);
      let frontier = [rootId];
      while (frontier.length) {
        const next: string[] = [];
        for (const u of users) {
          if (u.managerId && frontier.includes(u.managerId) && !out.has(u.id)) {
            out.add(u.id);
            next.push(u.id);
          }
        }
        frontier = next;
      }
      return out;
    };
    const cte = async (rootId: string): Promise<Set<string>> => {
      const r = await pool.query(
        `WITH RECURSIVE downline(id, depth) AS (
           SELECT u.id, 0 FROM users u WHERE u.id = $1
           UNION ALL
           SELECT u.id, d.depth + 1
             FROM users u JOIN downline d ON u.manager_id = d.id
            WHERE d.depth < 100 AND u.id <> d.id
         ) SELECT id FROM downline`,
        [rootId]
      );
      return new Set(r.rows.map((x: any) => String(x.id)));
    };
    const managers = users.filter((u) => u.employeeId.startsWith('MGR'));
    assert.equal(managers.length, 3);
    for (const m of managers) {
      const expected = bfsDownline(m.id);
      const actual = await cte(m.id);
      assert.deepEqual([...actual].sort(), [...expected].sort(), `downline for ${m.employeeId}`);
      // DownTeam visibility: scoped lead list for this manager must equal
      // the in-memory expectation computed from the seeded assignments.
      const leadVisible = leads
        .filter((l) => expected.has(String(l.assignedTo)) || expected.has(String(l.createdBy)))
        .map((l) => l.id)
        .sort();
      const dbRes = await pool.query(
        `SELECT id FROM leads l WHERE l.is_deleted = FALSE
          AND (l.assigned_to = ANY($1::uuid[]) OR l.created_by = ANY($1::uuid[]))`,
        [[...expected]]
      );
      assert.deepEqual(dbRes.rows.map((r: any) => String(r.id)).sort(), leadVisible,
        `DownTeam-scoped leads for ${m.employeeId} must match ground truth`);
    }
  });

  it('15. lead assignment/reassignment flips queue membership correctly', async () => {
    const lead = leads.find((l) => l.assignedTo && l.nextFu)!;
    const original = lead.assignedTo!;
    const target = users.find((u) => u.id !== original && u.employeeId.startsWith('EMP'))!.id;

    const queueOf = async (uid: string) => {
      const r = await pool.query(
        `SELECT id FROM leads l WHERE l.is_deleted = FALSE AND l.next_follow_up_at IS NOT NULL
          AND l.assigned_to = $1::uuid ORDER BY l.next_follow_up_at ASC LIMIT 50`,
        [uid]
      );
      return new Set(r.rows.map((x: any) => String(x.id)));
    };

    assert.ok((await queueOf(original)).has(lead.id), 'lead starts in the original assignee queue');

    // Reassignment write path (same shape the follow-up/assignment updates use).
    await pool.query(
      `UPDATE leads SET assigned_to = $1, previous_assigned_to = assigned_to, updated_at = NOW() WHERE id = $2`,
      [target, lead.id]
    );
    assert.ok(!(await queueOf(original)).has(lead.id), 'lead leaves the old assignee queue');
    assert.ok((await queueOf(target)).has(lead.id), 'lead appears in the new assignee queue');

    // Restore.
    await pool.query(`UPDATE leads SET assigned_to = $1, previous_assigned_to = NULL, updated_at = NOW() WHERE id = $2`, [original, lead.id]);
    assert.ok((await queueOf(original)).has(lead.id), 'restore puts the lead back');
  });

  it('15b. single-lead dual lookups (code-or-uuid) identical before/after', async () => {
    const byCode = leads[3];
    const cases = [
      byCode.leadCode,                       // business code
      byCode.id,                             // canonical uuid
      byCode.id.toUpperCase(),               // uppercase uuid (legacy no-match on id branch)
      'NO-SUCH-CODE',                        // nothing
    ];
    for (const param of cases) {
      const legacy = await pool.query(
        `SELECT id FROM leads WHERE (lead_code = $1 OR id::text = $1) AND is_deleted = FALSE LIMIT 1`,
        [param]);
      const shipped = await pool.query(
        `SELECT id FROM leads WHERE (lead_code = $1 OR id = $2) AND is_deleted = FALSE LIMIT 1`,
        [param, /^[0-9a-f-]{36}$/.test(param) && param === param.toLowerCase() ? param : null]);
      assert.deepEqual(
        shipped.rows.map((r: any) => String(r.id)),
        legacy.rows.map((r: any) => String(r.id)),
        `dual lookup must be identical for param=${param}`
      );
    }
  });

  it('15c. lead-scoped notification history identical without the redundant branch', async () => {
    const lead = leads[0];
    // Seed a notification referencing this lead both ways.
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, lead_code, reference_id)
       VALUES ($1, 'lead-scoped', 'x', 'info', $2, $3)`,
      [users[0].id, lead.leadCode, lead.id]
    );
    for (const param of [lead.leadCode, lead.id, 'MISSING-REF']) {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param) ? param : null;
      const legacy = await pool.query(
        `SELECT id FROM notifications WHERE lead_code = $1 OR reference_id::text = $1 OR reference_id = $2 ORDER BY created_at DESC`,
        [param, uuid]);
      const shipped = await pool.query(
        `SELECT id FROM notifications WHERE lead_code = $1 OR reference_id = $2 ORDER BY created_at DESC`,
        [param, uuid]);
      assert.deepEqual(
        shipped.rows.map((r: any) => String(r.id)),
        legacy.rows.map((r: any) => String(r.id)),
        `lead-scoped notifications must be identical for param=${param}`
      );
    }
  });

  /* ==================================================================
     PLAN EVIDENCE: hot predicates use the intended indexes
  ================================================================== */

  const planOf = async (sql: string, params: any[] = []) => {
    const r = await pool.query(`EXPLAIN ${sql}`, params);
    return r.rows.map((x: any) => x['QUERY PLAN']).join('\n');
  };

  it('16. queue assignedTo predicate exploits idx_leads_assigned_next_follow_up_active', async () => {
    const uid = leads.find((l) => l.assignedTo && l.nextFu)!.assignedTo;
    const plan = await planOf(
      `SELECT id FROM leads l WHERE l.is_deleted = FALSE AND l.next_follow_up_at IS NOT NULL
        AND l.assigned_to = $1::uuid ORDER BY l.next_follow_up_at ASC LIMIT 50`, [uid]);
    assert.ok(plan.includes('idx_leads_assigned_next_follow_up_active'),
      `expected partial composite index in plan, got:\n${plan}`);
  });

  it('17. visibility scope plan is index-driven (no seq scan on leads)', async () => {
    const plan = await planOf(
      `SELECT COUNT(*) FROM leads l WHERE l.is_deleted = FALSE
        AND (l.assigned_to = ANY($1::uuid[]) OR l.created_by = ANY($1::uuid[]))`,
      [scopeIds()]);
    assert.ok(!/Seq Scan on leads/.test(plan), `visibility scope must not seq-scan leads:\n${plan}`);
    assert.ok(/idx_leads_assigned_to|idx_leads_created_by/.test(plan),
      `expected BitmapOr over assigned_to/created_by indexes:\n${plan}`);
  });

  it('18. quality planned-action signals exploit idx_scheduled_activities_open_lead', async () => {
    const ids = leads.filter((_, i) => i % 4 === 0).map((l) => l.id);
    const plan = await planOf(
      `SELECT s.lead_id::text, MIN(s.scheduled_at)
         FROM scheduled_activities s
        WHERE s.lead_id = ANY($1::uuid[]) AND s.status = 'scheduled'
        GROUP BY s.lead_id`, [ids]);
    assert.ok(plan.includes('idx_scheduled_activities_open_lead'),
      `expected partial open index in plan, got:\n${plan}`);
  });

  it('19. notification list plan is index-driven with the shipped equality shape', async () => {
    const plan = await planOf(
      `SELECT id FROM notifications
        WHERE recipient_key = $1 OR user_id = $2 OR user_id = $3
        ORDER BY created_at DESC`,
      [users[0].employeeId, users[0].id, users[0].id]);
    assert.ok(!/Seq Scan on notifications/.test(plan),
      `notification list must not seq-scan:\n${plan}`);
    assert.ok(/idx_notification_user|idx_notifications_recipient_key/.test(plan),
      `expected recipient_key/user_id indexes in plan:\n${plan}`);
  });

  /* ==================================================================
     NO N+1: quality aggregation stays constant-query
  ================================================================== */

  it('20. quality aggregation uses a constant number of queries (no N+1)', async () => {
    const countQueries = async (fn: () => Promise<unknown>) => {
      const orig = pool.query.bind(pool);
      let count = 0;
      pool.query = (...args: any[]) => { count += 1; return orig(...args); };
      try { await fn(); } finally { pool.query = orig; }
      return count;
    };

    const idsSmall = leads.slice(0, 20).map((l) => l.id);
    const idsLarge = leads.slice(0, 200).map((l) => l.id);

    const smallCount = await countQueries(() =>
      Promise.all([fetchActivityQualitySignals(pool, idsSmall), fetchScheduledQualitySignals(pool, idsSmall)]));
    const largeCount = await countQueries(() =>
      Promise.all([fetchActivityQualitySignals(pool, idsLarge), fetchScheduledQualitySignals(pool, idsLarge)]));
    assert.equal(smallCount, 2, 'two signal families = two queries for 20 leads');
    assert.equal(largeCount, 2, 'still exactly two queries for 200 leads (no per-lead reads)');

    const scopeCount = await countQueries(() =>
      aggregateQualityForScope(pool, 'TRUE', [], TERMINAL));
    assert.equal(scopeCount, 3, 'dashboard quality scope = 1 lead scan + 2 signal queries');
  });

  /* ==================================================================
     SOURCE GUARDS: query-shape regression protection
  ================================================================== */

  it('21. no ::text casts remain on visibility/assignedTo hot predicates', () => {
    const routes = read('server/routes/production.routes.ts');
    assert.ok(!routes.includes('assigned_to::text = ANY'), 'visibility ANY must be uuid-typed');
    assert.ok(!routes.includes('created_by::text = ANY'), 'visibility ANY must be uuid-typed');
    assert.ok(routes.includes("l.assigned_to = ANY($${pUser}::uuid[]) OR l.created_by = ANY($${pUser}::uuid[])"),
      'shipped uuid visibility predicate must remain');
    assert.ok(routes.includes('l.assigned_to = $${params.length}::uuid'),
      'follow-up queue assignedTo must stay sargable');
    assert.ok(routes.includes('sa.assigned_to = $${params.length}::uuid'),
      'scheduled-activities assignedTo must stay sargable');
    // Dashboard visibility builder keeps the sargable shape.
    assert.ok(/buildDashboardVisibilitySql[\s\S]{0,600}assigned_to = ANY/.test(routes),
      'buildDashboardVisibilitySql must emit uuid-typed ANY');
    // Single-row PK lookups keep the sargable dual form.
    assert.ok(!routes.includes('sa.id::text'), 'scheduled-activity PK lookups must stay sargable');
    assert.ok(!routes.includes('n.id::text'), 'notification PK lookups must stay sargable');
    assert.ok(!/lead_code = \$1 OR l\.id::text/.test(routes), 'lead dual lookups must stay sargable');
    assert.ok(!routes.includes('reference_id::text'), 'lead-scoped notification branch must stay sargable');
  });

  it('22. notification queries keep sargable equality branches (no cast, no OR-ed subplan)', () => {
    const routes = read('server/routes/production.routes.ts');
    assert.ok(!routes.includes('user_id::text'), 'redundant cast-to-text user_id branch must stay removed');
    assert.ok(!routes.includes('user_id IN (SELECT id FROM users WHERE UPPER(employee_id)'),
      'hashed SubPlan employee branch must stay replaced by the pre-resolved equality');
    assert.ok(routes.includes('n.recipient_key = $1 OR n.user_id = $2 OR n.user_id = $3'),
      'list query must keep the three index-served equalities');
    assert.ok(routes.includes('WHERE recipient_key = $1 OR user_id = $2 OR user_id = $3'),
      'read-all/delete must keep the three index-served equalities');
  });

  it('23. lead quality planned-action signals stay sargable', () => {
    const signals = read('server/utils/leadQualitySignals.ts');
    assert.ok(signals.includes(`AND s.status = 'scheduled'`), 'status equality must remain');
    assert.ok(!signals.includes(`LOWER(s.status) = 'scheduled'`), 'LOWER() must not return');
    // Bulk-signal contract: one query per signal family, ids passed once.
    assert.ok(signals.includes('WHERE a.lead_id = ANY($1::uuid[])'), 'activity signals stay bulk-set');
    assert.ok(signals.includes('WHERE s.lead_id = ANY($1::uuid[])'), 'scheduled signals stay bulk-set');
    const routes = read('server/routes/production.routes.ts');
    assert.ok(routes.includes('sa.status = $${params.length}'), 'scheduled status filter stays sargable');
    assert.ok(routes.includes('sa.activity_type = $${params.length}'), 'scheduled type filter stays sargable');
  });

  it('24. migration 041 is registered in the runner and idempotent by construction', () => {
    const runner = read('server/database/runMigrations.ts');
    assert.ok(runner.includes('041_scheduled_activity_open_index'), 'runner must import migration 041');
    assert.ok(runner.includes('scheduledActivityOpenIndex'), 'runner must list migration 041');
    const mig = read('server/database/migrations/041_scheduled_activity_open_index.ts');
    assert.ok(mig.includes('CREATE INDEX IF NOT EXISTS idx_scheduled_activities_open_lead'), 'idempotent CREATE');
    assert.ok(mig.includes(`WHERE status = 'scheduled'`), 'partial predicate matches the hot query');
    assert.ok(!/CONCURRENTLY/.test(mig), 'runner executes each migration via the shared pool; CONCURRENTLY is intentionally not forced (see docs)');
  });
});
