/**
 * restore-drill-guards.test.ts — restore drill safety model
 * ------------------------------------------------------------------
 * Proves the default-deny guards of scripts/restore-drill.mjs WITHOUT any
 * database or PostgreSQL tooling (exec / smoke / verifyBackup injected):
 *
 *   A. default deny: no confirmation → REFUSED, nothing executed
 *   B. wrong confirmation values ('yes', 'true', '1') → REFUSED
 *   C. production-like targets refused: Supabase hosts, pooler hosts,
 *      prod/production/live in host / db / user, target == DATABASE_URL
 *   D. DATABASE_URL alone is never used as the target
 *   E. redacted target echo — credentials never appear in any output
 *   F. missing pg_restore → explicit FAIL (no restore attempted)
 *   G. happy path executes the documented pipeline in order:
 *      verify backup → restore → verify-db-schema → verify-data-integrity
 *      → read-only smoke, and stops at the first failure
 *   H. --plan touches no database
 *   I. CLI exit codes (2 refused)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// @ts-ignore — untyped .mjs module (JSDoc inference is too narrow for the injected fakes)
import * as drillLib from '../../scripts/lib/restore-drill.mjs';

const lib: any = drillLib;
const evaluateRestoreGuards: (opts: any) => any = lib.evaluateRestoreGuards;
const classifyRestoreTarget: (url: string, appUrl: string | null) => any = lib.classifyRestoreTarget;
const redactDatabaseUrl: (url: string) => string = lib.redactDatabaseUrl;
const runRestoreDrill: (opts: any) => Promise<any> = lib.runRestoreDrill;
const formatDrillResult: (r: any) => string = lib.formatDrillResult;
const CONFIRMATION_ENV: string = lib.CONFIRMATION_ENV;
const TARGET_ENV: string = lib.TARGET_ENV;

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '../..');
const CLI = path.join(ROOT, 'scripts', 'restore-drill.mjs');

const SECRET = 'sup3r-s3cret-pw';
const SCRATCH = `postgresql://drill_user:${SECRET}@scratch.internal:5432/leadflow_restore_drill`;
const APP_DB = `postgresql://app:${SECRET}@db.abcdefghijkl.supabase.co:5432/postgres`;

function goodEnv(extra: Record<string, string> = {}) {
  return { [CONFIRMATION_ENV]: 'YES', [TARGET_ENV]: SCRATCH, DATABASE_URL: APP_DB, ...extra };
}

function fakeBackupOk() {
  return async () => ({ ok: true, format: 'custom', sha256: 'a'.repeat(64), checks: [] });
}

/** Records every exec call; returns success unless `failOn` matches. */
function recordingExec(calls: any[], failOn: ((cmd: string, args: string[]) => boolean) | null = null, toolMissing = false) {
  return (cmd: string, args: string[]) => {
    calls.push({ cmd, args: [...args] });
    if (args[0] === '--version') {
      return toolMissing ? { status: -1, stdout: '', stderr: 'ENOENT' } : { status: 0, stdout: 'pg_restore (PostgreSQL) 16.4', stderr: '' };
    }
    if (failOn && failOn(cmd, args)) return { status: 1, stdout: 'RESULT: FAIL (exit 1)', stderr: 'boom' };
    return { status: 0, stdout: 'RESULT: PASS (exit 0)', stderr: '' };
  };
}

