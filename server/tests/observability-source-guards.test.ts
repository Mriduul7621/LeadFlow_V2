/**
 * observability-source-guards.test.ts — targeted observability source guards
 * ------------------------------------------------------------------
 * These guards pin the STRUCTURAL privacy rules of the observability
 * layer (the behavior suite in production-observability.test.ts proves
 * runtime behavior; these scan the sources so the rules cannot be
 * quietly removed):
 *
 *   1. No request/response dumping anywhere in server/entry sources:
 *      no console.*(req.body / req.headers / headers), no
 *      JSON.stringify(req …), no Authorization/Cookie dumps.
 *      (Deliberately NOT a blanket console ban — startup/ops lines such
 *      as "[config] …" remain legitimate.)
 *   2. The structured logger never persists anywhere: no pg/Pool, no
 *      database imports, no filesystem or network writes inside
 *      server/observability.
 *   3. The observability middleware is mounted BEFORE the rate limiters
 *      and body parsers in the shared pipeline (so 429s/parser errors
 *      are correlated).
 *   4. The DB pool is instrumented exactly at the pool factory.
 *   5. The DB slow-query event can never carry SQL text or parameters
 *      (its allowlist has no such field).
 *   6. Both entrypoints use the structured readiness event (not the old
 *      per-probe console line).
 *   7. Auth events are emitted through the central allowlisted catalog.
 *   8. The production observability documentation exists.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'node_modules') continue;
      collectSources(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SERVER_SOURCES = collectSources(path.join(ROOT, 'server'))
  .concat([path.join(ROOT, 'api', 'index.ts'), path.join(ROOT, 'server.ts')])
  .map((f) => path.relative(ROOT, f));

/* ================================================================== */

describe('Observability source guards', () => {
  it('1. no console.* request/header/authorization dumping in server sources', () => {
    const forbidden: Array<[RegExp, string]> = [
      [/console\.(log|info|warn|error)\(\s*req\.body/, 'console.*(req.body)'],
      [/console\.(log|info|warn|error)\(\s*req\.headers/, 'console.*(req.headers)'],
      [/console\.(log|info|warn|error)\(\s*headers\b/, 'console.*(headers)'],
      [/console\.(log|info|warn|error)\([^\n]*headers\.authorization/i, 'console dump of Authorization'],
      [/console\.(log|info|warn|error)\([^\n]*headers\.cookie/i, 'console dump of Cookie'],
      [/JSON\.stringify\(\s*req\s*[),]/, 'JSON.stringify(req)'],
      [/JSON\.stringify\(\s*res\s*[),]/, 'JSON.stringify(res)'],
    ];
    for (const rel of SERVER_SOURCES) {
      const src = read(rel);
      for (const [pattern, label] of forbidden) {
        assert.ok(!pattern.test(src), `${label} found in ${rel}`);
      }
    }
  });

  it('2. the structured logger never persists to DB, disk or a network service', () => {
    const observabilityDir = path.join(ROOT, 'server', 'observability');
    for (const file of fs.readdirSync(observabilityDir).filter((f) => f.endsWith('.ts'))) {
      const rel = `server/observability/${file}`;
      const src = read(rel);
      const importPattern = /(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
      const imports: string[] = [];
      for (const m of src.matchAll(importPattern)) imports.push(m[1] || m[2] || '');
      assert.ok(!imports.some((i) => i === 'pg' || i.startsWith('pg/')), `${rel} imports pg: ${imports}`);
      assert.ok(
        !imports.some((i) => i.includes('database') || i.includes('repository') || i.includes('fallbackStore')),
        `${rel} imports a data store: ${imports}`
      );
      assert.ok(!imports.some((i) => i.startsWith('node:fs') || i === 'fs'), `${rel} imports the filesystem`);
      assert.ok(!/fs\.write|fetch\(|https?\.request|net\.connect/.test(src), `${rel} writes/calls an external service`);
    }

    // The logger itself must emit to stdout/stderr only.
    const logger = read('server/observability/logger.ts');
    assert.ok(/console\.(log|warn|error)/.test(logger), 'logger writes to stdout/stderr');
    assert.ok(!/\.query\s*\(/.test(logger), 'logger must not touch a database handle');
  });

  it('3. the observability middleware runs before limiters and body parsers', () => {
    const src = read('server/middleware.ts');
    const fnStart = src.indexOf('export function applyProductionHttpSecurity');
    const fnEnd = src.indexOf('/* ===', fnStart + 10);
    const body = src.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
    const obs = body.indexOf('createApiObservabilityMiddleware');
    const limiters = body.indexOf('applyRateLimiters');
    const parsers = body.indexOf('applyBodyParsers');
    assert.ok(obs > 0, 'observability middleware is mounted');
    assert.ok(obs < limiters, 'observability must run before the rate limiters');
    assert.ok(obs < parsers, 'observability must run before the body parsers');
  });

  it('4. the DB pool is instrumented at the pool factory (single hook)', () => {
    const conn = read('server/database/connection.ts');
    assert.ok(
      conn.includes("import { instrumentPoolForObservability } from \"../observability/dbTiming.js\"") ||
        conn.includes("from '../observability/dbTiming.js'"),
      'connection.ts imports the pool instrumentation'
    );
    assert.ok(
      (conn.match(/instrumentPoolForObservability\(/g) || []).length >= 3,
      'pool + pglite branches are all instrumented'
    );
  });

  it('5. the slow-DB event has no field that could carry SQL text or parameters', () => {
    const src = read('server/observability/dbTiming.ts');
    const allow = src.match(/SLOW_DB_ALLOWLIST\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(allow, 'SLOW_DB_ALLOWLIST exists');
    const fields = allow![1];
    for (const bad of ['sql', 'query', 'text', 'params', 'values', 'statement']) {
      assert.ok(
        !new RegExp(`'${bad}'`, 'i').test(fields),
        `slow-DB allowlist must not include '${bad}'`
      );
    }
  });

  it('6. both entrypoints use the structured readiness event, not the old console line', () => {
    for (const rel of ['api/index.ts', 'server.ts']) {
      const src = read(rel);
      assert.ok(src.includes('logReadinessCheck'), `${rel} uses logReadinessCheck`);
      assert.ok(!src.includes('console.log(`[readiness]'), `${rel} kept the noisy probe log`);
    }
  });

  it('7. auth observability events come from the central allowlisted catalog', () => {
    const routes = read('server/routes/production.routes.ts');
    assert.ok(
      routes.includes("from '../observability/events.js'"),
      'auth events are imported from observability/events.ts'
    );
    for (const helper of [
      'logAuthLoginSuccess',
      'logAuthLoginFailed',
      'logAuthTokenRejected',
      'logAuthForcedPasswordChangeCompleted',
      'logAuthAdminPasswordReset',
    ]) {
      assert.ok(routes.includes(helper), `production.routes.ts uses ${helper}`);
    }
  });

  it('8. the production observability documentation exists and covers the contract', () => {
    const doc = read('docs/PRODUCTION_OBSERVABILITY.md');
    for (const required of [
      'X-Request-ID',
      'http_request_complete',
      'http_request_slow',
      'http_request_error',
      'rate_limit_rejected',
      'db_query_slow',
      'auth_login_success',
      'OBSERVABILITY_LOG_LEVEL',
      'OBSERVABILITY_SLOW_REQUEST_MS',
      'OBSERVABILITY_SLOW_DB_MS',
      'redaction',
      'Server-Timing',
      'audit_logs',
    ]) {
      assert.ok(doc.includes(required), `docs/PRODUCTION_OBSERVABILITY.md must cover '${required}'`);
    }
  });
});
