/**
 * production-security-vercel.test.ts
 * ------------------------------------------------------------------
 * The Vercel production entrypoint (`api/index.ts`) is imported under the
 * real production environment (NODE_ENV=production, VERCEL=1, NO
 * DATABASE_URL) and driven over HTTP with supertest. This proves the
 * security middleware is actually MOUNTED on the serverless path — not
 * merely defined somewhere in the repository.
 *
 * Covered here:
 *   - security headers on API responses (and the documented CSP deferral)
 *   - trust proxy = 1 (Vercel overwrites X-Forwarded-For) and per-client buckets
 *   - auth limiter (20 failed attempts/15 min) vs general limiter (3000/15 min)
 *   - JSON 429 contract, JSON 404, JSON body-parser/error contracts without leaks
 *   - body-size policy: 50 MB route-scoped bulk allowance, 10 MB global
 *   - production honesty: no DATABASE_URL never falls back to memory
 *   - both entrypoints mount the SAME shared pipeline (source guards)
 *
 * Request bodies, tokens and passwords are never logged or asserted on.
 */
process.env.NODE_ENV = 'production';
process.env.VERCEL = '1';
process.env.LEADFLOW_SKIP_LISTEN = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'production-security-test-secret';
delete process.env.DATABASE_URL;
delete process.env.TRUST_PROXY;

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import {
  AUTH_ATTEMPT_RATE_LIMIT,
  GENERAL_API_RATE_LIMIT,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MESSAGE,
  AUTH_RATE_LIMIT_MESSAGE,
  AUTH_SENSITIVE_PATHS,
  BULK_JSON_PATHS,
  API_JSON_BODY_LIMIT,
  BULK_JSON_BODY_LIMIT,
  createApiErrorHandler,
} from '../middleware.js';

const ROOT = process.cwd();
const { default: app } = await import('../../api/index.js');

/** Distinct TEST-NET-2 client identities (<= 254 tests use this helper). */
let ipSeq = 0;
const nextClientIp = () => `198.51.100.${(ipSeq += 1)}`;

const post = (p: string, body: unknown, ip = nextClientIp()) =>
  request(app).post(p).set('X-Forwarded-For', ip).send(body as any);
const get = (p: string, ip = nextClientIp()) =>
  request(app).get(p).set('X-Forwarded-For', ip);

/** ~12 MB payload shaped like the raw spreadsheet rows the UI posts. */
function bulkPayload(): { leads: any[] } {
  const leads = Array.from({ length: 600 }, (_, i) => ({
    'Name': `Bulk Customer ${i}`,
    'Phone': `0181${String(100000 + i)}`,
    'Other Info': 'note '.repeat(4000),
    'Source': 'Bulk Import',
  }));
  return { leads };
}

