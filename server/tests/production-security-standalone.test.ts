/**
 * production-security-standalone.test.ts
 * ------------------------------------------------------------------
 * The standalone production entrypoint (`server.ts`, i.e. `npm start` in
 * Docker/on a VPS) is imported under a production environment and driven
 * over HTTP. It proves the standalone runtime path applies the SAME
 * protections as the Vercel function:
 *
 *   - security headers, including frame protection (production only)
 *   - general + auth rate limiters with identical thresholds
 *   - trust proxy handling: Vercel = 1 hop, standalone = off unless the
 *     operator opts in with TRUST_PROXY (hop counts only recommended)
 *   - route-scoped bulk body allowance vs the smaller global JSON limit
 *   - JSON 404 for unknown API routes
 *   - production honesty: no DATABASE_URL => 503, never a memory fallback
 *
 * `LEADFLOW_SKIP_LISTEN=1` keeps the imported app from binding a port; the
 * exported Express app is what production itself serves.
 */
process.env.NODE_ENV = 'production';
process.env.LEADFLOW_SKIP_LISTEN = '1';
process.env.TRUST_PROXY = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'production-security-test-secret';
delete process.env.VERCEL;
delete process.env.DATABASE_URL;

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

import {
  AUTH_ATTEMPT_RATE_LIMIT,
  GENERAL_API_RATE_LIMIT,
  configureTrustProxy,
} from '../middleware.js';

const { default: app } = await import('../../server.js');

let ipSeq = 0;
const nextClientIp = () => `203.0.113.${(ipSeq += 1)}`;

const post = (p: string, body: unknown, ip = nextClientIp()) =>
  request(app).post(p).set('X-Forwarded-For', ip).send(body as any);
const get = (p: string, ip = nextClientIp()) =>
  request(app).get(p).set('X-Forwarded-For', ip);

describe('Production HTTP security — standalone entrypoint (server.ts)', () => {
  it('A. mounts security headers (frame protection included) on API responses', async () => {
    const res = await get('/api/health');

    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(res.headers['x-dns-prefetch-control'], 'off');
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
    assert.ok(res.headers['strict-transport-security']);
    assert.equal(res.headers['x-powered-by'], undefined);
    // CSP stays deferred on both entrypoints (documented decision).
    assert.equal(res.headers['content-security-policy'], undefined);
  });

  it('B. uses the configured trust proxy hop count', async () => {
    assert.equal(app.get('trust proxy'), 1, 'TRUST_PROXY=1 is honored');

    // Documented resolution rules (unit level, no env mutation of the app).
    const v = express();
    configureTrustProxy(v, { VERCEL: '1' } as any);
    assert.equal(v.get('trust proxy'), 1, 'Vercel = exactly one trusted hop');

    const direct = express();
    configureTrustProxy(direct, {} as any);
    assert.equal(direct.get('trust proxy'), false, 'direct exposure trusts no hop');

    const named = express();
    configureTrustProxy(named, { TRUST_PROXY: 'loopback' } as any);
    assert.equal(named.get('trust proxy'), 'loopback');
  });

  it('C. mounts the general and auth limiters with the documented thresholds', async () => {
    const login = await post('/api/auth/login', { employeeId: 'RLCHECK', password: 'x' });
    const leads = await get('/api/leads');

    assert.equal(login.headers['ratelimit-limit'], String(AUTH_ATTEMPT_RATE_LIMIT));
    assert.equal(leads.headers['ratelimit-limit'], String(GENERAL_API_RATE_LIMIT));
    assert.equal(leads.headers['ratelimit-policy'], `${GENERAL_API_RATE_LIMIT};w=900`);
  });

  it('D. blocks repeated failed logins with the JSON 429 contract', async () => {
    const ip = nextClientIp();
    for (let i = 0; i < AUTH_ATTEMPT_RATE_LIMIT; i += 1) {
      await post('/api/auth/login', { employeeId: 'BRUTE', password: 'wrong' }, ip);
    }
    const limited = await post('/api/auth/login', { employeeId: 'BRUTE', password: 'wrong' }, ip);

    assert.equal(limited.status, 429);
    assert.match(String(limited.headers['content-type']), /application\/json/);
    assert.equal(limited.body.success, false);
    assert.match(String(limited.body.message), /Too many sign-in attempts/);
  });

  it('E. keeps bulk-import payloads working (>10 MB) while the global limit is 10 MB', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      'Employee ID': `BULK${i}`,
      'Full Name': `Bulk User ${i}`,
      'Email': `bulk${i}@example.com`,
      'Department': 'note '.repeat(13000),
    }));
    const payload = { rows, dryRun: true };
    const sizeMb = JSON.stringify(payload).length / (1024 * 1024);
    assert.ok(sizeMb > 10, `payload must exceed the global limit (was ${sizeMb.toFixed(1)} MB)`);

    const bulk = await post('/api/users/bulk/validate', payload);
    assert.notEqual(bulk.status, 413, 'route-scoped bulk allowance must accept the payload');
    assert.equal(bulk.status, 401, 'and the existing auth gate still applies');

    const ordinary = await post('/api/users', payload);
    assert.equal(ordinary.status, 413);
    assert.equal(ordinary.body.message, 'Request payload is too large.');
  });

  it('F. unknown API routes return the JSON 404 contract', async () => {
    const res = await get('/api/nope');
    assert.equal(res.status, 404);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.body.success, false);
    assert.match(String(res.body.message), /API route not found: GET \/api\/nope/);
  });

  it('G. health responds on /health and /api/health, and is limiter-exempt', async () => {
    const root = await get('/health');
    const aliased = await get('/api/health');

    assert.equal(root.status, 200);
    assert.equal(aliased.status, 200);
    assert.equal(root.body.ok, true);
    assert.equal((root.body as any).mode, 'unconfigured');
    assert.equal((root.body as any).status, 'misconfigured');
    assert.equal(root.headers['ratelimit-limit'], undefined);
    assert.equal(aliased.headers['ratelimit-limit'], undefined);
  });

  it('H. production without DATABASE_URL stays honest (503, no demo session)', async () => {
    const dbStatus = await get('/api/db-status');
    assert.equal(dbStatus.status, 503);
    assert.equal(dbStatus.body.mode, 'db-unconfigured');

    const login = await post('/api/auth/login', { employeeId: 'DEMO_ADMIN', password: 'demo' });
    assert.equal(login.status, 503);
    assert.ok(!login.body.token);
    assert.match(String(login.body.message), /Database is not configured/i);
  });
});
