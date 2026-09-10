import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import http from 'node:http';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import {
  extractLoginPayload,
  extractSessionUser,
} from '../../src/modules/auth/services/loginContract';

/**
 * AUTHENTICATION / LOGIN-LOADING FLOW — contract + race tests.
 * ------------------------------------------------------------------
 * These tests deliberately do NOT mock the API layer. The real Express router
 * (`server/routes/production.routes.js` - the router both the root `server.ts`
 * and the Vercel `api/index.ts` mount) runs against a real PGlite PostgreSQL,
 * and the REAL browser modules (`authFlow`, `shared/api/http`, `authStore`,
 * `ProtectedRoute`, `lib/apiClient`) are driven against it over actual HTTP.
 * That is the only way to prove the bug class this PR fixes: a login response
 * contract mismatch, plus an auth gate that opened before the server had
 * confirmed (or rejected) the persisted session.
 *
 *   A  login response contract (both envelopes, exactly one unwrap, no
 *      credential material)
 *   B  failed login cannot authenticate, and cannot wipe anything
 *   C  persisted valid session initializes as authenticated, with no
 *      premature /login render and no duplicate work
 *   D  persisted invalid/stale/incomplete session fails closed, once, no loop
 *   E  authentication is established before the redirect to '/'
 *   F  background lead-status warm-up can neither block nor undo login
 *   G  no duplicate startup validation (React StrictMode double effect)
 *   H  401 scoping: the active session still logs out; unrelated 401s do not
 *   R  the guard is wired consistently across the router
 */

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';
const ADMIN = { employeeId: 'ADM9001', password: 'Sup3r-Secret!', fullName: 'Verify Admin' };