describe('Restore drill — safety guards and pipeline', () => {
  it('A. default deny: without explicit confirmation nothing is executed', async () => {
    const calls: any[] = [];
    const r = await runRestoreDrill({ backupPath: '/tmp/x.dump', env: { [TARGET_ENV]: SCRATCH }, exec: recordingExec(calls), smoke: async () => { throw new Error('must not run'); }, verifyBackup: fakeBackupOk() });
    assert.equal(r.status, 'REFUSED');
    assert.equal(r.exitCode, 2);
    assert.equal(calls.length, 0, 'no command executed');
    assert.equal(r.steps.find((s: any) => s.id === 'guard.explicit_confirmation').status, 'FAIL');
    assert.ok(r.steps.some((s: any) => s.id === 'drill.refused'));
    assert.ok(!r.steps.some((s: any) => s.id === 'backup.verify'), 'backup verification does not even start');
  });

  it('B. only the exact string YES confirms', () => {
    for (const v of ['yes', 'Yes', 'true', '1', 'Y', ' YES', 'YES ']) {
      const g = evaluateRestoreGuards({ env: goodEnv({ [CONFIRMATION_ENV]: v }), backupPath: '/tmp/x.dump' });
      assert.equal(g.allowed, false, `"${v}" must not confirm`);
    }
    assert.equal(evaluateRestoreGuards({ env: goodEnv(), backupPath: '/tmp/x.dump' }).allowed, true);
    assert.equal(evaluateRestoreGuards({ env: goodEnv(), backupPath: null }).allowed, false, 'backup path is required');
  });

  it('C. production-like targets are refused', () => {
    const refused = [
      `postgresql://postgres:${SECRET}@db.abcdefghijkl.supabase.co:5432/postgres`,
      `postgresql://postgres.abc:${SECRET}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`,
      `postgres://u:${SECRET}@prod-db.internal:5432/leadflow`,
      `postgres://u:${SECRET}@db.internal:5432/leadflow_production`,
      `postgres://u:${SECRET}@db.internal:5432/leadflow-live`,
      `postgres://prod_admin:${SECRET}@db.internal:5432/scratch`,
      `postgres://u:${SECRET}@db.internal:5432/`,
      'mysql://u:p@h/x',
      '',
    ];
    for (const url of refused) {
      const c = classifyRestoreTarget(url, null);
      assert.equal(c.allowed, false, `must refuse ${redactDatabaseUrl(url)}`);
      assert.ok(c.reasons.length >= 1);
    }
    // Equality with the application database is refused even on a neutral host.
    const same = classifyRestoreTarget(`postgresql://other:${SECRET}@scratch.internal:5432/leadflow_restore_drill`, SCRATCH);
    assert.equal(same.allowed, false);
    assert.match(same.reasons.join(' '), /equals DATABASE_URL/);

    const ok = classifyRestoreTarget(SCRATCH, APP_DB);
    assert.equal(ok.allowed, true, ok.reasons.join('; '));
    assert.equal(classifyRestoreTarget(`postgres://u:p@localhost:5433/leadflow_drill_2026`, APP_DB).allowed, true);
    // "product"/"productivity" are not production markers.
    assert.equal(classifyRestoreTarget(`postgres://u:p@localhost:5433/productivity_scratch`, null).allowed, true);
  });

  it('D. DATABASE_URL alone never becomes the target', async () => {
    const calls: any[] = [];
    const r = await runRestoreDrill({ backupPath: '/tmp/x.dump', env: { [CONFIRMATION_ENV]: 'YES', DATABASE_URL: SCRATCH }, exec: recordingExec(calls), verifyBackup: fakeBackupOk(), smoke: async () => ({ ok: true }) });
    assert.equal(r.status, 'REFUSED');
    assert.equal(calls.length, 0);
    assert.equal(r.steps.find((s: any) => s.id === 'guard.target_configured').status, 'FAIL');
    assert.match(r.steps.find((s: any) => s.id === 'guard.target_configured').detail, new RegExp(TARGET_ENV));
  });

  it('E. the target is always echoed redacted — credentials never appear anywhere', async () => {
    assert.equal(redactDatabaseUrl(SCRATCH), 'postgresql://[user]@scratch.internal:5432/leadflow_restore_drill');
    assert.equal(redactDatabaseUrl('nonsense'), '[invalid or non-postgres url]');
    const calls: any[] = [];
    const r = await runRestoreDrill({ backupPath: '/tmp/x.dump', env: goodEnv(), exec: recordingExec(calls), verifyBackup: fakeBackupOk(), smoke: async () => ({ ok: true, counts: { users: 3, roles: 8, leads: 1, lead_activities: 1, scheduled_activities: 1, notifications: 1, audit_logs: 0 }, activeAdmins: 1 }) });
    const text = formatDrillResult(r) + JSON.stringify(r);
    assert.ok(!text.includes(SECRET), 'password leaked into the drill output');
    assert.ok(!text.includes('drill_user'), 'username leaked into the drill output');
    assert.equal(r.target, 'postgresql://[user]@scratch.internal:5432/leadflow_restore_drill');
    // Refused runs are redacted too.
    const refused = await runRestoreDrill({ backupPath: '/tmp/x.dump', env: { [CONFIRMATION_ENV]: 'YES', [TARGET_ENV]: APP_DB }, exec: recordingExec([]), verifyBackup: fakeBackupOk(), smoke: async () => ({ ok: true }) });
    assert.equal(refused.status, 'REFUSED');
    assert.ok(!(formatDrillResult(refused) + JSON.stringify(refused)).includes(SECRET));
  });

  it('F. missing pg_restore is an explicit FAIL before any restore attempt', async () => {
    const calls: any[] = [];
    const r = await runRestoreDrill({ backupPath: '/tmp/x.dump', env: goodEnv(), exec: recordingExec(calls, null, true), verifyBackup: fakeBackupOk(), smoke: async () => ({ ok: true }) });
    assert.equal(r.status, 'FAIL');
    assert.equal(r.exitCode, 1);
    const tooling = r.steps.find((s: any) => s.id === 'restore.tooling');
    assert.equal(tooling.status, 'FAIL');
    assert.match(tooling.detail, /pg_restore is not available/);
    assert.ok(calls.every((c) => c.args[0] === '--version'), 'only the version probe ran — no restore, no verification');
    assert.ok(!r.steps.some((s: any) => s.id === 'restore.apply'));
  });

  it('G. the pipeline runs backup → restore → schema → integrity → smoke, in order, and stops at the first failure', async () => {
    const calls: any[] = [];
    const smokeCalls: string[] = [];
    const r = await runRestoreDrill({
      backupPath: '/tmp/leadflow.dump',
      env: goodEnv(),
      exec: recordingExec(calls),
      verifyBackup: fakeBackupOk(),
      smoke: async (url: string) => { smokeCalls.push(url); return { ok: true, counts: { users: 3, roles: 8, leads: 10, lead_activities: 4, scheduled_activities: 2, notifications: 5, audit_logs: 1 }, activeAdmins: 1, hasActiveLead: true }; },
    });
    assert.equal(r.status, 'PASS', formatDrillResult(r));
    assert.deepEqual(r.steps.filter((s: any) => !s.id.startsWith('guard.')).map((s: any) => s.id), [
      'backup.verify', 'restore.tooling', 'restore.apply', 'verify.schema', 'verify.integrity', 'smoke.read_only',
    ]);
    const restore = calls.find((c) => c.args.includes('--dbname'));
    assert.ok(restore, 'pg_restore invoked');
    assert.equal(restore.args[restore.args.indexOf('--dbname') + 1], SCRATCH, 'restore targets the isolated URL');
    assert.ok(restore.args.includes('--exit-on-error'));
    const schema = calls.find((c) => c.args.some((a: string) => a.endsWith('verify-db-schema.mjs')));
    const integrity = calls.find((c) => c.args.some((a: string) => a.endsWith('verify-data-integrity.mjs')));
    assert.ok(schema && integrity, 'both verification scripts are executed');
    assert.ok(calls.indexOf(restore) < calls.indexOf(schema) && calls.indexOf(schema) < calls.indexOf(integrity), 'ordering');
    assert.deepEqual(smokeCalls, [SCRATCH]);

    // Integrity failure stops before the smoke step and fails the drill.
    const smoke2: string[] = [];
    const failing = await runRestoreDrill({
      backupPath: '/tmp/leadflow.dump',
      env: goodEnv(),
      exec: recordingExec([], (_cmd, args) => args.some((a) => a.endsWith('verify-data-integrity.mjs'))),
      verifyBackup: fakeBackupOk(),
      smoke: async (url: string) => { smoke2.push(url); return { ok: true }; },
    });
    assert.equal(failing.status, 'FAIL');
    assert.equal(failing.steps.find((s: any) => s.id === 'verify.integrity').status, 'FAIL');
    assert.equal(smoke2.length, 0, 'smoke never runs after an integrity failure');

    // A failing backup verification stops before any restore.
    const restoreCalls: any[] = [];
    const badBackup = await runRestoreDrill({
      backupPath: '/tmp/leadflow.dump',
      env: goodEnv(),
      exec: recordingExec(restoreCalls),
      verifyBackup: async () => ({ ok: false, format: 'unknown', checks: [{ id: 'file.format', status: 'FAIL', detail: 'not a dump' }] }),
      smoke: async () => ({ ok: true }),
    });
    assert.equal(badBackup.status, 'FAIL');
    assert.equal(restoreCalls.length, 0);
  });

  it('H. --plan evaluates guards, backup and tooling but touches no database', async () => {
    const calls: any[] = [];
    const r = await runRestoreDrill({ backupPath: '/tmp/leadflow.dump', env: goodEnv(), exec: recordingExec(calls), verifyBackup: fakeBackupOk(), smoke: async () => { throw new Error('must not run'); }, planOnly: true });
    assert.equal(r.status, 'PASS');
    assert.ok(r.steps.some((s: any) => s.id === 'drill.plan_only'));
    assert.ok(calls.every((c) => c.args[0] === '--version'));
  });

  it('I. CLI: refused by default (exit 2) and refuses a Supabase target even with confirmation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadflow-drill-'));
    const dump = path.join(dir, 'x.dump');
    fs.writeFileSync(dump, Buffer.from('PGDMP'));
    try {
      const noConfirm = spawnSync(process.execPath, [CLI, dump], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
      assert.equal(noConfirm.status, 2, noConfirm.stdout + noConfirm.stderr);
      assert.match(noConfirm.stdout, /REFUSED/);

      const prodTarget = spawnSync(process.execPath, [CLI, dump], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH || '', [CONFIRMATION_ENV]: 'YES', [TARGET_ENV]: APP_DB },
      });
      assert.equal(prodTarget.status, 2);
      assert.match(prodTarget.stdout, /Supabase/);
      assert.ok(!prodTarget.stdout.includes(SECRET));

      const noArgs = spawnSync(process.execPath, [CLI], { encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
      assert.equal(noArgs.status, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
