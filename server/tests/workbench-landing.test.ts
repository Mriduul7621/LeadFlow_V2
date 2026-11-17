/**
 * workbench-landing.test.ts
 * ------------------------------------------------------------------
 * Phase 2 PR #3 — Workbench-first landing, RETIRED by the
 * role-workspace redesign (2026-11-17): after login (and on the
 * session's first arrival at the root), a caller now lands on their
 * ROLE home rendered in place at `/` — the member home (My Work)
 * for members, the Team Lead / Manager home for callers who see a
 * team. The Workbench is a sidebar page (Follow-up Queue), not a
 * landing. The landing fires ONCE per auth session, after which `/`
 * renders the member home as before (except a TL+ user who pinned
 * the Team view).
 *
 * What survives from the PR #3 contract:
 *   - Post-login navigation is still `activateSession -> navigate('/')`
 *     for every role (auth-flow-integration E1/E2/F1/F2 pin that exact
 *     contract), so the landing decision lives at the ROOT.
 *   - `/` renders a home in place (no redirect exists); the sidebar
 *     home item targets `/`, so a blind redirector at `/` would have
 *     made the member home unreachable from navigation.
 *   - resolveHomePath (the pure per-role decision) still exists and
 *     its contract is unchanged — the landing simply no longer
 *     consumes it, because the member home is always `/` now.
 *   - NO return-URL / `next` mechanism exists anywhere in the app:
 *     ProtectedRoute redirects the unauthenticated to `/login` with no
 *     location state, and Login never reads one.
 *
 * Sections:
 *   1. resolveHomePath — the pure landing decision per role class
 *      (kept: the function still exists, uncalled by the landing).
 *   2. homeLanding marker — once-per-session lifecycle.
 *   3. HomeLanding rendering (renderToStaticMarkup, repo style).
 *   4. Source guards — wiring (root wraps MemberHome in HomeLanding,
 *      activateSession re-arms + still navigates to `/`), and the
 *      unchanged surroundings (Workbench route, FeatureGate fallback,
 *      unauthenticated -> /login, no return-URL mechanism).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
import { useAuthStore } from '../../src/modules/auth/store/authStore';
import HomeLanding from '../../src/modules/auth/components/HomeLanding';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** A RolePermission fixture carrying only a menuAccess map. */
const withMenu = (menuAccess: Record<string, boolean>) => ({ menuAccess }) as any;

/* ================================================================ */
/* 1. resolveHomePath — the pure decision                            */
/* ================================================================ */

describe('resolveHomePath — Workbench-first landing decision', () => {
  // NOTE (2026-11-17): the landing no longer consumes this resolver —
  // the member home is always `/` now. The pure function and its
  // contract survive (the Workbench route gate still uses the same
  // Layer B decision), so these pins stay as the function's contract.
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
/* 3. HomeLanding rendering                                          */
/* ================================================================ */

describe('HomeLanding — rendering outcomes', () => {
  beforeEach(() => {
    resetSessionCacheForTests();
    useAuthStore.setState({ user: null, token: null, isAuthenticated: false, isInitialized: true });
  });

  // Rendering note (same constraint FeatureGate's tests live with):
  // zustand's SSR snapshot is the store's INITIAL state, so a static
  // render always sees the logged-out store — the interactive outcomes
  // (placeholder while the overview loads, role home on a team
  // decision, children once consumed) are therefore pinned by the pure
  // decision tests (section 1), the marker lifecycle (section 2) and
  // the source guards (section 4), exactly how this suite covers
  // FeatureGate. What SSR CAN prove is the defensive fall-through:
  it('falls through to the member home when there is no user (unreachable above ProtectedRoute)', () => {
    const html = renderToStaticMarkup(
      React.createElement(HomeLanding, null, React.createElement('div', null, 'MEMBER_HOME_BODY'))
    );
    assert.ok(html.includes('MEMBER_HOME_BODY'), 'no user -> children render verbatim');
    assert.ok(!html.includes('Checking access'), 'no placeholder on the fall-through');
  });
});

/* ================================================================ */
/* 4. Source guards — wiring and unchanged surroundings              */
/* ================================================================ */

describe('workbench landing — source guards', () => {
  it('the root route wraps the member home in HomeLanding; the Workbench route is unchanged', () => {
    const app = read('src/App.tsx');
    assert.ok(
      app.includes('<HomeLanding><LazyPage page={<MemberHome />} /></HomeLanding>'),
      'root route must apply the landing decision around the unchanged member-home element'
    );
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

  it('FeatureGate denial still falls back to the root (no loop: the landing is consumed by then)', () => {
    const gate = read('src/modules/auth/components/FeatureGate.tsx');
    assert.ok(gate.includes('Navigate to="/" replace'), 'denied routes still redirect to /');
    const landing = read('src/modules/auth/components/HomeLanding.tsx');
    assert.ok(landing.includes('consumeHomeLanding(userId)'), 'the decision is consumed before rendering');
    assert.ok(landing.includes('resolveHomeLandingDecision({'), 'the component decides through the pure TL+ resolver');
    assert.ok(!landing.includes('resolveHomePath('), 'the Workbench-first resolver is retired from the landing');
  });

  it('HomeLanding waits for the team overview, then renders the role home in place — never a redirect', () => {
    const landing = read('src/modules/auth/components/HomeLanding.tsx');
    assert.ok(landing.includes('hasConsumedHomeLanding(userId)'), 'consumed sessions skip the decision entirely');
    assert.ok(landing.includes('<AccessResolving />'), 'undecided sessions show the neutral placeholder, not a guessed page');
    assert.ok(landing.includes('loadTeamOverview(userId)'), 'the decision waits on the team overview, not the role matrix');
    assert.ok(!landing.includes('adminService.getRoles()'), 'no role-matrix load in the landing any more');
    assert.ok(
      landing.includes('decision === TEAM_HOME_PATH') && landing.includes('<RoleHomePage role={teamRole} />'),
      'a team decision renders the role home in place at /'
    );
    assert.ok(landing.includes('decision === DASHBOARD_HOME_PATH'), 'a member decision renders the children in place');
    assert.ok(!landing.includes('<Navigate'), 'the landing never redirects — the Workbench-first redirect is retired');
    assert.ok(!landing.includes('WORKBENCH_HOME_PATH'), 'no workbench landing target remains');
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
