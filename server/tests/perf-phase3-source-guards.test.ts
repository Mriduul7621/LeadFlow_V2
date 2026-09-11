/**
 * perf-phase3-source-guards.test.ts
 * ------------------------------------------------------------------
 * Performance Phase 3 — reduce first-login / first-dashboard startup
 * contention and duplicate reference-data reads.
 *
 *   1. Source guards — critical KPI still uses GET /api/dashboard;
 *      Tier 2/3 reads wait for critical readiness; users/options are
 *      coalesced + session-cached GET reads; operational data is not.
 *   2. Behavior (no network for the sequencer; fetch stub for the
 *      reference-data readers) — waiters block until mark, logout
 *      resets the gate, duplicate users/options collapse, cache does
 *      not cross users, mutations invalidate, logout clears.
 *
 * PR #29 coalescing, PR #30 diagnostics, auth/RBAC/visibility remain
 * the contract of their own suites (must stay green).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function dashboardLoaders(): { kpi: string; daily: string; full: string } {
  const full = read('src/modules/dashboard/pages/Dashboard.tsx');
  const kpiStart = full.indexOf('const loadDashboardData');
  const dailyStart = full.indexOf('const loadDailyExecution');
  assert.ok(kpiStart >= 0 && dailyStart > kpiStart);
  return {
    full,
    kpi: full.slice(kpiStart, dailyStart),
    daily: full.slice(dailyStart, dailyStart + 2500),
  };
}

/* ==================================================================== */
/* 1. Source guards                                                     */
/* ==================================================================== */

