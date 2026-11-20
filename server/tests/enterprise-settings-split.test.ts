/**
 * enterprise-settings-split.test.ts
 * ------------------------------------------------------------------
 * Fix round 1 (2026-11-19): Mahadi's check found the three Admin
 * CONFIGURATION items — Status & Pipeline, Products & Campaigns,
 * System Settings — all landing on the same /settings/system page,
 * with all three highlighting at once. Each is now its own page
 * with its own route and only its own content:
 *
 *   Status & Pipeline    /settings/status-pipeline  — lead statuses
 *                          (FollowUpStatus) + workflow/pipeline
 *                          configuration
 *   Products & Campaigns /settings/products-campaigns — products +
 *                          campaigns metadata
 *   System Settings      /settings/system           — everything else
 *                          (incl. Danger Zone); the pre-existing
 *                          route, kept so links/bookmarks survive
 *
 * Pinned here: the three nav destinations are distinct, the active
 * state resolves to exactly the clicked item, each variant renders
 * only its own bodies, and both new routes are registered in
 * App.tsx behind the same admin gate as /settings/system.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEnterpriseNavGroups,
  enterpriseActivePath,
  type EnterpriseNavGroup,
} from '../../src/layouts/enterpriseNav';
import { FEATURE_ROUTES } from '../../src/layouts/featureRouteAccess';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const adminGroups = (): EnterpriseNavGroup[] =>
  buildEnterpriseNavGroups({ role: 'admin', canOpen: () => true, canAccess: () => true });

const configItems = () =>
  adminGroups().find(g => g.title === 'CONFIGURATION')!.items;

describe('settings split — three distinct nav destinations', () => {
  it('the three CONFIGURATION items point to three distinct routes', () => {
    const byLabel = new Map(configItems().map(i => [i.label, i.path]));
    assert.equal(byLabel.get('Status & Pipeline'), '/settings/status-pipeline');
    assert.equal(byLabel.get('Products & Campaigns'), '/settings/products-campaigns');
    assert.equal(byLabel.get('System Settings'), '/settings/system');
    assert.equal(new Set(configItems().map(i => i.path)).size, 3);
  });
});

describe('settings split — exactly one active nav item per page', () => {
  for (const route of ['/settings/status-pipeline', '/settings/products-campaigns', '/settings/system']) {
    it(`${route} activates only its own nav item`, () => {
      const groups = adminGroups();
      assert.equal(enterpriseActivePath(groups, route), route);
      // No OTHER item shares the active path (the old bug: all three
      // shared /settings/system, so all three highlighted).
      const matching = groups
        .flatMap(g => g.items)
        .filter(i => i.path === enterpriseActivePath(groups, route));
      assert.equal(matching.length, 1, `exactly one nav item matches ${route}`);
    });
  }

  it('the plain /settings profile page does not hijack a settings sub-route', () => {
    // /settings is a prefix of /settings/system — longest match wins.
    assert.equal(enterpriseActivePath(adminGroups(), '/settings/system'), '/settings/system');
    // Since the TL/Manager/Admin workspace (2026-11-20) /settings is
    // NO LONGER a sidebar item for any role — the profile block gear
    // links there directly (no ACCOUNT group) — so no nav item is
    // active on the profile page. The route itself stays live (see
    // the registration test below).
    assert.equal(enterpriseActivePath(adminGroups(), '/settings'), null);
  });
});

describe('settings split — each variant shows only its own content', () => {
  const settings = read('src/modules/settings/pages/Settings.tsx');

  it('the variant type map pins the filtered metadata types', () => {
    assert.ok(settings.includes("'status-pipeline': ['FollowUpStatus']"));
    assert.ok(settings.includes("'products-campaigns': ['Product', 'Campaign']"));
    assert.ok(!settings.includes("'system':"), 'the system variant is unfiltered — no entry');
  });

  it('Status & Pipeline renders the statuses body AND the workflow body', () => {
    const branch = settings.slice(settings.indexOf("if (variant === 'status-pipeline')"));
    const body = branch.slice(0, branch.indexOf("if (variant === 'products-campaigns')"));
    assert.ok(body.includes("renderDropdownsBody(SETTINGS_VARIANT_DROPDOWN_TYPES['status-pipeline'])"));
    assert.ok(body.includes('renderWorkflowBody()'), 'workflow/pipeline config lives here');
    assert.ok(body.includes('title="Status & Pipeline"'));
  });

  it('Products & Campaigns renders ONLY the dropdowns body — no workflow, no tabs', () => {
    // The branch runs from its `if` to the system variant's return
    // (the next top-level `return (` at 2-space indent — the branch's
    // own return is nested deeper and cannot match the pattern).
    const start = settings.indexOf("if (variant === 'products-campaigns')");
    const end = settings.indexOf(
      '  return (\n    <div className="ep-page">\n      <OverviewHeading',
      start,
    );
    assert.ok(start !== -1 && end > start, 'the products branch and the system return both exist');
    const body = settings.slice(start, end);
    assert.ok(body.includes("renderDropdownsBody(SETTINGS_VARIANT_DROPDOWN_TYPES['products-campaigns'])"));
    assert.ok(!body.includes('renderWorkflowBody()'), 'no workflow config on the products page');
    assert.ok(body.includes('title="Products & Campaigns"'));
  });

  it('the system variant keeps the full page (tab bar + overview sections)', () => {
    const systemIdx = settings.indexOf('title="System Settings"');
    assert.ok(systemIdx !== -1, 'the system page keeps its sample heading');
    // The tab bar renders after the system heading (the filtered
    // variants return before it).
    const after = settings.slice(systemIdx);
    assert.ok(after.includes("setActiveTab('overview')"), 'the system page still switches tabs');
    assert.ok(after.includes('renderWorkflowBody()'), 'the system page still holds the workflow tab');
  });

  it('the dropdowns body filters to the visible types (no cross-variant leak)', () => {
    assert.ok(settings.includes('const renderDropdownsBody = (visibleTypeKeys: string[] | null)'));
    assert.ok(settings.includes('visibleTypeKeys.includes'), 'the grid is filtered to the visible types');
  });
});

describe('settings split — routes registered behind the admin gate', () => {
  it('App.tsx registers both new routes as AdminRoute + FeatureGate', () => {
    const app = read('src/App.tsx');
    for (const [route, variant] of [
      ['/settings/status-pipeline', 'status-pipeline'],
      ['/settings/products-campaigns', 'products-campaigns'],
    ] as const) {
      assert.ok(app.includes(`path: '${route}'`), `App.tsx registers ${route}`);
      assert.ok(
        app.includes(`<Settings variant="${variant}" />`),
        `${route} renders the ${variant} variant`,
      );
      const line = app.split('\n').find(l => l.includes(`route="${route}"`)) ?? '';
      assert.ok(line.includes('AdminRoute'), `${route} is behind AdminRoute`);
    }
  });

  it('/settings stays registered + live by URL even though no sidebar item points to it', () => {
    // The profile-block gear links to /settings directly; the route
    // must stay registered (App.tsx) and open to everyone (Layer B).
    const app = read('src/App.tsx');
    assert.ok(app.includes("path: '/settings'"), 'App.tsx still registers /settings');
    const entry = FEATURE_ROUTES['/settings'];
    assert.ok(entry, '/settings has a Layer B entry');
    assert.deepEqual([...entry.roles], ['*'], 'EVERYONE — the ANY_ROLE sentinel, open to every role');
  });

  it('featureRouteAccess gates both new routes to the admin roles', () => {
    for (const route of ['/settings/status-pipeline', '/settings/products-campaigns']) {
      const entry = FEATURE_ROUTES[route];
      assert.ok(entry, `${route} has a Layer B entry`);
      assert.deepEqual([...entry.roles], ['ADMIN', 'SUPERADMIN']);
      assert.equal(entry.path, '/settings', 'same menuAccess key as /settings/system');
    }
    // The entries use the shared constant, not a retyped list.
    const access = read('src/layouts/featureRouteAccess.ts');
    for (const route of ['/settings/status-pipeline', '/settings/products-campaigns']) {
      const line = access.split('\n').find(l => l.includes(`'${route}':`)) ?? '';
      assert.ok(line.includes('DIAGNOSTICS_ADMIN_ROLES'), `${route} uses the shared admin roles`);
    }
  });
});
