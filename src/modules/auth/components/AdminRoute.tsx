import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

/**
 * AdminRoute.tsx
 * ------------------------------------------------------------------
 * Route gate for the TEMPORARY admin-only Performance Diagnostics page
 * (/settings/performance-diagnostics). Pure role check against the
 * server-confirmed session user — it introduces NO new permission
 * system and NO new server endpoint (the diagnostics are client-side
 * timing metadata collected from already-authenticated requests).
 *
 * Layering for this route:
 *   1. ProtectedRoute   — existing session gate (unchanged).
 *   2. AdminRoute       — ADMIN/SUPERADMIN only; anyone else is
 *                         redirected to /settings.
 *   3. Sidebar entry    — hidden for non-admin roles (AppLayout).
 *   4. The page itself  — re-checks the role before rendering.
 *
 * The pure decision is exported so the access rule stays directly
 * testable (same pattern as ProtectedRoute.resolveProtectedAccess).
 */

export type AdminAccess = 'granted' | 'denied';

/** ADMIN/SUPERADMIN are the only roles allowed to open diagnostics. */
export function isAdminRole(role: string | undefined | null): boolean {
  const normalized = String(role ?? '').trim().toUpperCase();
  return normalized === 'ADMIN' || normalized === 'SUPERADMIN';
}

/** Pure decision, so the gate rule is directly testable. */
export function resolveAdminAccess(role: string | undefined | null): AdminAccess {
  return isAdminRole(role) ? 'granted' : 'denied';
}

export default function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(state => state.user);

  if (resolveAdminAccess(user?.role) === 'denied') {
    return <Navigate to="/settings" replace />;
  }

  return <>{children}</>;
}
