import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { adminService } from '../../admin/services/adminService';
import { readSessionCache, writeSessionCache } from '../../shared/api/sessionCache';
import { ROLES_CACHE_CHANGED_EVENT } from '../../shared/utils/localCacheEvents';
import type { RolePermission } from '../../shared/types';
import {
  canResolveRouteAccess,
  resolveFeatureRouteAccess,
} from '../../../layouts/featureRouteAccess';

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
 * Three outcomes, not two:
 *   granted -> render the page
 *   denied  -> redirect to the dashboard (unchanged)
 *   pending -> the role matrix has not arrived yet, so the static
 *              fallback would be a GUESS for a role that only its own
 *              menuAccess row can authorize. Rendering a neutral
 *              placeholder (instead of redirecting) is what makes a
 *              direct URL / hard reload work: the cold-load bounce to
 *              Home came from deciding on that guess. Admin, unknown
 *              routes and ANY_ROLE routes never wait.
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

/** Neutral, shell-preserving placeholder shown only while access is undecided. */
function AccessResolving() {
  return (
    <div className="space-y-4" role="status" aria-label="Checking access">
      <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
      <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
    </div>
  );
}

export default function FeatureGate({ route, children }: { route: string; children: React.ReactNode }) {
  const user = useAuthState();
  const userId = user?.id;
  // Seed from the session cache synchronously: an in-session navigation
  // (and a reload in a tab that already fetched the matrix) decides on the
  // first paint, with no placeholder frame.
  const [roles, setRoles] = useState<RolePermission[]>(() => {
    if (!userId) return [];
    return readSessionCache<RolePermission[]>(`roles:${userId}`)?.value ?? [];
  });
  const [settled, setSettled] = useState(() =>
    Boolean(userId && readSessionCache<RolePermission[]>(`roles:${userId}`))
  );

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const cacheKey = `roles:${userId}`;

    const cached = readSessionCache<RolePermission[]>(cacheKey);
    if (cached) {
      setRoles(cached.value);
      // A cache hit is a real answer — no need to wait for the network.
      setSettled(true);
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
      } finally {
        // The attempt finished: an empty answer is still an answer (the
        // static fallback then applies, exactly as before this change).
        if (!cancelled) setSettled(true);
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

  const matched = matchRole(roles, user);

  if (!canResolveRouteAccess(route, user.role, matched)) {
    // Nothing to decide on yet — wait, do NOT redirect. `settled` marks a
    // finished fetch attempt, so this can never hang: once the attempt
    // resolves (success or failure) the decision below runs.
    if (!settled) return <AccessResolving />;
  }

  if (!resolveFeatureRouteAccess(route, user.role, matched)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

/** Indirection so the component body stays a pure render (testable). */
function useAuthState() {
  return useAuthStore(state => state.user);
}
