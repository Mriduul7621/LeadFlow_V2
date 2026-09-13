/**
 * production-readiness.test.ts — production operational layer guards
 * ------------------------------------------------------------------
 * Proves the production-readiness hardening added in the "ops" PR without
 * needing a live deployment:
 *
 *   Part 1 — configuration validation (server/config/env.ts)
 *   Part 2 — readiness contract (server/health.ts)
 *   Part 3 — production smoke test (scripts/smoke-production.ts)
 *   Part 4 — source guards (entrypoints + no committed secrets)
 *
 * The existing production-security suites (PR #39), RBAC/fallback suites
 * (PR #40) and LeadFlow CI (PR #41) remain the contract for their own
 * behaviour and must stay green alongside this file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  validateProductionConfig,
  isWeakJwtSecret,
  KNOWN_WEAK_JWT_SECRETS,
  MIN_JWT_SECRET_LENGTH,
  ENV_VAR_SPECS,
} from '../config/env.js';
import {
  buildReadinessReport,
  resolveBuildIdentifier,
  resolveEnvironmentIdentifier,
} from '../health.js';
import { runSmokeChecks } from '../../scripts/smoke-production.js';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/* ==================================================================== */
/* Part 1 — configuration validation                                    */
/* ==================================================================== */

describe('Production configuration validation', () => {
  it('A. classifies DATABASE_URL and JWT_SECRET as REQUIRED', () => {
    const db = ENV_VAR_SPECS.find((s) => s.name === 'DATABASE_URL');
    const jwt = ENV_VAR_SPECS.find((s) => s.name === 'JWT_SECRET');
    assert.equal(db?.classification, 'REQUIRED');
    assert.equal(jwt?.classification, 'REQUIRED');
  });

  it('B. production missing critical config fails safely (no throw, BLOCKER issues)', () => {
    const report = validateProductionConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    assert.equal(report.production, true);
    assert.equal(report.valid, false);
    const names = report.issues.filter((i) => i.severity === 'BLOCKER').map((i) => i.name);
    assert.ok(names.includes('DATABASE_URL'), 'missing DATABASE_URL is a BLOCKER');
    assert.ok(names.includes('JWT_SECRET'), 'missing JWT_SECRET is a BLOCKER');
  });

  it('C. non-production (dev/test) with a demo secret is a WARNING, not a BLOCKER', () => {
    const report = validateProductionConfig({
      NODE_ENV: 'test',
      JWT_SECRET: 'leadflow_development_only_secret',
    } as NodeJS.ProcessEnv);
    assert.equal(report.production, false);
    assert.equal(report.valid, true);
    const jwt = report.issues.find((i) => i.name === 'JWT_SECRET');
    assert.ok(jwt, 'weak dev secret is surfaced');
    assert.equal(jwt.severity, 'WARNING');
  });

  it('D. production never accepts a known development/default JWT secret', () => {
    assert.equal(isWeakJwtSecret('leadflow_development_only_secret'), true);
    assert.equal(isWeakJwtSecret('replace-with-a-long-random-secret'), true);
    assert.equal(isWeakJwtSecret(undefined), true);
    assert.equal(isWeakJwtSecret('short'), true); // below MIN_JWT_SECRET_LENGTH
    assert.equal(isWeakJwtSecret('a'.repeat(MIN_JWT_SECRET_LENGTH - 1)), true);
    assert.equal(isWeakJwtSecret('a'.repeat(MIN_JWT_SECRET_LENGTH)), false);

    const report = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://leadflow:supersecret@db.internal:5432/postgres',
      JWT_SECRET: 'leadflow_development_only_secret',
    } as NodeJS.ProcessEnv);
    assert.equal(report.valid, false);
    const jwt = report.issues.find((i) => i.name === 'JWT_SECRET');
    assert.equal(jwt?.severity, 'BLOCKER');
  });

  it('E. secret values never appear in config errors', () => {
    const report = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://leadflow:supersecret-value-abc@db.internal:5432/postgres',
      JWT_SECRET: 'leadflow_development_only_secret',
    } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('supersecret-value-abc'), 'DATABASE_URL password must not leak');
    assert.ok(!serialized.includes('db.internal'), 'DATABASE_URL host must not leak');
    assert.ok(!serialized.includes('postgresql://'), 'DATABASE_URL must not leak');
    assert.ok(!serialized.includes('leadflow_development_only_secret'), 'JWT secret value must not leak');
  });

  it('F. every known-weak placeholder is rejected (and none is empty)', () => {
    for (const weak of KNOWN_WEAK_JWT_SECRETS) {
      assert.ok(weak.length > 0);
      assert.equal(isWeakJwtSecret(weak), true, `"${weak}" must be rejected`);
    }
  });
});

