import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import AppLayout from '../../../layouts/AppLayout';

/**
 * ProtectedRoute.tsx
 * ------------------------------------------------------------------
 * The gate in front of every authenticated route. Its only job is to make
 * the startup sequence deterministic:
 *
 *   initializing    -> neutral loading screen (NOT a redirect to /login)
 *   unauthenticated -> /login
 *   granted         -> the app
 *
 * `isInitialized` only turns true after authFlow has hydrated the persisted
 * snapshot and (when a token exists) had the server confirm or reject it.
 * Redirecting before that is exactly what made logged-in users land back on
 * /login: the router evaluated `isAuthenticated` while it was still `false`.
 */

export type ProtectedAccess = 'initializing' | 'unauthenticated' | 'granted';

export interface AuthGateState {
  isInitialized: boolean;
  isAuthenticated: boolean;
}

/** Pure decision, so the ordering rule is directly testable. */
export function resolveProtectedAccess(state: AuthGateState): ProtectedAccess {
  if (!state.isInitialized) return 'initializing';
  return state.isAuthenticated ? 'granted' : 'unauthenticated';
}

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isInitialized = useAuthStore(state => state.isInitialized);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);

  const access = resolveProtectedAccess({ isInitialized, isAuthenticated });

  if (access === 'initializing') {
    return (
      <div
        data-testid="auth-initializing"
        className="min-h-screen bg-white flex items-center justify-center"
      >
        <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
      </div>
    );
  }

  if (access === 'unauthenticated') return <Navigate to="/login" replace />;

  return <AppLayout>{children}</AppLayout>;
}
