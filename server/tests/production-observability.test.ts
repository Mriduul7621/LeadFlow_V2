/**
 * production-observability.test.ts — backend observability behavior
 * ------------------------------------------------------------------
 * Proves the production request-tracing / structured-logging layer:
 *
 *   1.  X-Request-ID response header on every API response
 *   2.  request ids are unique across independent requests
 *   3.  strictly-valid incoming X-Request-ID is adopted; forged/injection
 *       values are replaced with a server-generated id
 *   4.  one http_request_complete event per request with
 *       method/route/status/duration and the matching requestId
 *   5.  raw query values never appear in logs
 *   6.  Authorization headers never appear in logs
 *   7.  Cookie headers never appear in logs
 *   8.  JWT/password/secret values never appear in logs
 *   9.  email/phone values never appear in logs
 *   10. production 5xx response stays generic (PR #39 contract)
 *   11. the structured error event still carries the requestId
 *   12. slow requests emit http_request_slow warnings
 *   13. fast requests do not
 *   14. OBSERVABILITY_SLOW_REQUEST_MS is honored (and falls back safely)
 *   15. DB timing never logs SQL text or parameters
 *   16. DB query count/duration accumulate per request (AsyncLocalStorage)
 *   17. health endpoint contract/behavior unchanged
 *   18. readiness endpoint contract/behavior unchanged
 *   19. successful probes create no info/warn/error log noise
 *   20. auth failure logs contain no submitted credentials
 *   21. login success logs contain no token (and no password/email)
 *   22. rate_limit_rejected logs contain no Authorization/Cookie/body
 *   23. redaction + allowlisting are enforced structurally by the logger
 *
 * The suite drives the REAL standalone entrypoint (server.ts, imported
 * with LEADFLOW_SKIP_LISTEN=1) in the development-demo runtime (no
 * DATABASE_URL, NODE_ENV=test), plus small dedicated apps for the
 * production error path, slow-request detection and rate limiting.
 * Each test file runs in its own process; the sink installed by
 * _setLogSinkForTests is logger configuration, not request state.
 */

process.env.NODE_ENV = 'test';
process.env.LEADFLOW_SKIP_LISTEN = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'observability-test-secret-0123';
delete process.env.VERCEL;
delete process.env.DATABASE_URL;
delete process.env.OBSERVABILITY_LOG_LEVEL;
delete process.env.OBSERVABILITY_SLOW_REQUEST_MS;
delete process.env.OBSERVABILITY_SLOW_DB_MS;

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  _setLogSinkForTests,
  logEvent,
  resolveLogLevel,
} from '../observability/logger.js';
import {
  isSensitiveKey,
  pickAllowlisted,
  sanitizeFields,
  sanitizeValue,
  REDACTED,
} from '../observability/redaction.js';
import {
  isValidIncomingRequestId,
  resolveRequestId,
} from '../observability/requestId.js';
import {
  createApiObservabilityMiddleware,
  normalizeRoutePath,
} from '../observability/http.js';
import {
  runWithRequestContext,
  getRequestContext,
  type RequestObservabilityContext,
} from '../observability/context.js';
import { instrumentPoolForObservability } from '../observability/dbTiming.js';
import {
  DEFAULT_SLOW_DB_MS,
  DEFAULT_SLOW_REQUEST_MS,
  resolveSlowDbThresholdMs,
  resolveSlowRequestThresholdMs,
} from '../observability/config.js';
import {
  applyProductionHttpSecurity,
  createApiErrorHandler,
  createApiNotFoundHandler,
} from '../middleware.js';

const { default: app } = await import('../../server.js');
const { fallbackStore } = await import('../fallbackStore.js');

const JWT_SECRET = process.env.JWT_SECRET!;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- */
/* Log capture                                                      */
/* ---------------------------------------------------------------- */

const captured: Array<{ level: string; line: string }> = [];
_setLogSinkForTests((level, line) => captured.push({ level, line }));
after(() => _setLogSinkForTests(null));

