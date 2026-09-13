import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { adminService } from '../../admin/services/adminService';
import { readSessionCache, writeSessionCache } from '../../shared/api/sessionCache';
import { ROLES_CACHE_CHANGED_EVENT } from '../../shared/utils/localCacheEvents';
import type { RolePermission } from '../../shared/types';
import { resolveFeatureRouteAccess } from '../../../layouts/featureRouteAccess';

/**
 * FeatureGate.tsx
 * ------------------------------------------------------------------
 * Route-level Feature Access (Layer B) gate. Wraps every page route in
 * App.tsx and applies the SAME decision the sidebar applies
 * (`resolveFeatureRouteAccess` = `resolveMenuVisibility` + static
 * fallback), so a disabled module cannot be reached by typing the URL.
 *
 * Data source (identical to AppLayout's sidebar):
 *   - the session-scoped role cache under `roles:<userId>` (written by
 *     AppLayout / adminService, shared by coalesced GET /api/roles),
 *   - refreshed on the same-tab roles-cache-changed event so an admin
 *     save takes effect on the next render without a reload.
 *
 * Before dynamic role data has loaded, the static role fallback applies
 * (sidebar parity) — e.g. /leads/upload stays closed to non-admins.
 *
 * This is a visibility gate, not a security boundary: the server keeps
 * enforcing canonical Action Permissions and Data Visibility on every
 * API call regardless of what any page renders.
 */

function matchRole(roles: RolePermission[], user: { role?: string; id: string } | null): RolePermission | undefined {
  if (!user) return undefined;
  const role = String(user.role || '');
  const normalized = role.toUpperCase();
  return roles.find(rp => rp.roleId === role || rp.roleId === normalized);
}

export default function FeatureGate({ route, children }: { route: string; children: React.ReactNode }) {
  const user = useAuthState();
  const [roles, setRoles] = useState<RolePermission[]>([]);
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const cacheKey = `roles:${userId}`;

    const cached = readSessionCache<RolePermission[]>(cacheKey);
    if (cached) {
      setRoles(cached.value);
    }

    const load = async () => {
      try {
        const rp = await adminService.getRoles();
        if (cancelled) return;
        writeSessionCache(cacheKey, rp);
        setRoles(rp);
      } catch {
        // Network/5xx: keep whatever is on screen; the static fallback
        // already applied, and the sidebar shows the same data.
      }
    };

    if (!cached) void load();
    window.addEventListener(ROLES_CACHE_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(ROLES_CACHE_CHANGED_EVENT, load);
    };
  }, [userId]);

  if (!user) {
    // ProtectedRoute guarantees an authenticated user above this gate;
    // anything else falls through to the login redirect via that gate.
    return <Navigate to="/login" replace />;
  }

  if (!resolveFeatureRouteAccess(route, user.role, matchRole(roles, user))) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

/** Indirection so the component body stays a pure render (testable). */
function useAuthState() {
  return useAuthStore(state => state.user);
}
