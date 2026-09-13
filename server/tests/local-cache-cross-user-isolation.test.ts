/**
 * local-cache-cross-user-isolation.test.ts — production-safety audit (this PR)
 * ------------------------------------------------------------------
 * Behavioral proof for the localStorage/localDb hardening documented in
 * docs/RBAC_FALLBACK_SAFETY_AUDIT.md:
 *
 *   1. business-data caches are keyed PER AUTHENTICATED USER: after User A
 *      logs out and User B logs in on the same browser, B can never read or
 *      inherit A's cached leads / users directory / notifications;
 *   2. when no authenticated user is resolvable, reads return the empty
 *      fallback and writes are no-ops (business data is never persisted in
 *      an unscoped, shared form);
 *   3. logout (authStore) clears the signing-out user's scoped caches,
 *      sweeps the pre-hardening unscoped global keys, and resets the
 *      in-memory session caches (sessionCache, read coalescing, startup
 *      priority sequencing) so nothing session-sensitive crosses a login;
 *   4. the offline read-fallback rule is a single shared policy
 *      (offlinePolicy.ts): only status 0 / 5xx may fall back to cache —
 *      401 / 403 / 404 (authoritative client answers) never do;
 *   5. source guards: the logout wiring and every API-first service import
 *      the shared fallback policy (no per-file drift).
 *
 * Runs in plain Node with a minimal localStorage shim — no browser.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ */
/* localStorage shim (installed BEFORE any client module is imported)  */
/* ------------------------------------------------------------------ */

const storageBacking = new Map<string, string>();
// zustand v5 persist defaults to `() => window.localStorage`, so the shim
// must also expose a `window` alias (the browser equivalent is identical).
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = {
  getItem: (key: string) => (storageBacking.has(key) ? storageBacking.get(key)! : null),
  setItem: (key: string, value: string) => { storageBacking.set(key, String(value)); },
  removeItem: (key: string) => { storageBacking.delete(key); },
  clear: () => storageBacking.clear(),
  key: (index: number) => Array.from(storageBacking.keys())[index] ?? null,
  get length() { return storageBacking.size; },
};

// Dynamic imports AFTER the shim is in place: the auth store's zustand
// `persist` touches localStorage during module evaluation (rehydration).
const localDbMod = await import('../../src/services/localDb');
const offlinePolicy = await import('../../src/modules/shared/api/offlinePolicy');
const sessionCacheMod = await import('../../src/modules/shared/api/sessionCache');
const startupMod = await import('../../src/modules/shared/api/startupPriority');
const authStoreMod = await import('../../src/modules/auth/store/authStore');

const { localDb, setLocalDbUserIdProvider, clearUserCaches, clearLegacyGlobalCaches } = localDbMod;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const userA = { id: 'USER_A', employeeId: 'A1', fullName: 'User A', email: 'a@test.com', role: 'EMP' } as any;
const userB = { id: 'USER_B', employeeId: 'B1', fullName: 'User B', email: 'b@test.com', role: 'EMP' } as any;
const leadA1 = { id: 'lead_a1', customerName: 'A Lead 1' } as any;
const leadA2 = { id: 'lead_a2', customerName: 'A Lead 2' } as any;
const leadB1 = { id: 'lead_b1', customerName: 'B Lead 1' } as any;

/* ================================================================== */