function clearCaptured(): void {
  captured.length = 0;
}
function eventsOf(name: string): Array<Record<string, any>> {
  return captured
    .filter((c) => c.line.includes(`"event":"${name}"`))
    .map((c) => JSON.parse(c.line));
}
function captureText(): string {
  return captured.map((c) => c.line).join('\n');
}

function makeCtx(overrides: Partial<RequestObservabilityContext> = {}): RequestObservabilityContext {
  return {
    requestId: '11111111-2222-4333-8444-555555555555',
    method: 'GET',
    route: '/api/test',
    startedAtMs: 0,
    startedAtIso: new Date().toISOString(),
    dbQueryCount: 0,
    dbDurationMs: 0,
    ...overrides,
  };
}

/** A fake pg Pool whose query resolves after `latencyMs`. */
function fakePool(latencyMs: number) {
  return {
    query: (...args: any[]) => {
      const last = args[args.length - 1];
      const result = { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
      if (typeof last === 'function') {
        setTimeout(() => last(null, result), latencyMs);
        return undefined;
      }
      return new Promise((resolve) => setTimeout(() => resolve(result), latencyMs));
    },
  };
}

/* ================================================================== */
/* 1. Logger units — levels, allowlist, redaction                     */
/* ================================================================== */

describe('Structured logger — levels, allowlist, redaction', () => {
  it('A. OBSERVABILITY_LOG_LEVEL: invalid values fall back to info; debug default off in production', () => {
    assert.equal(resolveLogLevel({ OBSERVABILITY_LOG_LEVEL: 'bogus' } as any), 'info');
    assert.equal(resolveLogLevel({ OBSERVABILITY_LOG_LEVEL: 'verbose' } as any), 'info');
    assert.equal(resolveLogLevel({ OBSERVABILITY_LOG_LEVEL: 'DEBUG' } as any), 'debug');
    assert.equal(resolveLogLevel({ OBSERVABILITY_LOG_LEVEL: 'warn' } as any), 'warn');
    assert.equal(resolveLogLevel({ NODE_ENV: 'production' } as any), 'info');
    assert.equal(resolveLogLevel({ VERCEL: '1' } as any), 'info');
    assert.equal(resolveLogLevel({ NODE_ENV: 'test' } as any), 'debug');
  });

  it('B. every sensitive key concept is redacted', () => {
    const fields = {
      authorization: 'Bearer SENTINEL-AUTHZ-1',
      Authorization: 'Bearer SENTINEL-AUTHZ-2',
      cookie: 'SENTINEL-COOKIE-1',
      'set-cookie': 'SENTINEL-COOKIE-2',
      token: 'SENTINEL-TOKEN-1',
      refreshToken: 'SENTINEL-TOKEN-2',
      secret: 'SENTINEL-SECRET',
      password: 'SENTINEL-PASSWORD',
      newPassword: 'SENTINEL-PASSWORD-2',
      database_url: 'postgres://u:SENTINEL-PW@host/db',
      DATABASE_URL: 'postgres://u:SENTINEL-PW@host/db',
      jwt: 'SENTINEL-JWT',
      api_key: 'SENTINEL-APIKEY-1',
      apiKey: 'SENTINEL-APIKEY-2',
      email: 'sentinel.user@example.com',
      phone: 'SENTINEL-PHONE-01',
      mobile: 'SENTINEL-PHONE-02',
    };
    const out = sanitizeFields(fields);
    const serialized = JSON.stringify(out);
    for (const value of Object.values(fields)) {
      assert.ok(!serialized.includes(String(value)), `value for a sensitive key leaked: ${value}`);
    }
    assert.equal(out.email, REDACTED);
    assert.equal(out.password, REDACTED);
    assert.ok(isSensitiveKey('X-Api-Key'));
    assert.ok(isSensitiveKey('refresh_token'));
    assert.ok(!isSensitiveKey('status'));
    assert.ok(!isSensitiveKey('durationMs'));
  });

  it('C. nested secrets/PII are redacted recursively (email/phone never leak)', () => {
    const payload = {
      keep: 'visible-value',
      nested: {
        email: 'deep.person@example.com',
        phone: '01799999999',
        deeper: { jwt: 'DEEP-JWT-SENTINEL' },
      },
      list: [{ accessToken: 'LIST-TOKEN-SENTINEL' }, 'plain'],
    };
    const serialized = JSON.stringify(sanitizeValue(payload));
    assert.ok(serialized.includes('visible-value'), 'safe values pass through');
    assert.ok(!serialized.includes('deep.person@example.com'));
    assert.ok(!serialized.includes('01799999999'));
    assert.ok(!serialized.includes('DEEP-JWT-SENTINEL'));
    assert.ok(!serialized.includes('LIST-TOKEN-SENTINEL'));
  });

  it('D. allowlisting is the structural privacy boundary', () => {
    const fields = { status: 200, unleashed: 'SHOULD-DROP', nested: { password: 'x' } };
    const picked = pickAllowlisted(fields, ['status'] as const);
    assert.deepEqual(picked, { status: 200 });
    clearCaptured();
    logEvent('info', 'obs_test_allowlist', fields, ['status'] as const);
    const line = captured[captured.length - 1].line;
    assert.ok(line.includes('"status":200'));
    assert.ok(!line.includes('SHOULD-DROP'));
    assert.ok(!line.includes('unleashed'));
  });

  it('E. logEvent emits exactly one bounded line and never throws on hostile values', () => {
    const hostile: any = { note: 'x'.repeat(10_000) };
    hostile.self = hostile; // circular
    clearCaptured();
    logEvent('info', 'obs_test_hostile', hostile);
    assert.equal(captured.length, 1);
    const line = captured[0].line;
    assert.ok(!line.includes('\n'), 'single-line JSON');
    assert.ok(line.length < 10_000, 'bounded');
    const parsed = JSON.parse(line);
    assert.equal(parsed.event, 'obs_test_hostile');
    assert.ok(parsed.ts);
    assert.equal(parsed.env, 'test');
  });

  it('F. the build identifier is included when configured (reusing PR #42 resolution)', async () => {
    process.env.GIT_SHA = 'obs-build-7f34a12';
    try {
      clearCaptured();
      const res = await request(app).get('/api/leads');
      const events = eventsOf('http_request_complete');
      assert.equal(events.length, 1);
      assert.equal(events[0].build, 'obs-build-7f34a12');
      assert.equal(events[0].env, 'test');
      assert.ok(res.headers['x-request-id']);
    } finally {
      delete process.env.GIT_SHA;
    }
  });
});

/* ================================================================== */
/* 2. Request id units                                                 */
/* ================================================================== */

describe('Request id generation and adoption policy', () => {
  it('G. strictly-valid incoming ids are adopted; anything else is regenerated', () => {
    assert.ok(isValidIncomingRequestId('abc_def-12345'));
    assert.equal(resolveRequestId({ headers: { 'x-request-id': 'abc_def-12345' } }), 'abc_def-12345');

    const rejected = [
      'short',
      'has spaces here',
      'newline\nFORGED-LOG-LINE',
      'x'.repeat(65),
      'tab\tvalue000',
      12345 as any,
      ['a'.repeat(20)] as any,
    ];
    for (const bad of rejected) {
      const resolved = resolveRequestId({ headers: { 'x-request-id': bad } });
      assert.ok(UUID_RE.test(resolved), `expected a fresh server id for ${String(bad)}`);
      assert.notEqual(resolved, bad);
    }
  });

  it('H. route normalization strips queries and masks record ids', () => {
    assert.equal(normalizeRoutePath('/api/leads?search=alice%40x.com'), '/api/leads');
    assert.equal(
      normalizeRoutePath('/api/users/123e4567-e89b-12d3-a456-426614174000'),
      '/api/users/:id'
    );
    assert.equal(normalizeRoutePath('/api/users/12345678'), '/api/users/:id');
    assert.equal(normalizeRoutePath('/api/leads/'), '/api/leads');
  });
});

/* ================================================================== */
/* 3. Live HTTP behavior on the real standalone app                    */
/* ================================================================== */

describe('HTTP request observability (standalone app)', () => {
  it('1/4. every API response carries X-Request-ID and one safe completion event', async () => {
    clearCaptured();
    const res = await request(app).get('/api/leads');
    assert.equal(res.status, 401); // unauthenticated — guard unchanged
    const rid = res.headers['x-request-id'];
    assert.ok(UUID_RE.test(String(rid)), 'response returns the correlation id');

    const events = eventsOf('http_request_complete');
    assert.equal(events.length, 1, 'exactly one completion event per request');
    const e = events[0];
    assert.equal(e.requestId, rid, 'completion event carries the same request id');
    assert.equal(e.method, 'GET');
    assert.equal(e.route, '/api/leads');
    assert.equal(e.status, 401);
    assert.equal(typeof e.durationMs, 'number');
    assert.equal(typeof e.dbQueryCount, 'number');
    assert.equal(typeof e.dbDurationMs, 'number');
    assert.ok(e.ts);
  });

  it('2. request ids are unique across independent requests', async () => {
    clearCaptured();
    const a = await request(app).get('/api/leads');
    const b = await request(app).get('/api/users');
    assert.ok(UUID_RE.test(String(a.headers['x-request-id'])));
    assert.ok(UUID_RE.test(String(b.headers['x-request-id'])));
    assert.notEqual(a.headers['x-request-id'], b.headers['x-request-id']);
  });

  it('3. incoming X-Request-ID is adopted only when it validates', async () => {
    clearCaptured();
    const valid = await request(app).get('/api/leads').set('X-Request-ID', 'diag_req-00042');
    assert.equal(valid.headers['x-request-id'], 'diag_req-00042');
    assert.equal(eventsOf('http_request_complete')[0].requestId, 'diag_req-00042');

    clearCaptured();
    const forged = await request(app)
      .get('/api/leads')
      .set('X-Request-ID', 'forged id with spaces');
    const echoed = String(forged.headers['x-request-id']);
    assert.ok(UUID_RE.test(echoed), 'forged id replaced by a server id');
    assert.notEqual(echoed, 'forged id with spaces');
    assert.ok(!captureText().includes('forged id with spaces'));
  });

  it('5. raw query values never appear in request logs', async () => {
    clearCaptured();
    await request(app).get(
      '/api/leads?search=querySentinel%40example.com&phone=QUERY-PHONE-SENTINEL&status=Interested'
    );
    const text = captureText();
    assert.ok(!text.includes('querySentinel'));
    assert.ok(!text.includes('QUERY-PHONE-SENTINEL'));
    assert.ok(!text.includes('search='), 'no raw query string');
    const e = eventsOf('http_request_complete')[0];
    assert.equal(e.route, '/api/leads');
  });

  it('6/7/8. Authorization, Cookie and token values never appear in logs', async () => {
    clearCaptured();
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', 'Bearer SENTINEL-AUTHZ-VALUE-77')
      .set('Cookie', 'session=SENTINEL-COOKIE-VALUE-88');
    assert.equal(res.status, 401);
    const text = captureText();
    assert.ok(!text.includes('SENTINEL-AUTHZ-VALUE-77'), 'Authorization header leaked');
    assert.ok(!text.includes('SENTINEL-COOKIE-VALUE-88'), 'Cookie leaked');
    const rejected = eventsOf('auth_token_rejected');
    assert.equal(rejected.length, 1, 'invalid Bearer token is observed');
    assert.equal(rejected[0].reason, 'invalid');
    assert.equal(rejected[0].requestId, res.headers['x-request-id']);
  });

  it('6b. expired tokens are categorized without logging the token bytes', async () => {
    const expired = jwt.sign({ id: 'u-expired', role: 'EMPLOYEE' }, JWT_SECRET, { expiresIn: '-30s' });
    clearCaptured();
    await request(app).get('/api/users').set('Authorization', `Bearer ${expired}`);
    const rejected = eventsOf('auth_token_rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, 'expired');
    assert.ok(!captureText().includes(expired), 'raw JWT leaked');
  });
});

/* ================================================================== */
/* 4. Error behavior — production 5xx stays generic                   */
/* ================================================================== */

function buildMinimalApp(production: boolean) {
  const a = express();
  applyProductionHttpSecurity(a, { production });
  return a;
}

describe('API error observability', () => {
  it('10/11. production 5xx stays generic while the error event keeps requestId and safe metadata', async () => {
    const a = buildMinimalApp(true);
    a.get('/api/boom', () => {
      const err: any = new Error(
        'pg: password authentication failed for user "secretuser" at host db.internal using postgres://secretuser:hunter2@db.internal/db'
      );
      err.code = '28P01';
      throw err;
    });
    a.use('/api', createApiNotFoundHandler());
    a.use(createApiErrorHandler({ production: true }));

    clearCaptured();
    const res = await request(a).get('/api/boom');
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { success: false, message: 'Internal server error' });

    const errors = eventsOf('http_request_error');
    assert.equal(errors.length, 1);
    const e = errors[0];
    assert.equal(e.requestId, res.headers['x-request-id']);
    assert.equal(e.method, 'GET');
    assert.equal(e.route, '/api/boom');
    assert.equal(e.status, 500);
    assert.equal(e.errorName, 'Error');
    assert.equal(e.errorCode, '28P01');
    assert.equal(e.level, 'error');
    assert.equal(e.message, undefined, 'raw message is not logged in production');
    assert.equal(e.stack, undefined, 'stack is not logged in production');

    const text = captureText();
    assert.ok(!text.includes('secretuser'), 'connection user leaked');
    assert.ok(!text.includes('db.internal'), 'connection host leaked');
    assert.ok(!text.includes('hunter2'), 'connection password leaked');
  });

  it('11b. development error responses keep the detailed contract (unchanged behavior)', async () => {
    const a = buildMinimalApp(false);
    a.get('/api/boom-dev', () => {
      throw new Error('dev detail sentinel');
    });
    a.use('/api', createApiNotFoundHandler());
    a.use(createApiErrorHandler({ production: false }));
    clearCaptured();
    const res = await request(a).get('/api/boom-dev');
    assert.equal(res.status, 500);
    assert.match(String(res.body.message), /dev detail sentinel/);
    assert.equal(eventsOf('http_request_error').length, 1);
  });
});

/* ================================================================== */
/* 5. Slow request detection                                           */
/* ================================================================== */

describe('Slow request detection', () => {
  it('12/13/14. slow requests warn at the configured threshold; fast requests do not', async () => {
    const a = buildMinimalApp(false);
    a.get('/api/slow-op', async (_req, res) => {
      await sleep(45);
      res.json({ ok: true });
    });
    a.get('/api/fast-op', (_req, res) => res.json({ ok: true }));

    process.env.OBSERVABILITY_SLOW_REQUEST_MS = '20';
    try {
      clearCaptured();
      const slow = await request(a).get('/api/slow-op');
      assert.equal(slow.status, 200, 'slow request is NOT failed');
      const slows = eventsOf('http_request_slow');
      assert.equal(slows.length, 1);
      assert.equal(slows[0].requestId, slow.headers['x-request-id']);
      assert.equal(slows[0].route, '/api/slow-op');
      assert.equal(slows[0].thresholdMs, 20);
      assert.equal(typeof slows[0].durationMs, 'number');

      clearCaptured();
      const fast = await request(a).get('/api/fast-op');
      assert.equal(fast.status, 200);
      assert.equal(eventsOf('http_request_slow').length, 0, 'fast request emits no slow warning');
    } finally {
      delete process.env.OBSERVABILITY_SLOW_REQUEST_MS;
    }
  });

  it('14b. threshold parsing falls back safely on garbage', () => {
    assert.equal(resolveSlowRequestThresholdMs({} as any), DEFAULT_SLOW_REQUEST_MS);
    assert.equal(resolveSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: 'abc' } as any), DEFAULT_SLOW_REQUEST_MS);
    assert.equal(resolveSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: '-5' } as any), DEFAULT_SLOW_REQUEST_MS);
    assert.equal(resolveSlowRequestThresholdMs({ OBSERVABILITY_SLOW_REQUEST_MS: '1500' } as any), 1500);
    assert.equal(resolveSlowDbThresholdMs({} as any), DEFAULT_SLOW_DB_MS);
    assert.equal(resolveSlowDbThresholdMs({ OBSERVABILITY_SLOW_DB_MS: '250' } as any), 250);
  });
});