function signWithSecret(payload: Record<string, any>, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

/** Small synchronous localStorage stand-in (the client store persists through it). */
function createStorageShim() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('Authentication flow — login contract, startup validation, navigation', () => {
  let pool: any;
  let server: http.Server;
  let baseUrl = '';
  let adminRoleId = '';
  let adminUserId = '';
  let adminHash = '';

  // Real client modules, imported once the browser-ish globals exist.
  let useAuthStore: any;
  let authFlow: typeof import('../../src/modules/auth/services/authFlow');
  let httpModule: typeof import('../../src/modules/shared/api/http');
  let ProtectedRoute: React.ComponentType<{ children: React.ReactNode }>;
  let resolveProtectedAccess: (state: { isInitialized: boolean; isAuthenticated: boolean }) => string;

  type Logged = { method: string; path: string; hasAuthHeader: boolean };
  let requests: Logged[] = [];
  let storage: ReturnType<typeof createStorageShim>;
  const realFetch = globalThis.fetch;
  let unhandled: unknown[] = [];

  /** Requests whose path matches are held until `release()` is called, which
   *  is how an in-flight validation is observed mid-race. */
  let heldPath: string | null = null;
  let heldRelease: (() => void) | null = null;
  let heldWaiter: Promise<void> | null = null;

  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  function holdPath(path: string): () => void {
    let release: () => void = () => undefined;
    heldPath = path;
    heldWaiter = new Promise<void>(resolve => {
      release = resolve;
    });
    const done = () => {
      heldPath = null;
      heldWaiter = null;
      heldRelease = null;
      release();
    };
    heldRelease = done;
    return done;
  }

  function countRequests(path: string): number {
    return requests.filter(r => r.path.startsWith(path)).length;
  }

  function persistedSnapshot(): any {
    const raw = storage.getItem('leadflow-auth');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function tick(times = 4): Promise<void> {
    for (let i = 0; i < times; i++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  function resetStore(patch: Record<string, unknown> = {}) {
    storage.clear();
    useAuthStore.setState({
      user: null,
      token: null,
      isAuthenticated: false,
      isInitialized: false,
      isOfflineMode: false,
      ...patch,
    });
    authFlow.resetAuthSessionInitializationForTests();
  }

  /** Direct (non-client) call against the real server, for raw-contract checks. */
  async function api(
    method: string,
    path: string,
    { body, token }: { body?: unknown; token?: string } = {}
  ): Promise<{ status: number; json: any }> {
    const res = await realFetch(baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  }

  /** What the first paint looks like for the current store state. */
  function renderGate(): string {
    return renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        React.createElement(
          'div',
          null,
          React.createElement(ProtectedRoute, null, React.createElement('span', null, 'PROTECTED-CHILD')),
          React.createElement('span', null, 'OUTSIDE-GATE')
        )
      )
    );
  }

  before(async () => {
    process.env.DATABASE_URL = 'pglite://memory';
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = 'test';

    /* --- real PostgreSQL (PGlite) with the production users/roles tables --- */
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role_code VARCHAR(100) UNIQUE,
        role_name VARCHAR(255),
        hierarchy_level INT DEFAULT 0,
        data_visibility VARCHAR(30) DEFAULT 'Own',
        menu_access JSONB,
        actions JSONB,
        feature_permissions JSONB
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id VARCHAR(30) UNIQUE NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role_id UUID,
        department_id UUID,
        manager_id UUID,
        is_active BOOLEAN DEFAULT TRUE,
        must_change_password BOOLEAN DEFAULT FALSE,
        reporting_chain JSONB DEFAULT '[]'::jsonb,
        subordinates JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const role = await pool.query(
      `INSERT INTO roles (role_code, role_name, hierarchy_level, data_visibility)
       VALUES ('ADMIN', 'Administrator', 1, 'Organization') RETURNING id`
    );
    adminRoleId = role.rows[0].id;
    adminHash = await bcrypt.hash(ADMIN.password, 8);
    const created = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE, FALSE) RETURNING id`,
      [ADMIN.employeeId, ADMIN.fullName, 'verify-admin@leadflow.test', adminHash, adminRoleId]
    );
    adminUserId = created.rows[0].id;

    const routes = await import('../routes/production.routes.js');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use('/api', routes.default);
    server = await new Promise<http.Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

    /* --- browser-ish globals, then the REAL client modules --- */
    storage = createStorageShim();
    const g = globalThis as any;
    g.localStorage = storage;
    g.window = globalThis;

    const clientFetch: typeof fetch = async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const path = url.startsWith('http') ? url.slice(baseUrl.length) : url;
      const headers = new Headers(init?.headers || {});
      requests.push({ method: init?.method || 'GET', path, hasAuthHeader: headers.has('Authorization') });
      if (heldWaiter && path.startsWith(heldPath as string)) await heldWaiter;
      return realFetch(baseUrl + path, { ...init, headers });
    };
    g.fetch = clientFetch;
    // The same patch main.tsx applies in the browser, so requests carry the
    // store token exactly like production (this is what the 401 scoping keys on).
    const apiClient = await import('../../src/lib/apiClient');
    apiClient.installAuthenticatedFetch();

    authFlow = await import('../../src/modules/auth/services/authFlow');
    ({ useAuthStore } = await import('../../src/modules/auth/store/authStore'));
    httpModule = await import('../../src/modules/shared/api/http');
    const gate = await import('../../src/modules/auth/components/ProtectedRoute');
    ProtectedRoute = gate.default;
    resolveProtectedAccess = gate.resolveProtectedAccess;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    _resetPoolsForTest();
    await resetPGlite();
    await closePool();
  });

  beforeEach(() => {
    requests = [];
    unhandled = [];
    heldPath = null;
    heldWaiter = null;
    heldRelease = null;
    if (useAuthStore) resetStore();
  });

  afterEach(() => {
    if (heldRelease) heldRelease();
    heldPath = null;
    heldWaiter = null;
    heldRelease = null;
  });

  /* ================================================================ */
  /* A. login response contract                                       */
  /* ================================================================ */

  it('A1 extracts token+user from the real /api/auth/login body and from the { success, data } envelope', async () => {
    const real = await api('POST', '/api/auth/login', {
      body: { employeeId: ADMIN.employeeId, password: ADMIN.password },
    });
    assert.equal(real.status, 200, 'the seeded admin must be able to log in');
    assert.ok(typeof real.json.token === 'string' && real.json.token.length > 20);
    // Documented deployed contract (production.routes.ts): a bare { token, user }.
    assert.equal(real.json.success, undefined);

    const fromBare = extractLoginPayload(real.json);
    const fromWrapped = extractLoginPayload({ success: true, data: real.json });
    assert.equal(fromWrapped.token, fromBare.token, 'the newer envelope yields the same session');
    assert.deepEqual(fromWrapped.user, fromBare.user);

    assert.equal(fromBare.user.employeeId, ADMIN.employeeId);
    assert.equal(fromBare.user.name, ADMIN.fullName, 'the welcome toast reads user.name');
    assert.equal(fromBare.user.id, adminUserId, 'the server-returned user is used verbatim');
    assert.ok(jwt.decode(fromBare.token), 'the stored token is the server JWT');

    // Login and session validation must return the SAME profile: that is what
    // lets a cold reload skip the state rewrite (and the refetch storm behind
    // every effect that depends on `user`).
    // (`lastLogin` is the only legitimate difference: login stamps it after
    // reading the row, so the *next* read sees the new value.)
    const session = await api('GET', '/api/auth/session', { token: fromBare.token });
    assert.equal(session.status, 200);
    const stripVolatile = (value: any) => {
      const { lastLogin: _ignored, ...rest } = value;
      return rest;
    };
    assert.deepEqual(stripVolatile(JSON.parse(JSON.stringify(fromBare.user))), stripVolatile(session.json.data));
  });

  it('A2 apiRequest() unwraps exactly once - the client never re-unwraps', async () => {
    const login = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);

    // Same client function, but the server replies with the OTHER contract
    // (AuthController / auth.routes.ts shape). It must resolve identically,
    // because the unwrap lives only in shared/api/http.ts.
    const originalFetchImpl = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          message: 'Login successful.',
          data: { token: login.token, user: { ...login.user } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    try {
      const viaWrappedApi = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
      assert.equal(viaWrappedApi.token, login.token);
      assert.equal(viaWrappedApi.user.employeeId, ADMIN.employeeId);

      // apiRequest itself performed exactly one unwrap: the payload handed to
      // the caller is `data` itself, neither the envelope nor data.data.
      const unwrappedOnce = await httpModule.apiRequest<any>('/api/auth/login', { method: 'POST' });
      assert.equal(unwrappedOnce.token, login.token);
      assert.equal(unwrappedOnce.data, undefined, 'must not leave the envelope in place');
      assert.equal(unwrappedOnce.success, undefined, 'must not double-unwrap');
    } finally {
      (globalThis as any).fetch = originalFetchImpl;
    }
  });

  it('A3 no credential material ever reaches the parsed session', async () => {
    const real = await api('POST', '/api/auth/login', {
      body: { employeeId: ADMIN.employeeId, password: ADMIN.password },
    });
    assert.equal(
      JSON.stringify(real.json).includes('$2'),
      false,
      'the endpoint must not send a bcrypt hash to the browser'
    );

    // Even a hypothetically leaky body is sanitized before it can be stored.
    const leaky = { ...real.json, user: { ...real.json.user, password: adminHash, passwordHash: adminHash } };
    const parsed = extractLoginPayload(leaky);
    assert.equal('password' in (parsed.user as object), false);
    assert.equal('passwordHash' in (parsed.user as object), false);
    assert.equal(JSON.stringify(parsed).includes('password'), false);
  });

  it('A4 an unusable response fails loudly instead of storing undefined', () => {
    assert.throws(() => extractLoginPayload({ success: true }), /session token/i);
    assert.throws(() => extractLoginPayload({ token: 'x' }), /account profile/i);
    assert.throws(() => extractLoginPayload(null), /unexpected login response/i);
    assert.equal(extractSessionUser({ success: true, data: {} }), null);
    assert.equal(extractSessionUser(null), null);
  });

  it('A5 the login request is not sent as an authenticated call', async () => {
    await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    const loginCalls = requests.filter(r => r.path === '/api/auth/login');
    assert.equal(loginCalls.length, 1, 'exactly one login request per attempt');
    assert.equal(loginCalls[0].hasAuthHeader, false);
  });

  /* ================================================================ */
  /* B. failed login                                                  */
  /* ================================================================ */

  it('B1 invalid credentials do not authenticate and preserve the server error', async () => {
    const paths: string[] = [];
    await assert.rejects(
      authFlow
        .loginWithCredentials(ADMIN.employeeId, 'totally-wrong')
        .then(session => authFlow.activateSession(session, { navigate: p => void paths.push(p) })),
      (err: any) => err instanceof httpModule.ApiError && err.status === 401 && /invalid credentials/i.test(err.message)
    );

    assert.deepEqual(paths, [], 'a failed login must not navigate anywhere');
    const state = useAuthStore.getState();
    assert.equal(state.isAuthenticated, false);
    assert.equal(state.token, null);
    assert.equal(state.user, null);
  });

  it('B2 a rejected password cannot wipe a persisted (still cached) session', async () => {
    // The user retried credentials while an old snapshot sits in storage.
    useAuthStore.setState({ user: { id: 'u', employeeId: ADMIN.employeeId, name: 'Stale' } as any, token: null, isAuthenticated: true });
    storage.setItem(
      'leadflow-auth',
      JSON.stringify({ state: { user: { id: 'u', employeeId: ADMIN.employeeId, name: 'Stale' }, token: null, isAuthenticated: true }, version: 0 })
    );
    const before = storage.getItem('leadflow-auth');
    assert.ok(before, 'precondition: a persisted snapshot exists');

    await assert.rejects(() => authFlow.loginWithCredentials(ADMIN.employeeId, 'nope'), /invalid credentials/i);
    await tick();

    assert.equal(storage.getItem('leadflow-auth'), before, 'no logout side effect on a credential failure');
    assert.equal(persistedSnapshot()?.state?.isAuthenticated, true);
  });

  /* ================================================================ */
  /* E. authentication precedes navigation                             */
  /* ================================================================ */

  it('E1 the session is established BEFORE the redirect to /', async () => {
    const session = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    const atNavigation: any[] = [];
    await authFlow.activateSession(session, {
      navigate: path => {
        // Whatever the router sees at the moment of the redirect is what the
        // gate renders - so this is the real "no bounce back to /login" check.
        const s = useAuthStore.getState();
        atNavigation.push({ path, isAuthenticated: s.isAuthenticated, token: s.token, user: s.user?.employeeId });
      },
    });

    assert.equal(atNavigation.length, 1, 'exactly one navigation');
    assert.equal(atNavigation[0].path, '/');
    assert.equal(atNavigation[0].isAuthenticated, true, 'auth state must precede the redirect');
    assert.equal(atNavigation[0].token, session.token, 'the server token is already in the store');
    assert.equal(atNavigation[0].user, ADMIN.employeeId, 'the server user is already in the store');
    const state = useAuthStore.getState();
    assert.equal(state.isAuthenticated, true);
    assert.equal(state.token, session.token, 'the actual server-returned token is stored');
    assert.equal(state.user.employeeId, ADMIN.employeeId, 'the actual server-returned user is stored');
    assert.equal(state.isInitialized, true, 'a server-confirmed login settles the startup gate');
  });

  it('E2 a throwing welcome toast cannot prevent navigation', async () => {
    const paths: string[] = [];
    const session = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    process.on('unhandledRejection', onUnhandled);
    try {
      await authFlow.activateSession(session, {
        navigate: path => void paths.push(path),
        welcome: () => {
          throw new Error('toast host exploded');
        },
      });
      await tick(6);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(paths, ['/']);
    assert.equal(useAuthStore.getState().isAuthenticated, true);
    assert.deepEqual(unhandled, [], 'a failing toast must not create an unhandled rejection');
  });

  /* ================================================================ */
  /* F. background work is decoupled from login                        */
  /* ================================================================ */

  it('F1 a rejected background preload cannot undo authentication or navigation', async () => {
    const paths: string[] = [];
    const session = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    process.on('unhandledRejection', onUnhandled);
    try {
      await authFlow.activateSession(session, {
        navigate: path => void paths.push(path),
        afterAuthentication: () => Promise.reject(new Error('metadata service offline')),
      });
      await tick(8);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    assert.deepEqual(paths, ['/']);
    assert.equal(useAuthStore.getState().isAuthenticated, true, 'auth survives a failed warm-up');
    assert.equal(useAuthStore.getState().token, session.token);
    assert.equal(countRequests('/api/auth/session'), 0, 'no revalidation storm after login');
    assert.deepEqual(unhandled, [], 'the rejection is caught, never left floating');
  });

  it('F2 a synchronously throwing cache write cannot undo authentication either', async () => {
    const paths: string[] = [];
    const session = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    process.on('unhandledRejection', onUnhandled);
    try {
      await authFlow.activateSession(session, {
        navigate: path => void paths.push(path),
        afterAuthentication: () => {
          throw new Error('localStorage quota exceeded');
        },
      });
      await tick(8);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(paths, ['/']);
    assert.equal(useAuthStore.getState().isAuthenticated, true);
    assert.deepEqual(unhandled, []);
  });

  it('F3 navigation does not wait for the background work', async () => {
    let warmUpDone = false;
    let navigatedWhilePending: boolean | null = null;
    const session = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    await authFlow.activateSession(session, {
      navigate: () => {
        navigatedWhilePending = !warmUpDone;
      },
      afterAuthentication: async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        warmUpDone = true;
      },
    });
    assert.equal(navigatedWhilePending, true, 'navigation is not gated on the preload');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(warmUpDone, true, 'the warm-up still runs to completion afterwards');
  });

  /* ================================================================ */
  /* C. persisted valid session                                        */
  /* ================================================================ */

  it('C1 a persisted token the server accepts initializes as authenticated, with no premature /login', async () => {
    void resolveProtectedAccess;
    const { token, user } = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);

    // Simulate a reload: only the persisted snapshot exists and the gate is
    // closed (`isInitialized` is never persisted).
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false, isInitialized: false });
    storage.setItem(
      'leadflow-auth',
      JSON.stringify({ state: { user, token, isAuthenticated: true, isOfflineMode: false }, version: 0 })
    );
    await (useAuthStore as any).persist.rehydrate(); // what a reload does
    assert.equal(useAuthStore.getState().token, token, 'persisted snapshot hydrated');
    assert.equal(useAuthStore.getState().isInitialized, false, 'gate still closed before validation');

    const release = holdPath('/api/auth/session');
    const whileValidating = renderGate();
    assert.match(whileValidating, /auth-initializing/, 'protected content waits for validation');
    assert.doesNotMatch(whileValidating, /PROTECTED-CHILD/, 'no protected render before validation');

    const initialization = authFlow.initializeAuthSession();
    await tick();
    release();
    await initialization;

    const state = useAuthStore.getState();
    assert.equal(state.isInitialized, true);
    assert.equal(state.isAuthenticated, true, 'the confirmed session is kept');
    assert.equal(state.token, token);
    assert.equal(state.user.employeeId, ADMIN.employeeId);
    assert.equal(countRequests('/api/auth/session'), 1, 'exactly one validation request');
    assert.equal(countRequests('/api/db-status'), 0, 'no extra bootstrap request at startup');

    // A static render always reads the store's *initial* snapshot (React's
    // getServerSnapshot), which is exactly why the whileValidating check above
    // is meaningful: at cold start the first paint of a protected route is the
    // neutral gate. The post-validation decision is asserted through the same
    // pure function the component renders on.
    assert.equal(resolveProtectedAccess(useAuthStore.getState()), 'granted');
  });

  it('C2 the confirmed profile is only written when it differs (no effect re-run storm)', async () => {
    const { token, user } = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    useAuthStore.setState({ user, token, isAuthenticated: true, isInitialized: false });

    let userReplacements = 0;
    let previousUser = useAuthStore.getState().user;
    const unsubscribe = useAuthStore.subscribe(() => {
      const next = useAuthStore.getState().user;
      if (next !== previousUser) {
        userReplacements++;
        previousUser = next;
      }
    });
    try {
      await authFlow.initializeAuthSession();
    } finally {
      unsubscribe();
    }
    assert.equal(countRequests('/api/auth/session'), 1);
    assert.equal(useAuthStore.getState().isInitialized, true);
    assert.equal(userReplacements, 0, 'an identical server profile must not create a new user object');
  });

  /* ================================================================ */
  /* D. persisted invalid / stale session                              */
  /* ================================================================ */

  it('D1 a token the server rejects clears auth, ends at /login and never loops', async () => {
    const forged = signWithSecret({ id: adminUserId, employeeId: ADMIN.employeeId, role: 'ADMIN' }, 'not-the-real-secret');
    useAuthStore.setState({
      user: { id: adminUserId, employeeId: ADMIN.employeeId, name: 'Ghost' } as any,
      token: forged,
      isAuthenticated: true,
      isInitialized: false,
    });

    await authFlow.initializeAuthSession();

    const state = useAuthStore.getState();
    assert.equal(state.isAuthenticated, false, 'an invalid token must not stay authenticated');
    assert.equal(state.token, null);
    assert.equal(state.user, null);
    assert.equal(state.isInitialized, true, 'the gate still opens so /login is reachable');
    assert.doesNotMatch(renderGate(), /PROTECTED-CHILD/);

    // No loop: remounts / effect re-runs never re-validate.
    await authFlow.initializeAuthSession();
    await authFlow.initializeAuthSession();
    assert.equal(countRequests('/api/auth/session'), 1, 'one validation per page load');
  });

  it('D2 an inconsistent snapshot is cleared without contacting the server', async () => {
    // "authenticated" without a token is not a session: fail closed, quietly.
    useAuthStore.setState({ user: null, token: null, isAuthenticated: true, isInitialized: false });
    await authFlow.initializeAuthSession();
    assert.equal(useAuthStore.getState().isAuthenticated, false);
    assert.equal(useAuthStore.getState().isInitialized, true);
    assert.equal(requests.length, 0, 'nothing to validate -> no session request');
  });

  it('D3 a token without a cached profile fails closed when the server cannot confirm it', async () => {
    useAuthStore.setState({ user: null, token: 'unverifiable', isAuthenticated: true, isInitialized: false });
    const clientFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    try {
      await authFlow.initializeAuthSession();
    } finally {
      (globalThis as any).fetch = clientFetch;
    }
    assert.equal(useAuthStore.getState().isAuthenticated, false, 'fail closed on incomplete state');
    assert.equal(useAuthStore.getState().isInitialized, true);
  });

  it('D4 a deactivated or deleted account stops working immediately (server side)', async () => {
    const { token } = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    assert.equal((await api('GET', '/api/auth/session', { token })).status, 200);

    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [adminUserId]);
    const inactive = await api('GET', '/api/auth/session', { token });
    assert.equal(inactive.status, 401, 'an inactive account must not keep a live session');
    assert.match(String(inactive.json?.message), /inactive/i);

    await pool.query('UPDATE users SET is_active = TRUE WHERE id = $1', [adminUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
    const gone = await api('GET', '/api/auth/session', { token });
    assert.equal(gone.status, 401);
    assert.match(String(gone.json?.message), /no longer exists/i);

    await pool.query(
      `INSERT INTO users (id, employee_id, full_name, email, password, role_id, is_active, must_change_password)
       VALUES ($1, $2, $3, 'verify-admin@leadflow.test', $4, $5, TRUE, FALSE)`,
      [adminUserId, ADMIN.employeeId, ADMIN.fullName, adminHash, adminRoleId]
    );
  });

  it('D5 GET /api/auth/session keeps the { success, data } contract and refuses bad tokens', async () => {
    assert.equal((await api('GET', '/api/auth/session')).status, 401);
    assert.equal((await api('GET', '/api/auth/session', { token: 'garbage.token.value' })).status, 401);

    const valid = signWithSecret({ id: adminUserId, employeeId: ADMIN.employeeId, role: 'ADMIN' }, JWT_SECRET);
    const res = await api('GET', '/api/auth/session', { token: valid });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.equal(res.json.data.employeeId, ADMIN.employeeId);
    assert.equal(res.json.data.password, undefined, 'no credential material in the session payload');
    assert.equal(extractSessionUser(res.json)?.employeeId, ADMIN.employeeId);
  });

  /* ================================================================ */
  /* G. duplicate startup work                                          */
  /* ================================================================ */

  it('G1 a double effect run (React StrictMode) performs exactly one validation', async () => {
    const { token, user } = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    useAuthStore.setState({ user, token, isAuthenticated: true, isInitialized: false });

    await Promise.all([authFlow.initializeAuthSession(), authFlow.initializeAuthSession()]);

    assert.equal(countRequests('/api/auth/session'), 1, 'no duplicate session validation');
    assert.equal(useAuthStore.getState().isAuthenticated, true);
  });

  it('G2 a corrupt persisted snapshot cannot strand the gate (hydration wait always settles)', async () => {
    storage.setItem('leadflow-auth', '{not json at all');
    await (useAuthStore as any).persist.rehydrate().catch(() => undefined);
    // The wait resolves even though hydration failed, so no infinite spinner.
    await authFlow.waitForPersistedAuthState();
    assert.ok(true);

    useAuthStore.setState({ user: null, token: null, isAuthenticated: false, isInitialized: false });
    await authFlow.initializeAuthSession();
    assert.equal(useAuthStore.getState().isInitialized, true);
  });

  /* ================================================================ */
  /* H. 401 scoping: security kept, races removed                       */
  /* ================================================================ */

  it('H1 a login that lands while validation is in flight is not evicted by the stale validation', async () => {
    const forged = signWithSecret({ id: adminUserId, employeeId: ADMIN.employeeId, role: 'ADMIN' }, 'stale-secret');
    useAuthStore.setState({
      user: { id: adminUserId, employeeId: ADMIN.employeeId, name: 'Stale' } as any,
      token: forged,
      isAuthenticated: true,
      isInitialized: false,
    });

    const release = holdPath('/api/auth/session');
    const initialization = authFlow.initializeAuthSession();
    await tick(); // the validation request is now parked mid-flight

    // The user completes a real login meanwhile (note: login is NOT held).
    const fresh = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    const paths: string[] = [];
    await authFlow.activateSession(fresh, { navigate: p => void paths.push(p) });

    release();
    await initialization;

    assert.deepEqual(paths, ['/'], 'login navigation happened');
    const state = useAuthStore.getState();
    assert.equal(state.token, fresh.token, 'the new token survives the old validation');
    assert.equal(state.isAuthenticated, true, 'a pending 401 must not evict a fresh session');
    assert.equal(countRequests('/api/auth/session'), 1);
  });

  it('H2 a 401 against the active session still ends that session', async () => {
    const fresh = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    useAuthStore.setState({ user: fresh.user, token: fresh.token, isAuthenticated: true, isInitialized: true });
    await tick();

    await pool.query('UPDATE users SET is_active = FALSE WHERE id = $1', [adminUserId]);
    try {
      await assert.rejects(
        () => httpModule.apiRequest('/api/auth/session'),
        (err: any) => err instanceof httpModule.ApiError && err.status === 401
      );
      const state = useAuthStore.getState();
      assert.equal(state.isAuthenticated, false, 'an expired/revoked session still logs out');
      assert.equal(state.token, null);
      await tick();
      assert.equal(persistedSnapshot()?.state?.isAuthenticated, false, 'the cache is cleared too');
    } finally {
      await pool.query('UPDATE users SET is_active = TRUE WHERE id = $1', [adminUserId]);
    }
  });

  it('H3 a request fired before the token exists cannot wipe the session being established', async () => {
    // Cold start on /login: no session token yet, and some widget fires an
    // authenticated-looking request that 401s.
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false, isInitialized: false });
    await assert.rejects(
      () => httpModule.apiRequest('/api/notifications/users/ADM9001'),
      (err: any) => err.status === 401
    );
    assert.equal(requests.length, 1);

    // The login then completes normally and stays authenticated.
    const session = await authFlow.loginWithCredentials(ADMIN.employeeId, ADMIN.password);
    await authFlow.activateSession(session, { navigate: () => undefined });
    const state = useAuthStore.getState();
    assert.equal(state.isAuthenticated, true);
    assert.equal(state.token, session.token);
    await tick();
    assert.equal(persistedSnapshot()?.state?.isAuthenticated, true);
  });

  /* ================================================================ */
  /* R. guard wiring                                                     */
  /* ================================================================ */

  it('R1 the gate decision never redirects before initialization finishes', () => {
    assert.equal(resolveProtectedAccess({ isInitialized: false, isAuthenticated: false }), 'initializing');
    assert.equal(resolveProtectedAccess({ isInitialized: false, isAuthenticated: true }), 'initializing');
    assert.equal(resolveProtectedAccess({ isInitialized: true, isAuthenticated: false }), 'unauthenticated');
    assert.equal(resolveProtectedAccess({ isInitialized: true, isAuthenticated: true }), 'granted');
    // The render side agrees with the decision for the two startup states.
    useAuthStore.setState({ isInitialized: false, isAuthenticated: false });
    assert.match(renderGate(), /auth-initializing/);
    assert.doesNotMatch(renderGate(), /PROTECTED-CHILD/);
  });

  it('R2 every non-login route in the router is guarded by the same component', async () => {
    const appSource = fs.readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
    assert.match(appSource, /void initializeAuthSession\(\)/, 'App drives the deterministic init');
    assert.doesNotMatch(appSource, /setInitialized\(true\)/, 'no "React mounted == authenticated" shortcut');
    assert.doesNotMatch(appSource, /checkDatabaseStatus/, 'no useless startup db-status request');
    assert.doesNotMatch(appSource, /useAuthStore/, 'App holds no auth state of its own');

    const offenders = appSource
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('element: <'))
      .filter(
        line => !line.includes('<ProtectedRoute>') && !line.includes('<Login />') && !line.includes('<Navigate to="/"')
      );
    assert.deepEqual(offenders, [], 'every authenticated route renders through ProtectedRoute');
    const guarded = (appSource.match(/element: <ProtectedRoute>/g) || []).length;
    assert.ok(guarded >= 16, `expected all 16 app routes guarded, saw ${guarded}`);
  });

  it('R3 Login.tsx no longer parses the login response and never blocks on warm-up', async () => {
    const loginSource = fs.readFileSync(
      new URL('../../src/modules/auth/pages/Login.tsx', import.meta.url),
      'utf8'
    );
    assert.doesNotMatch(loginSource, /fetch\(['"]\/api\/auth\/login/, 'no hand-rolled login fetch left');
    assert.doesNotMatch(loginSource, /\.json\(\)/, 'no direct response parsing left');
    assert.doesNotMatch(loginSource, /\blogin\(/, 'the store login action is called only in authFlow');
    assert.match(loginSource, /loginWithCredentials\(empId, data\.password\)/);
    assert.match(loginSource, /await activateSession\(session, \{/);
    assert.match(loginSource, /afterAuthentication: warmUpAfterAuthentication/);

    // The only place that consumes login/bootstrap responses is the shared
    // contract helper - no duplicated unwrap anywhere in the auth flow.
    const flowSource = fs.readFileSync(
      new URL('../../src/modules/auth/services/authFlow.ts', import.meta.url),
      'utf8'
    );
    assert.equal(
      (flowSource.match(/\.data\b|success === true/g) || []).length,
      0,
      'authFlow must not re-implement envelope unwrapping'
    );
  });
});