describe('per-user cache scoping (localDb)', () => {
  before(() => {
    storageBacking.clear();
    sessionCacheMod.resetSessionCacheForTests();
    startupMod.resetStartupPriority();
    // A fresh, controllable provider (the auth store registers its own on
    // import; this section exercises localDb directly).
    setLocalDbUserIdProvider(() => null);
  });

  it('B cannot read A cached leads / users / notifications after a user switch', () => {
    setLocalDbUserIdProvider(() => 'USER_A');
    localDb.saveLeads([leadA1, leadA2] as any);
    localDb.saveUsers([userA] as any);
    localDb.saveNotifications([
      { id: 'n1', userId: 'USER_A', title: 'A note', message: 'x', leadId: 'lead_a1', read: false, date: new Date().toISOString() } as any,
    ]);
    // Sanity: A sees A's data under A's scoped keys.
    assert.equal(localDb.getLeads().length, 2);
    assert.ok(storageBacking.has('shanta_leads:USER_A'), 'A leads live under the per-user key');
    assert.ok(!storageBacking.has('shanta_leads'), 'no unscoped leads key exists');

    // User B logs in on the same browser.
    setLocalDbUserIdProvider(() => 'USER_B');
    assert.deepEqual(localDb.getLeads(), [], 'B must NOT read A cached leads');
    assert.deepEqual(localDb.getUsers(), [], 'B must NOT read A cached users directory');
    assert.deepEqual(localDb.getNotifications('USER_B'), [], 'B must NOT inherit A notifications');
  });

  it('user scopes are independent: B writes never clobber A, and clearing A never touches B', () => {
    setLocalDbUserIdProvider(() => 'USER_B');
    localDb.saveLeads([leadB1] as any);

    setLocalDbUserIdProvider(() => 'USER_A');
    assert.equal(localDb.getLeads().length, 2, 'A scope must be untouched by B writes');

    clearUserCaches('USER_A');
    assert.equal(localDb.getLeads().length, 0, 'clearing A must empty A scope');
    assert.ok(!storageBacking.has('shanta_leads:USER_A'), 'A scoped keys are deleted');

    setLocalDbUserIdProvider(() => 'USER_B');
    assert.equal(localDb.getLeads().length, 1, 'clearing A must NOT touch B scope');
    clearUserCaches('USER_B');
    assert.equal(localDb.getLeads().length, 0, 'clearing B empties B scope');
  });

  it('with no authenticated user, reads are empty and writes are no-ops (unscoped fail-safe)', () => {
    storageBacking.set('shanta_leads:LEFTOVER', JSON.stringify([leadA1]));
    setLocalDbUserIdProvider(() => null);

    assert.deepEqual(localDb.getLeads(), [], 'logged-out reads must be empty even with stale scoped keys present');
    assert.deepEqual(localDb.getUsers(), [], 'logged-out user-directory reads must be empty');
    assert.deepEqual(localDb.getNotifications('ANYONE'), [], 'logged-out notification reads must be empty');

    const before = storageBacking.size;
    localDb.saveLeads([leadA1] as any);
    localDb.saveUsers([userA] as any);
    localDb.saveNotifications([{ id: 'n', userId: 'ANYONE', title: 't', message: 'm', leadId: '', read: false, date: '' } as any]);
    assert.equal(storageBacking.size, before, 'logged-out writes must persist NOTHING');
    assert.ok(!storageBacking.has('shanta_leads'), 'no unscoped business key may be created');
    assert.ok(!storageBacking.has('shanta_leads:null'), 'null user must not become a literal key');
  });

  it('clearLegacyGlobalCaches purges pre-hardening unscoped globals but keeps org-wide options', () => {
    storageBacking.set('shanta_leads', JSON.stringify([leadA1]));
    storageBacking.set('shanta_users', JSON.stringify([userA]));
    storageBacking.set('shanta_notifications', JSON.stringify([userA]));
    storageBacking.set('shanta_options', JSON.stringify({ lead_status: ['Untouched'] }));

    clearLegacyGlobalCaches();
    assert.ok(!storageBacking.has('shanta_leads'), 'legacy unscoped leads must be purged');
    assert.ok(!storageBacking.has('shanta_users'), 'legacy unscoped users must be purged');
    assert.ok(!storageBacking.has('shanta_notifications'), 'legacy unscoped notifications must be purged');
    assert.ok(storageBacking.has('shanta_options'), 'org-wide options are reference data and stay');

    // Options remain usable by everyone (documented: not user-scoped).
    setLocalDbUserIdProvider(() => 'USER_B');
    assert.deepEqual(localDb.getOptionsByType('lead_status'), ['Untouched']);
  });
});