/* ================================================================== */
/* 6. DB timing instrumentation                                        */
/* ================================================================== */

describe('DB timing instrumentation', () => {
  it('15. slow-query warnings contain durations only — never SQL text or parameters', async () => {
    process.env.OBSERVABILITY_SLOW_DB_MS = '5';
    const pool = fakePool(12);
    instrumentPoolForObservability(pool);
    try {
      clearCaptured();
      await runWithRequestContext(makeCtx(), async () => {
        await pool.query('SELECT password, token FROM users WHERE email = $1', ['db.person@example.com']);
      });
      const slows = eventsOf('db_query_slow');
      assert.equal(slows.length, 1);
      assert.equal(slows[0].requestId, '11111111-2222-4333-8444-555555555555');
      assert.ok(slows[0].durationMs >= 5);
      const text = captureText();
      assert.ok(!text.includes('SELECT password'), 'SQL text leaked');
      assert.ok(!text.includes('db.person@example.com'), 'query parameter leaked');
    } finally {
      delete process.env.OBSERVABILITY_SLOW_DB_MS;
    }
  });

  it('16a. query count and duration accumulate inside a request context only', async () => {
    const pool = fakePool(6);
    instrumentPoolForObservability(pool);
    instrumentPoolForObservability(pool); // idempotent — still a single wrapper

    // Outside a request scope: nothing is recorded anywhere.
    await pool.query('SELECT 1');
    assert.equal(getRequestContext(), undefined);

    const ctx = makeCtx();
    await runWithRequestContext(ctx, async () => {
      await pool.query('SELECT 1');
      await pool.query('SELECT 2');
    });
    assert.equal(ctx.dbQueryCount, 2);
    assert.ok(ctx.dbDurationMs >= 10, `accumulated ${ctx.dbDurationMs} ms`);
  });

  it('16b. callback-style queries are timed too', async () => {
    const pool = fakePool(5);
    instrumentPoolForObservability(pool);
    const ctx = makeCtx({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    await new Promise<void>((resolve, reject) => {
      runWithRequestContext(ctx, () => {
        pool.query('SELECT 1', (err: any) => (err ? reject(err) : resolve()));
      });
    });
    assert.equal(ctx.dbQueryCount, 1);
    assert.ok(ctx.dbDurationMs >= 4);
  });

  it('16c. counters flow into the live completion event', async () => {
    const a = express();
    a.use(createApiObservabilityMiddleware());
    const pool = fakePool(6);
    instrumentPoolForObservability(pool);
    a.get('/api/db-touch', async (_req, res) => {
      await pool.query('SELECT 1');
      await pool.query('SELECT 2');
      res.json({ ok: true });
    });

    clearCaptured();
    const res = await request(a).get('/api/db-touch');
    assert.equal(res.status, 200);
    const events = eventsOf('http_request_complete');
    assert.equal(events.length, 1);
    assert.equal(events[0].dbQueryCount, 2);
    assert.ok(events[0].dbDurationMs >= 10);
    assert.equal(events[0].requestId, res.headers['x-request-id']);
  });
});

/* ================================================================== */
/* 7. Health / readiness — contracts unchanged, probes quiet          */
/* ================================================================== */

describe('Health and readiness observability policy', () => {
  it('17/19. health contract is unchanged AND success probes are silent at info level', async () => {
    process.env.OBSERVABILITY_LOG_LEVEL = 'info';
    try {
      clearCaptured();
      const res = await request(app).get('/api/health');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, database: false, mode: 'dev-demo', status: 'demo' });
      assert.ok(res.headers['x-request-id']);

      const rid = String(res.headers['x-request-id']);
      assert.ok(
        !captureText().includes(rid),
        'a passing probe must not produce info/warn/error log noise'
      );
    } finally {
      delete process.env.OBSERVABILITY_LOG_LEVEL;
    }

    // At debug level the probe event exists (opt-in diagnostics).
    process.env.OBSERVABILITY_LOG_LEVEL = 'debug';
    try {
      clearCaptured();
      const res = await request(app).get('/api/health');
      const probes = eventsOf('http_probe_complete');
      assert.equal(probes.length, 1);
      assert.equal(probes[0].level, 'debug');
      assert.equal(probes[0].requestId, res.headers['x-request-id']);
    } finally {
      delete process.env.OBSERVABILITY_LOG_LEVEL;
    }
  });

  it('18/19b. readiness contract is unchanged AND failures stay visible', async () => {
    process.env.OBSERVABILITY_LOG_LEVEL = 'info';
    try {
      clearCaptured();
      const res = await request(app).get('/api/health/readiness');
      // No DATABASE_URL in this runtime => honest not_ready (PR #42 contract).
      assert.equal(res.status, 503);
      assert.equal(res.body.status, 'not_ready');
      assert.equal(res.body.service, 'leadflow-api');
      assert.equal(typeof res.body.checks.database.configured, 'boolean');
      assert.equal(typeof res.body.checks.config.ok, 'boolean');
      assert.ok(Array.isArray(res.body.checks.config.issues));
      assert.ok(res.body.timestamp);

      const readinessEvents = eventsOf('readiness_check');
      assert.equal(readinessEvents.length, 1);
      assert.equal(readinessEvents[0].status, 'not_ready');
      const line = captured.find((c) => c.line.includes('"event":"readiness_check"'));
      assert.equal(line?.level, 'warn', 'not-ready probes remain visible as warnings');

      // The 503 probe completion is classified as a visible unhealthy probe.
      assert.equal(eventsOf('http_probe_unhealthy').length, 1);
    } finally {
      delete process.env.OBSERVABILITY_LOG_LEVEL;
    }
  });
});

