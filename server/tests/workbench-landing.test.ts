/**
 * workbench-landing.test.ts
 * ------------------------------------------------------------------
 * Phase 2 PR #3 — Workbench-first landing: after login (and on the
 * session's first arrival at the root), a user whose role has Workbench
 * access starts the day on the Daily Workbench (`/workbench`), not the
 * Dashboard. The Dashboard page itself, its route and the sidebar Home
 * item are unchanged; the landing fires ONCE per auth session, after
 * which `/` renders the Dashboard as before.
 *
 * Recon facts these tests encode (verified against the pre-PR tree):
 *   - Post-login navigation was `activateSession -> navigate('/')` for
 *     every role (auth-flow-integration E1/E2/F1/F2 pin that exact
 *     contract), so the landing decision lives at the ROOT, not in a
 *     changed navigate target.
 *   - `/` itself rendered Dashboard in place (no redirect existed);
 *     the sidebar "Home" item targets `/`, so a blind redirector at
 *     `/` would have made the Dashboard unreachable from navigation.
 *   - Workbench access is the app's Layer B decision for `/workbench`:
 *     ANY_ROLE static fallback (sidebar "My Work" agrees), ADMIN /
 *     SUPERADMIN bypass, and an explicit dynamic
 *     `menuAccess['/workbench'] = false` as the ONLY way a role loses
 *     it. Database/custom codes (MANAGER, TEAM_LEAD, EMPLOYEE, SBE,
 *     SM, CEO) therefore land on the Workbench like everyone else.
 *   - NO return-URL / `next` mechanism exists anywhere in the app:
 *     ProtectedRoute redirects the unauthenticated to `/login` with no
 *     location state, and Login never reads one. There is therefore no
 *     explicit target for the default landing to override — the guards
 *     in section 4 pin that this PR did not change that either.
 *
 * Enterprise Preview (2026-11-19): HomeLanding.tsx is deleted and `/`
 * renders EnterpriseHome directly — no landing redirect, no
 * Workbench-first bounce. The pure decision (resolveHomePath, section 1)
 * and the marker service (section 2) survive untouched as contracts;
 * the HomeLanding rendering section is deleted with the component, and
 * the source guards (section 4) now pin the EnterpriseHome root.
 *
 * Sections:
 *   1. resolveHomePath — the pure landing decision per role class.
 *   2. homeLanding marker — once-per-session lifecycle.
 *   3. (deleted with HomeLanding.tsx — the component no longer exists)
 *   4. Source guards — wiring (root renders EnterpriseHome directly,
 *      activateSession re-arms + still navigates to `/`), and the
 *      unchanged surroundings (Workbench route, FeatureGate fallback,
 *      unauthenticated -> /login, no return-URL mechanism).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DASHBOARD_HOME_PATH,
  WORKBENCH_HOME_PATH,
  resolveFeatureRouteAccess,
  resolveHomePath,
} from '../../src/layouts/featureRouteAccess';
import {
  consumeHomeLanding,
  hasConsumedHomeLanding,
  homeLandingKey,
  resetHomeLanding,
} from '../../src/modules/auth/services/homeLanding';
import { resetSessionCacheForTests } from '../../src/modules/shared/api/sessionCache';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** A RolePermission fixture carrying only a menuAccess map. */
const withMenu = (menuAccess: Record<string, boolean>) => ({ menuAccess }) as any;

/* ================================================================ */
/* 1. resolveHomePath — the pure decision                            */
/* ================================================================ */

describe('resolveHomePath — Workbench-first landing decision', () => {
  it('field roles land on the Workbench (no role matrix loaded)', () => {
    for (const role of ['RO', 'RM', 'ASM', 'BDM', 'BE', 'BH']) {
      assert.equal(resolveHomePath(role, undefined), WORKBENCH_HOME_PATH, `${role} -> workbench`);
    }
  });

  it('ADMIN and SUPERADMIN land on the Workbench (established bypass)', () => {
    assert.equal(resolveHomePath('ADMIN', undefined), WORKBENCH_HOME_PATH);
    assert.equal(resolveHomePath('SUPERADMIN', undefined), WORKBENCH_HOME_PATH);
    // The admin bypass beats even an explicit menuAccess hide.
    assert.equal(resolveHomePath('ADMIN', withMenu({ '/workbench': false })), WORKBENCH_HOME_PATH);
  });

  it('database / custom role codes land on the Workbench (ANY_ROLE fallback)', () => {
    for (const role of ['MANAGER', 'TEAM_LEAD', 'EMPLOYEE', 'SBE', 'SM', 'CEO']) {
      assert.equal(resolveHomePath(role, undefined), WORKBENCH_HOME_PATH, `${role} -> workbench`);
    }
  });

  it('a role whose admin explicitly hid /workbench stays on the Dashboard', () => {
    for (const role of ['RO', 'RM', 'EMPLOYEE']) {
      assert.equal(
        resolveHomePath(role, withMenu({ '/workbench': false })),
        DASHBOARD_HOME_PATH,
        `${role} with menuAccess[/workbench]=false -> dashboard`
      );
    }
  });

  it('an explicit menuAccess grant also lands on the Workbench; unrelated hides do not leak', () => {
    assert.equal(resolveHomePath('RO', withMenu({ '/workbench': true })), WORKBENCH_HOME_PATH);
    assert.equal(
      resolveHomePath('RO', withMenu({ '/team': false, '/users': false })),
      WORKBENCH_HOME_PATH,
      'hiding other modules must not change the landing'
    );
  });

  it('no role fails closed to the historical Dashboard default', () => {
    assert.equal(resolveHomePath(null, undefined), DASHBOARD_HOME_PATH);
    assert.equal(resolveHomePath(undefined, undefined), DASHBOARD_HOME_PATH);
    assert.equal(resolveHomePath('', undefined), DASHBOARD_HOME_PATH);
    // The decision is exactly the Layer B gate for the route — they
    // can never disagree (this is what keeps the landing off a page
    // the user cannot open).
    assert.equal(resolveFeatureRouteAccess('/workbench', null, undefined), false);
    assert.equal(resolveFeatureRouteAccess('/workbench', 'RO', undefined), true);
  });
});