describe('Production HTTP security — Vercel entrypoint (api/index.ts)', () => {
  /* ---------------- security headers ---------------- */

  it('A. mounts security headers on every API response', async () => {
    const res = await get('/api/health');

    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['x-dns-prefetch-control'], 'off');
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(res.headers['x-permitted-cross-domain-policies'], 'none');
    assert.ok(res.headers['strict-transport-security'], 'HSTS header present');
    assert.equal(res.headers['x-powered-by'], undefined, 'X-Powered-By is removed');

    // CSP is intentionally deferred (documented): enabling helmet's default
    // policy would break the Vite dev runtime and the external preset images.
    assert.equal(res.headers['content-security-policy'], undefined);
  });

  it('B. headers are applied before routing (also on route-level JSON errors)', async () => {
    const res = await get('/api/leads');
    assert.equal(res.status, 401);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });

  /* ---------------- proxy / client identity ---------------- */

  it('C. trusts exactly one proxy hop (Vercel) and keeps clients apart', async () => {
    assert.equal(app.get('trust proxy'), 1, 'one trusted hop on Vercel');

    // Exhaust the auth limiter for one client.
    const blockedIp = nextClientIp();
    for (let i = 0; i < AUTH_ATTEMPT_RATE_LIMIT; i += 1) {
      await post('/api/auth/login', { employeeId: 'BRUTE1', password: 'wrong' }, blockedIp);
    }
    const blocked = await post('/api/auth/login', { employeeId: 'BRUTE1', password: 'wrong' }, blockedIp);
    assert.equal(blocked.status, 429);

    // A different client (the normal case: one real user per IP) is untouched,
    // i.e. proxy configuration does not collapse every user into one bucket.
    const other = await post('/api/auth/login', { employeeId: 'BRUTE1', password: 'wrong' });
    assert.notEqual(other.status, 429);
  });

  /* ---------------- rate limiters ---------------- */

  it('D. mounts both limiters with auth stricter than the general API limit', async () => {
    const login = await post('/api/auth/login', { employeeId: 'RLCHECK', password: 'x' });
    const leads = await get('/api/leads');

    assert.equal(login.headers['ratelimit-limit'], String(AUTH_ATTEMPT_RATE_LIMIT));
    assert.equal(leads.headers['ratelimit-limit'], String(GENERAL_API_RATE_LIMIT));
    assert.ok(AUTH_ATTEMPT_RATE_LIMIT < GENERAL_API_RATE_LIMIT, 'auth limiter must be stricter');
    assert.equal(RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
    assert.ok(AUTH_ATTEMPT_RATE_LIMIT >= 10 && AUTH_ATTEMPT_RATE_LIMIT <= 20, 'auth baseline 10-20/15min');

    // The protected surface includes every credential-sensitive endpoint.
    for (const protectedPath of [
      '/api/auth/login',
      '/api/auth/change-password',
      '/api/auth/change-required-password',
      '/api/users/:id/reset-password',
    ]) {
      assert.ok(AUTH_SENSITIVE_PATHS.includes(protectedPath), `${protectedPath} must be auth-limited`);
    }
  });

  it('E. returns the documented JSON 429 contract (no account existence leak)', async () => {
    const ip = nextClientIp();
    for (let i = 0; i < AUTH_ATTEMPT_RATE_LIMIT; i += 1) {
      await post('/api/auth/login', { employeeId: 'TARGET_USER', password: 'wrong' }, ip);
    }

    const limited = await post('/api/auth/login', { employeeId: 'TARGET_USER', password: 'wrong' }, ip);
    assert.equal(limited.status, 429);
    assert.match(String(limited.headers['content-type']), /application\/json/);
    assert.deepEqual(limited.body, { success: false, message: AUTH_RATE_LIMIT_MESSAGE });
    assert.ok(limited.headers['retry-after'], 'Retry-After is advertised on 429');

    // The same message is returned whatever identifier was attempted, so the
    // limiter never reveals whether an account exists.
    const otherIdentifier = await post('/api/auth/login', { employeeId: 'someone-else@example.com', password: 'wrong' }, ip);
    assert.equal(otherIdentifier.status, 429);
    assert.deepEqual(otherIdentifier.body, limited.body);
    assert.ok(!/exist|unknown user|not found/i.test(String(otherIdentifier.body.message)));

    // The general limiter answers with the generic JSON contract too.
    assert.equal(RATE_LIMIT_MESSAGE, 'Too many requests. Please try again later.');
  });

  it('F. health and db-status probes stay usable when a client is throttled', async () => {
    const ip = nextClientIp();
    const health = await get('/api/health', ip);
    const dbStatus = await get('/api/db-status', ip);
    assert.equal(health.status, 200);
    assert.equal(dbStatus.status, 503);
    // Exempt from the limiter: no limit headers, and they never consume budget.
    assert.equal(health.headers['ratelimit-limit'], undefined);
    assert.equal(dbStatus.headers['ratelimit-limit'], undefined);
  });

  it('G. a real dashboard startup burst is far below the general limit', async () => {
    const ip = nextClientIp();
    const startup = [
      '/api/auth/session',
      '/api/dashboard',
      '/api/leads/follow-ups?bucket=today&limit=50',
      '/api/leads/follow-ups?bucket=upcoming&limit=50',
      '/api/scheduled-activities?limit=20',
      '/api/users',
      '/api/options',
      '/api/roles',
      '/api/leads?limit=20',
      '/api/notifications',
    ];

    const statuses: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      for (const route of startup) statuses.push((await get(route, ip)).status);
    }

    assert.equal(statuses.length, 40);
    assert.ok(!statuses.includes(429), 'startup burst must not be rate limited');
    // The burst consumes a small fraction of the window…
    assert.ok(40 / GENERAL_API_RATE_LIMIT < 0.05, 'startup burst uses <5% of the window');
    // …and the general limit keeps ~5x headroom over a heavy 15-minute session.
    assert.ok(GENERAL_API_RATE_LIMIT >= 2000);
  });

  /* ---------------- body size / request safety ---------------- */

  it('H. keeps the bulk-import payload working while shrinking the global limit', async () => {
    assert.equal(BULK_JSON_BODY_LIMIT, '50mb');
    assert.equal(API_JSON_BODY_LIMIT, '10mb');
    assert.deepEqual(BULK_JSON_PATHS, [
      '/api/leads/bulk',
      '/api/users/bulk/validate',
      '/api/users/bulk/commit',
    ]);

    const payload = bulkPayload();
    const sizeMb = JSON.stringify(payload).length / (1024 * 1024);
    assert.ok(sizeMb > 10, `bulk payload must exceed the global limit (was ${sizeMb.toFixed(1)} MB)`);

    // Route-scoped allowance: the parser accepts it (auth is refused, not 413),
    // so the real bulk-import path still works under the new policy.
    const bulk = await post('/api/leads/bulk', payload);
    assert.notEqual(bulk.status, 413);
    assert.equal(bulk.status, 401);

    // Same body on an ordinary endpoint is rejected by the global parser.
    const ordinary = await post('/api/leads', payload);
    assert.equal(ordinary.status, 413);
    assert.deepEqual(ordinary.body, { success: false, message: 'Request payload is too large.' });
  });

  it('I. rejects malformed JSON with a JSON error (never an HTML stack)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', nextClientIp())
      .set('Content-Type', 'application/json')
      .send('{"employeeId": "x", ');

    assert.equal(res.status, 400);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.deepEqual(res.body, { success: false, message: 'Invalid JSON request body.' });
  });

  it('J. unknown API routes keep the JSON 404 contract', async () => {
    const res = await get('/api/__does_not_exist__');
    assert.equal(res.status, 404);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.body.success, false);
    assert.match(String(res.body.message), /API route not found: GET \/api\/__does_not_exist__/);
  });

  /* ---------------- production honesty ---------------- */

  it('K. production without DATABASE_URL refuses to authenticate (no memory fallback)', async () => {
    const login = await post('/api/auth/login', { employeeId: 'ANYONE', password: 'whatever' });
    assert.equal(login.status, 503);
    assert.equal(login.body.success, false);
    assert.ok(!login.body.token, 'no token may be issued without a database');
    assert.match(String(login.body.message), /not configured/i);

    const bootstrap = await post('/api/auth/bootstrap-admin', {
      fullName: 'Should Not Exist',
      employeeId: 'NOSETUP',
      email: 'nosetup@example.com',
      password: 'should-not-work',
    });
    assert.equal(bootstrap.status, 503);
    assert.ok(!bootstrap.body.token);
  });

  it('L. health/db-status report misconfiguration instead of a demo session store', async () => {
    const health = await get('/api/health');
    assert.deepEqual(health.body, {
      ok: true,
      database: false,
      mode: 'unconfigured',
      status: 'misconfigured',
    });

    const dbStatus = await get('/api/db-status');
    assert.equal(dbStatus.status, 503);
    assert.equal(dbStatus.body.connected, false);
    assert.equal(dbStatus.body.mode, 'db-unconfigured');
    assert.ok(!/demo/i.test(String(dbStatus.body.message)));
  });

  /* ---------------- generic error handler ---------------- */

  it('M. the generic error handler never leaks SQL, credentials or stacks', async () => {
    const scratch = express();
    scratch.get('/api/boom', () => {
      const error: any = new Error(
        'connect ECONNREFUSED postgresql://leadflow:supersecret@db.internal:5432/postgres — SELECT * FROM users WHERE password = $1'
      );
      error.stack = 'Error: boom\n    at /var/task/server/routes/production.routes.js:1:1';
      throw error;
    });
    scratch.get('/api/denied', () => {
      const error: any = new Error('raw sql: SELECT id, password FROM users');
      error.status = 403;
      throw error;
    });
    scratch.use(createApiErrorHandler({ production: true }));

    const boom = await request(scratch).get('/api/boom');
    assert.equal(boom.status, 500);
    assert.deepEqual(boom.body, { success: false, message: 'Internal server error' });
    const boomText = JSON.stringify(boom.body);
    for (const secret of ['postgresql://', 'supersecret', 'SELECT', 'ECONNREFUSED', 'at /var/task']) {
      assert.ok(!boomText.includes(secret), `response must not contain "${secret}"`);
    }

    const denied = await request(scratch).get('/api/denied');
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, {
      success: false,
      message: 'You do not have permission to perform this action.',
    });
    assert.ok(!JSON.stringify(denied.body).includes('SELECT'));
  });

  /* ---------------- mounting (source guards) ---------------- */

  it('N. both entrypoints mount the same shared pipeline before their routes', () => {
    const standalone = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf-8');
    const vercel = fs.readFileSync(path.join(ROOT, 'api/index.ts'), 'utf-8');

    for (const [name, source] of [['server.ts', standalone], ['api/index.ts', vercel]] as const) {
      assert.ok(
        source.includes('applyProductionHttpSecurity(app,'),
        `${name} must mount the shared security pipeline`
      );
      assert.ok(
        source.includes('createApiErrorHandler('),
        `${name} must use the shared JSON error handler`
      );
      assert.ok(
        !source.includes("express.json({ limit: '50mb' })"),
        `${name} must not keep the old process-wide 50mb JSON parser`
      );
      // Mounting must happen before routes are registered.
      assert.ok(
        source.indexOf('applyProductionHttpSecurity(app,') < source.indexOf("'/api'"),
        `${name} must mount security middleware before any /api route`
      );
    }

    // Serverless compatibility: the lazy router + cold-start kick-off survive.
    assert.ok(vercel.includes('void loadRoutes().catch(() => undefined)'));
    assert.ok(vercel.includes('if (productionRouter) return productionRouter;'));
    assert.ok(vercel.includes("app.use('/api', async (req, res, next)"));
  });
});
