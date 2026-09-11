/**
 * perf-diagnostics-source-guards.test.ts
 * ------------------------------------------------------------------
 * TEMPORARY admin-only mobile Performance Diagnostics feature.
 *
 * The tests are split in two halves:
 *   1. Source guards — the instrumentation lives ONLY in the centralized
 *      API layer (lib/apiClient.ts around the real fetch + one
 *      body-inclusive upgrade call in shared/api/http.ts), the admin-only
 *      route/menu/page wiring exists, the page issues no requests, no new
 *      server endpoint was added, and no web-storage API is used.
 *   2. Behavior (no network, no DB) — the recorder captures timing
 *      metadata for API requests only, bounds history at 30, upgrades to
 *      body-inclusive duration, is cleared on logout, can never be
 *      inherited by a different authenticated session, and — critically —
 *      never stores or copies tokens, Authorization headers, request or
 *      response bodies, or sensitive query values.
 *
 * Existing behavior (auth flow, RBAC, coalescing, Server-Timing from
 * PR #29) is asserted by the pre-existing suites, which keep running.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Remove block + line comments so doc mentions don't trip absence checks. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ==================================================================== */
/* 1. Instrumentation lives in the CENTRALIZED API layer only           */
/* ==================================================================== */

describe('Diagnostics — centralized API instrumentation', () => {
  it('A. lib/apiClient.ts times the real fetch for /api/ calls', () => {
    const client = stripComments(read('src/lib/apiClient.ts'));

    assert.ok(client.includes('recordApiRequestStart('), 'patched fetch must record request start');
    assert.ok(client.includes('recordApiRequestSettled('), 'patched fetch must record the settled response');
    assert.ok(client.includes('recordApiRequestFailed('), 'patched fetch must record network errors');

    // The recorder receives ONLY url + method — never the init object, so
    // headers/tokens/bodies are structurally unreachable.
    assert.match(client, /recordApiRequestStart\(url,\s*\(init\.method \|\|/, 'start records exactly the URL and HTTP method (init.method only)');
    assert.doesNotMatch(client, /recordApiRequest(Settled|Failed)\s*\([^)]*\binit\b/, 'settle/fail never receive the request init object');
    assert.doesNotMatch(client, /recordApiRequestStart\([^)]*init\.(headers|body|credentials)/, 'no header/body material is passed to the recorder');

    // Timing is taken around the REAL fetch (performance-based clock).
    assert.ok(client.includes('diagnosticsNowMs() - startedPerfMs'), 'durations measured from before the request to its settlement');

    // Both authenticated and unauthenticated /api/ branches are instrumented.
    const branches = client.split('return instrumentedDiagnostics(');
    assert.equal(branches.length, 3, 'both the no-token and token /api/ branches must be instrumented (2 call sites + definition split)');
  });

  it('B. only API requests are captured (non-/api/ fetches pass through untouched)', () => {
    const client = stripComments(read('src/lib/apiClient.ts'));
    const nonApiReturn = client.indexOf('if (!isApiCall)');
    const firstRecord = client.indexOf('recordApiRequestStart(');
    assert.ok(nonApiReturn !== -1 && firstRecord !== -1);
    assert.ok(nonApiReturn < firstRecord, 'the !isApiCall early return must precede any diagnostics recording');
    const passthrough = client.slice(nonApiReturn, nonApiReturn + 120);
    assert.ok(passthrough.includes('return originalFetch(input, init)'), 'non-API requests bypass instrumentation entirely');
  });

  it('C. shared/api/http.ts upgrades to body-inclusive duration without semantic changes', () => {
    const http = read('src/modules/shared/api/http.ts');
    assert.match(http, /import \{ noteApiBodySettled \} from '\.\/diagnostics';/, 'http.ts imports the recorder upgrade helper');
    assert.equal(http.split('noteApiBodySettled(response)').length - 1, 1, 'exactly one upgrade call site');

    // The upgrade call sits right after the body read, before any parsing.
    const readIdx = http.indexOf('const text = await response.text()');
    const noteIdx = http.indexOf('noteApiBodySettled(response)');
    const parseIdx = http.indexOf('let body: any = null');
    assert.ok(readIdx !== -1 && noteIdx > readIdx && noteIdx < parseIdx, 'body-settled note runs between the body read and parsing');

    // Response semantics preserved: unwrap, error mapping, 401 session flow.
    assert.ok(http.includes('function unwrapBody'), 'unwrapBody untouched');
    assert.ok(http.includes("body.success === true && 'data' in body"), 'envelope unwrapping untouched');
    assert.ok(http.includes("response.status === 401"), '401 branch untouched');
    assert.ok(http.includes('rejectedTheActiveSession'), '401 session-scoping untouched');
    assert.ok(http.includes('throw new ApiError(response.status, message, body)'), 'error mapping untouched');
    assert.ok(http.includes('export async function apiRequest'), 'apiRequest unchanged');
    assert.ok(http.includes('export async function apiRequestEnvelope'), 'apiRequestEnvelope unchanged');
  });

  it('D. no page-level instrumentation — the recorder is wired nowhere else', () => {
    const offenders = [
      'src/modules/leads/services/leadService.ts',
      'src/modules/dashboard/services/dashboardService.ts',
      'src/modules/scheduledActivities/services/scheduledActivityService.ts',
      'src/modules/notifications/services/notificationService.ts',
      'src/modules/admin/services/adminService.ts',
      'src/modules/users/services/userService.ts',
    ].filter(rel => read(rel).includes('recordApiRequest') || read(rel).includes('diagnostics'));
    assert.deepEqual(offenders, [], 'individual services/pages must not import the diagnostics recorder');
  });
});

/* ==================================================================== */
/* 2. No new server endpoint, no persistence, read-only UI              */
/* ==================================================================== */

describe('Diagnostics — client-only, read-only, in-memory only', () => {
  it('E. no new server endpoint was added for diagnostics', () => {
    const serverSources = [
      'server/routes/production.routes.ts',
      'api/index.ts',
      'server.ts',
    ];
    for (const rel of serverSources) {
      const source = read(rel).toLowerCase();
      assert.ok(!source.includes('diagnostics'), `${rel} must not expose any diagnostics endpoint`);
    }
  });

  it('F. the recorder uses NO storage API and never sends data anywhere', () => {
    const diag = stripComments(read('src/modules/shared/api/diagnostics.ts'));
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'sendBeacon', 'XMLHttpRequest', 'WebSocket', 'fetch(']) {
      assert.ok(!diag.includes(banned), `diagnostics recorder must not use ${banned}`);
    }
  });

  it('G. the diagnostics PAGE is read-only: no requests, no writes, no storage', () => {
    const page = stripComments(read('src/modules/settings/pages/PerformanceDiagnostics.tsx'));
    for (const banned of ['apiRequest', 'fetch(', '.post(', '.put(', '.patch(', "'POST'", '"POST"', 'localStorage', 'sessionStorage', 'indexedDB']) {
      assert.ok(!page.includes(banned), `diagnostics page must not contain ${banned}`);
    }
    assert.ok(page.includes('clearApiDiagnostics()'), 'page wires the explicit Clear button');
    assert.ok(page.includes('buildDiagnosticsCopySummary()'), 'page wires the Copy summary button');
  });
});

