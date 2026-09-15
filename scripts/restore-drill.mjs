#!/usr/bin/env node
/**
 * scripts/restore-drill.mjs — restore a backup into an ISOLATED database and prove it
 * ----------------------------------------------------------------------------------
 *   ALLOW_DESTRUCTIVE_RESTORE=YES \
 *   RESTORE_TARGET_DATABASE_URL="postgresql://user:pw@scratch-host:5432/leadflow_restore_drill" \
 *   npm run restore:drill -- /path/to/leadflow_<timestamp>.dump
 *
 *   # dry run — evaluates guards, verifies the backup and tooling, touches NO database:
 *   npm run restore:drill -- /path/to/dump --plan
 *
 * Pipeline (docs/BACKUP_RESTORE_RUNBOOK.md §9):
 *   guards → verify backup → pg_restore/psql into the target → verify-db-schema
 *   → verify-data-integrity → read-only smoke → PASS/FAIL evidence lines
 *
 * DEFAULT DENY. The drill refuses to run unless ALL of the following hold:
 *   - ALLOW_DESTRUCTIVE_RESTORE is exactly "YES"
 *   - RESTORE_TARGET_DATABASE_URL is set (DATABASE_URL is never the target)
 *   - the target host is not a Supabase host and no host/db/user name looks
 *     production-like (prod / production / live)
 *   - the target does not equal DATABASE_URL
 * The target is always echoed WITH CREDENTIALS REDACTED. Missing pg_restore /
 * psql is an explicit FAIL, never a fake success. Nothing is ever written to
 * the application database.
 *
 * Exit codes: 0 PASS · 1 FAIL · 2 REFUSED by a safety guard.
 */

import { runRestoreDrill, formatDrillResult } from './lib/restore-drill.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const PLAN = argv.includes('--plan');
const JSON_OUT = argv.includes('--json');

const result = await runRestoreDrill({ backupPath: positional[0] || null, env: process.env, planOnly: PLAN });

if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else console.log(formatDrillResult(result));
process.exit(result.exitCode);
