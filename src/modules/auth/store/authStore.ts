import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../../shared/types';
import { clearSessionCache } from '../../shared/api/sessionCache';
import { clearCoalescing } from '../../shared/api/coalesce';
import { resetStartupPriority } from '../../shared/api/startupPriority';
import {
  setLocalDbUserIdProvider,
  clearUserCaches,
  clearLegacyGlobalCaches,
} from '../../../services/localDb';

/**
 * authStore.ts
 * ------------------------------------------------------------------
 * Auth state + its persistence. The persisted snapshot is a CACHE of the
 * session (so a reload does not flash an empty shell); it is never proof of
 * anything. Proof comes from the server: `services/authFlow.ts` validates the
 * persisted token on every cold load before `isInitialized` turns true, and
 * `shared/api/http.ts` ends the session whenever the server rejects it.
 */

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  /** True once startup session validation has settled (see authFlow.ts). */
  isInitialized: boolean;
  isOfflineMode: boolean;
  login: (user: User, token?: string, isOffline?: boolean) => void;
  logout: () => void;
  /** Replace the cached profile with the server's authoritative one. */
  setUser: (user: User) => void;
  setInitialized: (val: boolean) => void;
  setOfflineMode: (val: boolean) => void;
}

/**
 * Hydration signal.
 * ------------------------------------------------------------------
 * `persist` restores the snapshot asynchronously (a promise around the
 * storage read), so components must not decide "am I logged in?" before it
 * lands. `onRehydrateStorage` fires on the SUCCESS and the FAILURE path of
 * that read, which makes this promise always settle - a broken/locked
 * localStorage can therefore never strand the app on the startup gate.
 */
let markHydrationSettled: () => void = () => undefined;
export const authHydrationSettled: Promise<void> = new Promise<void>(resolve => {
  markHydrationSettled = resolve;
});

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isInitialized: false,
      isOfflineMode: false,
      login: (user, token, isOffline = false) => {
        localStorage.setItem('leadflow_last_activity', Date.now().toString());
        set({ user, token: token || null, isAuthenticated: true, isInitialized: true, isOfflineMode: isOffline });
      },
      logout: () => {
        // Capture the signing-out user FIRST: their browser caches must
        // be deleted while their identity is still resolvable.
        const signingOutUser = useAuthStore.getState().user;
        localStorage.removeItem('leadflow-auth');
        localStorage.removeItem('leadflow_last_activity');
        // Session-scoped data (roles, notifications, permission sheet)
        // belongs to the user being logged out: nothing may be carried
        // into the next session.
        clearSessionCache();
        // In-flight read coalescing belongs to the session too: a request
        // started for the signed-out user must not be joined by the next one.
        clearCoalescing();
        // First-dashboard sequencing must restart for the next login.
        resetStartupPriority();
        // Per-user localStorage business caches (leads, users,
        // notifications) belong to the signing-out user: delete them so
        // the next account on this browser can never fall back to this
        // user's previously visible data. Also sweep the pre-hardening
        // unscoped global keys one last time.
        clearUserCaches(signingOutUser?.id);
        clearLegacyGlobalCaches();
        // `isInitialized` is deliberately preserved: logging out is a settled
        // state, and re-running validation after a logout is how a page ends
        // up in a redirect loop.
        set({ user: null, token: null, isAuthenticated: false, isOfflineMode: false });
      },
      setUser: (user) => set({ user }),
      setInitialized: (val) => set({ isInitialized: val }),
      setOfflineMode: (val) => set({ isOfflineMode: val }),
    }),
    {
      name: 'leadflow-auth',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
        isOfflineMode: state.isOfflineMode,
      }),
      onRehydrateStorage: () => () => {
        markHydrationSettled();
      },
    }
  )
);

/**
 * localDb business-data caches are keyed per authenticated user. The
 * provider is registered here (one-way dependency: authStore ->
 * localDb) so every cache read/write resolves the CURRENT user's scope;
 * when logged out the scope is null and business data is neither read
 * nor persisted.
 */
setLocalDbUserIdProvider(() => useAuthStore.getState().user?.id ?? null);
