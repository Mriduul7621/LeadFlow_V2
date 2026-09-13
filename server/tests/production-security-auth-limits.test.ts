/**
 * production-security-auth-limits.test.ts
 * ------------------------------------------------------------------
 * Behaviour of the auth limiter against a WORKING authentication flow
 * (development demo store: NODE_ENV=test, no DATABASE_URL). The same
 * limiter instance is mounted by both production entrypoints, so these
 * assertions describe production behavior while letting the suite create
 * real credentials (bootstrap-admin) and real bcrypt logins.
 *
 * Proves:
 *   1. normal successful login still works,
 *   2. successful logins are never counted — an office/NAT IP may log in
 *      as often as it needs,
 *   3. the limiter keys on the client identity (IP), never on a request body
 *      field,
 *   4. the 429 body is identical for existing and non-existing accounts, so
 *      neither the 401 nor the 429 reveals whether a username exists,
 *   5. exhausting the auth limiter does not throttle ordinary API traffic.
 */
process.env.NODE_ENV = 'test';
process.env.LEADFLOW_SKIP_LISTEN = '1';
process.env.TRUST_PROXY = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'production-security-test-secret';
delete process.env.VERCEL;
delete process.env.DATABASE_URL;

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

import { AUTH_ATTEMPT_RATE_LIMIT, AUTH_RATE_LIMIT_MESSAGE } from '../middleware.js';

const { default: app } = await import('../../server.js');

let ipSeq = 0;
const nextClientIp = () => `192.0.2.${(ipSeq += 1)}`;

const post = (p: string, body: unknown, ip = nextClientIp()) =>
  request(app).post(p).set('X-Forwarded-For', ip).send(body as any);
const get = (p: string, ip = nextClientIp()) =>
  request(app).get(p).set('X-Forwarded-For', ip);

const ADMIN = {
  fullName: 'Security Admin',
  employeeId: 'SECADMIN1',
  email: 'sec-admin@leadflow.test',
  password: 'security-test-pass',
};

describe('Production HTTP security — auth limiter behaviour', () => {
  it('A. normal auth flow still works (bootstrap then successful login)', async () => {
    const bootstrap = await post('/api/auth/bootstrap-admin', ADMIN);
    assert.equal(bootstrap.status, 201);
    assert.ok(bootstrap.body.token);

    const login = await post('/api/auth/login', {
      employeeId: ADMIN.employeeId,
      password: ADMIN.password,
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(login.body.user.employeeId, ADMIN.employeeId);
    assert.equal(login.body.user.password, undefined, 'password hash is never returned');
  });

  it('B. successful logins are never counted against the auth limiter', async () => {
    const ip = nextClientIp();
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_ATTEMPT_RATE_LIMIT + 5; i += 1) {
      const res = await post(
        '/api/auth/login',
        { employeeId: ADMIN.employeeId, password: ADMIN.password },
        ip
      );
      statuses.push(res.status);
    }
    assert.deepEqual(
      [...new Set(statuses)],
      [200],
      'repeated legitimate logins from one office IP must never be throttled'
    );
  });

  it('C. wrong password and unknown account are indistinguishable', async () => {
    const wrongPassword = await post('/api/auth/login', {
      employeeId: ADMIN.employeeId,
      password: 'definitely-not-the-password',
    });
    const unknownAccount = await post('/api/auth/login', {
      employeeId: 'NO_SUCH_EMPLOYEE',
      password: 'definitely-not-the-password',
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownAccount.status, 401);
    assert.deepEqual(unknownAccount.body, wrongPassword.body);
    assert.match(String(wrongPassword.body.message), /Invalid credentials/);
    assert.ok(!/exist|unknown|not found|inactive/i.test(String(wrongPassword.body.message)));
  });

  it('D. the 429 message is identical for existing and non-existing accounts', async () => {
    const ip = nextClientIp();
    for (let i = 0; i < AUTH_ATTEMPT_RATE_LIMIT; i += 1) {
      await post('/api/auth/login', { employeeId: ADMIN.employeeId, password: 'nope-nope' }, ip);
    }

    const existing = await post('/api/auth/login', { employeeId: ADMIN.employeeId, password: 'nope-nope' }, ip);
    const missing = await post('/api/auth/login', { employeeId: 'GHOST_USER', password: 'nope-nope' }, ip);

    assert.equal(existing.status, 429);
    assert.equal(missing.status, 429);
    assert.deepEqual(existing.body, { success: false, message: AUTH_RATE_LIMIT_MESSAGE });
    assert.deepEqual(missing.body, existing.body);
  });

  it('E. a blocked auth client can still use the rest of the API', async () => {
    const ip = nextClientIp();
    for (let i = 0; i < AUTH_ATTEMPT_RATE_LIMIT; i += 1) {
      await post('/api/auth/login', { employeeId: 'BRUTE2', password: 'nope' }, ip);
    }

    assert.equal((await post('/api/auth/login', { employeeId: 'BRUTE2', password: 'nope' }, ip)).status, 429);
    // Ordinary (unauthenticated) API traffic from the same client is not
    // affected: 401 comes from the route's own auth gate, not from a limiter,
    // and the public bootstrap probe still answers normally.
    assert.equal((await get('/api/leads', ip)).status, 401);
    assert.equal((await get('/api/auth/bootstrap-status', ip)).status, 200);
  });

  it('F. every credential endpoint is protected, including the parameterised one', async () => {
    const changePassword = await post('/api/auth/change-password', { userId: 'x' });
    const forcedChange = await post('/api/auth/change-required-password', { newPassword: 'x'.repeat(8) });
    const adminReset = await post('/api/users/some-id/reset-password', {});

    for (const [name, res] of [
      ['change-password', changePassword],
      ['change-required-password', forcedChange],
      ['users/:id/reset-password', adminReset],
    ] as const) {
      assert.equal(res.headers['ratelimit-limit'], String(AUTH_ATTEMPT_RATE_LIMIT), `${name} auth-limited`);
      assert.equal(res.status, 401, `${name} keeps its auth gate`);
    }
  });
});
