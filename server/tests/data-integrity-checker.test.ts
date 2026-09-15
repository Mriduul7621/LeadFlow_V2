/**
 * data-integrity-checker.test.ts — read-only integrity checker, proven on
 * the REAL migrated schema (isolated PGlite + full runMigrations()).
 * ------------------------------------------------------------------
 * Covers the reliability-audit acceptance list:
 *
 *    1. the checker is read-only (guard rejects write/DDL verbs; a spy
 *       query function sees only SELECT/WITH statements)
 *    2. a valid, freshly-migrated + seeded database PASSES
 *    3. orphan-style detections on the FK-less invariants (notification
 *       lead reference, custom-field owner shadow)
 *    4. notification idempotency: duplicate keys are impossible (unique
 *       index) and the index-presence check is asserted
 *    5. RBAC references (FK CASCADE keeps them clean; detection is proven
 *       by dropping the FK in a savepoint)
 *    6. manager cycle detection
 *    7. self-manager detection (and migration 042 rejects new writes)
 *    8. manager anomaly severity (self-manager/cycle = BLOCKER,
 *       inactive manager / stale chain = WARNING)
 *    9. assigned_to vs latest assignment_history owner mismatch (WARNING)
 *   10. duplicate completion is impossible after migration 042 and the
 *       checker reports it as BLOCKER when the index is absent
 *   11. non-zero exit code on BLOCKER violations
 *   12. WARNING severity does not fail the run
 *   13. no PII in the output (names/phones/emails/notes never appear even
 *       when the fixture contains them)
 *
 * Injection technique: every corruption is written inside a SAVEPOINT (or
 * with FK constraints temporarily dropped inside a transaction that is
 * rolled back) so the shared database returns to a clean state and the
 * final "clean DB passes" assertion is meaningful.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { _setTestPoolForTest, _resetPoolsForTest } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import { runMigrations } from '../database/runMigrations.js';
import { runSeeds } from '../database/runSeeds.js';

// The checker library is plain ESM (.mjs) — imported directly by the tests.
// @ts-ignore — untyped .mjs module
import {
  runIntegrityChecks,
  formatReport,
  assertReadOnlySql,
  INTEGRITY_CHECKS,
  SEVERITY,
} from '../../scripts/lib/integrity-checks.mjs';

const PII = {
  name: 'Zebulon Quixote-Integrity',
  email: 'zebulon.quixote@example-integrity.test',
  phone: '01799887766',
  note: 'SECRET-NOTE-DO-NOT-PRINT',
};

describe('Data integrity checker — read-only invariants on the migrated schema', () => {
  let pool: any;
  const q = (sql: string, params: any[] = []) => pool.query(sql, params);
  const run = (opts: any = {}) => runIntegrityChecks((sql: string, params: any[]) => pool.query(sql, params), opts);
  const byId = (report: any, id: string) => report.results.find((r: any) => r.id === id);

  let roleAdmin = '';
  let roleEmp = '';
  let deptId = '';
  let adminId = '';
  let mgrId = '';
  let empId = '';
  let leadId = '';

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    await runMigrations();
    await runSeeds();

    const roles = await q(`SELECT id, role_code FROM roles WHERE role_code IN ('ADMIN','EMPLOYEE')`);
    roleAdmin = roles.rows.find((r: any) => r.role_code === 'ADMIN').id;
    roleEmp = roles.rows.find((r: any) => r.role_code === 'EMPLOYEE').id;
    const dept = await q(`INSERT INTO departments (department_code, department_name) VALUES ('INTG', 'Integrity') RETURNING id`);
    deptId = dept.rows[0].id;

    const mk = async (emp: string, roleId: string, managerId: string | null, name = emp) => {
      const r = await q(
        `INSERT INTO users (employee_id, full_name, email, password, role_id, department_id, manager_id, is_active)
         VALUES ($1, $2, $3, 'hash', $4, $5, $6, TRUE) RETURNING id`,
        [emp, name, `${emp.toLowerCase()}@integrity.test`, roleId, deptId, managerId]
      );
      return r.rows[0].id as string;
    };
    adminId = await mk('INTADMIN', roleAdmin, null);
    mgrId = await mk('INTMGR', roleEmp, adminId);
    empId = await mk('INTEMP', roleEmp, mgrId, PII.name);
    // Derived caches as the app would write them.
    await q(`UPDATE users SET reporting_chain = '["INTADMIN"]'::jsonb WHERE id = $1`, [mgrId]);
    await q(`UPDATE users SET reporting_chain = '["INTMGR","INTADMIN"]'::jsonb WHERE id = $1`, [empId]);
    await q(`INSERT INTO hierarchies (user_id, manager_id, level, path) VALUES ($1, $2, 2, '["INTADMIN"]'), ($3, $4, 3, '["INTMGR","INTADMIN"]')`, [mgrId, adminId, empId, mgrId]);

    const lead = await q(
      `INSERT INTO leads (lead_code, customer_name, mobile, email, notes, assigned_to, created_by, current_status, assignment_history, custom_fields)
       VALUES ('LD-INTG-1', $1, $2, $3, $4, $5, $6, 'Interested',
               '[{"id":"assign_1","toEmployeeId":"INTEMP","changedBy":"INTADMIN"}]'::jsonb,
               '{"assignedTo":"INTEMP","campaignName":"Integrity"}'::jsonb) RETURNING id`,
      [PII.name, PII.phone, PII.email, PII.note, empId, adminId]
    );
    leadId = lead.rows[0].id;

    // A completed scheduled activity linked to its actual activity, plus an open one.
    const act = await q(`INSERT INTO lead_activities (lead_id, activity_type, status, remarks, created_by) VALUES ($1, 'call', 'Interested', $2, $3) RETURNING id`, [leadId, PII.note, empId]);
    await q(
      `INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, assigned_to, created_by, completed_at, completed_by, completed_activity_id)
       VALUES ($1, 'call', $2, NOW() - INTERVAL '1 day', 'completed', $3, $3, NOW(), $3, $4)`,
      [leadId, PII.note, empId, act.rows[0].id]
    );
    await q(`INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, assigned_to, created_by) VALUES ($1, 'meeting', 'open', NOW() + INTERVAL '1 day', 'scheduled', $2, $2)`, [leadId, empId]);

    // A system notification exactly as NotificationService writes it.
    await q(
      `INSERT INTO notifications (user_id, recipient_key, title, message, event_type, idempotency_key, lead_code, reference_id, reference_type, is_read, type)
       VALUES ($1, 'INTEMP', 'Lead assigned', $2, 'lead-assigned', 'lead-assigned:LD-INTG-1:INTEMP:v1', 'LD-INTG-1', $3, 'lead', FALSE, 'info')`,
      [empId, PII.note, leadId]
    );
    // RBAC grant + override.
    const perm = await q(`SELECT id FROM permissions WHERE permission_code = 'leads.view' LIMIT 1`);
    await q(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING`, [roleEmp, perm.rows[0].id]);
    await q(`INSERT INTO user_permissions (user_id, permission_id, is_allowed, reason) VALUES ($1, $2, TRUE, 'test') ON CONFLICT DO NOTHING`, [empId, perm.rows[0].id]);
  });

  after(async () => {
    try { _resetPoolsForTest(); } catch { /* ignore */ }
    try { resetPGlite(); } catch { /* ignore */ }
  });

  /** Run `mutate` inside a savepoint, execute the checker, then roll back. */
  async function withInjected<T>(mutate: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
      await mutate();
      return await fn();
    } finally {
      await q('ROLLBACK');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 1. read-only                                                        */
  /* ------------------------------------------------------------------ */

  it('1. every catalog statement is SELECT/WITH and the guard rejects writes', async () => {
    for (const c of INTEGRITY_CHECKS) {
      assert.doesNotThrow(() => assertReadOnlySql(c.countSql), c.id);
      if (c.sampleSql) assert.doesNotThrow(() => assertReadOnlySql(c.sampleSql), `${c.id} sample`);
    }
    for (const bad of [
      `DELETE FROM leads`,
      `UPDATE users SET manager_id = NULL`,
      `INSERT INTO audit_logs (action_code, entity_type) VALUES ('x','y')`,
      `ALTER TABLE leads DROP COLUMN notes`,
      `DROP TABLE users`,
      `TRUNCATE notifications`,
      `SELECT 1; DELETE FROM leads`,
      `WITH x AS (DELETE FROM leads RETURNING id) SELECT COUNT(*) FROM x`,
      `CREATE TABLE evil (id int)`,
    ]) {
      assert.throws(() => assertReadOnlySql(bad), `must refuse: ${bad}`);
    }
    // Literals never trip the guard (statuses like 'completed' are data).
    assert.doesNotThrow(() => assertReadOnlySql(`SELECT COUNT(*)::int AS count FROM scheduled_activities WHERE status = 'completed'`));

    // The runner only ever sends SELECT/WITH to the database.
    const seen: string[] = [];
    await runIntegrityChecks((sql: string, params: any[]) => { seen.push(sql.trim()); return pool.query(sql, params); }, { diagnostic: true });
    assert.ok(seen.length > INTEGRITY_CHECKS.length, 'all checks executed');
    for (const s of seen) assert.match(s, /^(SELECT|WITH)\b/i);
  });

  /* ------------------------------------------------------------------ */
  /* 2. clean DB passes                                                  */
  /* ------------------------------------------------------------------ */

  it('2. a valid migrated + seeded database passes with exit code 0', async () => {
    const report = await run();
    assert.equal(report.overall, 'PASS', formatReport(report));
    assert.equal(report.exitCode, 0);
    assert.equal(report.counts.FAIL, 0);
    assert.equal(report.counts.WARN, 0);
    assert.equal(report.counts.ERROR, 0);
    assert.equal(report.counts.SKIPPED, 0, 'every required table exists after migrations');
    assert.equal(byId(report, 'schema.required_tables').status, 'PASS');
    assert.equal(byId(report, 'notifications.idempotency_index_present').status, 'PASS');
    assert.equal(byId(report, 'volume.users').status, 'INFO');
    assert.ok(byId(report, 'volume.users').count >= 3);
  });

  /* ------------------------------------------------------------------ */
  /* 3. orphan detections without FKs                                    */
  /* ------------------------------------------------------------------ */

  it('3a. notification lead reference pointing at a missing lead is a WARNING', async () => {
    await withInjected(
      async () => {
        await q(`INSERT INTO notifications (user_id, title, message, reference_type, reference_id, is_read, type)
                 VALUES ($1, 'orphan', 'x', 'lead', '00000000-0000-4000-8000-000000000001', FALSE, 'info')`, [empId]);
      },
      async () => {
        const report = await run();
        const r = byId(report, 'notifications.lead_reference_dangling');
        assert.equal(r.status, 'WARN');
        assert.equal(r.severity, SEVERITY.WARNING);
        assert.equal(r.count, 1);
        assert.equal(report.overall, 'WARN');
        assert.equal(report.exitCode, 0, 'warnings never fail the run');
      }
    );
  });

  it('3b. FK-backed orphans (lead_activities.lead_id) are detected when the constraint is removed', async () => {
    await withInjected(
      async () => {
        await q(`ALTER TABLE lead_activities DROP CONSTRAINT lead_activities_lead_id_fkey`);
        await q(`INSERT INTO lead_activities (lead_id, activity_type, status) VALUES ('00000000-0000-4000-8000-000000000002', 'call', 'x')`);
      },
      async () => {
        const report = await run();
        const r = byId(report, 'lead_activities.lead_dangling');
        assert.equal(r.status, 'FAIL');
        assert.equal(r.severity, SEVERITY.BLOCKER);
        assert.equal(r.count, 1);
        assert.equal(report.exitCode, 1);
      }
    );
  });

  /* ------------------------------------------------------------------ */
  /* 4. idempotency                                                      */
  /* ------------------------------------------------------------------ */

  it('4. duplicate idempotency keys are impossible (unique index) and the index check notices removal', async () => {
    await assert.rejects(
      q(`INSERT INTO notifications (user_id, title, message, idempotency_key, is_read, type)
         VALUES ($1, 'dup', 'x', 'lead-assigned:LD-INTG-1:INTEMP:v1', FALSE, 'info')`, [empId]),
      (e: any) => e.code === '23505'
    );
    await withInjected(
      async () => {
        await q(`DROP INDEX idx_notifications_idempotency_key`);
        await q(`INSERT INTO notifications (user_id, title, message, idempotency_key, is_read, type)
                 VALUES ($1, 'dup', 'x', 'lead-assigned:LD-INTG-1:INTEMP:v1', FALSE, 'info')`, [empId]);
      },
      async () => {
        const report = await run();
        assert.equal(byId(report, 'notifications.idempotency_index_present').status, 'FAIL');
        assert.equal(byId(report, 'notifications.idempotency_key_duplicate').status, 'FAIL');
        assert.equal(byId(report, 'notifications.idempotency_key_duplicate').count, 1);
        assert.equal(report.exitCode, 1);
      }
    );
  });

  /* ------------------------------------------------------------------ */
  /* 5. RBAC                                                             */
  /* ------------------------------------------------------------------ */

  it('5. role/user permission references are clean and dangling grants are BLOCKERs', async () => {
    const clean = await run();
    for (const id of ['rbac.role_permissions_dangling', 'rbac.user_permissions_dangling', 'rbac.duplicate_role_grants', 'rbac.duplicate_user_grants', 'rbac.permission_code_blank']) {
      assert.equal(byId(clean, id).status, 'PASS', id);
    }
    await withInjected(
      async () => {
        // Drop whichever FK points at roles (looked up first — a failed
        // statement inside a transaction would poison it, exactly the
        // pattern the transaction audit flags).
        const fk = await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'role_permissions'::regclass AND contype = 'f' AND confrelid = 'roles'::regclass`);
        assert.ok(fk.rows.length >= 1, 'role_permissions has an FK to roles');
        for (const r of fk.rows) await q(`ALTER TABLE role_permissions DROP CONSTRAINT ${r.conname}`);
        const perm = await q(`SELECT id FROM permissions LIMIT 1`);
        await q(`INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ('00000000-0000-4000-8000-000000000003', $1, TRUE)`, [perm.rows[0].id]);
      },
      async () => {
        const report = await run();
        assert.equal(byId(report, 'rbac.role_permissions_dangling').status, 'FAIL');
        assert.equal(byId(report, 'rbac.role_permissions_dangling').count, 1);
        assert.equal(report.exitCode, 1);
      }
    );
  });

  /* ------------------------------------------------------------------ */
  /* 6–8. manager chain                                                  */
  /* ------------------------------------------------------------------ */

  it('6. a manager cycle is detected as a BLOCKER', async () => {
    await withInjected(
      async () => { await q(`UPDATE users SET manager_id = $1 WHERE id = $2`, [empId, adminId]); }, // admin → emp → mgr → admin
      async () => {
        const report = await run();
        const r = byId(report, 'users.manager_cycle');
        assert.equal(r.status, 'FAIL');
        assert.equal(r.severity, SEVERITY.BLOCKER);
        assert.equal(r.count, 3, 'every member of the cycle is counted');
        assert.equal(report.exitCode, 1);
      }
    );
  });

  it('7. a self-manager is rejected by migration 042 for new writes and detected as a BLOCKER for legacy rows', async () => {
    await assert.rejects(q(`UPDATE users SET manager_id = id WHERE id = $1`, [empId]), (e: any) => e.code === '23514');
    await withInjected(
      async () => {
        await q(`ALTER TABLE users DROP CONSTRAINT users_no_self_manager`);
        await q(`UPDATE users SET manager_id = id WHERE id = $1`, [empId]);
      },
      async () => {
        const report = await run({ diagnostic: true });
        const r = byId(report, 'users.self_manager');
        assert.equal(r.status, 'FAIL');
        assert.equal(r.severity, SEVERITY.BLOCKER);
        assert.equal(r.count, 1);
        assert.deepEqual(r.sample, [empId], 'diagnostic mode exposes only the opaque row id');
        assert.equal(report.exitCode, 1);
      }
    );
  });

  it('8. manager anomalies carry the right severity: inactive manager and stale chain are WARNINGS', async () => {
    await withInjected(
      async () => { await q(`UPDATE users SET is_active = FALSE WHERE id = $1`, [mgrId]); },
      async () => {
        const report = await run();
        const r = byId(report, 'users.manager_inactive');
        assert.equal(r.status, 'WARN');
        assert.equal(r.count, 1);
        assert.equal(report.exitCode, 0);
      }
    );
    await withInjected(
      async () => { await q(`UPDATE users SET reporting_chain = '["SOMEONE_ELSE"]'::jsonb WHERE id = $1`, [empId]); },
      async () => {
        const report = await run();
        const r = byId(report, 'users.reporting_chain_stale');
        assert.equal(r.status, 'WARN');
        assert.equal(r.severity, SEVERITY.WARNING);
        assert.equal(r.count, 1);
        assert.equal(report.overall, 'WARN');
      }
    );
    await withInjected(
      async () => { await q(`DELETE FROM hierarchies WHERE user_id = $1`, [empId]); },
      async () => {
        const report = await run();
        const r = byId(report, 'users.hierarchies_mismatch');
        assert.equal(r.status, 'INFO', 'write-only derived table is informational');
        assert.equal(r.count, 1);
        assert.equal(report.overall, 'PASS');
      }
    );
  });

  /* ------------------------------------------------------------------ */
  /* 9. assignment history                                               */
  /* ------------------------------------------------------------------ */

  it('9. assigned_to vs latest assignment_history owner mismatch is a WARNING; owner shadow mismatch too', async () => {
    await withInjected(
      async () => { await q(`UPDATE leads SET assigned_to = $1 WHERE id = $2`, [mgrId, leadId]); }, // history still says INTEMP
      async () => {
        const report = await run();
        assert.equal(byId(report, 'assignment_history.latest_owner_mismatch').status, 'WARN');
        assert.equal(byId(report, 'assignment_history.latest_owner_mismatch').count, 1);
        assert.equal(byId(report, 'leads.owner_shadow_mismatch').status, 'WARN');
        assert.equal(byId(report, 'leads.owner_shadow_mismatch').count, 1);
        assert.equal(report.exitCode, 0);
      }
    );
    await withInjected(
      async () => {
        await q(`UPDATE leads SET assignment_history = assignment_history || '[{"id":"assign_1","toEmployeeId":"INTEMP"}]'::jsonb WHERE id = $1`, [leadId]);
      },
      async () => {
        const report = await run();
        assert.equal(byId(report, 'assignment_history.duplicate_entry_ids').status, 'WARN');
        assert.equal(byId(report, 'assignment_history.duplicate_entry_ids').count, 1);
      }
    );
  });

  /* ------------------------------------------------------------------ */
  /* 10. duplicate completion                                            */
  /* ------------------------------------------------------------------ */

  it('10. duplicate completion is impossible (migration 042) and reported as BLOCKER without the index', async () => {
    const linked = await q(`SELECT completed_activity_id FROM scheduled_activities WHERE completed_activity_id IS NOT NULL LIMIT 1`);
    const actId = linked.rows[0].completed_activity_id;
    await assert.rejects(
      q(`INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, completed_at, completed_activity_id)
         VALUES ($1, 'call', 'dup', NOW(), 'completed', NOW(), $2)`, [leadId, actId]),
      (e: any) => e.code === '23505'
    );
    await withInjected(
      async () => {
        await q(`DROP INDEX uq_scheduled_activities_completed_activity`);
        await q(`INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, completed_at, completed_activity_id)
                 VALUES ($1, 'call', 'dup', NOW(), 'completed', NOW(), $2)`, [leadId, actId]);
      },
      async () => {
        const report = await run();
        const r = byId(report, 'scheduled_activities.duplicate_completion');
        assert.equal(r.status, 'FAIL');
        assert.equal(r.severity, SEVERITY.BLOCKER);
        assert.equal(r.count, 1);
        assert.equal(report.exitCode, 1);
      }
    );
    // completed without an actual activity → BLOCKER
    await withInjected(
      async () => {
        await q(`INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status) VALUES ($1, 'task', 'broken', NOW(), 'completed')`, [leadId]);
      },
      async () => {
        const report = await run();
        assert.equal(byId(report, 'scheduled_activities.completed_without_activity').status, 'FAIL');
        assert.equal(byId(report, 'scheduled_activities.completed_without_activity').count, 1);
      }
    );
    // cancelled row carrying completion fields → WARNING
    await withInjected(
      async () => {
        await q(`INSERT INTO scheduled_activities (lead_id, activity_type, title, scheduled_at, status, completed_at) VALUES ($1, 'task', 'odd', NOW(), 'cancelled', NOW())`, [leadId]);
      },
      async () => {
        const report = await run();
        assert.equal(byId(report, 'scheduled_activities.open_with_completion_fields').status, 'WARN');
        assert.equal(report.exitCode, 0);
      }
    );
  });

  /* ------------------------------------------------------------------ */
  /* 11–12. exit codes & terminal anomalies                              */
  /* ------------------------------------------------------------------ */

  it('11. BLOCKER → exit 1; terminal-lead anomalies are WARNINGS → exit 0', async () => {
    await withInjected(
      async () => {
        await q(`UPDATE leads SET current_status = 'Converted', next_follow_up_at = NOW() + INTERVAL '3 days' WHERE id = $1`, [leadId]);
      },
      async () => {
        const report = await run();
        assert.equal(byId(report, 'leads.terminal_with_open_schedule').status, 'WARN');
        assert.equal(byId(report, 'leads.terminal_with_future_follow_up').status, 'WARN');
        assert.equal(report.overall, 'WARN');
        assert.equal(report.exitCode, 0);
      }
    );
    await withInjected(
      async () => { await q(`UPDATE leads SET is_deleted = TRUE WHERE id = $1`, [leadId]); }, // deleted_at missing + open schedule
      async () => {
        const report = await run();
        assert.equal(byId(report, 'leads.soft_delete_inconsistent').status, 'WARN');
        assert.equal(byId(report, 'leads.deleted_with_open_schedule').status, 'WARN');
        assert.equal(report.exitCode, 0);
      }
    );
  });

  it('12. a missing required table is a BLOCKER and dependent checks are SKIPPED (no crash)', async () => {
    await withInjected(
      async () => { await q(`DROP TABLE hierarchies`); },
      async () => {
        const report = await run();
        assert.equal(byId(report, 'schema.required_tables').status, 'FAIL');
        assert.match(byId(report, 'schema.required_tables').detail, /hierarchies/);
        assert.equal(byId(report, 'users.hierarchies_mismatch').status, 'SKIPPED');
        assert.equal(report.exitCode, 1);
      }
    );
  });

  /* ------------------------------------------------------------------ */
  /* 13. no PII                                                          */
  /* ------------------------------------------------------------------ */

  it('13. the report never contains names, phones, emails or free text — even in diagnostic mode with violations', async () => {
    await withInjected(
      async () => {
        await q(`ALTER TABLE users DROP CONSTRAINT users_no_self_manager`);
        await q(`UPDATE users SET manager_id = id WHERE id = $1`, [empId]);
        await q(`UPDATE leads SET assigned_to = $1, current_status = 'Converted' WHERE id = $2`, [mgrId, leadId]);
        await q(`INSERT INTO notifications (user_id, title, message, reference_type, reference_id, is_read, type)
                 VALUES ($1, $2, $3, 'lead', '00000000-0000-4000-8000-000000000001', FALSE, 'info')`, [empId, PII.name, PII.note]);
      },
      async () => {
        for (const diagnostic of [false, true]) {
          const report = await run({ diagnostic });
          const text = formatReport(report) + JSON.stringify(report);
          for (const [k, v] of Object.entries(PII)) {
            assert.ok(!text.includes(v), `${k} leaked in ${diagnostic ? 'diagnostic' : 'aggregate'} output`);
          }
          assert.ok(!text.includes('INTEMP') && !text.includes('LD-INTG-1'), 'employee ids / lead codes are not printed');
          assert.ok(!/@/.test(formatReport(report)), 'no email-like tokens');
          if (!diagnostic) {
            assert.ok(report.results.every((r: any) => r.sample.length === 0), 'aggregate mode prints no ids at all');
          } else {
            const ids = report.results.flatMap((r: any) => r.sample);
            assert.ok(ids.length > 0);
            for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/i);
          }
        }
      }
    );
  });

  it('14. after every injection the database is clean again (PASS)', async () => {
    const report = await run();
    assert.equal(report.overall, 'PASS', formatReport(report));
  });
});
