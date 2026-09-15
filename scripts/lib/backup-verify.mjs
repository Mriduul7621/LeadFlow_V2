/**
 * scripts/lib/backup-verify.mjs — pg_dump artifact verification (library)
 * ------------------------------------------------------------------------
 * Pure verification logic behind `scripts/verify-backup.mjs` and the
 * restore drill. Kept dependency-free and injectable so the test-suite can
 * exercise every negative path (missing file, empty file, unknown format,
 * pg_restore absent, catalog missing critical tables) without PostgreSQL
 * client tools installed.
 *
 * Safety posture:
 *   - NEVER spawns pg_dump, never connects to any database. It inspects a
 *     file the operator already produced.
 *   - Prints object names only (table identifiers from the dump catalog),
 *     never row contents. Plain-SQL dumps are scanned line-by-line for
 *     `CREATE TABLE` identifiers; COPY payload lines are skipped unread.
 *   - When `pg_restore` is not available and the format requires it, the
 *     result is an explicit FAIL ("catalog could not be verified") — a
 *     missing tool must never turn into a fake PASS.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

/**
 * Tables whose loss is unrecoverable from any other source. A backup that
 * does not contain ALL of them is not a LeadFlow backup. Kept aligned with
 * EXPECTED_TABLES in scripts/verify-db-schema.mjs (the schema gate) — this
 * list is the subset that carries business data.
 */
export const CRITICAL_TABLES = Object.freeze([
  'users',
  'roles',
  'permissions',
  'role_permissions',
  'user_permissions',
  'departments',
  'teams',
  'leads',
  'lead_activities',
  'scheduled_activities',
  'notifications',
  'audit_logs',
  'options',
]);

/** Bytes inspected for format detection. */
const HEAD_BYTES = 64 * 1024;

/**
 * Detect a pg_dump artifact format from its first bytes.
 *   custom     — `PGDMP` magic (pg_dump -Fc)
 *   tar        — POSIX ustar header at offset 257 (pg_dump -Ft)
 *   plain      — SQL text beginning with the pg_dump banner
 *   plain-gzip — gzip-compressed plain SQL (pg_dump | gzip)
 *   directory  — a directory containing toc.dat (pg_dump -Fd)
 *   unknown    — anything else
 */
export function detectDumpFormat(head, { isDirectory = false, hasTocDat = false } = {}) {
  if (isDirectory) return hasTocDat ? 'directory' : 'unknown';
  if (!head || head.length === 0) return 'unknown';
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === 'PGDMP') return 'custom';
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    const inflated = safeGunzipHead(head);
    return inflated && looksLikePlainSql(inflated) ? 'plain-gzip' : 'unknown';
  }
  return looksLikePlainSql(head) ? 'plain' : 'unknown';
}

function looksLikePlainSql(buf) {
  const text = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8').replace(/^\uFEFF/, '');
  return /PostgreSQL database dump/i.test(text) || /^\s*--\s*\n--\s*PostgreSQL/i.test(text) || /^\s*SET\s+statement_timeout\b/i.test(text);
}

