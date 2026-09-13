/**
 * scripts/smoke-production.ts — safe production smoke test
 * ------------------------------------------------------------------
 * A non-destructive, unauthenticated smoke test for a running LeadFlow
 * deployment. It verifies the operational surface WITHOUT creating,
 * updating or deleting any business data:
 *
 *   1. application/API reachable            (GET /api/health -> 200)
 *   2. liveness contract                    (body.ok === true)
 *   3. readiness contract                   (GET /api/health/readiness -> 200, ready)
 *   4. database status contract             (GET /api/db-status -> 200, connected)
 *   5. unauthenticated protected endpoint   (GET /api/leads -> 401)
 *   6. unknown API endpoint                 (GET /api/__nope__ -> JSON 404)
 *   7. security headers                     (nosniff / referrer-policy / frame)
 *   8. HTML shell / static delivery         (GET / -> text/html, soft check)
 *
 * The ONLY HTTP methods issued are GET/HEAD — never a write method — so a
 * default run can never mutate production data. Authenticated destructive
 * checks are out of scope (see docs/PRODUCTION_READINESS.md).
 *
 * Target selection: LEADFLOW_BASE_URL (no default that points at real
 * infrastructure). No production credentials are hard-coded.
 *
 * Usage:
 *   LEADFLOW_BASE_URL=https://<host> npm run smoke:production
 *   LEADFLOW_BASE_URL=http://127.0.0.1:3000 npx tsx scripts/smoke-production.ts
 *
 * Exit code 0 = all checks passed, non-zero = at least one check failed.
 */

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeResult {
  ok: boolean;
  baseUrl: string;
  checks: SmokeCheck[];
}

export interface SmokeOptions {
  /** Injectable fetch (for tests / custom TLS handling). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** When true (default), a non-ready target fails the run. */
  expectReadiness?: boolean;
  /** When false, skips the optional HTML-shell check. */
  checkHtmlShell?: boolean;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export async function runSmokeChecks(
  baseUrl: string,
  opts: SmokeOptions = {}
): Promise<SmokeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const expectReadiness = opts.expectReadiness ?? true;
  const checkHtmlShell = opts.checkHtmlShell ?? true;

  const base = normalizeBase(baseUrl);
  const checks: SmokeCheck[] = [];
  const issuedMethods: string[] = [];