/* ================================================================ */
/* 2. homeLanding marker — once per auth session                     */
/* ================================================================ */

describe('homeLanding marker — once-per-session lifecycle', () => {
  beforeEach(() => resetSessionCacheForTests());

  it('starts unconsumed, consumes once, and resets for a fresh login', () => {
    assert.equal(hasConsumedHomeLanding('user-1'), false);
    consumeHomeLanding('user-1');
    assert.equal(hasConsumedHomeLanding('user-1'), true);
    resetHomeLanding('user-1');
    assert.equal(hasConsumedHomeLanding('user-1'), false, 'fresh login re-arms the landing');
  });

  it('is keyed per user — one user landing never consumes another\'s', () => {
    consumeHomeLanding('user-1');
    assert.equal(hasConsumedHomeLanding('user-2'), false);
    assert.notEqual(homeLandingKey('user-1'), homeLandingKey('user-2'));
  });
});

/* ================================================================ */
/* 3. (deleted — HomeLanding.tsx no longer exists)                   */
/* ================================================================ */

// The HomeLanding rendering section died with the component
// (Enterprise Preview 2026-11-19): `/` renders EnterpriseHome
// directly, so there is no wrapper left to render. The pure decision
// (section 1) and the marker lifecycle (section 2) still pin the
// surviving contracts, and section 4 pins the new root wiring.

/* ================================================================ */
/* 4. Source guards — wiring and unchanged surroundings              */
/* ================================================================ */

describe('workbench landing — source guards', () => {
  it('the root route renders EnterpriseHome directly; the Workbench route is unchanged', () => {
    const app = read('src/App.tsx');
    assert.ok(
      app.includes('<LazyPage page={<EnterpriseHome />} />'),
      'root route must render the Enterprise home directly (no HomeLanding wrapper)'
    );
    assert.ok(!app.includes('HomeLanding'), 'the deleted landing wrapper must not be referenced by the router');
    assert.ok(
      app.includes('path: \'/workbench\'') && app.includes('<LazyPage page={<DailyWorkbench />} />'),
      'the /workbench route still renders DailyWorkbench'
    );
    assert.ok(app.includes("path: '*',"), 'the catch-all still funnels to the root decision');
  });

  it('activateSession re-arms the landing and STILL navigates to / (the E1 contract)', () => {
    const flow = read('src/modules/auth/services/authFlow.ts');
    assert.ok(flow.includes('resetHomeLanding(session.user.id)'), 'a fresh login re-arms the landing');
    assert.ok(flow.includes("ctx.navigate('/')"), 'post-login navigation target is unchanged — the root decides');
    assert.ok(!flow.includes("navigate('/workbench')"), 'authFlow must not hard-code the landing page');
  });

  it('FeatureGate denial still falls back to the root (no loop: the root renders a home, never a redirect)', () => {
    const gate = read('src/modules/auth/components/FeatureGate.tsx');
    assert.ok(gate.includes('Navigate to="/" replace'), 'denied routes still redirect to /');
    // The old no-loop argument (the landing consumed its decision
    // before navigating) died with HomeLanding.tsx. The new one is
    // structural: the root renders EnterpriseHome in place, so a
    // fallback to / can never bounce anywhere.
    const app = read('src/App.tsx');
    assert.ok(app.includes('<LazyPage page={<EnterpriseHome />} />'), 'the root renders the Enterprise home directly');
    const home = read('src/modules/workspace/pages/EnterpriseHome.tsx');
    assert.ok(!home.includes('<Navigate'), 'the home never redirects — the role overview IS the landing page');
  });

  it('useEnterpriseRole waits for the overview, then derives the home from the role matrix + team fact', () => {
    // Retargeted from the deleted HomeLanding component: the "wait
    // for the matrix, then decide" invariant now lives in the hook
    // that derives the enterprise role.
    const hook = read('src/layouts/useEnterpriseRole.ts');
    assert.ok(hook.includes('callerTeam.loading'), 'the home waits for the overview before deciding');
    assert.ok(/adminService\s*\.\s*getRoles\(\)/.test(hook), 'the role matrix comes from the same source FeatureGate uses');
    assert.ok(hook.includes('deriveEnterpriseRole({'), 'the home decision goes through the pure role derivation');
    assert.ok(hook.includes('callerHasTeam(callerTeam.overview?.people)'), 'the team fact comes from the shared overview loader');
    const home = read('src/modules/workspace/pages/EnterpriseHome.tsx');
    assert.ok(home.includes('HomeSkeleton'), 'an undecided home shows a neutral skeleton, not a guessed page');
  });

  it('unauthenticated users still go to /login, and no return-URL mechanism exists to override the default', () => {
    const gate = read('src/modules/auth/components/ProtectedRoute.tsx');
    assert.ok(gate.includes('Navigate to="/login" replace'), 'unauthenticated -> /login (unchanged)');
    assert.ok(!gate.includes('location.state') && !gate.includes('returnUrl'),
      'ProtectedRoute fabricates no return path (none existed before this PR)');
    const login = read('src/modules/auth/pages/Login.tsx');
    assert.ok(!login.includes('returnUrl') && !login.includes('searchParams'),
      'Login reads no return/next parameter (none existed before this PR)');
  });
});