function safeGunzipHead(buf) {
  try {
    return zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch {
    return null;
  }
}

/** Formats whose catalog can only be read through pg_restore --list. */
export function requiresPgRestore(format) {
  return format === 'custom' || format === 'tar' || format === 'directory';
}

/**
 * Locate pg_restore. `PG_RESTORE_BIN` overrides the lookup. Returns
 * { available, bin, version } and never throws.
 */
export function locatePgRestore(env = process.env, spawn = spawnSync) {
  const bin = env.PG_RESTORE_BIN || 'pg_restore';
  try {
    const res = spawn(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (res.error || res.status !== 0) return { available: false, bin, version: null };
    return { available: true, bin, version: String(res.stdout || '').trim().split(/\r?\n/)[0] || null };
  } catch {
    return { available: false, bin, version: null };
  }
}

/**
 * Parse `pg_restore --list` output into table names. TOC lines look like:
 *   2345; 1259 16400 TABLE public leads postgres
 *   2999; 0 16400 TABLE DATA public leads postgres
 * Only identifiers are extracted; nothing else is retained.
 */
export function parsePgRestoreList(text) {
  const tables = new Set();
  const dataTables = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    let m = /^\d+;\s+\d+\s+\d+\s+TABLE\s+DATA\s+(\S+)\s+(\S+)/.exec(line);
    if (m) { dataTables.add(stripQuotes(m[2])); tables.add(stripQuotes(m[2])); continue; }
    m = /^\d+;\s+\d+\s+\d+\s+TABLE\s+(\S+)\s+(\S+)/.exec(line);
    if (m) tables.add(stripQuotes(m[2]));
  }
  return { tables, dataTables };
}

function stripQuotes(ident) {
  return String(ident).replace(/^"|"$/g, '');
}

/**
 * Scan a plain-SQL dump (optionally gzip-compressed) for CREATE TABLE and
 * COPY identifiers. Streams line by line; COPY payload rows are consumed
 * and discarded without being retained or printed.
 */
export async function scanPlainSqlTables(filePath, { gzip = false, maxLines = 50_000_000 } = {}) {
  const tables = new Set();
  const dataTables = new Set();
  let stream = fs.createReadStream(filePath);
  if (gzip) stream = stream.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lines = 0;
  let inCopy = false;
  for await (const line of rl) {
    lines += 1;
    if (lines > maxLines) break;
    if (inCopy) {
      if (line === '\\.') inCopy = false;
      continue; // payload rows are never inspected
    }
    let m = /^CREATE TABLE(?: IF NOT EXISTS)?\s+(?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?/i.exec(line);
    if (m) { tables.add(m[2]); continue; }
    m = /^COPY\s+(?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/i.exec(line);
    if (m) { dataTables.add(m[2]); tables.add(m[2]); inCopy = true; continue; }
    if (/^INSERT INTO\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/i.test(line)) {
      const mm = /^INSERT INTO\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?/i.exec(line);
      if (mm) { dataTables.add(mm[1]); tables.add(mm[1]); }
    }
  }
  return { tables, dataTables, linesScanned: lines };
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Verify a backup artifact.
 *
 * @param {string} filePath
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   spawn?: typeof spawnSync,                 // injectable for tests
 *   criticalTables?: readonly string[],
 *   expectSha256?: string | null,
 *   requireData?: boolean,                     // critical tables must have TABLE DATA entries (default true)
 * }} [opts]
 * @returns {Promise<BackupVerificationResult>}
 */
export async function verifyBackupFile(filePath, opts = {}) {
  const env = opts.env || process.env;
  const spawn = opts.spawn || spawnSync;
  const critical = opts.criticalTables || CRITICAL_TABLES;
  const requireData = opts.requireData !== false;
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail: detail || null });
  const finish = (extra = {}) => {
    const failed = checks.filter((c) => c.status === 'FAIL');
    return { file: filePath ? path.basename(filePath) : null, ok: failed.length === 0, exitCode: failed.length ? 1 : 0, checks, ...extra };
  };

  if (!filePath) {
    add('file.path', 'FAIL', 'no backup file path supplied');
    return finish({ format: 'unknown' });
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    add('file.exists', 'FAIL', 'backup file does not exist or is unreadable');
    return finish({ format: 'unknown' });
  }
  add('file.exists', 'PASS', stat.isDirectory() ? 'directory' : 'file');

  const isDirectory = stat.isDirectory();
  let hasTocDat = false;
  if (isDirectory) {
    hasTocDat = fs.existsSync(path.join(filePath, 'toc.dat'));
    if (!hasTocDat) {
      add('file.size', 'FAIL', 'directory-format dump without toc.dat');
      return finish({ format: 'unknown' });
    }
    add('file.size', 'PASS', 'directory format (toc.dat present)');
  } else if (stat.size === 0) {
    add('file.size', 'FAIL', 'backup file is empty (0 bytes)');
    return finish({ format: 'unknown', sizeBytes: 0 });
  } else {
    add('file.size', 'PASS', `${stat.size} bytes`);
  }

  let head = Buffer.alloc(0);
  if (!isDirectory) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  const format = detectDumpFormat(head, { isDirectory, hasTocDat });
  if (format === 'unknown') {
    add('file.format', 'FAIL', 'not a recognizable pg_dump artifact (expected custom/tar/directory/plain SQL)');
    return finish({ format, sizeBytes: isDirectory ? null : stat.size });
  }
  add('file.format', 'PASS', format);

  let sha256 = null;
  if (!isDirectory) {
    sha256 = sha256File(filePath);
    if (opts.expectSha256) {
      const ok = sha256.toLowerCase() === String(opts.expectSha256).toLowerCase();
      add('file.sha256', ok ? 'PASS' : 'FAIL', ok ? 'matches expected digest' : 'does NOT match the expected digest');
    } else {
      add('file.sha256', 'PASS', sha256);
    }
  }

  // ---- catalog -----------------------------------------------------------
  let catalog = null;
  if (requiresPgRestore(format)) {
    const tool = locatePgRestore(env, spawn);
    if (!tool.available) {
      add(
        'catalog.pg_restore',
        'FAIL',
        'pg_restore is not available on this machine — the archive catalog could NOT be verified. Install PostgreSQL client tools (or set PG_RESTORE_BIN) and re-run; a missing tool is never treated as success.'
      );
      return finish({ format, sizeBytes: isDirectory ? null : stat.size, sha256 });
    }
    add('catalog.pg_restore', 'PASS', tool.version || tool.bin);
    const res = spawn(tool.bin, ['--list', filePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    if (res.error || res.status !== 0) {
      const reason = res.error ? String(res.error.message || res.error) : `exit ${res.status}`;
      add('catalog.list', 'FAIL', `pg_restore --list failed (${reason.split(/\r?\n/)[0].slice(0, 160)}) — archive is unreadable or corrupt`);
      return finish({ format, sizeBytes: isDirectory ? null : stat.size, sha256 });
    }
    catalog = parsePgRestoreList(res.stdout);
    add('catalog.list', 'PASS', `${catalog.tables.size} tables in catalog`);
  } else {
    // plain / plain-gzip — no pg_restore required; scan identifiers only.
    try {
      catalog = await scanPlainSqlTables(filePath, { gzip: format === 'plain-gzip' });
      add('catalog.list', 'PASS', `${catalog.tables.size} tables found (plain SQL scan; pg_restore not required for this format)`);
    } catch (err) {
      add('catalog.list', 'FAIL', `could not scan the SQL dump: ${String(err?.message || err).split(/\r?\n/)[0].slice(0, 160)}`);
      return finish({ format, sizeBytes: stat.size, sha256 });
    }
  }

  const missing = critical.filter((t) => !catalog.tables.has(t));
  if (missing.length) {
    add('catalog.critical_tables', 'FAIL', `missing critical tables: ${missing.join(', ')}`);
  } else {
    add('catalog.critical_tables', 'PASS', `${critical.length}/${critical.length} critical tables present`);
  }

  if (requireData) {
    const noData = critical.filter((t) => catalog.tables.has(t) && !catalog.dataTables.has(t));
    if (noData.length) {
      add('catalog.critical_table_data', 'FAIL', `critical tables without a data section (schema-only dump?): ${noData.join(', ')}`);
    } else if (!missing.length) {
      add('catalog.critical_table_data', 'PASS', 'every critical table has a data section');
    }
  }

  return finish({
    format,
    sizeBytes: isDirectory ? null : stat.size,
    sha256,
    tables: [...catalog.tables].sort(),
    dataTables: [...catalog.dataTables].sort(),
  });
}

/** Human-readable lines (object names only — never data). */
export function formatBackupResult(result) {
  const lines = [];
  lines.push(`LeadFlow backup verification — ${result.ok ? 'PASS' : 'FAIL'}${result.file ? ` (${result.file})` : ''}`);
  if (result.format) lines.push(`  format: ${result.format}${result.sizeBytes != null ? `  size: ${result.sizeBytes} bytes` : ''}`);
  if (result.sha256) lines.push(`  sha256: ${result.sha256}`);
  for (const c of result.checks) {
    lines.push(`  [${c.status}] ${c.id}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  lines.push(`RESULT: ${result.ok ? 'PASS' : 'FAIL'} (exit ${result.exitCode})`);
  return lines.join('\n');
}