/* ==================================================================== */
/* 3. Admin-only access wiring                                          */
/* ==================================================================== */

describe('Diagnostics — admin-only access control', () => {
  it('H. resolveAdminAccess grants only ADMIN/SUPERADMIN (pure rule)', async () => {
    ensureStorageShim();
    const gate = await import('../../src/modules/auth/components/AdminRoute.js');
    assert.equal(gate.resolveAdminAccess('ADMIN'), 'granted');
    assert.equal(gate.resolveAdminAccess('SUPERADMIN'), 'granted');
    assert.equal(gate.resolveAdminAccess('admin'), 'granted', 'case-insensitive');
    for (const denied of ['RM', 'ASM', 'BDM', 'BE', 'BH', 'RO', 'user', '', undefined, null]) {
      assert.equal(gate.resolveAdminAccess(denied as any), 'denied', `${String(denied)} must be denied`);
    }
  });

  it('I. the new route is wrapped in ProtectedRoute AND AdminRoute', () => {
    const app = read('src/App.tsx');
    assert.match(app, /const\s+PerformanceDiagnostics\s*=\s*lazy\(\s*\(\s*\)\s*=>\s*import\s*\(\s*['"]\.\/modules\/settings\/pages\/PerformanceDiagnostics['"]\s*\)/, 'diagnostics page must be a lazy chunk like every other page');
    const idx = app.indexOf("path: '/settings/performance-diagnostics'");
    assert.ok(idx !== -1, 'the admin-only route must exist');
    const routeSlice = app.slice(idx, idx + 400);
    assert.ok(routeSlice.includes('<ProtectedRoute>'), 'route stays behind the standard session gate');
    assert.ok(routeSlice.includes('<AdminRoute>'), 'route is wrapped in the ADMIN-only gate');
  });

  it('J. non-admins are redirected by AdminRoute and the sidebar entry is admin-only', () => {
    const gate = read('src/modules/auth/components/AdminRoute.tsx');
    assert.ok(gate.includes('<Navigate to="/settings" replace />'), 'non-admins must be redirected, not shown an empty page');

    const layout = read('src/layouts/AppLayout.tsx');
    assert.match(layout, /path:\s*'\/settings\/performance-diagnostics',\s*roles:\s*\[UserRole\.ADMIN\]/, 'sidebar entry must be visible to ADMIN only');
  });

  it('K. the page itself re-checks the role before rendering anything', () => {
    const page = stripComments(read('src/modules/settings/pages/PerformanceDiagnostics.tsx'));
    assert.ok(page.includes("resolveAdminAccess(user?.role) === 'denied'"), 'in-page admin re-check must exist');
    assert.ok(page.includes('<Navigate to="/settings" replace />'), 'in-page denial redirects');
  });
});

/* ==================================================================== */
/* 4. Behavior — recorder (no network, no DB)                           */
/* ==================================================================== */

function ensureStorageShim() {
  if ((globalThis as any).localStorage) return;
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  (globalThis as any).window = globalThis;
}

function loginSession(store: any, userId: string, token: string, role = 'ADMIN') {
  store.setState({
    user: { id: userId, employeeId: 'EMP-' + userId, name: userId, role } as any,
    token,
    isAuthenticated: true,
    isInitialized: true,
  });
}

function fakeResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    ok: true,
    headers: {
      get(name: string) {
        if (String(name).toLowerCase() === 'server-timing') return 'total;dur=1180.4';
        if (String(name).toLowerCase() === 'content-length') return '2048';
        return null;
      },
    },
    // Decoy sensitive payload: must never be read or stored by the recorder.
    bodyJSON: { phone: 'SECRET-PHONE-017100000000', email: 'SECRET-EMAIL@example.com' },
    bodyText: 'SECRET-RESPONSE-BODY',
    ...overrides,
  };
}

describe('Diagnostics — recorder behavior', () => {
  it('L. records duration, method, status, Server-Timing, size, timestamps and pending state', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    loginSession(useAuthStore, 'diag-user-l', 'token-l');
    diag.clearApiDiagnostics();

    const id = diag.recordApiRequestStart('/api/dashboard?page=1&limit=20', 'GET');
    let list = diag.getApiDiagnostics();
    assert.equal(list.length, 1);
    assert.equal(list[0].pending, true, 'a started request is pending until it settles');
    assert.equal(list[0].seq, 1);
    assert.equal(list[0].firstAfterLoad, true, 'first request after app load is marked');
    assert.equal(list[0].method, 'GET');
    assert.equal(list[0].path, '/api/dashboard?page=1&limit=20', 'safe allowlisted query values are kept');

    diag.recordApiRequestSettled(id, fakeResponse(), 1180);
    list = diag.getApiDiagnostics();
    assert.equal(list[0].pending, false);
    assert.equal(list[0].status, 200);
    assert.equal(list[0].ok, true);
    assert.equal(list[0].serverTiming, 'total;dur=1180.4');
    assert.equal(list[0].responseSizeBytes, 2048);
    assert.equal(list[0].finishedAt !== null, true);

    // Body-inclusive upgrade from the shared http layer: the SAME Response
    // object, after the body read, raises durationMs above header time.
    const slowResponse = fakeResponse();
    const slowId = diag.recordApiRequestStart('/api/dashboard?view=slow', 'GET');
    diag.recordApiRequestSettled(slowId, slowResponse, 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    diag.noteApiBodySettled(slowResponse);
    list = diag.getApiDiagnostics();
    assert.equal(list[0].id, slowId);
    assert.ok(list[0].durationMs >= 25, `duration must be upgraded to body-inclusive time (got ${list[0].durationMs})`);
    assert.equal(list[0].headerDurationMs, 0, 'header-time measurement is preserved alongside');

    // An unknown Response object is a no-op (raw fetch paths never upgrade).
    const secondId = diag.recordApiRequestStart('/api/roles', 'GET');
    diag.recordApiRequestSettled(secondId, fakeResponse(), 900);
    const before = diag.getApiDiagnostics()[0].durationMs;
    diag.noteApiBodySettled({} as any);
    assert.equal(diag.getApiDiagnostics()[0].durationMs, before, 'unknown responses cannot mutate entries');
    list = diag.getApiDiagnostics();
    assert.equal(list[0].id, secondId, 'newest first');
    assert.equal(list[0].firstAfterLoad, false, 'subsequent requests are not the first-after-load marker');

    diag.clearApiDiagnostics();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('M. network failures are recorded with status 0 and a short error message', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    loginSession(useAuthStore, 'diag-user-m', 'token-m');
    diag.clearApiDiagnostics();

    const id = diag.recordApiRequestStart('/api/dashboard', 'GET');
    diag.recordApiRequestFailed(id, 4200, new Error('Failed to fetch'));
    const list = diag.getApiDiagnostics();
    assert.equal(list[0].networkError, true);
    assert.equal(list[0].status, 0);
    assert.equal(list[0].ok, false);
    assert.equal(list[0].durationMs, 4200);
    assert.equal(list[0].errorMessage, 'Failed to fetch');

    diag.clearApiDiagnostics();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('N. history is bounded to the most recent 30 requests', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    loginSession(useAuthStore, 'diag-user-n', 'token-n');
    diag.clearApiDiagnostics();

    for (let i = 0; i < 35; i++) {
      const id = diag.recordApiRequestStart(`/api/leads?page=${i}&limit=1`, 'GET');
      diag.recordApiRequestSettled(id, fakeResponse(), 100 + i);
    }
    const list = diag.getApiDiagnostics();
    assert.equal(list.length, 30, 'only the most recent 30 requests are kept');
    assert.equal(list[0].path, '/api/leads?page=34&limit=1', 'the newest request survives');
    assert.equal(list[list.length - 1].path, '/api/leads?page=5&limit=1', 'the oldest entries are evicted');

    diag.clearApiDiagnostics();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });
});

/* ==================================================================== */
/* 5. Privacy — nothing sensitive is ever stored or copied              */
/* ==================================================================== */

const SENSITIVE_URL =
  '/api/leads?search=SECRET-LEAD-NAME&contact=SECRET-PHONE-0171&email=SECRET-EMAIL@x.com&token=SECRET-QUERY-TOKEN&page=2&limit=50&status=Untouched';

describe('Diagnostics — privacy guarantees', () => {
  it('O. Authorization/token/request-body/response-body never reach storage even when present on the request', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    loginSession(useAuthStore, 'diag-user-o', 'SECRET-JWT-TOKEN-VALUE');
    diag.clearApiDiagnostics();

    // The recorder API accepts ONLY (url, method): a caller physically
    // cannot hand it the Authorization header or the request body.
    const id = diag.recordApiRequestStart(SENSITIVE_URL, 'POST');
    diag.recordApiRequestSettled(id, fakeResponse(), 640);

    const dump = JSON.stringify({
      entries: diag.getApiDiagnostics(),
      summary: diag.buildDiagnosticsCopySummary(),
    });

    for (const secret of ['SECRET-JWT-TOKEN-VALUE', 'Bearer', 'SECRET-LEAD-NAME', 'SECRET-PHONE-0171', 'SECRET-EMAIL@x.com', 'SECRET-QUERY-TOKEN', 'SECRET-RESPONSE-BODY', 'SECRET-PHONE-017100000000']) {
      assert.ok(!dump.includes(secret), `stored diagnostics must not contain ${secret}`);
    }
    // The decoy response payload fields are not referenced either.
    assert.ok(!dump.includes('bodyJSON') && !dump.includes('bodyText'), 'response payloads are not recorded');

    diag.clearApiDiagnostics();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('P. query values are default-deny sanitized; only safe pagination keys survive', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    loginSession(useAuthStore, 'diag-user-p', 'token-p');
    diag.clearApiDiagnostics();

    const id = diag.recordApiRequestStart(SENSITIVE_URL, 'GET');
    diag.recordApiRequestSettled(id, fakeResponse(), 100);

    const entry = diag.getApiDiagnostics()[0];
    assert.ok(entry.path.startsWith('/api/leads?'), 'path + query KEYS are kept for diagnosis');
    assert.ok(entry.path.includes('page=2'), 'page stays readable');
    assert.ok(entry.path.includes('limit=50'), 'limit stays readable');
    assert.ok(entry.path.includes('status=Untouched'), 'safe status filter stays readable');
    assert.ok(entry.path.includes('search=…'), 'search values are redacted');
    assert.ok(entry.path.includes('contact=…'), 'contact values are redacted');
    assert.ok(entry.path.includes('email=…'), 'email values are redacted');
    assert.ok(entry.path.includes('token=…'), 'token values are redacted');

    diag.clearApiDiagnostics();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('Q. the copy summary contains only timing metadata (paste-safe)', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    loginSession(useAuthStore, 'diag-user-q', 'SECRET-JWT-TOKEN-VALUE');
    diag.clearApiDiagnostics();

    const a = diag.recordApiRequestStart('/api/auth/session', 'GET');
    diag.recordApiRequestSettled(a, fakeResponse({ headers: { get: (n: string) => (String(n).toLowerCase() === 'server-timing' ? 'total;dur=2610' : null) } }), 2840);
    const b = diag.recordApiRequestStart(SENSITIVE_URL, 'GET');
    diag.recordApiRequestSettled(b, fakeResponse(), 1320);
    const c = diag.recordApiRequestStart('/api/roles', 'GET');
    diag.recordApiRequestSettled(c, fakeResponse(), 910);

    const text = diag.buildDiagnosticsCopySummary();
    assert.ok(text.includes('Performance Diagnostics'), 'summary header present');
    assert.ok(text.includes('Session started:'), 'session start present');
    assert.ok(text.includes('/api/auth/session — 2840 ms'), 'entry line format');
    assert.ok(text.includes('Server-Timing: total;dur=2610'), 'server timing included when present');
    assert.ok(text.includes('Slowest:'), 'slowest line present');
    assert.ok(text.includes('Requests >1s:'), 'over-1s count present');
    assert.ok(text.includes('Requests >3s:'), 'over-3s count present');
    assert.ok(text.includes('1st request after app load'), 'cold/warm marker included');
    for (const secret of ['SECRET', 'Bearer', 'token=…=']) {
      assert.ok(!text.includes(secret), `copy summary must not contain ${secret}`);
    }

    diag.clearApiDiagnostics();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('R. diagnostics are cleared on logout', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    loginSession(useAuthStore, 'diag-user-r', 'token-r');
    diag.clearApiDiagnostics();

    const id = diag.recordApiRequestStart('/api/dashboard', 'GET');
    diag.recordApiRequestSettled(id, fakeResponse(), 500);
    assert.equal(diag.apiDiagnosticsCount(), 1);

    useAuthStore.getState().logout();
    assert.equal(diag.apiDiagnosticsCount(), 0, 'logout must wipe all diagnostics');
  });

  it('S. a different authenticated session can never inherit prior diagnostics', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');

    loginSession(useAuthStore, 'diag-user-s-A', 'token-s-A');
    diag.clearApiDiagnostics();
    const idA = diag.recordApiRequestStart('/api/dashboard?view=A-PRIVATE', 'GET');
    diag.recordApiRequestSettled(idA, fakeResponse(), 700);
    assert.equal(diag.apiDiagnosticsCount(), 1);

    // A different user logs in (no logout in between — e.g. re-auth flow).
    loginSession(useAuthStore, 'diag-user-s-B', 'token-s-B');
    const idB = diag.recordApiRequestStart('/api/dashboard', 'GET');
    diag.recordApiRequestSettled(idB, fakeResponse(), 300);

    const list = diag.getApiDiagnostics();
    assert.equal(list.length, 1, 'session A data must be wiped, not merged');
    assert.equal(list[0].id, idB);
    assert.equal(list[0].seq, 1, 'sequence restarts for the new session');
    assert.ok(!JSON.stringify(list).includes('A-PRIVATE'), 'previous session URLs are gone');

    // Same user, NEW token (logout + login again) is also a new session.
    loginSession(useAuthStore, 'diag-user-s-B', 'token-s-B-2');
    const idC = diag.recordApiRequestStart('/api/dashboard', 'GET');
    diag.recordApiRequestSettled(idC, fakeResponse(), 200);
    const list2 = diag.getApiDiagnostics();
    assert.equal(list2.length, 1, 'a new token scope wipes the prior session even for the same user');
    assert.equal(list2[0].id, idC);

    diag.clearApiDiagnostics();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('T. only API-timing helpers are exposed — no raw request interception surface', async () => {
    ensureStorageShim();
    const diag = await import('../../src/modules/shared/api/diagnostics.js');
    for (const fn of ['recordApiRequestStart', 'recordApiRequestSettled', 'recordApiRequestFailed', 'noteApiBodySettled']) {
      assert.equal(typeof (diag as any)[fn], 'function', `${fn} must exist`);
    }
    // The recorder cannot observe arbitrary requests: it exposes no
    // listener/patch API at all — the only wiring lives in lib/apiClient.ts.
    assert.equal(typeof (diag as any).patchFetch, 'undefined');
    assert.equal(typeof (diag as any).intercept, 'undefined');
  });
});