describe('logout clears every session-sensitive cache (authStore wiring)', () => {
  it('A logs out -> A scoped caches, legacy globals, sessionCache, startup sequencing all reset; B inherits nothing', async () => {
    const { useAuthStore } = authStoreMod;
    storageBacking.clear();
    sessionCacheMod.resetSessionCacheForTests();
    startupMod.resetStartupPriority();

    // NOTE: importing the auth store registered its own localDb user-id
    // provider (resolves useAuthStore user id), so login() now controls the
    // scope — exactly the production wiring. The previous describe exercised
    // localDb directly and swapped the provider, so restore the production
    // wiring before this scenario.
    setLocalDbUserIdProvider(() => useAuthStore.getState().user?.id ?? null);
    useAuthStore.getState().login(userA, 'tokenA');
    assert.equal(useAuthStore.getState().isAuthenticated, true);

    // A's session state accumulates across the caches.
    localDb.saveLeads([leadA1, leadA2] as any);
    localDb.saveNotifications([
      { id: 'nA', userId: 'USER_A', title: 'A note', message: 'x', leadId: 'lead_a1', read: false, date: new Date().toISOString() } as any,
    ]);
    sessionCacheMod.writeSessionCache('roles:USER_A', { cached: true });
    startupMod.markCriticalStartupSettled();
    // Pre-hardening build leftovers a legacy user might carry.
    storageBacking.set('shanta_leads', JSON.stringify([leadA1]));
    assert.ok(storageBacking.has('leadflow-auth'), 'persisted session snapshot exists');

    // ---- LOGOUT ----
    useAuthStore.getState().logout();

    // Auth state reset.
    assert.equal(useAuthStore.getState().isAuthenticated, false);
    assert.equal(useAuthStore.getState().user, null);
    // The persisted snapshot may be re-written by zustand persist during the
    // final set() — but it must hold NO session-sensitive data (no user,
    // no token, not authenticated). authFlow.ts re-validates against the
    // server on cold load, and with token null there is nothing to prove.
    const snapshot = storageBacking.get('leadflow-auth');
    const parsed = snapshot ? JSON.parse(snapshot) : null;
    assert.ok(
      !parsed?.state || (parsed.state.user === null && parsed.state.token === null && parsed.state.isAuthenticated === false),
      `persisted snapshot must hold no session-sensitive data after logout, got ${snapshot}`
    );

    // Per-user business caches of the signing-out user deleted.
    assert.ok(!storageBacking.has('shanta_leads:USER_A'), 'A scoped leads cache deleted on logout');
    assert.ok(!storageBacking.has('shanta_notifications:USER_A'), 'A scoped notifications cache deleted on logout');
    // Legacy unscoped globals swept.
    assert.ok(!storageBacking.has('shanta_leads'), 'legacy unscoped globals swept on logout');
    // In-memory session caches reset.
    assert.equal(sessionCacheMod.readSessionCache('roles:USER_A'), null, 'sessionCache reset on logout');
    assert.equal(startupMod.isCriticalStartupSettled(), false, 'startup priority sequencing reset on logout');

    // ---- B logs in on the same browser ----
    useAuthStore.getState().login(userB, 'tokenB');
    assert.deepEqual(localDb.getLeads(), [], 'B must not inherit A cached leads after logout+login');
    assert.deepEqual(localDb.getUsers(), [], 'B must not inherit A cached users after logout+login');
    assert.deepEqual(localDb.getNotifications('USER_B'), [], 'B must not inherit A notifications after logout+login');
  });
});

