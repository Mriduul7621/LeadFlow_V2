/**
 * migrate-production.ts — deploy-time schema migration entry point
 * ------------------------------------------------------------------
 * Usage
 *   npm run migrate:production            # apply pending migrations + seeds
 *   npm run migrate:production -- --check # report only; exit 1 if pending
 *   npm run migrate:production -- --force # run even outside a prod build
 *
 * Why you would run this at deploy time
 *   The runtime path already converges the schema (ledger-backed, a few
 *   round trips when nothing is pending — see database/migrationLedger.ts).
 *   Running this in the deploy pipeline moves even those few round trips
 *   off the first request after a release, so no user ever waits for DDL.
 *
 * Safety
 *   - `--check` never writes: it reports the ledger state and exits.
 *   - Without --force this refuses to touch a database from a development
 *     or preview context (VERCEL_ENV=preview/development), because those
 *     environments may point at shared data.
 *   - Errors are non-fatal by default so a deploy never breaks because the
 *     database was briefly unreachable; set MIGRATE_STRICT=1 to fail hard.
 *   - No credentials, hostnames or SQL are printed.
 */

import { isDatabaseConfigured, resolveConnectionString } from '../server/database/connection.js';

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const forced = argv.includes('--force') || String(process.env.ALLOW_MIGRATE_DB || '') === '1';
const strict = String(process.env.MIGRATE_STRICT || '') === '1';

function describeTarget(): string {
  const url = resolveConnectionString();
  if (!url) return 'none';
  if (url.startsWith('pglite://')) return 'pglite (in-memory)';
  try {
    const parsed = new URL(url);
    const port = parsed.port ? `:${parsed.port}` : '';
    // Host only — never the user, password or database name.
    return `${parsed.hostname}${port}${/:6543\b/.test(url) ? ' (pooler)' : ''}`;
  } catch {
    return 'unparsable connection string';
  }
}

function isNonProductionContext(): boolean {
  const vercelEnv = String(process.env.VERCEL_ENV || '').toLowerCase();
  if (vercelEnv === 'preview' || vercelEnv === 'development') return true;
  if (process.env.VERCEL && !vercelEnv) return true;
  return process.env.NODE_ENV !== 'production' && !process.env.VERCEL_ENV;
}

async function main(): Promise<void> {
  if (!isDatabaseConfigured()) {
    console.log('[db-migrate] No database configured — nothing to do.');
    return;
  }

  console.log(`[db-migrate] Target: ${describeTarget()}`);

  if (checkOnly) {
    const { loadLedger } = await import('../server/database/migrationLedger.js');
    const { MIGRATION_IDS } = await import('../server/database/runMigrations.js');
    const ledger = await loadLedger();
    const pending = MIGRATION_IDS.filter(id => !ledger.applied.has(id));
    console.log(
      JSON.stringify({
        event: 'schema_migration_check',
        known: MIGRATION_IDS.length,
        applied: ledger.applied.size,
        pending,
      })
    );
    if (pending.length) {
      console.error(
        `[db-migrate] ${pending.length} migration(s) pending — run "npm run migrate:production".`
      );
      process.exitCode = 1;
    }
    return;
  }

  if (!forced && isNonProductionContext()) {
    console.log(
      '[db-migrate] Skipped: not a production context. ' +
        'Run with --force (or ALLOW_MIGRATE_DB=1) to migrate this database on purpose.'
    );
    return;
  }

  const startedAt = Date.now();
  const { runMigrations } = await import('../server/database/runMigrations.js');
  const { runSeeds } = await import('../server/database/runSeeds.js');

  const migrations = await runMigrations();
  const seeds = await runSeeds();

  console.log(
    JSON.stringify({
      event: 'production_database_migration_complete',
      durationMs: Date.now() - startedAt,
      applied: migrations.applied.length,
      upToDate: migrations.upToDate,
      adoptedLegacySchema: migrations.adopted,
      seedsSkipped: seeds.skipped,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
    })
  );
}

main()
  .catch(error => {
    const message = error?.message || String(error);
    if (strict) {
      console.error('[db-migrate] FAILED:', message);
      process.exitCode = 1;
    } else {
      console.warn(
        `[db-migrate] Not applied (${message}). The runtime will converge the schema on boot.`
      );
    }
  })
  .finally(async () => {
    try {
      const { closePool } = await import('../server/database/connection.js');
      await closePool();
    } catch {
      /* ignore */
    }
  });
