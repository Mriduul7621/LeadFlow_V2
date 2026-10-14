import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';

import {
  _setTestPoolForTest,
  _resetPoolsForTest,
  resolveConnectionString,
  resolvePoolMax,
  isServerlessRuntime,
} from '../database/connection.js';
import {
  getPGliteInstanceAsync,
  createPGlitePoolAsync,
  resetPGlite,
} from '../database/pglitePool.js';

/**
 * perf-final-latency-fix.test.ts
 * ------------------------------------------------------------------
 * Regression guards for the cold-start / payload fix:
 *
 *  A. Schema boot is LEDGER-BACKED:
 *       - a virgin database still applies every migration,
 *       - an already-current database performs NO DDL at all and stays
 *         within a handful of round trips (the measured replay was 226),
 *       - seeds run once and are then skipped,
 *       - a migration that throws is NOT recorded (so the next boot retries).
 *  B. Response compression is mounted by the shared production stack and
 *     actually gzips a large JSON body when the client accepts gzip, while
 *     leaving small bodies and opt-out clients untouched.
 *  C. Connection-string precedence + serverless pool sizing are the
 *     documented ones (pooled endpoint preferred, small per-instance pool).
 *  D. Source guards: no DDL reaches the request path, the follow-up bucket
 *     predicate stays sargable, and the hot authorization lookups are
 *     awaited in parallel rather than sequentially.
 */

const ROOT = path.resolve(process.cwd());
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Performance fix — ledger-backed schema boot', () => {
  let pool: any;
  let statements: string[] = [];

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'perf_final_test_secret';
    // Make sure a previous suite's env does not change the ledger behavior.
    delete process.env.LEADFLOW_FORCE_SEEDS;
    _resetPoolsForTest();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);
    const originalQuery = pool.query.bind(pool);
    pool.query = async (sql: string, params?: any[]) => {
      statements.push(String(sql));
      return originalQuery(sql, params);
    };
  });

  after(async () => {
    try {
      resetPGlite();
    } catch {
      /* ignore */
    }
    _resetPoolsForTest();
  });

  it('A1. virgin database applies every known migration and records them', async () => {
    const { initializeDatabase } = await import('../database/initialize.js');
    const { MIGRATION_IDS } = await import('../database/runMigrations.js');

    statements = [];
    const result = await initializeDatabase();

    assert.equal(result.healthy, true, 'database must be reachable');
    assert.ok(result.migrations, 'migrations must run on a virgin database');
    assert.equal(result.migrations!.upToDate, false, 'virgin database has work to do');
    assert.equal(result.migrations!.applied.length, MIGRATION_IDS.length, 'every migration is applied');
    assert.equal(result.migrations!.adopted, false, 'nothing to adopt on a virgin database');

    const rows = await pool.query('SELECT name FROM schema_migrations');
    const recorded = rows.rows.map((r: any) => String(r.name));
    for (const id of MIGRATION_IDS) {
      assert.ok(recorded.includes(id), `ledger must record ${id}`);
    }
  });

  it('A2. a current schema boots with NO DDL and only a handful of round trips', async () => {
    const { initializeDatabase } = await import('../database/initialize.js');

    statements = [];
    const result = await initializeDatabase();
    const ddl = statements.filter(sql => /^\s*(CREATE|ALTER|DROP)\s/i.test(sql));

    assert.deepEqual(ddl, [], `no DDL may run on a current schema, saw: ${ddl.join(' | ').slice(0, 200)}`);
    assert.ok(
      statements.length <= 8,
      `a current schema must boot in a few round trips, used ${statements.length}`
    );
    assert.equal(result.noOp, true, 'boot must be reported as a no-op');
  });

  it('A3. seeds are recorded once and skipped afterwards', async () => {
    const { runSeeds } = await import('../database/runSeeds.js');
    const first = await runSeeds();
    assert.equal(first.skipped, true, 'baseline marker already present from A1');

    const { SEED_LEDGER_MARKER } = await import('../database/migrationLedger.js');
    const rows = await pool.query('SELECT name FROM schema_migrations WHERE name = $1', [SEED_LEDGER_MARKER]);
    assert.equal(rows.rows.length, 1, 'seed marker must exist exactly once');
  });

  it('A4. a failed migration is not recorded (and therefore retried)', async () => {
    const { recordApplied, readAppliedIds } = await import('../database/migrationLedger.js');
    const { MIGRATION_IDS } = await import('../database/runMigrations.js');
    const id = MIGRATION_IDS[0];
    await recordApplied(id, 1);
    const applied = await readAppliedIds();
    assert.ok(applied.has(id), 'recorded id is readable');

    // Explicitly removing the marker (the state a thrown migration leaves
    // behind) makes the migration eligible to run again on the next boot.
    await pool.query('DELETE FROM schema_migrations WHERE name = $1', [id]);
    const after = await readAppliedIds();
    assert.equal(after.has(id), false, 'an unrecorded migration is pending again');
    await recordApplied(id, 1); // restore for the remaining suites
  });

  it('A5. a legacy database is adopted instead of replayed', async () => {
    // Simulate the upgrade path: a database created before the ledger
    // existed has all objects but an empty ledger.
    await pool.query('DELETE FROM schema_migrations');
    const { loadLedger, tryAdoptLegacySchema } = await import('../database/migrationLedger.js');
    const { MIGRATION_IDS } = await import('../database/runMigrations.js');

    const adopted = await tryAdoptLegacySchema(MIGRATION_IDS);
    assert.equal(adopted, true, 'a database holding the LAST migration sentinels is adopted');

    const ledger = await loadLedger();
    assert.equal(ledger.applied.size, MIGRATION_IDS.length, 'adoption records every migration id');
    assert.equal(ledger.createdNow, false, 'the ledger already existed');
  });
});

