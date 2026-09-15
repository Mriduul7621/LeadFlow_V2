/**
 * scripts/lib/restore-drill.mjs — restore-drill safety guards + orchestration
 * ------------------------------------------------------------------------
 * Library behind `scripts/restore-drill.mjs`. Everything that decides
 * whether a restore may proceed lives here as pure functions so the guard
 * logic is unit-tested without PostgreSQL tools or a database.
 *
 * SAFETY MODEL (docs/BACKUP_RESTORE_RUNBOOK.md §9 / DATA_INTEGRITY_AND_RECOVERY.md §8)
 *
 *   default deny      Nothing destructive happens unless EVERY guard passes.
 *   explicit intent   ALLOW_DESTRUCTIVE_RESTORE=YES (exact string) is required.
 *   isolated target   RESTORE_TARGET_DATABASE_URL is required (DATABASE_URL is
 *                     deliberately NOT used as the target — the app database
 *                     is never a restore target for a drill).
 *   never production  The target is refused when its host is a Supabase host
 *                     (LeadFlow production lives there), when host / database
 *                     / user names look production-like (prod, production,
 *                     live), or when it equals DATABASE_URL.
 *   redaction         The target is echoed with credentials removed, always.
 *   no fake success   Missing pg_restore / psql → explicit FAIL, never "ok".
 *   evidence          Every step reports PASS/FAIL with timestamps; the
 *                     backup SHA-256 is recorded for the drill log.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBackupFile, requiresPgRestore, locatePgRestore } from './backup-verify.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.resolve(path.dirname(__filename), '..');

export const CONFIRMATION_ENV = 'ALLOW_DESTRUCTIVE_RESTORE';
export const CONFIRMATION_VALUE = 'YES';
export const TARGET_ENV = 'RESTORE_TARGET_DATABASE_URL';

/** Hosts that are ALWAYS refused: LeadFlow production is hosted here. */
export const REFUSED_HOST_SUFFIXES = Object.freeze([
  'supabase.co',
  'supabase.com',
  'supabase.in',
  'supabase.net',
]);

/** Name fragments (host, db name, user) that mark a production-like target. */
export const PRODUCTION_LIKE_PATTERN = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;

/* ==================================================================== */
/* URL helpers                                                           */
/* ==================================================================== */

export function parseDatabaseUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (!/^postgres(ql)?:$/.test(u.protocol)) return null;
    return {
      protocol: u.protocol,
      host: u.hostname.toLowerCase(),
      port: u.port || '5432',
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      user: decodeURIComponent(u.username || ''),
      hasPassword: Boolean(u.password),
      search: u.search || '',
    };
  } catch {
    return null;
  }
}

/** Credential-free echo of a database URL (never throws). */
export function redactDatabaseUrl(url) {
  const p = parseDatabaseUrl(url);
  if (!p) return '[invalid or non-postgres url]';
  return `${p.protocol}//${p.user ? '[user]@' : ''}${p.host}:${p.port}/${p.database || '[no-db]'}${p.search ? ' [params]' : ''}`;
}

export function isRefusedHost(host) {
  const h = String(host || '').toLowerCase();
  return REFUSED_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

export function isProductionLikeName(value) {
  return PRODUCTION_LIKE_PATTERN.test(String(value || ''));
}

/**
 * Classify a restore TARGET. Returns { allowed, reasons[] , redacted }.
 * `appDatabaseUrl` (DATABASE_URL) is only used for the equality guard.
 */
export function classifyRestoreTarget(targetUrl, appDatabaseUrl = null) {
  const reasons = [];
  const p = parseDatabaseUrl(targetUrl);
  if (!p) {
    return { allowed: false, reasons: [`${TARGET_ENV} is missing or not a postgres:// URL`], redacted: redactDatabaseUrl(targetUrl) };
  }
  if (isRefusedHost(p.host)) reasons.push(`target host is a Supabase host (${p.host}); LeadFlow production lives on Supabase — a drill never targets it`);
  if (isProductionLikeName(p.host)) reasons.push('target host name looks production-like (prod/production/live)');
  if (isProductionLikeName(p.database)) reasons.push('target database name looks production-like (prod/production/live)');
  if (isProductionLikeName(p.user)) reasons.push('target user name looks production-like (prod/production/live)');
  if (!p.database) reasons.push('target URL has no database name');
  if (appDatabaseUrl) {
    const a = parseDatabaseUrl(appDatabaseUrl);
    if (a && a.host === p.host && a.port === p.port && a.database === p.database) {
      reasons.push('target equals DATABASE_URL (the application database is never a drill target)');
    }
  }
  return { allowed: reasons.length === 0, reasons, redacted: redactDatabaseUrl(targetUrl) };
}

/**
 * Evaluate every guard. Pure: reads only the provided env object.
 * Returns { allowed, decisions: [{ id, status: 'PASS'|'FAIL', detail }], target }.
 */
export function evaluateRestoreGuards({ env = {}, backupPath = null } = {}) {
  const decisions = [];
  const add = (id, ok, detail) => decisions.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

  add('guard.backup_path', Boolean(backupPath), backupPath ? path.basename(backupPath) : 'no backup file argument supplied');

  const confirm = env[CONFIRMATION_ENV];
  add(
    'guard.explicit_confirmation',
    confirm === CONFIRMATION_VALUE,
    confirm === CONFIRMATION_VALUE
      ? `${CONFIRMATION_ENV}=${CONFIRMATION_VALUE}`
      : `${CONFIRMATION_ENV} must be exactly "${CONFIRMATION_VALUE}" (default deny)`
  );

  const targetUrl = env[TARGET_ENV] || null;
  add('guard.target_configured', Boolean(targetUrl), targetUrl ? `target ${redactDatabaseUrl(targetUrl)}` : `${TARGET_ENV} is required (DATABASE_URL is never used as a restore target)`);

  const target = classifyRestoreTarget(targetUrl, env.DATABASE_URL || null);
  if (targetUrl) {
    add('guard.target_not_production', target.allowed, target.allowed ? 'target is not production-like' : target.reasons.join('; '));
  }

  const allowed = decisions.every((d) => d.status === 'PASS');
  return { allowed, decisions, target: { url: targetUrl, redacted: target.redacted } };
}

/* ==================================================================== */
/* Orchestration                                                         */
/* ==================================================================== */

function defaultExec(cmd, args, env) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
  return { status: res.error ? -1 : res.status, stdout: res.stdout || '', stderr: res.error ? String(res.error.message || res.error) : res.stderr || '' };
}