/* ==================================================================== */
/* Part 2 — readiness contract                                          */
/* ==================================================================== */

describe('Readiness contract', () => {
  it('G. ready when runtime ok, config valid and DB configured + reachable', () => {
    const report = buildReadinessReport({
      databaseConfigured: true,
      databaseReachable: true,
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://x:x@x/x',
        JWT_SECRET: 'a-strong-production-secret-1234567890',
      } as NodeJS.ProcessEnv,
    });
    assert.equal(report.status, 'ready');
    assert.equal(report.checks.database.configured, true);
    assert.equal(report.checks.database.reachable, true);
    assert.equal(report.checks.config.ok, true);
  });

  it('H. reports unavailable DB honestly (not ready)', () => {
    const report = buildReadinessReport({
      databaseConfigured: true,
      databaseReachable: false,
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://x:x@x/x',
        JWT_SECRET: 'a-strong-production-secret-1234567890',
      } as NodeJS.ProcessEnv,
    });
    assert.equal(report.status, 'not_ready');
    assert.equal(report.checks.database.configured, true);
    assert.equal(report.checks.database.reachable, false);
  });

  it('I. reports misconfiguration honestly (not ready)', () => {
    const report = buildReadinessReport({
      databaseConfigured: false,
      databaseReachable: false,
      env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    });
    assert.equal(report.status, 'not_ready');
    assert.equal(report.checks.config.ok, false);
    assert.ok(report.checks.config.issues.includes('DATABASE_URL'));
  });

  it('J. never exposes secrets, connection strings or SQL in the readiness body', () => {
    const report = buildReadinessReport({
      databaseConfigured: true,
      databaseReachable: true,
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://leadflow:supersecret-xyz@db.internal:5432/postgres',
        JWT_SECRET: 'a-strong-production-secret-1234567890',
      } as NodeJS.ProcessEnv,
    });
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('supersecret-xyz'));
    assert.ok(!serialized.includes('db.internal'));
    assert.ok(!serialized.includes('postgresql://'));
    assert.ok(!serialized.includes('a-strong-production-secret'));
  });

  it('K. build identifier is resolved safely and never fabricated', () => {
    assert.equal(resolveBuildIdentifier({} as NodeJS.ProcessEnv), null);
    assert.equal(resolveBuildIdentifier({ VERCEL_GIT_COMMIT_SHA: 'abc123' } as NodeJS.ProcessEnv), 'abc123');
    assert.equal(resolveBuildIdentifier({ GIT_SHA: 'deadbeef' } as NodeJS.ProcessEnv), 'deadbeef');
  });

  it('L. environment identifier is safe and bounded', () => {
    assert.equal(resolveEnvironmentIdentifier({ VERCEL: '1' } as NodeJS.ProcessEnv), 'vercel');
    assert.equal(resolveEnvironmentIdentifier({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), 'production');
    assert.equal(resolveEnvironmentIdentifier({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), 'test');
  });
});

/* ==================================================================== */
/* Part 3 — production smoke test                                       */
/* ==================================================================== */

