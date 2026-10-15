/**
 * report-insight-access-parity.test.ts
 * ------------------------------------------------------------------
 * Guards the F16 §3.3 divergence fix (decided 2026-10-15, "Option B —
 * the server is the truth"): the four insight/report pages must open by
 * default for EXACTLY the standard roles the default grant table gives
 * `reports.view` — no more, no less.
 *
 * Before the fix the client fallback listed ADMIN/RO/RM/CEO by hand while
 * the database granted MANAGER, SM, RM, TEAM_LEAD, BDM and ASM the same
 * permission. A manager therefore held a capability the navigation hid —
 * one user, two answers. The fallback now DERIVES from
 * `rolesWithDefaultGrant('reports.view')`, and this suite fails if anyone
 * reintroduces a second hand-written copy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveFeatureRouteAccess } from '../../src/layouts/featureRouteAccess';
import {
  DEFAULT_GRANTS,
  rolesWithDefaultGrant,
} from '../../src/modules/shared/access/roleGrantDefaults';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

const INSIGHT_ROUTES = [
  '/execution-intelligence',
  '/ncp-progress',
  '/trend-charts',
  '/campaign-breakdown',
];

describe('Insight pages — client fallback derived from the default grant table', () => {
  it('every standard role matches the reports.view default exactly', () => {
    const holders = new Set(rolesWithDefaultGrant('reports.view').map(r => r.toUpperCase()));
    for (const roleCode of Object.keys(DEFAULT_GRANTS)) {
      const expected = holders.has(roleCode.toUpperCase());
      for (const route of INSIGHT_ROUTES) {
        assert.equal(
          resolveFeatureRouteAccess(route, roleCode, undefined),
          expected,
          `${route} for ${roleCode}: the page gate must mirror reports.view (expected ${expected})`
        );
      }
    }
  });

  it('the roles the decision named behave as agreed', () => {
    const open = ['MANAGER', 'SM', 'RM', 'TEAM_LEAD', 'BDM', 'ASM', 'CEO', 'BH'];
    const closed = ['EMPLOYEE', 'SBE', 'BE', 'RO'];
    for (const role of open) {
      for (const route of INSIGHT_ROUTES) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), true, `${route} open for ${role}`);
      }
    }
    for (const role of closed) {
      for (const route of INSIGHT_ROUTES) {
        assert.equal(resolveFeatureRouteAccess(route, role, undefined), false, `${route} closed for ${role}`);
      }
    }
    // ADMIN/SUPERADMIN bypass, and a custom code starts fail-closed.
    assert.equal(resolveFeatureRouteAccess('/ncp-progress', 'ADMIN', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/ncp-progress', 'SUPERADMIN', undefined), true);
    assert.equal(resolveFeatureRouteAccess('/ncp-progress', 'MKTH', undefined), false, 'custom roles fail closed');
    // ...until an admin grants the page: menuAccess wins over the fallback.
    assert.equal(
      resolveFeatureRouteAccess('/ncp-progress', 'MKTH', { menuAccess: { '/ncp-progress': true } } as any),
      true
    );
    assert.equal(
      resolveFeatureRouteAccess('/ncp-progress', 'MANAGER', { menuAccess: { '/ncp-progress': false } } as any),
      false,
      'an explicit deny still hides the page from a default holder'
    );
  });

  it('no second hand-written insight list may return (source guard)', () => {
    const src = read('src/layouts/featureRouteAccess.ts');
    assert.ok(
      src.includes("rolesWithDefaultGrant('reports.view')"),
      'the insight fallback must be derived from the shared grant table'
    );
    const block = src.slice(src.indexOf('const INSIGHT_ROLES'), src.indexOf('];', src.indexOf('const INSIGHT_ROLES')));
    for (const role of ['RO', 'BE', 'SBE', 'EMPLOYEE']) {
      assert.ok(
        !new RegExp(`['"]${role}['"]`).test(block),
        `${role} holds no reports.view default and must not be listed in the insight fallback`
      );
    }
  });

  it('the database bootstrap and the client read the SAME table', () => {
    const bootstrap = read('server/database/roleAccessDefaults.ts');
    assert.ok(
      bootstrap.includes("from '../../src/modules/shared/access/roleGrantDefaults.js'"),
      'the migration/seed routine must import the shared default table (with the .js specifier Node ESM demands)'
    );
    const shared = read('src/modules/shared/access/roleGrantDefaults.ts');
    assert.ok(shared.includes('export function rolesWithDefaultGrant'), 'the shared table owner must expose the query');
    assert.ok(shared.includes("'reports.view'"), 'reports.view must be part of the standard grants');
  });
});
