/**
 * roadshow-access-parity.test.ts
 * ------------------------------------------------------------------
 * One predicate for "may this user see roadshow alerts?".
 *
 * Field report: the SAME signed-in employee saw "Roadshows today 1" on My
 * Work and NO roadshow row at all on Home. The capability has two
 * legitimate sources in this codebase — the canonical feature matrix
 * (`canAccess('roadshow_follow_up', 'view')`) and the role's
 * `menuAccess['/roadshows']` grant written by Roles & Access — and the two
 * pages were reading different ones (whichever had loaded first). The fix
 * is a single shared hook that ORs both, so the row can never appear on
 * one page and vanish on the other for the same user.
 *
 *   1. Behavior — `resolveMenuVisibility` honours the ANY_ROLE sentinel and
 *      an explicit menuAccess still wins; `hasMenuAccessFor` reads only
 *      explicit grants.
 *   2. Source guards — both callers use the shared hook, and the hook ORs
 *      the two signals.
 *   3. Contract — a denied read keeps hiding the row (never a fabricated 0).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ANY_ROLE, hasMenuAccessFor, resolveMenuVisibility } from '../../src/layouts/menuVisibility';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('menuVisibility — ANY_ROLE sentinel', () => {
  it('A. opens an org-wide item for every authenticated role, admin bypass unchanged', () => {
    const item = { path: '/', roles: [ANY_ROLE] };
    for (const role of ['ADMIN', 'RO', 'RM', 'ASM', 'BDM', 'BE', 'BH', 'CEO', 'MANAGER', 'SM', 'TEAM_LEAD', 'EMPLOYEE', 'SBE', 'MKTH', 'anything-custom']) {
      assert.equal(resolveMenuVisibility(role, undefined, item), true, `${role} must see an org-wide item`);
    }
    assert.equal(resolveMenuVisibility('ADMIN', { menuAccess: { '/': false } } as any, item), true, 'admin bypass still wins');
    assert.equal(resolveMenuVisibility('', undefined, item), true, 'role-less callers fall back to the sentinel (ProtectedRoute gates them first)');
  });

  it('B. an explicit menuAccess entry still wins over the sentinel (both ways)', () => {
    const item = { path: '/leads', roles: [ANY_ROLE] };
    assert.equal(resolveMenuVisibility('EMPLOYEE', { menuAccess: { '/leads': false } } as any, item), false,
      'an admin can still hide an org-wide page from a role');
    const closed = { path: '/roadshows', roles: ['ADMIN', 'MANAGER'] };
    assert.equal(resolveMenuVisibility('EMPLOYEE', { menuAccess: { '/roadshows': true } } as any, closed), true,
      'an explicit grant opens a page that is closed by default');
    assert.equal(resolveMenuVisibility('EMPLOYEE', undefined, closed), false,
      'without a grant the static list stays fail-closed');
  });

  it('C. hasMenuAccessFor reads only explicit grants for the caller’s own role', () => {
    const roles = [
      { roleId: 'EMPLOYEE', menuAccess: { '/roadshows': true } },
      { roleId: 'MANAGER', menuAccess: { '/roadshows': false } },
      { roleId: 'SM', menuAccess: {} },
    ] as any;
    assert.equal(hasMenuAccessFor(roles, 'EMPLOYEE', '/roadshows'), true);
    assert.equal(hasMenuAccessFor(roles, 'employee', '/roadshows'), true, 'role match is case-insensitive');
    assert.equal(hasMenuAccessFor(roles, 'MANAGER', '/roadshows'), false, 'an explicit false is not access');
    assert.equal(hasMenuAccessFor(roles, 'SM', '/roadshows'), false, 'an empty map is not access');
    assert.equal(hasMenuAccessFor(roles, 'UNKNOWN', '/roadshows'), false);
    assert.equal(hasMenuAccessFor(null, 'EMPLOYEE', '/roadshows'), false, 'no matrix yet is not access');
    assert.equal(hasMenuAccessFor(roles, null, '/roadshows'), false);
  });
});

describe('roadshow access — shared predicate', () => {
  it('D. both pages ask the same hook', () => {
    for (const file of ['src/modules/dashboard/pages/Dashboard.tsx', 'src/modules/workbench/pages/DailyWorkbench.tsx']) {
      const src = read(file);
      assert.ok(src.includes("from '../../shared/hooks/useRoadshowAccess'"), `${file} must import the shared hook`);
      assert.ok(src.includes('const canViewRoadshows = useRoadshowAccess();'), `${file} must resolve roadshow access through the hook`);
      assert.ok(!src.includes("canAccess('roadshow_follow_up'"), `${file} must not re-implement the capability check`);
    }
  });

  it('E. the hook ORs the capability matrix and the menu grant, and nothing else', () => {
    const hook = read('src/modules/shared/hooks/useRoadshowAccess.ts');
    assert.ok(hook.includes("canAccess('roadshow_follow_up', 'view')"), 'capability signal');
    assert.ok(hook.includes("hasMenuAccessFor(roles, user?.role, '/roadshows')"), 'menu-grant signal');
    assert.ok(/return capability \|\| menuGrant;/.test(hook), 'either signal shows the row');
    assert.ok(!hook.includes('fetch('), 'the hook stays a pure predicate — the pages own their reads');
  });

  it('F. a denied/failed read still hides the row (no fabricated 0)', () => {
    const home = read('src/modules/dashboard/pages/Dashboard.tsx');
    // Home: the counts state is null when access is absent OR the read fails.
    assert.ok(home.includes('setRoadshowCounts(null)'), 'a failed read must clear the counts');
    assert.ok(home.includes('canViewRoadshows'), 'the read is still gated by the predicate');
    const workbench = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(workbench.includes('roadshowsToday: canViewRoadshows ? roadshowsToday.length : 0'),
      'My Work falls back to a hidden row, never a stale count');
  });
});
