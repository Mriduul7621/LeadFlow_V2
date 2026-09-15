#!/usr/bin/env node
/**
 * scripts/verify-data-integrity.mjs — READ-ONLY data-integrity check
 * ------------------------------------------------------------------
 * Verifies the LeadFlow business invariants (docs/DATA_INTEGRITY_AND_RECOVERY.md)
 * against the database at DATABASE_URL and prints PASS / WARN / FAIL.
 *
 *   DATABASE_URL="postgresql://..." npm run verify:data-integrity
 *   DATABASE_URL="postgresql://..." npm run verify:data-integrity -- --diagnostic
 *   DATABASE_URL="postgresql://..." npm run verify:data-integrity -- --json
 *
 * Guarantees:
 *   - STRICTLY READ-ONLY. Runs inside `BEGIN … SET TRANSACTION READ ONLY`
 *     and every statement is guarded to be a SELECT (scripts/lib/
 *     integrity-checks.mjs#assertReadOnlySql). It never runs migrations,
 *     never repairs, never writes telemetry to the database.
 *   - NO PII. Default output is invariant names + aggregate counts.
 *     `--diagnostic` additionally prints a bounded list of opaque row
 *     UUIDs (never names, phones, emails, notes or payloads).
 *   - BOUNDED. All detection queries are aggregates; samples are LIMITed;
 *     a statement_timeout (default 60 s, override with
 *     INTEGRITY_STATEMENT_TIMEOUT_MS) prevents a runaway scan.
 *   - EXIT CODE. 1 when any BLOCKER (FAIL/ERROR) is present, 0 otherwise
 *     (WARNINGS are reported but do not fail the run).
 *
 * This script is deliberately NOT part of CI: CI has no production
 * database. Use it in release verification, after a restore drill, and
 * during incident triage (docs/INCIDENT_RESPONSE_RUNBOOK.md §8).
 *
 * Note: the checker reads business tables in full for exact counts —
 * this is an operator tool, not a health endpoint. /api/health/readiness
 * stays a single `SELECT 1` by design.
 */

import pg from 'pg';
import { runIntegrityChecks, formatReport } from './lib/integrity-checks.mjs';

const args = new Set(process.argv.slice(2));
const DIAGNOSTIC = args.has('--diagnostic');
const JSON_OUT = args.has('--json');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? '[user]@' : ''}${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail('DATABASE_URL is not set. Refusing to run an integrity check against an unknown target.');
  }
  if (url.startsWith('pglite://')) {
    fail('DATABASE_URL points at the in-process PGlite test database; run the checker through the test-suite for that case.');
  }

  const timeoutMs = Math.max(1000, Number(process.env.INTEGRITY_STATEMENT_TIMEOUT_MS) || 60000);

  const client = new pg.Client({
    connectionString: url,
    ssl: /[?&]sslmode=disable\b/i.test(url) ? false : { rejectUnauthorized: false },
    application_name: 'leadflow-verify-data-integrity',
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (err) {
    fail(`Could not connect to the database: ${err?.message || err}`);
  }

  if (!JSON_OUT) {
    console.log(`LeadFlow data integrity check (read-only) — target ${redactUrl(url)}`);
    console.log(`mode=${DIAGNOSTIC ? 'diagnostic (opaque ids)' : 'aggregate'} statement_timeout=${timeoutMs}ms`);
    console.log('');
  }

  let report;
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    report = await runIntegrityChecks((sql, params) => client.query(sql, params), { diagnostic: DIAGNOSTIC });
  } catch (err) {
    fail(`Integrity check failed to run: ${err?.message || err}`);
  } finally {
    // Always ROLLBACK: nothing was written, but end the read-only txn cleanly.
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (connected) await client.end().catch(() => undefined);
  }

  if (JSON_OUT) {
    // Machine-readable, same PII posture (ids, counts, statuses only).
    console.log(JSON.stringify({ target: redactUrl(url), ...report }, null, 2));
  } else {
    console.log(formatReport(report));
  }
  process.exit(report.exitCode);
}

main();
