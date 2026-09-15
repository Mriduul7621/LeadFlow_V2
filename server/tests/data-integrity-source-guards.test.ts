/**
 * data-integrity-source-guards.test.ts — static contract guards for the
 * reliability tooling (no database required)
 * ------------------------------------------------------------------
 *   1. readiness stays lightweight: health.ts and both entrypoints never
 *      query business tables (only checkDatabaseHealth → SELECT 1)
 *   2. the operator scripts are NOT wired into CI (CI has no production DB)
 *   3. verify-data-integrity runs in a READ ONLY transaction and imports
 *      only the guarded catalog
 *   4. the restore drill keeps its default-deny guards
 *   5. package.json exposes the documented commands
 *   6. the documentation exists and covers the required sections
 *   7. the user_permissions INSERT matches migration 027 (no granted_at)
 *   8. migration 042 is registered exactly once and stays NOT VALID / guarded
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BUSINESS_TABLES = ['leads', 'users', 'lead_activities', 'scheduled_activities', 'notifications', 'audit_logs'];

describe('Data integrity & recovery — source guards', () => {
  it('1. readiness and liveness never scan business tables', () => {
    const health = read('server/health.ts');
    assert.ok(!/\bSELECT\b[\s\S]{0,80}\bFROM\s+\w+/.test(health), 'health.ts contains no SQL at all');
    for (const rel of ['api/index.ts', 'server.ts']) {
      const src = read(rel);
      const start = src.indexOf('const readinessHandler');
      const end = src.indexOf("app.get('/api/health/readiness'", start);
      assert.ok(start > 0 && end > start, `${rel} defines the readiness handler`);
      const body = src.slice(start, end);
      assert.ok(body.includes('checkDatabaseHealth'), `${rel} readiness uses checkDatabaseHealth (SELECT 1)`);
      for (const t of BUSINESS_TABLES) {
        assert.ok(!new RegExp(`FROM\\s+${t}\\b`, 'i').test(body), `${rel} readiness must not read ${t}`);
      }
      assert.ok(!/COUNT\(\*\)/i.test(body), `${rel} readiness performs no counts`);
    }
    const conn = read('server/database/connection.ts');
    assert.match(conn, /export async function checkDatabaseHealth[\s\S]*?query\("SELECT 1"\)/);
  });

  it('2. the production-database tools are not part of the CI gate', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    assert.ok(files.length >= 1);
    for (const f of files) {
      const yml = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const cmd of ['verify:data-integrity', 'verify:backup', 'restore:drill', 'verify:db-schema', 'verify-data-integrity.mjs', 'restore-drill.mjs']) {
        assert.ok(!yml.includes(cmd), `${f} must not run ${cmd} (no production DB in CI)`);
      }
      assert.ok(!/DATABASE_URL\s*:/.test(yml), `${f} must not inject a DATABASE_URL`);
    }
  });

  it('3. verify-data-integrity is strictly read-only by construction', () => {
    const cli = read('scripts/verify-data-integrity.mjs');
    assert.ok(cli.includes("SET TRANSACTION READ ONLY"), 'runs in a READ ONLY transaction');
    assert.ok(cli.includes("from './lib/integrity-checks.mjs'"), 'uses the guarded catalog');
    assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\s+(INTO|FROM|TABLE|users|leads)\b/i.test(cli.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'no write statements in the CLI');
    assert.ok(!cli.includes('runMigrations'), 'never runs migrations');

    const lib = read('scripts/lib/integrity-checks.mjs');
    assert.ok(lib.includes('export function assertReadOnlySql'));
    assert.ok(lib.includes('assertReadOnlySql(check.countSql)'), 'every count query passes through the guard');
    assert.ok(lib.includes('assertReadOnlySql(check.sampleSql)'), 'every sample query passes through the guard');
    // Detection queries never project PII-bearing columns.
    for (const col of ['customer_name', 'mobile', 'email', 'notes', 'remarks', 'full_name', 'message', 'title', 'password']) {
      assert.ok(!new RegExp(`SELECT[^;]*\\b${col}\\b[^;]*FROM`, 'i').test(lib.replace(/description:.*$/gm, '')), `catalog never selects ${col}`);
    }
    const libCode = lib.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/SELECT\s+\*/i.test(libCode), 'no SELECT *');
    assert.ok(/LIMIT \$1/.test(lib), 'diagnostic samples are bounded');
  });

  it('4. the restore drill keeps default-deny, redaction and the Supabase refusal', () => {
    const lib = read('scripts/lib/restore-drill.mjs');
    assert.ok(lib.includes("ALLOW_DESTRUCTIVE_RESTORE"));
    assert.ok(lib.includes("'supabase.co'") && lib.includes("'supabase.com'"));
    assert.ok(lib.includes('export function redactDatabaseUrl'));
    assert.ok(lib.includes('RESTORE_TARGET_DATABASE_URL'));
    assert.ok(/target equals DATABASE_URL/.test(lib), 'application DB is never a target');
    const cli = read('scripts/restore-drill.mjs');
    assert.ok(!cli.includes('process.env.DATABASE_URL ='), 'the drill never rewrites DATABASE_URL in its own process');
    const verify = read('scripts/lib/backup-verify.mjs');
    assert.ok(!/pg_dump/.test(verify.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'[^']*pg_dump[^']*'/g, "''")), 'the verifier never spawns pg_dump');
    assert.ok(verify.includes('never treated as success'), 'missing pg_restore is an explicit failure');
  });

  it('5. package.json exposes the operator commands', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.scripts['verify:data-integrity'], 'node scripts/verify-data-integrity.mjs');
    assert.equal(pkg.scripts['verify:backup'], 'node scripts/verify-backup.mjs');
    assert.equal(pkg.scripts['restore:drill'], 'node scripts/restore-drill.mjs');
    assert.equal(pkg.scripts['verify:db-schema'], 'node scripts/verify-db-schema.mjs');
  });

  it('6. documentation covers the integrity model and the recovery procedure', () => {
    const integrity = read('docs/DATA_INTEGRITY_AND_RECOVERY.md');
    for (const section of ['Integrity model', 'Invariant matrix', 'Checker architecture', 'Severity model', 'Transaction audit', 'Recovery tooling', 'Restore safety model', 'Operator commands', 'Limitations', 'Deferred']) {
      assert.ok(new RegExp(section, 'i').test(integrity), `DATA_INTEGRITY_AND_RECOVERY.md covers "${section}"`);
    }
    for (const id of ['users.self_manager', 'users.manager_cycle', 'scheduled_activities.duplicate_completion', 'notifications.idempotency_key_duplicate', 'assignment_history.latest_owner_mismatch']) {
      assert.ok(integrity.includes(id), `matrix lists ${id}`);
    }
    const runbook = read('docs/BACKUP_RESTORE_RUNBOOK.md');
    for (const topic of ['verify:backup', 'restore:drill', 'ALLOW_DESTRUCTIVE_RESTORE', 'RPO', 'RTO', 'When NOT to restore', 'forward-fix vs. restore', 'Decision tree', 'verify:data-integrity', 'Evidence']) {
      assert.ok(runbook.includes(topic), `BACKUP_RESTORE_RUNBOOK.md covers "${topic}"`);
    }
    assert.ok(!/LeadFlow has (a )?verified production backup/i.test(runbook), 'never claims a verified production backup');
    const incident = read('docs/INCIDENT_RESPONSE_RUNBOOK.md');
    assert.ok(incident.includes('verify:data-integrity'));
    assert.ok(!/reliability\*\* is a planned roadmap item/.test(incident), 'stale "planned" notification reliability text removed');
  });

  it('7. PUT /users/:id/permissions matches migration 027 (no granted_at)', () => {
    const routes = read('server/routes/production.routes.ts');
    const start = routes.indexOf("router.put('/users/:id/permissions'");
    const end = routes.indexOf('router.', start + 10);
    const body = routes.slice(start, end);
    assert.ok(body.includes('INSERT INTO user_permissions (user_id, permission_id, is_allowed, reason, created_at, updated_at)'));
    assert.ok(!/granted_at/.test(body.replace(/\/\/.*$/gm, '')), 'no reference to a non-existent granted_at column');
    const migration = read('server/database/migrations/027_user_permissions.ts');
    assert.ok(!migration.includes('granted_at'));

    // Bulk-op safety: purge rejects blank filters and both routes audit.
    const purgeStart = routes.indexOf("router.delete('/leads/campaign/:campaign'");
    const purgeEnd = routes.indexOf("router.post('/leads/clear-all'", purgeStart);
    const purge = routes.slice(purgeStart, purgeEnd);
    assert.match(purge, /requireAuth, requireAdmin/);
    assert.match(purge, /if \(!campaign\)/);
    assert.match(purge, /LEAD_CAMPAIGN_PURGE/);
    const clearEnd = routes.indexOf('router.', purgeEnd + 10);
    assert.match(routes.slice(purgeEnd, clearEnd), /LEAD_CLEAR_ALL/);
  });

  it('8. migration 042 is registered once and is data-safe by construction', () => {
    const runner = read('server/database/runMigrations.ts');
    assert.equal((runner.match(/042_data_integrity_guards/g) || []).length, 1);
    assert.equal((runner.match(/run: dataIntegrityGuards/g) || []).length, 1);
    assert.ok(runner.includes('export function getLastMigrationRunSummary'));
    const m = read('server/database/migrations/042_data_integrity_guards.ts');
    assert.match(m, /CHECK \(manager_id IS NULL OR manager_id <> id\) NOT VALID/);
    assert.match(m, /HAVING COUNT\(\*\) > 1[\s\S]*RAISE WARNING/, 'duplicate links skip the index instead of failing startup');
    assert.ok(!/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE \w+ SET/i.test(m.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'no data rewrite');
  });
});