describe('Performance Phase 3 — critical vs deferred startup', () => {
  it('A. dashboard critical request still uses GET /api/dashboard', () => {
    const { kpi } = dashboardLoaders();
    assert.ok(kpi.includes('dashboardService.getDashboard'), 'KPI loader must call dashboardService.getDashboard');
    assert.ok(!kpi.includes('localStorage'), 'KPI loader must not read localStorage');
    assert.ok(!kpi.includes('localDb'), 'KPI loader must not read localDb');
    assert.ok(!kpi.includes('getLeads('), 'KPI loader must not call getLeads()');
    assert.ok(!kpi.includes('getFollowUpQueue'), 'KPI loader must not fetch follow-ups');
    assert.ok(!kpi.includes('scheduledActivityService'), 'KPI loader must not fetch scheduled activities');
    const svc = read('src/modules/dashboard/services/dashboardService.ts');
    assert.ok(svc.includes('/api/dashboard'), 'dashboardService must hit /api/dashboard');
    assert.ok(svc.includes('coalesceGet'), 'PR #29 coalescing of dashboard reads must remain');
    assert.ok(!svc.includes('writeSessionCache'), 'dashboard KPI must not be stored as reference data');
    assert.ok(!svc.includes('readSessionCache'), 'dashboard KPI must not be read from the session cache');
  });

  it('B. noncritical deferred reads wait for critical readiness', () => {
    const { kpi, daily, full } = dashboardLoaders();
    assert.ok(kpi.includes('markCriticalStartupSettled()'), 'KPI loader must release the startup gate');
    assert.ok(daily.includes('await waitForCriticalStartup()'), 'daily execution must wait for critical readiness');
    const waitIdx = daily.indexOf('await waitForCriticalStartup()');
    const todayIdx = daily.indexOf("getFollowUpQueue({ bucket: 'today', limit: 50 })");
    const upcomingIdx = daily.indexOf("getFollowUpQueue({ bucket: 'upcoming', limit: 50 })");
    const scheduledIdx = daily.indexOf('scheduledActivityService.list({ from: dhakaToday, to: tomorrowYmd, limit: 100 })');
    assert.ok(waitIdx >= 0 && todayIdx > waitIdx, 'today follow-up must start AFTER critical readiness');
    assert.ok(upcomingIdx > waitIdx, 'upcoming follow-up must start AFTER critical readiness');
    assert.ok(scheduledIdx > upcomingIdx, 'scheduled activities must start AFTER the follow-up reads');
    assert.ok(!daily.includes('setTimeout'), 'no arbitrary sleeps in daily execution');
    assert.ok(!full.includes('setTimeout'), 'Dashboard must not introduce setTimeout delays');

    const layout = read('src/layouts/AppLayout.tsx');
    assert.ok(layout.includes('waitForShellStartup()'), 'notification first-fetch waits on the shell gate, not first-dashboard-critical');
    assert.ok(!layout.includes('waitForCriticalStartup'), 'AppLayout must not wait on first-dashboard-critical (that would hang on /workbench)');
    assert.ok(layout.includes('markShellStartupSettled()'), 'non-dashboard routes release SHELL waiters so they cannot hang');
    assert.ok(!layout.includes('markCriticalStartupSettled'), 'non-dashboard routes must NOT mark the future first Dashboard as completed');
    assert.ok(layout.includes("location.pathname !== '/'"), 'non-dashboard routes must release the shell gate so waiters cannot hang');

    const login = read('src/modules/auth/pages/Login.tsx');
    assert.ok(login.includes('waitForShellStartup()'), 'lead-status /api/options warm-up waits on the shell gate');
    assert.ok(!login.includes('waitForCriticalStartup'), 'login warm-up must not wait on first-dashboard-critical (would hang on a non-dashboard first route)');
    const warm = login.slice(login.indexOf('warmUpAfterAuthentication'));
    assert.ok(warm.indexOf('localDb.createUser') < warm.indexOf('waitForShellStartup'), 'local cache write stays immediate; only the network warm-up waits');

    const gate = read('src/modules/shared/api/startupPriority.ts');
    assert.ok(gate.includes('let dashboardSettled'), 'first-dashboard-critical is its own flag');
    assert.ok(gate.includes('let shellSettled'), 'shell readiness is a separate flag');
    assert.ok(gate.includes('STARTUP_CRITICAL = GET /api/dashboard'));
  });

  it('C. follow-up bucket reads stay server-authoritative and are not replaced by bucket=all', () => {
    const { daily, full } = dashboardLoaders();
    assert.equal((full.match(/leadService\.getFollowUpQueue\(/g) || []).length, 2);
    assert.ok(daily.includes("getFollowUpQueue({ bucket: 'today', limit: 50 })"));
    assert.ok(daily.includes("getFollowUpQueue({ bucket: 'upcoming', limit: 50 })"));
    assert.ok(!daily.includes("bucket: 'all'"), 'dashboard must not switch Today/Tomorrow to bucket=all');
    const followUpSvc = read('src/modules/leads/services/leadService.ts');
    const qStart = followUpSvc.indexOf('async getFollowUpQueue');
    const qBody = followUpSvc.slice(qStart, followUpSvc.indexOf('async getLeadActivities'));
    assert.ok(qBody.includes('/api/leads/follow-ups'));
    assert.ok(qBody.includes('coalesceGet'), 'PR #29 follow-up coalescing must remain');
    assert.ok(!qBody.includes('writeSessionCache'), 'follow-up queue must not be stored as reference data');
    assert.ok(!qBody.includes('readSessionCache'), 'follow-up queue must not be read from the session cache');
  });

  it('D. scheduled-activity operational data is not cached as reference data', () => {
    const svc = read('src/modules/scheduledActivities/services/scheduledActivityService.ts');
    assert.ok(svc.includes('coalesceGet'), 'PR #29 scheduled-activities coalescing must remain');
    assert.ok(!svc.includes('writeSessionCache'), 'scheduled activities must not be stored as reference data');
    assert.ok(!svc.includes('readSessionCache'), 'scheduled activities must not be read from the session cache');
  });
});

describe('Performance Phase 3 — users/options reference cache wiring', () => {
  it('E. GET /api/users is coalesced and session-cached, mutations invalidate', () => {
    const src = read('src/modules/users/services/userService.ts');
    assert.ok(src.includes("coalesceGet('/api/users'"), 'users list GET must be coalesced');
    assert.ok(src.includes('readSessionCache<User[]>'), 'users list must reuse the session cache');
    assert.ok(src.includes("users:${id}"), 'users cache must be keyed by the authenticated user');
    assert.ok(src.includes('invalidateUsersReferenceCache'), 'mutations must invalidate the users cache');
    const createBody = src.slice(src.indexOf('async createUser'), src.indexOf('async updateUser'));
    assert.ok(createBody.includes('invalidateUsersReferenceCache()'), 'createUser invalidates after the server confirms');
    assert.ok(!createBody.includes('coalesceGet'), 'createUser mutation is not coalesced');
    const updateBody = src.slice(src.indexOf('async updateUser'), src.indexOf('async getUser'));
    assert.ok(updateBody.includes('invalidateUsersReferenceCache()'), 'updateUser invalidates after the server confirms');
    const deleteBody = src.slice(src.indexOf('async deleteUser'), src.indexOf('async resetPassword'));
    assert.ok(deleteBody.includes('invalidateUsersReferenceCache()'), 'deleteUser invalidates after the server confirms');
  });

  it('F. GET /api/options is coalesced and session-cached, mutations invalidate', () => {
    const src = read('src/modules/metadata/services/metadataService.ts');
    assert.ok(src.includes("coalesceGet('/api/options'"), 'options GET must be coalesced');
    assert.ok(src.includes("options:${id}"), 'options cache must be keyed by the authenticated user');
    assert.ok(src.includes('invalidateOptionsReferenceCache'), 'mutations must invalidate the options cache');
    assert.ok(src.includes('registerSessionCacheClearHandler'), 'per-type index must die with the session');
    const addBody = src.slice(src.indexOf('async addValue'), src.indexOf('async updateValue'));
    assert.ok(addBody.includes('invalidateOptionsReferenceCache()'));
    assert.ok(!addBody.includes('coalesceGet'), 'addValue mutation is not coalesced');
    const delBody = src.slice(src.indexOf('async deleteValue'), src.indexOf('async reorder'));
    assert.ok(delBody.includes('invalidateOptionsReferenceCache()'));
  });

  it('G. logout still clears session cache, coalescing, AND the startup gate', () => {
    const store = read('src/modules/auth/store/authStore.ts');
    const logout = store.slice(store.indexOf('logout: () => {'), store.indexOf("set({ user: null, token: null, isAuthenticated: false, isOfflineMode: false })"));
    assert.ok(logout.includes('clearSessionCache()'));
    assert.ok(logout.includes('clearCoalescing()'));
    assert.ok(logout.includes('resetStartupPriority()'));
  });

  it('H. PR #29 coalescing wiring is unchanged (six GET readers, no mutations)', () => {
    const checks: Array<[string, RegExp]> = [
      ['src/modules/admin/services/adminService.ts', /coalesceGet\(['"]\/api\/roles['"],\s*\(\)\s*=>\s*apiRequest/],
      ['src/modules/notifications/services/notificationService.ts', /coalesceGet\(path,\s*\(\)\s*=>\s*apiRequest/],
      ['src/modules/shared/hooks/usePermissions.ts', /coalesceGet\(permPath,\s*\(\)\s*=>\s*fetch\(permPath\)\)/],
      ['src/modules/dashboard/services/dashboardService.ts', /coalesceGet\(path,\s*\(\)\s*=>\s*apiRequest/],
      ['src/modules/leads/services/leadService.ts', /coalesceGet\(path,\s*\(\)\s*=>\s*apiRequest/],
      ['src/modules/scheduledActivities/services/scheduledActivityService.ts', /coalesceGet\(`\/api\/scheduled-activities\$\{qs\}`,/],
    ];
    for (const [rel, re] of checks) {
      assert.ok(re.test(read(rel)), `${rel} must keep PR #29 coalescing`);
    }
  });

  it('I. PR #30 diagnostics recorder wiring is unchanged', () => {
    const client = read('src/lib/apiClient.ts');
    assert.ok(client.includes('recordApiRequestStart('));
    assert.ok(client.includes('recordApiRequestSettled('));
    const http = read('src/modules/shared/api/http.ts');
    assert.ok(http.includes('noteApiBodySettled(response)'));
    const app = read('src/App.tsx');
    assert.ok(app.includes('/settings/performance-diagnostics'));
    assert.ok(app.includes('PerformanceDiagnostics'));
  });
});

/* ==================================================================== */
/* 2. Behavior                                                          */
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

function loginSession(store: any, userId: string, employeeId: string, token: string) {
  store.setState({
    user: { id: userId, employeeId, name: userId, role: 'ADMIN', email: `${employeeId.toLowerCase()}@test.com`, status: 'Active' } as any,
    token,
    isAuthenticated: true,
    isInitialized: true,
  });
}

describe('Performance Phase 3 — startupPriority behavior', () => {
  async function loadGate() {
    const mod = await import('../../src/modules/shared/api/startupPriority.js');
    mod.resetStartupPriority();
    return mod;
  }

  it('J. login → Dashboard: sequencing applies (follow-ups wait for KPI; shell waits too)', async () => {
    const {
      waitForCriticalStartup,
      waitForShellStartup,
      markCriticalStartupSettled,
      isCriticalStartupSettled,
      isShellStartupSettled,
      resetStartupPriority,
    } = await loadGate();

    assert.equal(isCriticalStartupSettled(), false);
    assert.equal(isShellStartupSettled(), false);

    let daily = 0;
    let shell = 0;
    const dailyP = waitForCriticalStartup().then(() => { daily += 1; });
    const shellP = waitForShellStartup().then(() => { shell += 1; });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(daily, 0, 'today/upcoming must not start before GET /api/dashboard settles');
    assert.equal(shell, 0, 'notifications/options must not join the first-dashboard burst');

    markCriticalStartupSettled(); // Dashboard KPI finally (success)
    await Promise.all([dailyP, shellP]);
    assert.equal(daily, 1);
    assert.equal(shell, 1);
    assert.equal(isCriticalStartupSettled(), true);
    assert.equal(isShellStartupSettled(), true);
    resetStartupPriority();
  });

  it('J2. login → Workbench → Dashboard: first Dashboard STILL sequences', async () => {
    const {
      waitForCriticalStartup,
      waitForShellStartup,
      markCriticalStartupSettled,
      markShellStartupSettled,
      isCriticalStartupSettled,
      isShellStartupSettled,
      resetStartupPriority,
    } = await loadGate();

    // AppLayout on /workbench: shell may proceed, first-dashboard must not.
    markShellStartupSettled();
    assert.equal(isShellStartupSettled(), true);
    assert.equal(isCriticalStartupSettled(), false, 'Workbench must not mark first-dashboard complete');

    let notif = false;
    await waitForShellStartup().then(() => { notif = true; });
    assert.equal(notif, true, 'notifications/options must not hang on a non-dashboard first route');

    let daily = 0;
    const dailyP = waitForCriticalStartup().then(() => { daily += 1; });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(daily, 0, 'later first Dashboard load must still wait for GET /api/dashboard');

    markCriticalStartupSettled();
    await dailyP;
    assert.equal(daily, 1);
    resetStartupPriority();
  });

  it('J3. cold reload on /users → Dashboard: first Dashboard STILL sequences', async () => {
    const {
      waitForCriticalStartup,
      waitForShellStartup,
      markCriticalStartupSettled,
      markShellStartupSettled,
      isCriticalStartupSettled,
      resetStartupPriority,
    } = await loadGate();

    markShellStartupSettled(); // AppLayout on /users
    await waitForShellStartup();
    assert.equal(isCriticalStartupSettled(), false);

    let daily = 0;
    const dailyP = waitForCriticalStartup().then(() => { daily += 1; });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(daily, 0, 'cold reload on /users must not skip first-dashboard sequencing');

    markCriticalStartupSettled();
    await dailyP;
    assert.equal(daily, 1);
    resetStartupPriority();
  });

  it('J4. Dashboard → other route → Dashboard: later revisit does not deadlock', async () => {
    const {
      waitForCriticalStartup,
      waitForShellStartup,
      markCriticalStartupSettled,
      markShellStartupSettled,
      isCriticalStartupSettled,
      resetStartupPriority,
    } = await loadGate();

    markCriticalStartupSettled(); // first Dashboard KPI of the session
    assert.equal(isCriticalStartupSettled(), true);

    markShellStartupSettled(); // navigate to /leads (no-op; already settled)
    await waitForShellStartup();
    await waitForCriticalStartup(); // later Dashboard revisit: must resolve, not hang

    const again = await Promise.race([
      waitForCriticalStartup().then(() => 'ok'),
      new Promise<string>(r => setTimeout(() => r('deadlock'), 30)),
    ]);
    assert.equal(again, 'ok', 'a later Dashboard revisit in the same session must not re-wait');
    resetStartupPriority();
  });

  it('J5. failure of GET /api/dashboard still releases dependent reads', async () => {
    const {
      waitForCriticalStartup,
      waitForShellStartup,
      markCriticalStartupSettled,
      resetStartupPriority,
    } = await loadGate();

    // Source: Dashboard KPI `finally` calls mark even after the catch.
    const { kpi } = dashboardLoaders();
    const finallyIdx = kpi.indexOf('finally');
    assert.ok(finallyIdx >= 0, 'KPI loader must use finally');
    assert.ok(kpi.indexOf('markCriticalStartupSettled()', finallyIdx) > finallyIdx, 'failure path still marks settled');
    assert.ok(kpi.includes("setError('Dashboard data could not be loaded.')"));

    let daily = 0;
    let shell = 0;
    const dailyP = waitForCriticalStartup().then(() => { daily += 1; });
    const shellP = waitForShellStartup().then(() => { shell += 1; });
    markCriticalStartupSettled(); // finally after catch
    await Promise.all([dailyP, shellP]);
    assert.equal(daily, 1, 'a failed KPI must not pin today/upcoming forever');
    assert.equal(shell, 1, 'a failed KPI must not pin notifications/options forever');
    resetStartupPriority();
  });

  it('J6. logout/login resets first-dashboard AND shell state', async () => {
    const {
      waitForCriticalStartup,
      waitForShellStartup,
      markCriticalStartupSettled,
      isCriticalStartupSettled,
      isShellStartupSettled,
      resetStartupPriority,
    } = await loadGate();

    markCriticalStartupSettled();
    assert.equal(isCriticalStartupSettled(), true);
    assert.equal(isShellStartupSettled(), true);

    let leaked = false;
    const pending = waitForCriticalStartup(); // already settled — this one resolves
    await pending;

    resetStartupPriority(); // logout of a session that had already sequenced
    assert.equal(isCriticalStartupSettled(), false);
    assert.equal(isShellStartupSettled(), false);

    void waitForCriticalStartup().then(() => { leaked = true; });
    void waitForShellStartup().then(() => { leaked = true; });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(leaked, false, 'logout must drop in-flight waiters and require the next session to sequence again');

    let nextDaily = 0;
    const nextP = waitForCriticalStartup().then(() => { nextDaily += 1; });
    await new Promise(r => setTimeout(r, 15));
    assert.equal(nextDaily, 0, 'the next login must re-apply first-dashboard sequencing');
    markCriticalStartupSettled();
    await nextP;
    assert.equal(nextDaily, 1);
    resetStartupPriority();
  });
});

describe('Performance Phase 3 — users/options session cache behavior', () => {
  it('K. duplicate /api/users reads collapse; cache does not cross users; logout clears; mutations invalidate', async () => {
    ensureStorageShim();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    (globalThis as any).fetch = async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = String(init.method || 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/users') && method === 'GET' && !url.includes('/permissions')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [{ id: 'u1', employeeId: 'E1', name: 'One', email: 'one@test.com', role: 'ADMIN', status: 'Active', createdDate: '2026-01-01' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/users' && method === 'POST') {
        return new Response(
          JSON.stringify({
            success: true,
            data: { id: 'u2', employeeId: 'E2', name: 'Two', email: 'two@test.com', role: 'RO', status: 'Active', createdDate: '2026-01-01' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
      const { resetSessionCacheForTests, readSessionCache } = await import('../../src/modules/shared/api/sessionCache.js');
      const { clearCoalescing } = await import('../../src/modules/shared/api/coalesce.js');
      const { userService } = await import('../../src/modules/users/services/userService.js');
      resetSessionCacheForTests();
      clearCoalescing();
      loginSession(useAuthStore, 'alice', 'ALICE', 'token-alice-1');
      calls.length = 0;

      const [a, b] = await Promise.all([userService.getAllUsers(), userService.getAllUsers()]);
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
      assert.equal(calls.filter(c => c === 'GET /api/users').length, 1, 'concurrent duplicate /api/users reads must collapse');
      assert.ok(readSessionCache('users:alice'), 'users list is stored under the authenticated user key');
      assert.equal(readSessionCache('users:bob'), null, 'users cache must not be visible under another user key');

      calls.length = 0;
      const cached = await userService.getAllUsers();
      assert.equal(cached.length, 1);
      assert.equal(calls.filter(c => c === 'GET /api/users').length, 0, 'same-session repeat must reuse the session cache');

      await userService.createUser({
        id: 'u2', employeeId: 'E2', name: 'Two', email: 'two@test.com', role: 'RO', status: 'Active', createdDate: '2026-01-01',
      } as any);
      assert.equal(readSessionCache('users:alice'), null, 'createUser must invalidate the users reference cache');

      calls.length = 0;
      await userService.getAllUsers();
      assert.equal(calls.filter(c => c === 'GET /api/users').length, 1, 'after invalidation the next read is a fresh GET');

      useAuthStore.getState().logout();
      assert.equal(readSessionCache('users:alice'), null, 'logout must clear the users reference cache');

      loginSession(useAuthStore, 'bob', 'BOB', 'token-bob-1');
      calls.length = 0;
      await userService.getAllUsers();
      assert.equal(calls.filter(c => c === 'GET /api/users').length, 1, 'a different user must not reuse alice’s users list');
      assert.ok(readSessionCache('users:bob'));
      assert.equal(readSessionCache('users:alice'), null);

      useAuthStore.getState().logout();
      resetSessionCacheForTests();
      clearCoalescing();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('L. duplicate /api/options reads collapse; cache does not cross users; logout clears; mutations invalidate', async () => {
    ensureStorageShim();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    (globalThis as any).fetch = async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = String(init.method || 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (url === '/api/options' && method === 'GET') {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              { type: 'FollowUpStatus', value: 'Untouched', label: 'Untouched', status: 'Active', sortOrder: 1 },
              { type: 'Product', value: 'Term', label: 'Term', status: 'Active', sortOrder: 1 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/options' && method === 'POST') {
        return new Response(
          JSON.stringify({ success: true, data: { type: 'Product', value: 'Endow', label: 'Endow', status: 'Active' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    try {
      const { useAuthStore } = await import('../../src/modules/auth/store/authStore.js');
      const { resetSessionCacheForTests, readSessionCache } = await import('../../src/modules/shared/api/sessionCache.js');
      const { clearCoalescing } = await import('../../src/modules/shared/api/coalesce.js');
      const { metadataService } = await import('../../src/modules/metadata/services/metadataService.js');
      metadataService.clearCache();
      resetSessionCacheForTests();
      clearCoalescing();
      loginSession(useAuthStore, 'alice', 'ALICE', 'token-alice-opts');
      calls.length = 0;

      const [statuses, products] = await Promise.all([
        metadataService.getAllValues('FollowUpStatus'),
        metadataService.getAllValues('Product'),
      ]);
      assert.equal(statuses.length, 1);
      assert.equal(products.length, 1);
      assert.equal(calls.filter(c => c === 'GET /api/options').length, 1, 'concurrent type reads must share one /api/options GET');

      calls.length = 0;
      const again = await metadataService.getAllValues('FollowUpStatus');
      assert.equal(again.length, 1);
      assert.equal(calls.filter(c => c === 'GET /api/options').length, 0, 'same-session repeat must reuse cache');
      assert.ok(readSessionCache('options:alice'));
      assert.equal(readSessionCache('options:bob'), null);

      await metadataService.addValue('Product', 'Endow');
      assert.equal(readSessionCache('options:alice'), null, 'addValue must invalidate the options reference cache');

      useAuthStore.getState().logout();
      assert.equal(readSessionCache('options:alice'), null, 'logout must clear the options reference cache');

      loginSession(useAuthStore, 'bob', 'BOB', 'token-bob-opts');
      calls.length = 0;
      await metadataService.getAllValues('FollowUpStatus');
      assert.equal(calls.filter(c => c === 'GET /api/options').length, 1, 'a different user must not reuse alice’s options list');

      useAuthStore.getState().logout();
      metadataService.clearCache();
      resetSessionCacheForTests();
      clearCoalescing();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('M. dashboard / follow-up / scheduled-activity keys are never written as reference data', async () => {
    ensureStorageShim();
    const { resetSessionCacheForTests, writeSessionCache, readSessionCache } = await import('../../src/modules/shared/api/sessionCache.js');
    resetSessionCacheForTests();
    writeSessionCache('users:alice', [{ id: 'u1' }]);
    writeSessionCache('options:alice', [{ type: 'FollowUpStatus', value: 'Untouched' }]);
    writeSessionCache('roles:alice', [{ roleId: 'ADMIN' }]);
    assert.ok(readSessionCache('users:alice'));
    assert.ok(readSessionCache('options:alice'));
    assert.equal(readSessionCache('dashboard:alice'), null, 'no dashboard KPI reference entry');
    assert.equal(readSessionCache('follow-ups:alice'), null, 'no follow-up queue reference entry');
    assert.equal(readSessionCache('scheduled-activities:alice'), null, 'no scheduled-activity reference entry');

    const dash = read('src/modules/dashboard/services/dashboardService.ts');
    const follow = read('src/modules/leads/services/leadService.ts');
    const scheduled = read('src/modules/scheduledActivities/services/scheduledActivityService.ts');
    for (const [name, src] of [['dashboard', dash], ['follow-up', follow], ['scheduled', scheduled]] as const) {
      assert.ok(!src.includes('writeSessionCache'), `${name} service must not write the session cache`);
    }
    resetSessionCacheForTests();
  });
});