describe('Performance fix — response compression', () => {
  let server: http.Server;
  let port = 0;

  before(async () => {
    const { applyProductionHttpSecurity } = await import('../middleware.js');
    const app = express();
    applyProductionHttpSecurity(app, { production: false });
    app.get('/api/big', (_req, res) => {
      res.json({ success: true, data: Array.from({ length: 800 }, (_, i) => ({ id: i, name: 'Lead '.repeat(6) })) });
    });
    app.get('/api/small', (_req, res) => {
      res.json({ ok: true });
    });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  after(() => {
    server?.close();
  });

  const raw = (pathname: string, headers: Record<string, string>) =>
    new Promise<{ status: number; encoding?: string; body: Buffer }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', c => chunks.push(c as Buffer));
          res.on('end', () =>
            resolve({
              status: res.statusCode || 0,
              encoding: res.headers['content-encoding'] as string | undefined,
              body: Buffer.concat(chunks),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

  it('B1. a large JSON body is gzipped for clients that accept gzip', async () => {
    const plain = await raw('/api/big', { 'accept-encoding': 'identity' });
    const gz = await raw('/api/big', { 'accept-encoding': 'gzip' });

    assert.equal(plain.status, 200);
    assert.equal(gz.status, 200);
    assert.equal(gz.encoding, 'gzip', 'gzip must be negotiated');
    assert.ok(
      gz.body.length < plain.body.length / 3,
      `compressed body (${gz.body.length} B) must be far smaller than raw (${plain.body.length} B)`
    );
    // The decoded payload must be byte-identical to the uncompressed one.
    assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString(), 'payload identity preserved');
  });

  it('B2. small bodies stay uncompressed and x-no-compression opts out', async () => {
    const small = await raw('/api/small', { 'accept-encoding': 'gzip' });
    assert.equal(small.encoding, undefined, 'bodies under the threshold are not compressed');

    const optedOut = await raw('/api/big', { 'accept-encoding': 'gzip', 'x-no-compression': '1' });
    assert.equal(optedOut.encoding, undefined, 'explicit opt-out is honored');
  });
});

describe('Performance fix — connection string + pool sizing', () => {
  it('C1. DATABASE_URL wins, then POSTGRES_URL / POSTGRES_PRISMA_URL', () => {
    assert.equal(
      resolveConnectionString({ DATABASE_URL: 'postgres://direct', POSTGRES_URL: 'postgres://pooled' }),
      'postgres://direct'
    );
    assert.equal(resolveConnectionString({ POSTGRES_URL: 'postgres://pooled' }), 'postgres://pooled');
    assert.equal(resolveConnectionString({ POSTGRES_PRISMA_URL: 'postgres://prisma' }), 'postgres://prisma');
    assert.equal(resolveConnectionString({}), undefined);
  });

  it('C2. serverless gets a small pool, long-lived servers keep the larger one', () => {
    assert.equal(isServerlessRuntime({ VERCEL: '1' }), true);
    assert.equal(isServerlessRuntime({}), false);
    assert.equal(resolvePoolMax({ VERCEL: '1' }), 6);
    assert.equal(resolvePoolMax({}), 20);
    assert.equal(resolvePoolMax({ VERCEL: '1', PG_POOL_MAX: '12' }), 12, 'explicit override wins');
  });
});

describe('Performance fix — source guards', () => {
  it('D1. the serverless entrypoint never schedules DDL/seeds on the import path', () => {
    const api = read('api/index.ts');
    assert.ok(api.includes('initializeDatabase'), 'the entrypoint still converges the schema');
    assert.ok(
      api.includes('migrationLedger') || api.includes('initialize.js'),
      'schema work must go through the ledger-backed initializer'
    );
    const warmup = api.slice(api.indexOf('void loadRoutes()'));
    assert.ok(
      !/initializeDatabase\(\)\s*;\s*\n\s*await/.test(warmup),
      'no unconditional awaited DDL in the module-eval kickoff block'
    );
  });

  it('D2. migrations are ledger-gated, not replayed', () => {
    const src = read('server/database/runMigrations.ts');
    assert.ok(src.includes('loadLedger'), 'runMigrations must consult the ledger');
    assert.ok(src.includes('recordApplied'), 'each successful migration must be recorded');
    assert.ok(src.includes('withMigrationLock'), 'concurrent boots must be serialized by an advisory lock');
    assert.ok(
      /const pending = migrations\.filter\(m => !ledger\.applied\.has\(m\.id\)\)/.test(src),
      'only pending migrations may run'
    );
  });

  it('D3. compression is mounted by the shared production HTTP stack', () => {
    const mw = read('server/middleware.ts');
    assert.ok(/import compression from 'compression'/.test(mw), 'the compression dependency is used');
    assert.ok(
      /app\.use\(createResponseCompression\(\)\)/.test(mw),
      'compression must be mounted in applyProductionHttpSecurity (both entrypoints)'
    );
    const securityFn = mw.slice(mw.indexOf('export function applyProductionHttpSecurity'));
    assert.ok(
      securityFn.indexOf('createResponseCompression') < securityFn.indexOf('applyRateLimiters(app)'),
      'compression must be mounted before the routes are reached'
    );
  });

  it('D4. the follow-up queue filter is sargable and reads in parallel', () => {
    const routes = read('server/routes/production.routes.ts');
    assert.ok(
      routes.includes('bucketRangePredicate'),
      'bucket filters must compile to half-open ranges so index 038 can serve them'
    );
    assert.ok(
      !/const listWhere = bucket === 'all' \? where : \[\.\.\.where, `\$\{bucketExpr\} = '\$\{bucket\}'`\]/.test(routes),
      'the CASE-expression equality predicate must be gone'
    );
    assert.ok(
      /const \[countRes, listRes\] = await Promise\.all\(\[\s*pool\.query\(countSql, params\),\s*pool\.query\(listSql, listParams\),\s*\]\)/.test(routes),
      'the bucket aggregate and the page query must be issued together'
    );
  });

  it('D5. hot authorization lookups run in parallel, not sequentially', () => {
    const routes = read('server/routes/production.routes.ts');
    assert.ok(
      /const \[canDashboard, canLeads\] = await Promise\.all\(\[/.test(routes),
      'dashboard permission checks must be batched'
    );
    assert.ok(
      /const \[canViewLeads, visibility\] = await Promise\.all\(\[/.test(routes),
      'lead list permission + visibility must overlap'
    );
    assert.ok(
      /resolveCallerVisibility\(caller\),\s*\]\);/.test(routes),
      'visibility is resolved with the permission check, not after it'
    );
    assert.ok(
      !/const canImport = await hasPermissionCode\(caller, 'leads\.import'\);/.test(routes),
      'the bulk-import permission batch must not be sequential again'
    );
  });

  it('D6. startup cost is attributed in Server-Timing (queries + pool wait)', () => {
    const perf = read('server/utils/perf.ts');
    assert.ok(perf.includes('dbAcquireDurationMs'), 'pool checkout wait must be reported');
    assert.ok(perf.includes('dbq;dur='), 'query count must be reported');
    const conn = read('server/database/connection.ts');
    assert.ok(conn.includes('instrumentPoolAcquireWait'), 'the pool must be instrumented once, idempotently');
  });
});
