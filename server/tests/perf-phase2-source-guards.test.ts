/**
 * perf-phase2-source-guards.test.ts
 * ------------------------------------------------------------------
 * Performance Phase 2 — route-level code splitting, startup request
 * coalescing, deferred dashboard calendar, serverless cold-start
 * kick-off.
 *
 * The tests are split in two halves:
 *   1. Client source guards — the optimizations must exist exactly where
 *      they were promised (lazy routes, no eager feature imports in
 *      App.tsx, GET-only coalescing, deferred embedded calendar).
 *   2. Behavior — the coalescing primitive and its logout hygiene are
 *      exercised directly (no network, no DB): duplicates collapse,
 *      different keys do not, nothing is cached after settlement,
 *      failures reach every waiter, and logout drops in-flight entries.
 *
 * Security-critical behavior (single session validation, 401 logout,
 * fail-closed permissions, RBAC) is already asserted behaviorally by
 * auth-flow-integration / role-action-permissions / perf-latency-
 * hardening — this file only adds the guards for what Phase 2 changed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/* ==================================================================== */
/* 1. Route-level code splitting (App.tsx)                              */
/* ==================================================================== */

describe('Performance Phase 2 — route-level code splitting', () => {
  const APP = () => read('src/App.tsx');

  /** Every heavy feature page that must be a lazy chunk. */
  const LAZY_PAGES = [
    ['Dashboard', 'modules/dashboard/pages/Dashboard'],
    ['LeadGenerate', 'modules/leads/pages/LeadGenerate'],
    ['LeadList', 'modules/leads/pages/LeadList'],
    ['LeadUpload', 'modules/leads/pages/LeadUpload'],
    ['AllLeads', 'modules/leads/pages/AllLeads'],
    ['FollowUpStrategy', 'modules/leads/pages/FollowUpStrategy'],
    ['TaskCalendar', 'modules/auth/pages/TaskCalendar'],
    ['Activities', 'modules/leads/pages/Activities'],
    ['DailyWorkbench', 'modules/workbench/pages/DailyWorkbench'],
    ['Lead360', 'modules/leads/pages/Lead360'],
    ['UserManagement', 'modules/users/pages/UserManagement'],
    ['TeamHierarchy', 'modules/hierarchy/pages/TeamHierarchy'],
    ['ExecutionIntelligence', 'modules/dashboard/pages/ExecutionIntelligence'],
    ['NcpProgress', 'modules/dashboard/pages/NcpProgress'],
    ['TrendCharts', 'modules/dashboard/pages/TrendCharts'],
    ['CampaignBreakdown', 'modules/dashboard/pages/CampaignBreakdown'],
    ['Settings', 'modules/settings/pages/Settings'],
  ] as const;

  it('A. every feature page is loaded via React.lazy, none is statically imported', () => {
    const app = APP();
    for (const [name, rel] of LAZY_PAGES) {
      // lazy(() => import( './modules/<rel>' )) — the space after `import`
      // in Dashboard.tsx is deliberate (see that file's note); normalize
      // whitespace so both spellings are accepted here.
      const re = new RegExp(
        `const\\s+${name}\\s*=\\s*lazy\\(\\s*\\(\\s*\\)\\s*=>\\s*import\\s*\\(\\s*['"]\\./${rel.replace(/\//g, '\\/')}['"]\\s*\\)`
      );
      assert.ok(re.test(app), `${name} must be lazy(() => import('./${rel}')) in App.tsx`);
      // And the same module must NOT also be pulled in eagerly.
      const eager = new RegExp(`import\\s+${name}\\s+from\\s+['"]\\./${rel.replace(/\//g, '\\/')}['"]`);
      assert.ok(!eager.test(app), `${name} must not be statically imported in App.tsx`);
    }
  });

  it('B. Login stays a static (lightweight) import — no chunk round-trip to sign in', () => {
    const app = APP();
    assert.ok(
      /import\s+Login\s+from\s+['"]\.\/modules\/auth\/pages\/Login['"]/.test(app),
      'Login must remain a static import'
    );
    assert.ok(!/lazy\([^)]*auth\/pages\/Login/.test(app), 'Login must not be lazy');
  });

  it('C. lazy pages render inside a Suspense boundary BELOW the ProtectedRoute gate', () => {
    const app = APP();
    // The Suspense wrapper lives in the route element (i.e. inside
    // ProtectedRoute/AppLayout), so the app shell survives chunk loads.
    assert.ok(
      /<ProtectedRoute><LazyPage/.test(app),
      'route elements must wrap the lazy page in the shell-preserving Suspense boundary'
    );
    const lazyPage = app.slice(app.indexOf('function LazyPage'));
    assert.ok(lazyPage.includes('<Suspense fallback='), 'LazyPage must use a Suspense boundary');
    assert.ok(lazyPage.includes('RouteFallback'), 'LazyPage must fall back to the compact placeholder');
    // Content-level fallback: a status region, not a full-screen takeover.
    const fallback = app.slice(app.indexOf('function RouteFallback'), app.indexOf('function LazyPage'));
    assert.ok(fallback.includes('role="status"'), 'fallback must be an aria status region');
    assert.ok(!fallback.includes('min-h-screen'), 'fallback must not be a full-screen takeover');
  });

  it('D. auth init wiring in App.tsx is unchanged (single deterministic validation)', () => {
    const app = APP();
    assert.match(app, /void initializeAuthSession\(\)/);
    assert.doesNotMatch(app, /setInitialized\(true\)/);
    assert.doesNotMatch(app, /useAuthStore/);
  });
});

/* ==================================================================== */
/* 2. Dashboard: embedded Task Calendar is deferred + code-split        */
/* ==================================================================== */

describe('Performance Phase 2 — deferred dashboard Task Calendar', () => {
  const DASHBOARD = () => read('src/modules/dashboard/pages/Dashboard.tsx');

  it('E. the embedded calendar is lazy and never statically imported by the dashboard', () => {
    const d = DASHBOARD();
    assert.ok(
      /const\s+TaskCalendar\s*=\s*lazy\(\s*\(\s*\)\s*=>\s*import\s*\(\s*['"]\.\.\/\.\.\/auth\/pages\/TaskCalendar['"]\s*\)/.test(d),
      'Dashboard must lazy-import TaskCalendar'
    );
    assert.doesNotMatch(d, /import\s+TaskCalendar\s+from/, 'no static TaskCalendar import in Dashboard');
  });

  it('F. the calendar mounts only after primary content settled, inside a Suspense boundary', () => {
    const d = DASHBOARD();
    assert.ok(d.includes('calendarReady'), 'dashboard must derive a calendarReady flag');
    const flag = d.slice(d.indexOf('const calendarReady'));
    assert.ok(/!loading\s*&&\s*!dailyLoading/.test(flag), 'calendar must wait for BOTH primary loads');
    const renderIdx = d.lastIndexOf('<TaskCalendar embedded');
    const openIdx = d.lastIndexOf('<Suspense');
    const closeIdx = d.indexOf('</Suspense', renderIdx);
    assert.ok(
      openIdx !== -1 && openIdx < renderIdx && closeIdx > renderIdx,
      'the embedded calendar must render inside a Suspense boundary (open before, close after)'
    );
    assert.ok(d.includes('TaskCalendarPlaceholder'), 'deferred calendar needs a lightweight placeholder');
    // Primary sections still exist and still precede the calendar section
    // (the calendar remains the LAST major section — no behavior change).
    for (const marker of ['ExecutiveSnapshot', 'TodayTomorrowPanel', 'SalesPipeline', 'FollowUpDiscipline', 'NeedsAttentionSection', 'PerformanceInsights']) {
      assert.ok(d.includes(marker), `primary section ${marker} must remain on the dashboard`);
    }
    assert.ok(
      d.indexOf('const TaskCalendar = lazy') < d.lastIndexOf('<TaskCalendar'),
      'calendar declaration precedes its render'
    );
  });

  it('G. dashboard KPI authority is untouched (no new client-side sources)', () => {
    const d = DASHBOARD();
    const start = d.indexOf('const loadDashboardData');
    const end = d.indexOf('const loadDailyExecution');
    assert.ok(start >= 0 && end > start);
    const body = d.slice(start, end);
    assert.ok(body.includes('dashboardService.getDashboard'));
    assert.ok(!body.includes('localStorage'));
    assert.ok(!body.includes('localDb'));
    assert.ok(!body.includes('getLeads('));
  });
});

/* ==================================================================== */
/* 3. Startup request coalescing (GET-only, in-flight only)             */
/* ==================================================================== */

describe('Performance Phase 2 — GET coalescing wiring', () => {
  it('H. the shared startup reads are coalesced by URL key', async () => {
    const coalesce = read('src/modules/shared/api/coalesce.ts');
    assert.ok(coalesce.includes('export function coalesceGet'), 'coalesceGet must exist');
    assert.ok(coalesce.includes('inFlight.delete(scopedKey)'), 'entries must be dropped on settlement (no persistence)');

    const checks: Array<[string, RegExp, string]> = [
      [
        'src/modules/admin/services/adminService.ts',
        /coalesceGet\(['"]\/api\/roles['"],\s*\(\)\s*=>\s*apiRequest/,
        'roles read must be coalesced',
      ],
      [
        'src/modules/notifications/services/notificationService.ts',
        /coalesceGet\(path,\s*\(\)\s*=>\s*apiRequest/,
        'notifications read must be coalesced',
      ],
      [
        'src/modules/shared/hooks/usePermissions.ts',
        /coalesceGet\(permPath,\s*\(\)\s*=>\s*fetch\(permPath\)\)/,
        'user permission sheet must be coalesced',
      ],
      [
        'src/modules/dashboard/services/dashboardService.ts',
        /coalesceGet\(path,\s*\(\)\s*=>\s*apiRequest/,
        'dashboard metrics read must be coalesced',
      ],
      [
        'src/modules/leads/services/leadService.ts',
        /coalesceGet\(path,\s*\(\)\s*=>\s*apiRequest/,
        'follow-up queue read must be coalesced',
      ],
      [
        'src/modules/scheduledActivities/services/scheduledActivityService.ts',
        /coalesceGet\(`\/api\/scheduled-activities\$\{qs\}`,/,
        'scheduled-activities list read must be coalesced',
      ],
    ];
    for (const [rel, re, why] of checks) {
      assert.ok(re.test(read(rel)), why);
    }
  });

  it('I. mutations are NOT coalesced (lead/scheduled/notification writes stay per-call)', () => {
    // The coalesced call sites are exactly the GET readers; the mutation
    // paths in leadService keep awaiting apiRequest directly.
    const leadSvc = read('src/modules/leads/services/leadService.ts');
    const createBody = leadSvc.slice(leadSvc.indexOf('async createLead'), leadSvc.indexOf('async bulkUploadLeads'));
    assert.ok(!createBody.includes('coalesceGet'), 'createLead must not be coalesced');
    assert.ok(createBody.includes('await apiRequest<Lead>(\'/api/leads\''), 'createLead still awaits the server');

    const scheduledSvc = read('src/modules/scheduledActivities/services/scheduledActivityService.ts');
    const createBodyS = scheduledSvc.slice(scheduledSvc.indexOf('async create('));
    assert.ok(!createBodyS.includes('coalesceGet'), 'scheduled-activities mutations must not be coalesced');
  });
});

/* ==================================================================== */
/* 4. Coalescing behavior (session-scoped, pure, no network)            */
/* ==================================================================== */

/**
 * Minimal localStorage shim — installed BEFORE the first dynamic import
 * so the zustand persist middleware (pulled in via coalesce -> authStore)
 * has a storage target in Node.
 */
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

/** Set the store to an authenticated session (same shape as login). */
function loginSession(store: any, userId: string, employeeId: string, name: string, token: string) {
  store.setState({
    user: { id: userId, employeeId, name, role: 'ADMIN' } as any,
    token,
    isAuthenticated: true,
    isInitialized: true,
  });
}

describe('Performance Phase 2 — coalesceGet behavior (session-scoped)', () => {
  it('J. same URL + same session collapses to one call; same URL + different session does NOT', async () => {
    ensureStorageShim();
    const { coalesceGet, clearCoalescing } = await import('../../src/modules/shared/api/coalesce.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    clearCoalescing();

    // Session A
    loginSession(useAuthStore, 'user-a', 'EMPA', 'A', 'token-a-1');
    let aCalls = 0;
    const slowA = () =>
      new Promise<number>(resolve => {
        aCalls += 1;
        setTimeout(() => resolve(42), 25);
      });
    const [a1, a2] = await Promise.all([coalesceGet('/api/x', slowA), coalesceGet('/api/x', slowA)]);
    assert.equal(aCalls, 1, 'two concurrent identical reads in the SAME session must share one request');
    assert.deepEqual([a1, a2], [42, 42], 'both waiters get the same result');

    // Session B, same URL, while A's request is still in flight: must be
    // a SEPARATE request (session-boundary guarantee).
    loginSession(useAuthStore, 'user-b', 'EMPB', 'B', 'token-b-1');
    let bCalls = 0;
    const slowB = () =>
      new Promise<number>(resolve => {
        bCalls += 1;
        setTimeout(() => resolve(7), 5);
      });
    const b1 = await coalesceGet('/api/x', slowB);
    assert.equal(bCalls, 1, 'a different authenticated session must never join session A in-flight request');
    assert.equal(b1, 7);

    // Different query in the same session is still a separate request
    // (path/query distinction preserved).
    let other = 0;
    const otherFn = () =>
      new Promise<number>(resolve => {
        other += 1;
        setTimeout(() => resolve(9), 5);
      });
    const c = await coalesceGet('/api/x?other=1', otherFn);
    assert.equal(other, 1);
    assert.equal(c, 9, 'a different URL (query included) must be a separate request');
    clearCoalescing();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('K. nothing is cached after settlement — the next call in the same session is a fresh request', async () => {
    ensureStorageShim();
    const { coalesceGet, clearCoalescing } = await import('../../src/modules/shared/api/coalesce.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    clearCoalescing();
    loginSession(useAuthStore, 'user-k', 'EMPK', 'K', 'token-k-1');

    let calls = 0;
    const fn = () =>
      new Promise<number>(resolve => {
        calls += 1;
        setTimeout(() => resolve(calls), 5);
      });
    const first = await coalesceGet('/api/y', fn);
    assert.equal(first, 1);
    const second = await coalesceGet('/api/y', fn);
    assert.equal(second, 2, 'after the first settled, a new request must be issued (no stale reuse, no TTL)');
    clearCoalescing();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('L. a failure fans out to every same-session waiter and the key is released for a retry', async () => {
    ensureStorageShim();
    const { coalesceGet, clearCoalescing } = await import('../../src/modules/shared/api/coalesce.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    clearCoalescing();
    loginSession(useAuthStore, 'user-l', 'EMPPL', 'L', 'token-l-1');

    let calls = 0;
    const failing = () => {
      calls += 1;
      return new Promise<string>((_resolve, reject) =>
        setTimeout(() => reject(new Error('boom')), 5)
      );
    };
    const p1 = coalesceGet('/api/fail', failing).catch((e: Error) => e.message);
    const p2 = coalesceGet('/api/fail', failing).catch((e: Error) => e.message);
    const [m1, m2] = await Promise.all([p1, p2]);
    assert.equal(calls, 1, 'the failing request was issued once');
    assert.deepEqual([m1, m2], ['boom', 'boom'], 'both same-session waiters observe the failure');

    // The key must be free again — a subsequent call retries (fresh request).
    let retryCalls = 0;
    const retry = () => {
      retryCalls += 1;
      return Promise.resolve('ok');
    };
    const r = await coalesceGet('/api/fail', retry);
    assert.equal(r, 'ok');
    assert.equal(retryCalls, 1, 'after a settled failure the key must not block a retry');
    clearCoalescing();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });
});

/* ==================================================================== */
/* 5. Logout/login hygiene for session-scoped coalescing                */
/* ==================================================================== */

describe('Performance Phase 2 — coalescing never crosses user/session boundaries', () => {
  it('M. logout/login cannot join the prior session’s in-flight request', async () => {
    ensureStorageShim();
    const { coalesceGet, clearCoalescing } = await import('../../src/modules/shared/api/coalesce.js');
    const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
    clearCoalescing();

    // Session "alice" starts a still-in-flight read.
    loginSession(useAuthStore, 'alice', 'ALICE', 'Alice', 'token-alice-1');
    let aliceCalls = 0;
    let resolveAlice: (v: number) => void = () => undefined;
    const aliceRequest = coalesceGet('/api/roles', () => {
      aliceCalls += 1;
      return new Promise<number>(resolve => {
        resolveAlice = resolve;
      });
    });

    // Alice logs out; "bob" signs in. Bob's identical read must NOT join
    // alice's in-flight request — it must be a fresh request.
    useAuthStore.getState().logout();
    loginSession(useAuthStore, 'bob', 'BOB', 'Bob', 'token-bob-1');
    let bobCalls = 0;
    const bobRead = coalesceGet('/api/roles', () => {
      bobCalls += 1;
      return Promise.resolve(1);
    });
    await bobRead;
    assert.equal(bobCalls, 1, 'a different user’s read must be a fresh request');
    assert.equal(aliceCalls, 1, 'alice’s original request was issued exactly once');

    // Alice signs in AGAIN (same user id, new token — a NEW session).
    // The prior session's request is still in flight; the re-login must
    // STILL not join it (token fingerprint changes the session scope).
    useAuthStore.getState().logout();
    loginSession(useAuthStore, 'alice', 'ALICE', 'Alice', 'token-alice-2');
    let alice2Calls = 0;
    const alice2Read = coalesceGet('/api/roles', () => {
      alice2Calls += 1;
      return Promise.resolve(2);
    });
    await alice2Read;
    assert.equal(alice2Calls, 1, 'a re-login (even of the same user) must not join the prior session’s in-flight request');

    // The original request settles independently for alice's first session.
    resolveAlice(0);
    const settled = await aliceRequest;
    assert.equal(settled, 0, 'the prior session’s request still resolves for its own waiter');
    assert.equal(aliceCalls, 1, 'the prior session’s request was never re-issued by later sessions');

    clearCoalescing();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false } as any);
  });

  it('M2. the coalescing key includes the session identity, never the raw token', () => {
    const src = read('src/modules/shared/api/coalesce.ts');
    assert.ok(src.includes('currentSessionScope'), 'scope derivation must exist');
    assert.ok(src.includes('tokenFingerprint'), 'token must be reduced to a fingerprint');
    assert.ok(/scopedKey\s*=\s*`[^`]*::\$\{key\}`/.test(src), 'in-flight key must be <sessionScope>::<url>');
    // The raw token must never be concatenated into a key or logged.
    const keyExpr = src.slice(src.indexOf('function currentSessionScope'));
    assert.ok(!/`[^`]*\$\{\s*(state\.)?token\s*\}[^`]*`/.test(keyExpr), 'raw token must not appear in the key');
    assert.ok(!src.includes('console.log'), 'no logging of key/scope');
  });
});

/* ==================================================================== */
/* 6. Serverless cold-start kick-off (api/index.ts)                     */
/* ==================================================================== */

describe('Performance Phase 2 — serverless cold-start kick-off', () => {
  it('N. DB init + router load start at module scope and stay memoized', () => {
    const api = read('api/index.ts');
    // The kick-off must happen at module scope, before the /api dispatch
    // middleware, and swallow its own rejection (the first request still
    // surfaces cold-start failures).
    const kickoff = api.indexOf('void loadRoutes().catch');
    assert.ok(kickoff >= 0, 'module-scope loadRoutes() kick-off must exist');
    assert.ok(
      kickoff < api.indexOf("app.use('/api', async (req, res, next)"),
      'the kick-off must precede the /api dispatch'
    );
    assert.ok(api.includes('.catch(() => undefined)'), 'the kick-off must not create an unhandled rejection');
    // Memoization preserved: the dispatch still awaits the same promise.
    const dispatch = api.slice(api.indexOf("app.use('/api', async (req, res, next)"));
    assert.ok(dispatch.includes('await loadRoutes()'), 'first request must await the memoized load');
    assert.ok(api.includes('if (productionRouter) return productionRouter;'), 'router load must stay memoized');
  });
});
