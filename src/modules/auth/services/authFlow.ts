import { useAuthStore, authHydrationSettled } from '../store/authStore';
import { apiRequest, ApiError } from '../../shared/api/http';
import { extractLoginPayload, extractSessionUser } from './loginContract';
import { User } from '../../shared/types';

/**
 * authFlow.ts
 * ------------------------------------------------------------------
 * The whole authentication lifecycle in one deterministic sequence:
 *
 *   cold start :  wait for Zustand hydration  ->  validate the persisted
 *                 token against the server  ->  isInitialized = true
 *   login      :  server confirms credentials ->  auth state + navigate
 *                 ->  cache writes / lead-status warm-up in the background
 *
 * Why it lives here instead of inside the components: the previous flow
 * mixed `fetch()` response parsing, localStorage cache writes, lead-status
 * preloading, the toast and the redirect into one submit handler, so a
 * background request could (a) delay navigation, (b) fail the login, or
 * (c) trigger a 401 -> logout while the session was still being established.
 * Every rule below is asserted by server/tests/auth-flow-integration.test.ts.
 */

export const LOGIN_ENDPOINT = '/api/auth/login';
export const SESSION_ENDPOINT = '/api/auth/session';

export interface EstablishedSession {
  token: string;
  user: User;
}

/** Anything the UI layer wants to do once a session exists (toast, warm cache). */
export interface ActivateSessionContext {
  navigate: (path: string) => void;
  /** Presentation only (e.g. the welcome toast). Throwing must not affect auth. */
  welcome?: (user: User) => void;
  /** Background warm-up (localStorage cache, lead-status preload). Failures
   *  are logged and can never undo or delay the authenticated session. */
  afterAuthentication?: (user: User) => void | Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* Login                                                             */
/* ------------------------------------------------------------------ */

/**
 * POST /api/auth/login through the centralized API contract helper, so the
 * `{ success, data }` envelope is unwrapped exactly once and every server
 * error arrives as an ApiError carrying the real status + message.
 */
export async function loginWithCredentials(employeeId: string, password: string): Promise<EstablishedSession> {
  const body = await apiRequest<unknown>(LOGIN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId, password }),
  });
  return extractLoginPayload(body);
}

/**
 * Applies a server-confirmed session and navigates immediately. Everything
 * non-essential is deliberately sequenced AFTER the state change:
 * authentication never waits for cache writes or metadata preloading.
 */
export async function activateSession(session: EstablishedSession, ctx: ActivateSessionContext): Promise<void> {
  useAuthStore.getState().login(session.user, session.token, false);
  // A login is proof of a valid session: it also settles any cold-start
  // validation that is still in flight (see initializeAuthSession below).
  sessionConfirmedByLogin = true;

  useAuthStore.getState().setInitialized(true);
  ctx.navigate('/');

  try {
    ctx.welcome?.(session.user);
  } catch (err) {
    console.warn('[auth] Welcome notification failed (session is unaffected):', err);
  }

  if (ctx.afterAuthentication) {
    const after = ctx.afterAuthentication;
    const user = session.user;
    // Fire-and-forget, but never unhandled: rejections are logged only.
    void Promise.resolve()
      .then(() => after(user))
      .catch(err => {
        console.warn('[auth] Background warm-up after login failed (session is unaffected):', err);
      });
  }
}

/* ------------------------------------------------------------------ */
/* Cold-start session validation                                     */
/* ------------------------------------------------------------------ */

let initialization: Promise<void> | null = null;
let sessionConfirmedByLogin = false;

/**
 * Test seam: the initialization guard is intentionally per page-load (that is
 * what stops React StrictMode / a second mount from validating the same token
 * twice), so a test needs to reset it between cases.
 */
export function resetAuthSessionInitializationForTests(): void {
  initialization = null;
  sessionConfirmedByLogin = false;
}

/** Resolves when the persisted auth snapshot is usable (hydrated or broken). */
export async function waitForPersistedAuthState(): Promise<void> {
  const persistApi = (useAuthStore as unknown as { persist?: { hasHydrated?: () => boolean } }).persist;
  // No persist API (storage unavailable) means there is nothing to hydrate;
  // authHydrationSettled covers the storage-error case, so this can never
  // leave the app stuck on the startup gate.
  if (!persistApi || typeof persistApi.hasHydrated !== 'function' || persistApi.hasHydrated()) return;
  await authHydrationSettled;
}

function markAuthInitialized(): void {
  useAuthStore.getState().setInitialized(true);
}

/** True while the token this initialization started with is still the session. */
function isStillSameSession(token: string | null): boolean {
  return useAuthStore.getState().token === token;
}

