import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { adminService } from '../../admin/services/adminService';
import { readSessionCache, writeSessionCache } from '../../shared/api/sessionCache';
import { ROLES_CACHE_CHANGED_EVENT } from '../../shared/utils/localCacheEvents';
import type { RolePermission } from '../../shared/types';
import {
  DASHBOARD_HOME_PATH,
  WORKBENCH_HOME_PATH,
  resolveHomePath,
} from '../../../layouts/featureRouteAccess';
import { consumeHomeLanding, hasConsumedHomeLanding } from '../services/homeLanding';

/**
 * HomeLanding.tsx
 * ------------------------------------------------------------------
 * The root route's landing decision (Phase 2 — Workbench-first).
 *
 * `/` is both the post-login destination (activateSession navigates
 * here, as it always has) and the sidebar Home item's target, i.e. the
 * Dashboard. Those two jobs conflict once the Workbench becomes the
 * day-start page, so this wrapper separates them by TIME, once per
 * auth session (see services/homeLanding.ts for the marker lifetime):
 *
 *   first arrival this session -> decide via `resolveHomePath`:
 *       Workbench access  -> redirect to /workbench
 *       no Workbench access -> render the Dashboard (children)
 *   every later arrival        -> render the Dashboard (children), so
 *       Home stays fully reachable from navigation, unchanged.
 *
 * The role matrix is loaded EXACTLY like FeatureGate does (same
 * session cache key `roles:<userId>`, same coalesced GET /api/roles,
 * same roles-cache-changed event), and the decision waits for that
 * load to settle instead of guessing: deciding on the static fallback
 * while an admin-configured `menuAccess['/workbench'] = false` was
 * still in flight would land a restricted role on a page its gate is
 * about to deny. When the fetch fails, the settled decision falls back
 * to the static model, mirroring FeatureGate's failure semantics.
 *
 * Denied-route fallbacks stay safe: FeatureGate redirects denied pages
 * to `/`, where the (already consumed) landing renders the Dashboard —
 * no redirect loop is possible, because this component redirects only
 * on the session's first arrival and only to a route the same access
 * model just granted.
 */

/** Identical matcher to FeatureGate's (role id, case-insensitive). */
function matchRole(roles: RolePermission[], user: { role?: string; id: string } | null): RolePermission | undefined {
  if (!user) return undefined;
  const role = String(user.role || '');
  const normalized = role.toUpperCase();
  return roles.find(rp => rp.roleId === role || rp.roleId === normalized);
}

/** Neutral, shell-preserving placeholder (same markup as FeatureGate's). */
function AccessResolving() {
  return (
    <div className="space-y-4" role="status" aria-label="Checking access">
      <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
      <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
    </div>
  );
}

export default function HomeLanding({ children }: { children: React.ReactNode }) {
  const user = useAuthStore(state => state.user);
  const userId = user?.id;
  // The marker is read during render from the session cache: once the
  // decision has been consumed, Home is just the Dashboard again — no
  // role load, no placeholder, no redirect.
  const alreadyLanded = userId ? hasConsumedHomeLanding(userId) : false;

  const [roles, setRoles] = useState<RolePermission[]>(() => {
    if (!userId || alreadyLanded) return [];
    return readSessionCache<RolePermission[]>(`roles:${userId}`)?.value ?? [];
  });
  const [settled, setSettled] = useState(() =>
    Boolean(!userId || alreadyLanded || readSessionCache<RolePermission[]>(`roles:${userId}`))
  );
  const [decision, setDecision] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || alreadyLanded) return;
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
        // Network/5xx: keep whatever is on screen; once the attempt
        // settles, the static fallback decides, exactly as FeatureGate.
      } finally {
        if (!cancelled) setSettled(true);
      }
    };

    if (!cached) void load();
    window.addEventListener(ROLES_CACHE_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(ROLES_CACHE_CHANGED_EVENT, load);
    };
  }, [userId, alreadyLanded]);

  useEffect(() => {
    if (decision !== null || !settled || !user || !userId || alreadyLanded) return;
    const home = resolveHomePath(user.role, matchRole(roles, user));
    // Consume BEFORE navigating/rendering so any bounce back to `/`
    // (e.g. a FeatureGate denial elsewhere) renders the Dashboard
    // instead of deciding again.
    consumeHomeLanding(userId);
    setDecision(home);
  }, [decision, settled, roles, user, userId, alreadyLanded]);

  if (!user || !userId || alreadyLanded) {
    // No user cannot happen above ProtectedRoute; falling through to
    // the Dashboard keeps this wrapper invisible in that case.
    return <>{children}</>;
  }
  if (decision === WORKBENCH_HOME_PATH) {
    return <Navigate to={WORKBENCH_HOME_PATH} replace />;
  }
  if (decision === DASHBOARD_HOME_PATH) {
    return <>{children}</>;
  }
  // Undecided (role matrix still in flight) or decided-but-not-yet
  // committed: one neutral frame instead of a guessed page.
  return <AccessResolving />;
}
