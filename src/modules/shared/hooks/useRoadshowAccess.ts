import { usePermissions } from './usePermissions';
import { hasMenuAccessFor } from '../../../layouts/menuVisibility';

/**
 * useRoadshowAccess.ts
 * ------------------------------------------------------------------
 * ONE predicate for "may this user see roadshow alerts?", shared by Home
 * (Today & Tomorrow) and My Work.
 *
 * Why a shared hook: the two pages previously asked the same question
 * through different paths and disagreed on screen — My Work showed
 * "Roadshows today 1" while Home rendered no roadshow row at all for the
 * same signed-in employee, because one view had the role matrix in hand
 * and the other was still on the static fallback (the "/roadshows" menu
 * entry was granted, while the feature-matrix copy of the same
 * capability had not loaded yet).
 *
 * The capability has two legitimate sources in this codebase:
 *   1. the canonical feature matrix — `canAccess('roadshow_follow_up')`
 *      (server permission sheet -> role feature permissions), and
 *   2. the role's menu grant for the "/roadshows" page (Layer B), which
 *      the Roles & Access editor writes.
 *
 * They describe the same business capability, so the row is shown when
 * EITHER says yes; the server still decides whether any data comes back
 * (a denied read hides the row again — the callers treat `null` counts as
 * "hide", never as a fabricated 0).
 */
export function useRoadshowAccess(): boolean {
  const { canAccess, roles, user } = usePermissions();
  const capability = canAccess('roadshow_follow_up', 'view');
  const menuGrant = hasMenuAccessFor(roles, user?.role, '/roadshows');
  return capability || menuGrant;
}
