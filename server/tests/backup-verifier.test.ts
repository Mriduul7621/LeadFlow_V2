/**
 * backup-verifier.test.ts — scripts/verify-backup.mjs negative & positive paths
 * ------------------------------------------------------------------
 * No PostgreSQL client tools are required: `pg_restore` is injected via a
 * fake spawn so both the "tool missing → explicit FAIL" and the
 * "tool present → catalog parsed" branches are proven deterministically.
 *
 *   A. missing file        → FAIL file.exists
 *   B. empty file          → FAIL file.size
 *   C. unrecognized format → FAIL file.format
 *   D. custom-format dump without pg_restore → FAIL catalog.pg_restore
 *      (never a fake success)
 *   E. custom-format dump with pg_restore (fake) → catalog parsed;
 *      missing critical tables fail; complete catalog passes
 *   F. plain SQL dump → scanned without pg_restore; COPY payload lines
 *      (which contain PII in the fixture) are never surfaced
 *   G. gzip plain dump detected
 *   H. sha256 mismatch fails
 *   I. CLI: usage error / missing file exit non-zero
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// @ts-ignore — untyped .mjs module (JSDoc inference is too narrow for the injected fake spawn)
import * as backupLib from '../../scripts/lib/backup-verify.mjs';

const lib: any = backupLib;
const verifyBackupFile: (filePath: string | null, opts?: any) => Promise<any> = lib.verifyBackupFile;
const detectDumpFormat: (head: Buffer, opts?: any) => string = lib.detectDumpFormat;
const parsePgRestoreList: (text: string) => { tables: Set<string>; dataTables: Set<string> } = lib.parsePgRestoreList;
const formatBackupResult: (r: any) => string = lib.formatBackupResult;
const CRITICAL_TABLES: readonly string[] = lib.CRITICAL_TABLES;

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '../..');
const CLI = path.join(ROOT, 'scripts', 'verify-backup.mjs');

const PII_ROW = 'Zebulon Quixote\t01799887766\tzebulon@example.test\tSECRET-NOTE-DO-NOT-PRINT';

function fakeTocFor(tables: string[], withData = true): string {
  const lines = [';', '; Archive created at 2026-09-14 00:00:00 UTC', ';     dbname: leadflow', ';'];
  let id = 200;
  for (const t of tables) {
    lines.push(`${id++}; 1259 1${id} TABLE public ${t} postgres`);
    if (withData) lines.push(`${id++}; 0 1${id} TABLE DATA public ${t} postgres`);
  }
  return lines.join('\n') + '\n';
}

function fakeSpawn(toc: string | null) {
  return (cmd: string, args: string[]) => {
    if (toc === null) return { error: new Error(`spawnSync ${cmd} ENOENT`), status: null, stdout: '', stderr: '' };
    if (args[0] === '--version') return { status: 0, stdout: 'pg_restore (PostgreSQL) 16.4\n', stderr: '' };
    if (args[0] === '--list') return { status: 0, stdout: toc, stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
}

function plainSqlDump(tables: string[]): string {
  const out = ['--', '-- PostgreSQL database dump', '--', '', 'SET statement_timeout = 0;', ''];
  for (const t of tables) {
    out.push(`CREATE TABLE public.${t} (`, '    id uuid NOT NULL', ');', '');
  }
  for (const t of tables) {
    out.push(`COPY public.${t} (a, b, c, d) FROM stdin;`, PII_ROW, '\\.', '');
  }
  out.push('--', '-- PostgreSQL database dump complete', '--');
  return out.join('\n') + '\n';
}

describe('Backup verifier — pg_dump artifact checks', () => {
  let dir = '';
  const p = (name: string) => path.join(dir, name);

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leadflow-backup-verify-'));
    fs.writeFileSync(p('empty.dump'), '');
    fs.writeFileSync(p('garbage.dump'), Buffer.from('this is not a dump at all\n'.repeat(20)));
    // Custom-format header: PGDMP magic + arbitrary bytes.
    fs.writeFileSync(p('custom.dump'), Buffer.concat([Buffer.from('PGDMP'), Buffer.from([1, 16, 0, 4, 8, 8, 1, 1, 0, 0]), Buffer.alloc(512, 7)]));
    fs.writeFileSync(p('plain.sql'), plainSqlDump([...CRITICAL_TABLES, 'sessions']));
    fs.writeFileSync(p('plain-missing.sql'), plainSqlDump(CRITICAL_TABLES.filter((t: string) => t !== 'leads' && t !== 'audit_logs')));
    fs.writeFileSync(p('plain.sql.gz'), zlib.gzipSync(Buffer.from(plainSqlDump([...CRITICAL_TABLES]))));
  });

  after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('A. missing file fails clearly', async () => {
    const r = await verifyBackupFile(p('does-not-exist.dump'));
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.equal(r.checks.find((c: any) => c.id === 'file.exists').status, 'FAIL');
    const nothing = await verifyBackupFile(null);
    assert.equal(nothing.ok, false);
  });

  it('B. empty file fails clearly', async () => {
    const r = await verifyBackupFile(p('empty.dump'));
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c: any) => c.id === 'file.size').status, 'FAIL');
    assert.match(r.checks.find((c: any) => c.id === 'file.size').detail, /empty/);
  });

  it('C. unrecognized format fails', async () => {
    const r = await verifyBackupFile(p('garbage.dump'));
    assert.equal(r.ok, false);
    assert.equal(r.format, 'unknown');
    assert.equal(r.checks.find((c: any) => c.id === 'file.format').status, 'FAIL');
  });

  it('D. custom-format dump without pg_restore is an explicit FAIL — never a fake success', async () => {
    const r = await verifyBackupFile(p('custom.dump'), { spawn: fakeSpawn(null), env: {} });
    assert.equal(r.format, 'custom');
    assert.equal(r.ok, false);
    const c = r.checks.find((x: any) => x.id === 'catalog.pg_restore');
    assert.equal(c.status, 'FAIL');
    assert.match(c.detail, /pg_restore is not available/);
    assert.match(c.detail, /never treated as success/);
    assert.ok(!r.checks.some((x: any) => x.id === 'catalog.critical_tables'), 'no catalog claim without a catalog');
  });

  it('E. custom-format dump with pg_restore: catalog parsed, critical tables enforced', async () => {
    const incomplete = await verifyBackupFile(p('custom.dump'), { spawn: fakeSpawn(fakeTocFor(['users', 'roles', 'leads'])), env: {} });
    assert.equal(incomplete.ok, false);
    const crit = incomplete.checks.find((x: any) => x.id === 'catalog.critical_tables');
    assert.equal(crit.status, 'FAIL');
    assert.match(crit.detail, /lead_activities/);
    assert.match(crit.detail, /audit_logs/);

    const schemaOnly = await verifyBackupFile(p('custom.dump'), { spawn: fakeSpawn(fakeTocFor([...CRITICAL_TABLES], false)), env: {} });
    assert.equal(schemaOnly.ok, false);
    assert.equal(schemaOnly.checks.find((x: any) => x.id === 'catalog.critical_table_data').status, 'FAIL');

    const complete = await verifyBackupFile(p('custom.dump'), { spawn: fakeSpawn(fakeTocFor([...CRITICAL_TABLES, 'sessions'])), env: {} });
    assert.equal(complete.ok, true, formatBackupResult(complete));
    assert.equal(complete.exitCode, 0);
    assert.equal(complete.checks.find((x: any) => x.id === 'catalog.pg_restore').status, 'PASS');
    assert.equal(complete.checks.find((x: any) => x.id === 'catalog.critical_tables').status, 'PASS');
    assert.ok(complete.tables.includes('sessions'));
    assert.match(complete.sha256, /^[0-9a-f]{64}$/);

    const parsed = parsePgRestoreList(fakeTocFor(['"Quoted"', 'plain']));
    assert.ok(parsed.tables.has('Quoted') && parsed.tables.has('plain'));
  });

  it('F. plain SQL dump is scanned without pg_restore and never surfaces row payloads', async () => {
    const ok = await verifyBackupFile(p('plain.sql'), { spawn: fakeSpawn(null), env: {} });
    assert.equal(ok.format, 'plain');
    assert.equal(ok.ok, true, formatBackupResult(ok));
    assert.ok(!ok.checks.some((x: any) => x.id === 'catalog.pg_restore'), 'plain SQL does not need pg_restore');
    const text = formatBackupResult(ok) + JSON.stringify(ok);
    for (const piece of PII_ROW.split('\t')) assert.ok(!text.includes(piece), `row payload leaked: ${piece}`);

    const missing = await verifyBackupFile(p('plain-missing.sql'), { spawn: fakeSpawn(null), env: {} });
    assert.equal(missing.ok, false);
    assert.match(missing.checks.find((x: any) => x.id === 'catalog.critical_tables').detail, /leads, audit_logs|audit_logs|leads/);
  });

  it('G. gzip-compressed plain dump is detected and scanned', async () => {
    const r = await verifyBackupFile(p('plain.sql.gz'), { spawn: fakeSpawn(null), env: {} });
    assert.equal(r.format, 'plain-gzip');
    assert.equal(r.ok, true, formatBackupResult(r));
    assert.equal(detectDumpFormat(Buffer.from('PGDMP')), 'custom');
    assert.equal(detectDumpFormat(Buffer.alloc(0)), 'unknown');
    const tar = Buffer.alloc(600); tar.write('ustar', 257, 'latin1');
    assert.equal(detectDumpFormat(tar), 'tar');
  });

  it('H. sha256 mismatch fails, match passes', async () => {
    const good = await verifyBackupFile(p('plain.sql'), { spawn: fakeSpawn(null), env: {} });
    const bad = await verifyBackupFile(p('plain.sql'), { spawn: fakeSpawn(null), env: {}, expectSha256: '0'.repeat(64) });
    assert.equal(bad.ok, false);
    assert.equal(bad.checks.find((x: any) => x.id === 'file.sha256').status, 'FAIL');
    const match = await verifyBackupFile(p('plain.sql'), { spawn: fakeSpawn(null), env: {}, expectSha256: good.sha256.toUpperCase() });
    assert.equal(match.ok, true);
  });

  it('I. CLI exits non-zero on usage error and on a missing file; never spawns pg_dump', () => {
    const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage/);

    const missing = spawnSync(process.execPath, [CLI, p('nope.dump')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /RESULT: FAIL/);

    const json = spawnSync(process.execPath, [CLI, p('plain.sql'), '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(!json.stdout.includes('SECRET-NOTE'));

    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'backup-verify.mjs'), 'utf8') + fs.readFileSync(CLI, 'utf8');
    assert.ok(!/spawn(Sync)?\(\s*['"`]pg_dump/.test(src), 'the verifier never invokes pg_dump');
    assert.ok(!/new\s+pg\.Client|from 'pg'|import pg/.test(src), 'the verifier never connects to a database');
  });
});