describe('offline fallback policy (shared rule for all read services)', () => {
  it('only "no server answer" failures may fall back to cache', () => {
    const { shouldFallBackToCache, isAuthoritativeClientError } = offlinePolicy;
    // Transport failure / server unavailable -> read-only fallback allowed.
    for (const status of [0, 500, 502, 503]) {
      assert.equal(shouldFallBackToCache(status), true, `status ${status} may fall back`);
      assert.equal(isAuthoritativeClientError(status), false, `status ${status} is not an authoritative client error`);
    }
    // Authoritative client answers -> NEVER fall back to stale business data.
    for (const status of [400, 401, 403, 404, 409, 418]) {
      assert.equal(shouldFallBackToCache(status), false, `status ${status} must NOT fall back to cache`);
      assert.equal(isAuthoritativeClientError(status), true, `status ${status} is authoritative`);
    }
    // Success responses are not fallback cases either.
    assert.equal(shouldFallBackToCache(200), false);
    assert.equal(shouldFallBackToCache(304), false);
  });
});

describe('source guards (no per-file policy drift)', () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

  it('authStore.logout performs the full session-sensitive cleanup', () => {
    const src = read('src/modules/auth/store/authStore.ts');
    assert.ok(src.includes('clearUserCaches(signingOutUser?.id)'), 'logout clears the signing-out user scoped caches');
    assert.ok(src.includes('clearLegacyGlobalCaches()'), 'logout sweeps legacy unscoped globals');
    assert.ok(src.includes('clearSessionCache()'), 'logout resets the in-memory session cache');
    assert.ok(src.includes('clearCoalescing()'), 'logout resets read coalescing');
    assert.ok(src.includes('resetStartupPriority()'), 'logout resets startup priority sequencing');
    assert.ok(src.includes("removeItem('leadflow-auth')"), 'logout removes the persisted session snapshot');
    assert.ok(src.includes("removeItem('leadflow_last_activity')"), 'logout removes the activity marker');
    assert.ok(/setLocalDbUserIdProvider\(\(\)\s*=>\s*useAuthStore\.getState\(\)\.user\?\.id/.test(src), 'auth store registers the localDb user-id provider');
  });

  it('every API-first read service uses the shared offlinePolicy helper', () => {
    const services = [
      'src/modules/admin/services/adminService.ts',
      'src/modules/leads/services/leadService.ts',
      'src/modules/metadata/services/metadataService.ts',
      'src/modules/notifications/services/notificationService.ts',
      'src/modules/hierarchy/services/orgService.ts',
      'src/modules/users/services/userService.ts',
      'src/modules/workflow/services/workflowService.ts',
      'src/modules/forms/services/formBuilderService.ts',
    ];
    for (const rel of services) {
      const src = read(rel);
      assert.ok(
        src.includes("from '../../shared/api/offlinePolicy'") || src.includes("from '../../../shared/api/offlinePolicy'") || /from '\.\.\/\.\.\/\.\.\/shared\/api\/offlinePolicy'/.test(src),
        `${rel} must import the shared offlinePolicy`
      );
      assert.ok(src.includes('shouldFallBackToCache('), `${rel} must gate cache fallback through shouldFallBackToCache`);
    }
  });

  it('no service keeps an inline fallback condition (4xx masking) or direct notification storage writes', () => {
    const services = [
      'src/modules/admin/services/adminService.ts',
      'src/modules/leads/services/leadService.ts',
      'src/modules/metadata/services/metadataService.ts',
      'src/modules/notifications/services/notificationService.ts',
      'src/modules/hierarchy/services/orgService.ts',
      'src/modules/users/services/userService.ts',
      'src/modules/workflow/services/workflowService.ts',
      'src/modules/forms/services/formBuilderService.ts',
    ];
    for (const rel of services) {
      const src = read(rel);
      assert.ok(!/status\s*(===\s*0\s*\|\|[^;]*>=\s*500|\s*!==\s*0\s*&&[^;]*<\s*500)/.test(src), `${rel} must not inline its own fallback condition`);
    }
    const notifications = read('src/modules/notifications/services/notificationService.ts');
    assert.ok(!notifications.includes("localStorage.setItem"), 'notificationService must not write notifications to raw localStorage');
    assert.ok(notifications.includes('saveNotifications'), 'notificationService must persist via localDb.saveNotifications');
  });
});
