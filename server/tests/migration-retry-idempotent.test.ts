/**
 * migration-retry-idempotent.test.ts — migration runner safety
 * ------------------------------------------------------------------
 *   1. runMigrations() twice on the same database: both green, no
 *      duplicate constraints / indexes, and the migration-042 guards are
 *      present exactly once (idempotent retry after a cold-start failure).
 *   2. The run summary reports completed=total after success and exposes
 *      no SQL / connection details.
 *   3. Failure marker: when a migration throws, the summary records WHICH
 *      one, how many completed before it, and rethrows unchanged — the
 *      startup behaviour (initializeDatabase rejects → 503s) is preserved,
 *      and a retry after the fault clears completes normally.
 *   4. Migration 042 is data-safe: pre-existing duplicate completion links
 *      do NOT fail the migration (the index is skipped, the checker
 *      reports the BLOCKER instead).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { _setTestPoolForTest, _resetPoolsForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import {
  runMigrations,
  getLastMigrationRunSummary,
  describeMigrationRun,
  listMigrationNames,
} from '../database/runMigrations.js';
// @ts-ignore — untyped .mjs module
import { runIntegrityChecks } from '../../scripts/lib/integrity-checks.mjs';

describe('Migration runner — idempotent retries and failure marker', () => {
  let pool: any;
  const q = (sql: string, params: any[] = []) => pool.query(sql, params);

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
  });

  after(async () => {
    try { _resetPoolsForTest(); } catch { /* ignore */ }
    try { resetPGlite(); } catch { /* ignore */ }
  });

  it('1. running the whole suite twice is green and leaves no duplicate guards', async () => {
    assert.equal(getLastMigrationRunSummary().status, 'never');
    await runMigrations();
    await runMigrations();

    const check = await q(`SELECT COUNT(*)::int AS c FROM pg_constraint WHERE conname = 'users_no_self_manager' AND conrelid = 'users'::regclass`);
    assert.equal(check.rows[0].c, 1, 'self-manager CHECK exists exactly once');
    const idx = await q(`SELECT COUNT(*)::int AS c, MIN(indexdef) AS def FROM pg_indexes WHERE indexname = 'uq_scheduled_activities_completed_activity'`);
    assert.equal(idx.rows[0].c, 1, 'unique completion index exists exactly once');
    assert.match(idx.rows[0].def, /UNIQUE/);
    assert.match(idx.rows[0].def, /completed_activity_id IS NOT NULL/);

    const dupes = await q(
      `SELECT tablename, indexdef, COUNT(*)::int AS c FROM pg_indexes WHERE schemaname = 'public' GROUP BY tablename, indexdef HAVING COUNT(*) > 1`
    );
    assert.equal(dupes.rows.length, 0, 'no duplicate index definitions after a re-run');
  });

  it('2. the run summary is complete, ordered and secret-free', () => {
    const s = getLastMigrationRunSummary();
    assert.equal(s.status, 'completed');
    assert.equal(s.total, listMigrationNames().length);
    assert.deepEqual(s.completed, listMigrationNames());
    assert.equal(s.failedAt, null);
    assert.equal(s.error, null);
    assert.ok(s.startedAt && s.finishedAt);
    assert.ok(listMigrationNames().includes('Data Integrity Guards'));
    const line = describeMigrationRun(s);
    assert.match(line, /migrations=completed completed=\d+\/\d+/);
    assert.ok(!/postgres(ql)?:\/\//i.test(line));
    // The summary object is a snapshot — mutating it cannot affect the runner.
    s.completed.push('tamper');
    assert.equal(getLastMigrationRunSummary().completed.includes('tamper'), false);
  });

  it('3. a failing migration is recorded as a failure marker, rethrown unchanged, and a retry succeeds', async () => {
    // Fault injection at the pool boundary: the first statement of the
    // 'Users' migration fails once (simulated transient DB error).
    let armed = true;
    const faultyPool = {
      query: async (sql: string, params?: any[]) => {
        if (armed && /CREATE TABLE IF NOT EXISTS users\b/i.test(sql)) {
          armed = false;
          const err: any = new Error('connection terminated unexpectedly\nsecond line postgresql://user:pw@host/db');
          err.code = '57P01';
          throw err;
        }
        return pool.query(sql, params);
      },
      connect: () => pool.connect(),
      on: () => undefined,
      end: async () => undefined,
    };
    _setTestPoolForTest(faultyPool);
    try {
      await assert.rejects(runMigrations(), (e: any) => e.code === '57P01' && /connection terminated/.test(e.message));
      const failed = getLastMigrationRunSummary();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failedAt, 'Users');
      assert.deepEqual(failed.completed, ['Departments', 'Roles', 'Teams']);
      assert.equal(failed.error, 'connection terminated unexpectedly', 'first line only, connection string never recorded');
      assert.match(describeMigrationRun(failed), /migrations=failed completed=3\/\d+ failedAt=Users/);
      assert.ok(!describeMigrationRun(failed).includes('pw@host'));

      // Retry (fault cleared) — idempotent DDL completes the run.
      await runMigrations();
      const ok = getLastMigrationRunSummary();
      assert.equal(ok.status, 'completed');
      assert.equal(ok.failedAt, null);
      assert.equal(ok.completed.length, ok.total);
    } finally {
      _setTestPoolForTest(pool);
    }
  });

  it('4. migration 042 never fails on legacy duplicate completion links — it skips the index and the checker reports the BLOCKER', async () => {
    // Fresh schema state: drop the index, inject a duplicate, re-run.
    const role = await q(`INSERT INTO roles (role_code, role_name, hierarchy_level) VALUES ('MIGR', 'Migr', 5) ON CONFLICT (role_code) DO UPDATE SET role_name = EXCLUDED.role_name RETURNING id`);
    const user = await q(`INSERT INTO users (employee_id, full_name, email, password, role_id) VALUES ('MIGR1', 'M', 'migr1@test', 'h', $1) RETURNING id`, [role.rows[0].id]);
    const lead = await q(`INSERT INTO leads (lead_code, customer_name, mobile, created_by) VALUES ('LD-MIGR-1', 'M', '01700000999', $1) RETURNING id`, [user.rows[0].id]);
    const act = await q(`INSERT INTO lead_activities (lead_id, activity_type, status) VALUES ($1, 'call', 'x') RETURNING id`, [lead.rows[0].id]);

    await q(`DROP INDEX uq_scheduled_activities_completed_activity`);
    for (let i = 0; i < 2; i++) {
      await q(`INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, completed_at, completed_activity_id)
               VALUES ($1, 'call', 'dup', NOW(), 'completed', NOW(), $2)`, [lead.rows[0].id, act.rows[0].id]);
    }

    await runMigrations(); // must NOT throw
    assert.equal(getLastMigrationRunSummary().status, 'completed');
    const idx = await q(`SELECT COUNT(*)::int AS c FROM pg_indexes WHERE indexname = 'uq_scheduled_activities_completed_activity'`);
    assert.equal(idx.rows[0].c, 0, 'index skipped while duplicates exist');

    const report = await runIntegrityChecks((sql: string, params: any[]) => pool.query(sql, params));
    const dup = report.results.find((r: any) => r.id === 'scheduled_activities.duplicate_completion');
    assert.equal(dup.status, 'FAIL');
    assert.equal(dup.count, 1);
    assert.equal(report.exitCode, 1);

    // Operator resolves the duplicates → the next run creates the index.
    await q(`DELETE FROM scheduled_activities WHERE lead_id = $1`, [lead.rows[0].id]);
    await runMigrations();
    const idx2 = await q(`SELECT COUNT(*)::int AS c FROM pg_indexes WHERE indexname = 'uq_scheduled_activities_completed_activity'`);
    assert.equal(idx2.rows[0].c, 1);
  });
});