/**
 * The profile fields that decide what the authenticated app renders: menus,
 * permission checks, data-visibility scope, forced password change. Volatile
 * audit fields (notably `lastLogin`, which the login endpoint itself stamps)
 * are deliberately excluded: rewriting the user for them would re-run every
 * `[user]`-dependent effect (roles, notifications, dashboard) on the landing
 * tab for no behavioral change - which is precisely the duplicate startup
 * traffic this PR removes.
 */
const PROFILE_KEYS = [
  'id',
  'employeeId',
  'name',
  'role',
  'roleCode',
  'roleName',
  'status',
  'designation',
  'departmentId',
  'teamId',
  'managerId',
  'reportingManagerId',
  'hierarchyLevel',
  'mustChangePassword',
  'avatarUrl',
] as const;

function sameProfile(cached: User | null, authoritative: User): boolean {
  if (!cached) return false;
  return PROFILE_KEYS.every(key => {
    const before = (cached as Record<string, any>)[key];
    const after = (authoritative as Record<string, any>)[key];
    return String(before ?? '') === String(after ?? '');
  });
}

/**
 * Runs at most once per page load. Never rejects: whatever happens, protected
 * routes end up either authenticated-and-validated or back on /login, so a
 * failure can neither hang the startup gate nor loop.
 */
export function initializeAuthSession(): Promise<void> {
  if (!initialization) initialization = performAuthInitialization();
  return initialization;
}

async function performAuthInitialization(): Promise<void> {
  try {
    // 1. Nothing may be decided before the persisted state has been read.
    await waitForPersistedAuthState();

    if (sessionConfirmedByLogin) {
      markAuthInitialized();
      return;
    }

    const state = useAuthStore.getState();

    // 2. Either there is nothing to validate, or the snapshot is internally
    //    inconsistent (a token the app does not treat as a session, or a
    //    "session" without a token). Both are cleared rather than guessed at -
    //    a cached snapshot is never allowed to authenticate anybody.
    if (!state.token || !state.isAuthenticated) {
      if (state.token || state.isAuthenticated) state.logout();
      markAuthInitialized();
      return;
    }

    const tokenUnderTest = state.token;

    // 3. Ask the server. `fetchAuthenticatedSession` pins the Authorization
    //    header to the exact token being validated, so a login that lands
    //    while this is in flight cannot be mistaken for a rejected session.
    let authoritativeUser: User | null = null;
    try {
      authoritativeUser = await fetchAuthenticatedSession(tokenUnderTest);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // 5. The server rejected this session -> existing logout behaviour.
        //    If the token changed underneath us (a login completed while we
        //    were awaiting), that login owns the state - step aside instead
        //    of logging a fresh session out.
        if (!sessionConfirmedByLogin && isStillSameSession(tokenUnderTest)) {
          useAuthStore.getState().logout();
        }
        markAuthInitialized();
        return;
      }
      // 4xx other than 401 (e.g. an API version without this endpoint) and
      // 5xx / network failures are "cannot confirm right now", not "invalid".
      // The session survives and every authenticated request keeps its own
      // 401 -> logout safety net, so an expired token still ends the session.
      console.warn(
        '[auth] Could not confirm the persisted session with the server; keeping it for now.',
        err instanceof Error ? err.message : err
      );
      // Exception: a snapshot that has no profile at all can never render a
      // usable session, so incomplete/stale state is cleared (fail closed)
      // rather than trusted.
      if (!useAuthStore.getState().user) useAuthStore.getState().logout();
      markAuthInitialized();
      return;
    }

    if (sessionConfirmedByLogin || !isStillSameSession(tokenUnderTest)) {
      markAuthInitialized();
      return;
    }

    // 4. Valid session: keep the user, and only touch the store when the
    //    server profile actually differs - a new object identity would
    //    re-trigger every `[user]` effect (roles, notifications, dashboard)
    //    and double the startup requests for nothing.
    const current = useAuthStore.getState();
    if (authoritativeUser) {
      if (!sameProfile(current.user, authoritativeUser)) current.setUser(authoritativeUser);
    } else if (!current.user) {
      // Token accepted, no profile from the server and none cached: there is
      // nothing renderable, so clear it instead of half-authenticating.
      current.logout();
    }
    markAuthInitialized();
  } catch (err) {
    // Defensive: an unexpected error must not leave the app on the spinner.
    console.error('[auth] Session initialization failed:', err);
    markAuthInitialized();
  }
}

/**
 * Validates a token against the server and returns the authoritative profile.
 * Throws ApiError (status preserved) for anything the server rejected.
 */
export async function fetchAuthenticatedSession(token: string): Promise<User | null> {
  const body = await apiRequest<unknown>(SESSION_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return extractSessionUser(body);
}