/** Default read-only smoke: bounded SELECTs inside a READ ONLY transaction. */
async function defaultSmoke(targetUrl) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: targetUrl,
    ssl: /[?&]sslmode=disable\b/i.test(targetUrl) ? false : { rejectUnauthorized: false },
    application_name: 'leadflow-restore-drill-smoke',
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query('SET LOCAL statement_timeout = 60000');
    const counts = {};
    for (const t of ['users', 'roles', 'permissions', 'leads', 'lead_activities', 'scheduled_activities', 'notifications', 'audit_logs']) {
      const r = await client.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
      counts[t] = Number(r.rows[0].c);
    }
    const admin = await client.query(
      `SELECT COUNT(*)::int AS c FROM users u JOIN roles r ON r.id = u.role_id WHERE UPPER(r.role_code) IN ('ADMIN','SUPERADMIN') AND u.is_active IS DISTINCT FROM FALSE`
    );
    const recentLead = await client.query(`SELECT COUNT(*)::int AS c FROM (SELECT 1 FROM leads WHERE is_deleted = FALSE ORDER BY created_at DESC LIMIT 1) x`);
    await client.query('ROLLBACK');
    return {
      ok: counts.users > 0 && counts.roles > 0 && Number(admin.rows[0].c) > 0,
      counts,
      activeAdmins: Number(admin.rows[0].c),
      hasActiveLead: Number(recentLead.rows[0].c) > 0,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Run the drill: guards → verify backup → restore → schema → integrity →
 * read-only smoke. Every step is recorded; the first FAIL stops the run.
 *
 * Injectable for tests: `exec(cmd, args, env)`, `smoke(targetUrl)`,
 * `verifyBackup(path)`, `now()`.
 */
export async function runRestoreDrill({
  backupPath,
  env = process.env,
  exec = defaultExec,
  smoke = defaultSmoke,
  verifyBackup = (p) => verifyBackupFile(p, { env }),
  planOnly = false,
  now = () => new Date(),
} = {}) {
  const steps = [];
  const startedAt = now().toISOString();
  const step = (id, status, detail, extra = {}) => {
    steps.push({ id, status, detail: detail || null, at: now().toISOString(), ...extra });
  };
  // 1. guards -------------------------------------------------------------
  const guards = evaluateRestoreGuards({ env, backupPath });
  const result = (status) => ({
    status,
    exitCode: status === 'PASS' ? 0 : status === 'REFUSED' ? 2 : 1,
    startedAt,
    finishedAt: now().toISOString(),
    steps,
    target: guards.target.redacted,
    planOnly,
  });
  for (const d of guards.decisions) step(d.id, d.status, d.detail);
  if (!guards.allowed) {
    step('drill.refused', 'FAIL', 'one or more safety guards failed — nothing was executed against any database');
    return result('REFUSED');
  }
  const targetUrl = guards.target.url;

  // 2. backup verification -------------------------------------------------
  const backup = await verifyBackup(backupPath);
  step('backup.verify', backup.ok ? 'PASS' : 'FAIL', backup.ok ? `format=${backup.format} sha256=${backup.sha256 || 'n/a'}` : backup.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.id}: ${c.detail}`).join('; '), {
    format: backup.format,
    sha256: backup.sha256 || null,
  });
  if (!backup.ok) return result('FAIL');

  // 3. tooling -------------------------------------------------------------
  const needsPgRestore = requiresPgRestore(backup.format);
  const restoreTool = needsPgRestore ? locatePgRestore(env, (cmd, args) => {
    const r = exec(cmd, args, env);
    return { status: r.status, stdout: r.stdout, error: r.status === -1 ? new Error(r.stderr) : undefined };
  }) : { available: true, bin: env.PSQL_BIN || 'psql', version: null };
  if (needsPgRestore && !restoreTool.available) {
    step('restore.tooling', 'FAIL', 'pg_restore is not available — cannot restore an archive-format dump (install PostgreSQL client tools or set PG_RESTORE_BIN)');
    return result('FAIL');
  }
  if (!needsPgRestore) {
    const psqlProbe = exec(restoreTool.bin, ['--version'], env);
    if (psqlProbe.status !== 0) {
      step('restore.tooling', 'FAIL', 'psql is not available — cannot restore a plain-SQL dump (install PostgreSQL client tools or set PSQL_BIN)');
      return result('FAIL');
    }
  }
  step('restore.tooling', 'PASS', needsPgRestore ? `pg_restore (${restoreTool.version || restoreTool.bin})` : 'psql');

  if (planOnly) {
    step('drill.plan_only', 'PASS', 'plan mode: guards, backup verification and tooling checked; no database was touched');
    return result('PASS');
  }

  // 4. restore into the ISOLATED target -----------------------------------
  const childEnv = { ...env, DATABASE_URL: targetUrl };
  let restore;
  if (needsPgRestore) {
    restore = exec(
      restoreTool.bin,
      ['--dbname', targetUrl, '--no-owner', '--no-privileges', '--clean', '--if-exists', '--exit-on-error', backupPath],
      env
    );
  } else {
    const psqlArgs = ['--dbname', targetUrl, '-v', 'ON_ERROR_STOP=1', '--quiet'];
    if (backup.format === 'plain-gzip') {
      // psql cannot read gzip directly; stream through gunzip.
      restore = exec('sh', ['-c', `gunzip -c "$0" | "${restoreTool.bin}" --dbname "$1" -v ON_ERROR_STOP=1 --quiet`, backupPath, targetUrl], env);
    } else {
      restore = exec(restoreTool.bin, [...psqlArgs, '-f', backupPath], env);
    }
  }
  step('restore.apply', restore.status === 0 ? 'PASS' : 'FAIL', restore.status === 0 ? 'restore completed' : `restore exited ${restore.status}: ${firstLine(restore.stderr)}`);
  if (restore.status !== 0) return result('FAIL');

  // 5. schema verification (existing gate, read-only) ---------------------
  const schema = exec(process.execPath, [path.join(SCRIPTS_DIR, 'verify-db-schema.mjs')], childEnv);
  step('verify.schema', schema.status === 0 ? 'PASS' : 'FAIL', schema.status === 0 ? 'verify-db-schema passed' : `verify-db-schema exited ${schema.status}: ${firstLine(schema.stderr || schema.stdout)}`);
  if (schema.status !== 0) return result('FAIL');

  // 6. integrity verification (read-only) ---------------------------------
  const integrity = exec(process.execPath, [path.join(SCRIPTS_DIR, 'verify-data-integrity.mjs')], childEnv);
  step('verify.integrity', integrity.status === 0 ? 'PASS' : 'FAIL', integrity.status === 0 ? 'verify-data-integrity passed (see its output for WARNINGS)' : `verify-data-integrity exited ${integrity.status}: ${lastResultLine(integrity.stdout) || firstLine(integrity.stderr)}`);
  if (integrity.status !== 0) return result('FAIL');

  // 7. read-only smoke -----------------------------------------------------
  try {
    const s = await smoke(targetUrl);
    step(
      'smoke.read_only',
      s.ok ? 'PASS' : 'FAIL',
      `users=${s.counts?.users ?? '?'} roles=${s.counts?.roles ?? '?'} leads=${s.counts?.leads ?? '?'} activities=${s.counts?.lead_activities ?? '?'} scheduled=${s.counts?.scheduled_activities ?? '?'} notifications=${s.counts?.notifications ?? '?'} audit=${s.counts?.audit_logs ?? '?'} activeAdmins=${s.activeAdmins ?? '?'}`
    );
    if (!s.ok) return result('FAIL');
  } catch (err) {
    step('smoke.read_only', 'FAIL', `smoke queries failed: ${firstLine(err?.message || String(err))}`);
    return result('FAIL');
  }

  return result('PASS');
}

function firstLine(s) {
  return String(s || '').split(/\r?\n/).find((l) => l.trim()) || '';
}
function lastResultLine(s) {
  return String(s || '').split(/\r?\n/).reverse().find((l) => /^RESULT:/.test(l)) || '';
}

export function formatDrillResult(r) {
  const lines = [];
  lines.push(`LeadFlow restore drill — ${r.status}${r.planOnly ? ' (plan only)' : ''}`);
  lines.push(`  target: ${r.target}`);
  lines.push(`  started: ${r.startedAt}  finished: ${r.finishedAt}`);
  for (const s of r.steps) {
    lines.push(`  [${s.status}] ${s.id}${s.detail ? ` — ${s.detail}` : ''}`);
  }
  lines.push(`RESULT: ${r.status} (exit ${r.exitCode})`);
  return lines.join('\n');
}