  async function req(method: string, path: string): Promise<{ status: number; body: any; headers: Headers }> {
    issuedMethods.push(method);
    const res = await fetchImpl(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { accept: 'application/json, text/html' },
    });
    let body: any = null;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };

  // 1 + 2. Liveness.
  const health = await req('GET', '/api/health');
  add(
    'liveness: GET /api/health responds 200',
    health.status === 200,
    `status=${health.status}`
  );
  add(
    'liveness: body.ok === true',
    !!health.body && health.body.ok === true,
    `body=${JSON.stringify(health.body)}`
  );

  // 3. Readiness.
  const readiness = await req('GET', '/api/health/readiness');
  const readyOk = readiness.status === 200 && !!readiness.body && readiness.body.status === 'ready';
  if (expectReadiness) {
    add(
      'readiness: GET /api/health/readiness is ready (200)',
      readyOk,
      `status=${readiness.status} body=${JSON.stringify(readiness.body)}`
    );
  } else {
    add(
      'readiness: GET /api/health/readiness answered (200 or 503)',
      readiness.status === 200 || readiness.status === 503,
      `status=${readiness.status}`
    );
  }

  // 4. Database status contract (connected in a healthy deployment).
  const dbStatus = await req('GET', '/api/db-status');
  const dbOk = dbStatus.status === 200 && !!dbStatus.body && dbStatus.body.connected === true;
  if (expectReadiness) {
    add(
      'db-status: GET /api/db-status reports connected (200)',
      dbOk,
      `status=${dbStatus.status} body=${JSON.stringify(dbStatus.body)}`
    );
  } else {
    add(
      'db-status: GET /api/db-status answered (200 or 503)',
      dbStatus.status === 200 || dbStatus.status === 503,
      `status=${dbStatus.status}`
    );
  }

  // 5. Protected endpoint must be 401 without a token.
  const protectedRes = await req('GET', '/api/leads');
  add(
    'auth: unauthenticated GET /api/leads returns 401',
    protectedRes.status === 401,
    `status=${protectedRes.status}`
  );

  // 6. Unknown API endpoint must return JSON 404.
  const notFound = await req('GET', '/api/__leadflow_smoke_nope__');
  add(
    'routing: unknown API endpoint returns 404',
    notFound.status === 404,
    `status=${notFound.status}`
  );
  add(
    'routing: unknown API endpoint returns JSON (not HTML)',
    notFound.body && typeof notFound.body === 'object',
    `body=${JSON.stringify(notFound.body)}`
  );

  // 7. Security headers (present in production).
  const xcto = (health.headers.get('x-content-type-options') || '').toLowerCase();
  const referrer = (health.headers.get('referrer-policy') || '').toLowerCase();
  const frame = (health.headers.get('x-frame-options') || '').toLowerCase();
  add(
    'security: X-Content-Type-Options: nosniff',
    xcto === 'nosniff',
    `value=${health.headers.get('x-content-type-options') || '<missing>'}`
  );
  add(
    'security: Referrer-Policy present',
    referrer.length > 0,
    `value=${health.headers.get('referrer-policy') || '<missing>'}`
  );
  add(
    'security: X-Frame-Options present (SAMEORIGIN or DENY)',
    frame === 'sameorigin' || frame === 'deny',
    `value=${health.headers.get('x-frame-options') || '<missing>'}`
  );

  // 8. HTML shell / static delivery (soft: not every runtime serves it the
  //    same way, and a bare API function may legitimately 404 the root).
  if (checkHtmlShell) {
    const shell = await req('GET', '/');
    const ct = (shell.headers.get('content-type') || '').toLowerCase();
    const okShell = shell.status === 200 && ct.includes('text/html');
    add(
      'static: GET / returns an HTML shell (200, text/html)',
      okShell,
      `status=${shell.status} content-type=${ct || '<missing>'}`
    );
  }

  // Safety invariant: the smoke run must never issue a write method.
  const wrote = issuedMethods.some((m) => WRITE_METHODS.has(m.toUpperCase()));
  add('safety: no write methods were issued', !wrote, `methods=${issuedMethods.join(', ')}`);

  return { ok: checks.every((c) => c.ok), baseUrl: base, checks };
}

async function main(): Promise<void> {
  const baseUrl = process.env.LEADFLOW_BASE_URL;
  if (!baseUrl) {
    console.error(
      'LEADFLOW_BASE_URL is not set. Provide the target base URL, e.g.\n' +
        '  LEADFLOW_BASE_URL=https://<host> npm run smoke:production'
    );
    process.exit(2);
  }

  const result = await runSmokeChecks(baseUrl, {
    expectReadiness: process.env.LEADFLOW_SMOKE_EXPECT_READY !== '0',
    checkHtmlShell: process.env.LEADFLOW_SMOKE_CHECK_HTML !== '0',
  });

  console.log(`Smoke test against ${result.baseUrl}`);
  for (const c of result.checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }

  const failed = result.checks.filter((c) => !c.ok).length;
  console.log('');
  if (!result.ok) {
    console.error(`✗ Smoke test FAILED (${failed} check(s)).`);
    process.exit(1);
  }
  console.log('✓ Smoke test passed.');
}

// Run as a CLI only when executed directly (tsx scripts/smoke-production.ts).
// When imported by the test suite, `process.argv[1]` is the test runner, so
// main() is not invoked.
const invokedAsScript = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/scripts/smoke-production.ts');
if (invokedAsScript) {
  main().catch((err) => {
    console.error('Smoke test error:', err?.message || err);
    process.exit(1);
  });
}