/** Builds a mock fetch with per-path canned responses and records methods. */
function mockFetch(handlers: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) {
  const methods: string[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    const method = String(init?.method || 'GET').toUpperCase();
    methods.push(method);
    const path = String(url).replace(/^https?:\/\/[^/]+/, '') || '/';
    const h = handlers[path];
    if (!h) {
      return new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    const headers = new Headers(h.headers || {});
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    const body = typeof h.body === 'string' ? h.body : JSON.stringify(h.body);
    return new Response(body, { status: h.status, headers });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, methods };
}

const HEALTHY_HANDLERS = {
  '/api/health': {
    status: 200,
    body: { ok: true, database: true, mode: 'database', status: 'ok' },
    headers: {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'SAMEORIGIN',
    },
  },
  '/api/health/readiness': { status: 200, body: { status: 'ready' } },
  '/api/db-status': { status: 200, body: { connected: true, mode: 'database' } },
  '/api/leads': { status: 401, body: { success: false, message: 'Unauthorized' } },
  '/api/__leadflow_smoke_nope__': { status: 404, body: { success: false, message: 'API route not found' } },
  '/': { status: 200, body: '<!doctype html>', headers: { 'content-type': 'text/html' } },
};

describe('Production smoke test', () => {
  it('M. passes on a healthy response', async () => {
    const { fetchImpl } = mockFetch(HEALTHY_HANDLERS);
    const result = await runSmokeChecks('https://example.com', { fetchImpl });
    assert.equal(result.ok, true, JSON.stringify(result.checks));
  });

  it('N. fails non-zero on unhealthy readiness', async () => {
    const handlers = {
      ...HEALTHY_HANDLERS,
      '/api/health/readiness': { status: 503, body: { status: 'not_ready', checks: { database: { reachable: false } } } },
    };
    const { fetchImpl } = mockFetch(handlers);
    const result = await runSmokeChecks('https://example.com', { fetchImpl });
    assert.equal(result.ok, false);
    const readinessCheck = result.checks.find((c) => c.name.includes('readiness'));
    assert.equal(readinessCheck?.ok, false);
  });

  it('O. verifies the protected endpoint returns 401', async () => {
    const handlers = {
      ...HEALTHY_HANDLERS,
      '/api/leads': { status: 200, body: { success: true, data: [] } }, // auth misconfigured
    };
    const { fetchImpl } = mockFetch(handlers);
    const result = await runSmokeChecks('https://example.com', { fetchImpl });
    const authCheck = result.checks.find((c) => c.name.includes('401'));
    assert.equal(authCheck?.ok, false);
  });

  it('P. verifies security headers where applicable', async () => {
    const handlers = {
      ...HEALTHY_HANDLERS,
      '/api/health': {
        status: 200,
        body: { ok: true },
        headers: {}, // no security headers
      },
    };
    const { fetchImpl } = mockFetch(handlers);
    const result = await runSmokeChecks('https://example.com', { fetchImpl });
    const securityChecks = result.checks.filter((c) => c.name.startsWith('security:'));
    assert.ok(securityChecks.length > 0);
    assert.ok(securityChecks.every((c) => c.ok === false), 'missing headers must fail security checks');
  });

  it('Q. never mutates business data (only read methods are issued)', async () => {
    const { fetchImpl, methods } = mockFetch(HEALTHY_HANDLERS);
    await runSmokeChecks('https://example.com', { fetchImpl });
    assert.ok(methods.length > 0);
    const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    assert.ok(
      methods.every((m) => !writeMethods.has(m)),
      `only read methods allowed, got: ${methods.join(', ')}`
    );
  });

  it('R. verifies unknown API endpoint returns JSON 404', async () => {
    const handlers = {
      ...HEALTHY_HANDLERS,
      '/api/__leadflow_smoke_nope__': { status: 200, body: '<html>fallback</html>' },
    };
    const { fetchImpl } = mockFetch(handlers);
    const result = await runSmokeChecks('https://example.com', { fetchImpl });
    const routing = result.checks.find((c) => c.name.includes('404'));
    assert.equal(routing?.ok, false);
  });
});

/* ==================================================================== */
/* Part 4 — source guards                                               */
/* ==================================================================== */

describe('Production-readiness source guards', () => {
  it('S. both entrypoints still serve liveness and add readiness (additive)', () => {
    for (const file of ['api/index.ts', 'server.ts']) {
      const src = read(file);
      assert.ok(src.includes("/api/health'"), `${file} must keep /api/health`);
      assert.ok(src.includes('/api/health/readiness'), `${file} must add /api/health/readiness`);
      assert.ok(src.includes('healthHandler'), `${file} must keep the liveness handler`);
    }
  });

  it('T. liveness body shape is unchanged (backward compatible)', () => {
    // The liveness handler must still return exactly {ok, database, mode, status}.
    const api = read('api/index.ts');
    assert.ok(api.includes('ok: true'), 'liveness keeps ok: true');
    assert.ok(api.includes('mode:'), 'liveness keeps mode');
    assert.ok(api.includes('status:'), 'liveness keeps status');
    // The new readiness contract lives in a separate endpoint, not in health.
    assert.ok(api.includes('buildReadinessReport'), 'readiness is a separate builder');
  });

  it('U. production router refuses weak/default JWT secrets in production', () => {
    const src = read('server/routes/production.routes.ts');
    assert.ok(src.includes('isWeakJwtSecret'), 'router must use the shared weak-secret check');
    assert.ok(src.includes('Refusing to sign a token in production'), 'signToken must refuse weak secrets');
  });

  it('V. no production secrets are committed', () => {
    const gitignore = read('.gitignore');
    assert.ok(gitignore.includes('.env'), '.env is ignored');

    // The env template must use placeholders, not real credentials.
    const example = read('.env.example');
    assert.ok(example.includes('replace-with-a-long-random-secret'), 'JWT placeholder present');
    assert.ok(example.includes('<password>'), 'DATABASE_URL uses a placeholder password');
    assert.ok(!/postgresql:\/\/[^:]+:[^@< ]+@/.test(example), 'no real connection string in .env.example');

    // The smoke script and config validator must not embed credentials.
    const smoke = read('scripts/smoke-production.ts');
    assert.ok(!/postgresql:\/\//.test(smoke), 'smoke script has no connection string');
    assert.ok(!smoke.includes('JWT_SECRET='), 'smoke script has no JWT secret');
  });
});

/* ==================================================================== */
/* Part 5 — server-secret exposure guards (GEMINI_API_KEY)              */
/* ==================================================================== */

/** Recursively list files under a relative directory (test-only helper). */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(rel));
    else out.push(rel);
  }
  return out;
}

