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
 * Sections:
 *   1. resolveHomePath — the pure landing decision per role class.
 *   2. homeLanding marker — once-per-session lifecycle.
 *   3. HomeLanding rendering (renderToStaticMarkup, repo style).
 *   4. Source guards — wiring (root wraps Dashboard in HomeLanding,
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
  // (placeholder while the matrix loads, Navigate on a Workbench
  // decision, children once consumed) are therefore pinned by the pure
  // decision tests (section 1), the marker lifecycle (section 2) and
  // the source guards (section 4), exactly how this suite covers
  // FeatureGate. What SSR CAN prove is the defensive fall-through:
  it('falls through to the Dashboard when there is no user (unreachable above ProtectedRoute)', () => {
    const html = renderToStaticMarkup(
      React.createElement(HomeLanding, null, React.createElement('div', null, 'DASHBOARD_BODY'))
    );
    assert.ok(html.includes('DASHBOARD_BODY'), 'no user -> children render verbatim');
    assert.ok(!html.includes('Checking access'), 'no placeholder on the fall-through');
  });
});

/* ================================================================ */
/* 4. Source guards — wiring and unchanged surroundings              */
/* ================================================================ */

describe('workbench landing — source guards', () => {
  it('the root route wraps the Dashboard in HomeLanding; the Workbench route is unchanged', () => {
    const app = read('src/App.tsx');
    assert.ok(
      app.includes('<HomeLanding><LazyPage page={<Dashboard />} /></HomeLanding>'),
      'root route must apply the landing decision around the unchanged Dashboard element'
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
    assert.ok(landing.includes('consumeHomeLanding(userId)'), 'the decision is consumed before navigating');
    assert.ok(landing.includes('resolveHomePath('), 'the component decides through the pure resolver');
  });

  it('HomeLanding waits for the role matrix, then redirects only on a Workbench decision', () => {
    const landing = read('src/modules/auth/components/HomeLanding.tsx');
    assert.ok(landing.includes('hasConsumedHomeLanding(userId)'), 'consumed sessions skip the decision entirely');
    assert.ok(landing.includes('<AccessResolving />'), 'undecided sessions show the neutral placeholder, not a guessed page');
    assert.ok(
      landing.includes('decision === WORKBENCH_HOME_PATH') && landing.includes('<Navigate to={WORKBENCH_HOME_PATH} replace />'),
      'only a Workbench decision redirects, and only to /workbench'
    );
    assert.ok(landing.includes('decision === DASHBOARD_HOME_PATH'), 'a Dashboard decision renders the children in place');
    assert.ok(landing.includes('adminService.getRoles()'), 'the role matrix comes from the same source FeatureGate uses');
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