/* ================================================================== */
/* 8. Auth observability events (demo runtime)                        */
/* ================================================================== */

describe('Auth observability events', () => {
  let adminUserId = '';
  let adminToken = '';

  it('21. bootstrap + login success is logged with userId/role — never token, password or email', async () => {
    clearCaptured();
    const boot = await request(app).post('/api/auth/bootstrap-admin').send({
      fullName: 'Obs Admin',
      employeeId: 'OBSADMIN',
      email: 'obs.admin@example.com',
      password: 'BootStrap#Pass1',
    });
    assert.equal(boot.status, 201);
    adminUserId = boot.body.user.id;

    clearCaptured();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: 'OBSADMIN', password: 'BootStrap#Pass1' });
    assert.equal(login.status, 200);
    adminToken = login.body.token;

    const successes = eventsOf('auth_login_success');
    assert.equal(successes.length, 1);
    assert.equal(successes[0].requestId, login.headers['x-request-id']);
    assert.equal(successes[0].userId, adminUserId);
    assert.equal(successes[0].role, 'ADMIN');

    const text = captureText();
    assert.ok(!text.includes(String(adminToken)), 'token must never appear in logs');
    assert.ok(!text.includes('BootStrap#Pass1'), 'password must never appear in logs');
    assert.ok(!text.includes('obs.admin@example.com'), 'email must never appear in logs');
  });

  it('20. login failure is categorized — no submitted identifier or password', async () => {
    clearCaptured();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ employeeId: 'OBSADMIN', password: 'WrongPass#999' });
    assert.equal(res.status, 401);
    const failures = eventsOf('auth_login_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason, 'invalid_credentials');
    assert.equal(failures[0].requestId, res.headers['x-request-id']);
    const text = captureText();
    assert.ok(!text.includes('WrongPass#999'), 'submitted password leaked');
    assert.ok(!text.includes('OBSADMIN'), 'submitted identifier leaked');
  });

  it('20b. forced password change completion is logged without password material', async () => {
    fallbackStore.users.push({
      id: 'u-obs-forced',
      employeeId: 'OBSFORCED',
      fullName: 'Obs Forced',
      name: 'Obs Forced',
      email: 'obs.forced@example.com',
      role: 'EMPLOYEE',
      roleCode: 'EMPLOYEE',
      status: 'Active',
      accountStatus: 'ACTIVE',
      isActive: true,
      designation: 'Officer',
      departmentId: '',
      teamId: '',
      managerId: '',
      reportingManagerId: '',
      avatarUrl: '',
      createdDate: new Date().toISOString(),
      password: 'irrelevant-hash',
      mustChangePassword: true,
    } as any);
    const token = jwt.sign(
      { id: 'u-obs-forced', employeeId: 'OBSFORCED', role: 'EMPLOYEE' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    clearCaptured();
    const res = await request(app)
      .post('/api/auth/change-required-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'BrandNew#Pass1' });
    assert.equal(res.status, 200);
    const events = eventsOf('auth_forced_password_change_completed');
    assert.equal(events.length, 1);
    assert.equal(events[0].userId, 'u-obs-forced');
    const text = captureText();
    assert.ok(!text.includes('BrandNew#Pass1'), 'new password leaked');
    assert.ok(!text.includes(token), 'token leaked');
  });

  it('20c. admin password reset is logged with actor/target uuids only', async () => {
    assert.ok(adminToken, 'previous test provided the admin token');
    clearCaptured();
    const res = await request(app)
      .post('/api/users/u-obs-forced/reset-password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ password: 'Reset#Pass777' });
    assert.equal(res.status, 200);
    const events = eventsOf('auth_admin_password_reset');
    assert.equal(events.length, 1);
    assert.equal(events[0].targetUserId, 'u-obs-forced');
    assert.equal(events[0].actorUserId, adminUserId);
    assert.ok(!captureText().includes('Reset#Pass777'), 'new password leaked');
  });
});

/* ================================================================== */
/* 9. Rate-limit observability                                         */
/* ================================================================== */

describe('Rate-limit observability', () => {
  it('22. a limiter rejection emits rate_limit_rejected without Authorization/Cookie/body data', async () => {
    const a = buildMinimalApp(false);
    a.use('/api', createApiNotFoundHandler());
    a.use(createApiErrorHandler({ production: false }));

    clearCaptured();
    let res: request.Response | undefined;
    // Auth limiter: 20 counted failures, the 21st request is rejected.
    for (let i = 0; i < 21; i += 1) {
      res = await request(a)
        .post('/api/auth/login')
        .set('Authorization', 'Bearer SENTINEL-RATELIMIT-AUTHZ')
        .set('Cookie', 'session=SENTINEL-RATELIMIT-COOKIE')
        .send({ employeeId: 'sentinel.rl@example.com', password: 'SentinelRateLimit#999' });
    }
    assert.equal(res?.status, 429);
    const rejects = eventsOf('rate_limit_rejected');
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0].limiter, 'auth');
    assert.equal(rejects[0].method, 'POST');
    assert.equal(rejects[0].route, '/api/auth/login');
    assert.ok(rejects[0].requestId, 'the rejection carries the request correlation id');

    const line = captured.find((c) => c.line.includes('rate_limit_rejected'))!.line;
    assert.ok(!line.includes('SENTINEL-RATELIMIT-AUTHZ'));
    assert.ok(!line.includes('SENTINEL-RATELIMIT-COOKIE'));
    assert.ok(!line.includes('SentinelRateLimit#999'));
    assert.ok(!line.includes('sentinel.rl@example.com'));
    // And not the raw client IP either (privacy default).
    assert.ok(!line.includes('127.0.0.1'));

    // The 429 response still completes through the normal completion path.
    const completions = eventsOf('http_request_complete');
    assert.equal(completions[completions.length - 1].status, 429);
  });
});