const CLIENT_DIRS = ['src'];
const CLIENT_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

function clientSourceFiles(): string[] {
  return CLIENT_DIRS.flatMap((d) =>
    listFiles(d).filter((f) => CLIENT_EXTS.some((ext) => f.endsWith(ext)))
  );
}

describe('Server-secret exposure guards (GEMINI_API_KEY)', () => {
  it('W. GEMINI_API_KEY is not injected into the browser via Vite define/env', () => {
    const vite = read('vite.config.ts');
    assert.ok(!vite.includes('GEMINI_API_KEY'), 'vite.config.ts must not reference GEMINI_API_KEY');
    assert.ok(!/process\.env\.GEMINI/.test(vite), 'vite.config.ts must not inject a process.env GEMINI value');
    // Any process.env reference must be a public VITE_* var (or a benign dev flag),
    // never a server secret.
    const processEnvRefs = [...vite.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    const allowed = new Set(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'DISABLE_HMR']);
    for (const name of processEnvRefs) {
      assert.ok(allowed.has(name), `process.env.${name} must not be injected into the browser bundle`);
    }
  });

  it('X. no client source imports or references the Gemini SDK or key', () => {
    const files = clientSourceFiles();
    assert.ok(files.length > 0, 'expected client source files to scan');
    for (const f of files) {
      const src = read(f);
      assert.ok(!/GEMINI_API_KEY/i.test(src), `${f} must not reference GEMINI_API_KEY`);
      assert.ok(!/@google\/genai|GoogleGenAI|google-genai/i.test(src), `${f} must not import the Gemini SDK`);
    }
  });

  it('Y. GEMINI_API_KEY is no longer classified as a runtime env requirement', () => {
    const gemini = ENV_VAR_SPECS.filter((s) => /GEMINI/i.test(s.name));
    assert.deepEqual(gemini, [], 'GEMINI_API_KEY must not appear in the env catalog');
  });

  it('Z. config validation never exposes a GEMINI_API_KEY value', () => {
    const report = validateProductionConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@h/d',
      JWT_SECRET: 'a-strong-production-secret-1234567890',
      GEMINI_API_KEY: 'AIzaVerySecretValue123456789',
    } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('AIzaVerySecretValue123456789'), 'GEMINI_API_KEY value must never leak');
    // And the env catalog's own source must not contain a hard-coded secret.
    const envSrc = read('server/config/env.ts');
    assert.ok(!/AIza[A-Za-z0-9_-]{10,}/.test(envSrc), 'no hard-coded API key in env.ts');
  });

  it('AA. only public VITE_* variables remain in the Vite define block', () => {
    const vite = read('vite.config.ts');
    // Every `define` entry that names an import.meta.env var must be VITE_-prefixed.
    const defines = [...vite.matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    assert.ok(defines.length > 0, 'expected at least one define entry');
    for (const name of defines) {
      assert.ok(name.startsWith('VITE_'), `only VITE_* vars may be defined, got ${name}`);
    }
  });

  it('AB. the Gemini SDK dependency is no longer shipped', () => {
    const pkg = read('package.json');
    assert.ok(!pkg.includes('@google/genai'), 'package.json must not depend on @google/genai');
    const lock = read('package-lock.json');
    assert.ok(!lock.includes('@google/genai'), 'package-lock.json must not reference @google/genai');
  });
});