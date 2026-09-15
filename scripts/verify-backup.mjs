#!/usr/bin/env node
/**
 * scripts/verify-backup.mjs — verify a pg_dump artifact WITHOUT restoring it
 * ------------------------------------------------------------------------
 *   npm run verify:backup -- /path/to/leadflow_20260914T000000Z.dump
 *   npm run verify:backup -- /path/to/dump --sha256 <expected-digest>
 *   npm run verify:backup -- /path/to/dump --json
 *
 * Checks (docs/BACKUP_RESTORE_RUNBOOK.md §8):
 *   1. the file exists and is readable
 *   2. it is non-empty
 *   3. it is a recognizable pg_dump format (custom `PGDMP`, tar, directory,
 *      plain SQL, gzip-compressed plain SQL)
 *   4. its catalog can be listed — `pg_restore --list` for archive formats;
 *      a streaming identifier scan for plain SQL
 *   5. every CRITICAL LeadFlow table is present, with a data section
 *   6. optional: the SHA-256 matches the digest recorded at backup time
 *
 * What it will NEVER do:
 *   - create a backup (it does not spawn pg_dump and never connects to a
 *     database — producing a dump from production is a deliberate operator
 *     action documented in the runbook),
 *   - print row contents (only table identifiers from the catalog),
 *   - report success when pg_restore is missing for an archive format —
 *     that is an explicit FAIL with instructions.
 *
 * Exit code: 0 = PASS, 1 = FAIL / usage error.
 */

import { verifyBackupFile, formatBackupResult } from './lib/backup-verify.mjs';

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const JSON_OUT = argv.includes('--json');
const shaIdx = argv.indexOf('--sha256');
const expectSha256 = shaIdx >= 0 ? argv[shaIdx + 1] || null : null;

if (!positional.length) {
  console.error('✗ usage: verify-backup.mjs <path-to-pg_dump-file> [--sha256 <digest>] [--json]');
  process.exit(1);
}

const result = await verifyBackupFile(positional[0], { expectSha256 });

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatBackupResult(result));
}
process.exit(result.exitCode);
