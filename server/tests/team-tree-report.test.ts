import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Org-tree team report (owner request, 2026-11-11) — REMOVED
 * 2026-11-20 with the Team Members rebuild.
 *
 * Mahadi called the tree page "ekta faltu design" and the /team
 * page was rebuilt as the Team Members roster (his demo
 * screenshot 4). The rebuild's data comes from the ONE scoped
 * overview payload (GET /api/team/overview) + the loaded leads
 * list — the tree endpoint had no other caller, so GET
 * /api/team/tree, its pure builder (server/services/teamTree.ts)
 * and this file's builder + HTTP suites were all DELETED with
 * it, not left orphaned. The organogram chart still lives at
 * /team/organogram (linked from the rebuilt page's header).
 *
 * What remains here: the guards pinning the roster page, and the
 * proof that the tree endpoint is really gone.
 */

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('org-tree report — removed with the 2026-11-20 Team Members rebuild', () => {
  const page = stripComments(readFileSync(new URL('../../src/modules/team/pages/TeamOverview.tsx', import.meta.url), 'utf8'));
  const routes = readFileSync(new URL('../routes/production/users.routes.ts', import.meta.url), 'utf8');

  it('the tree endpoint and its builder are gone (no orphaned route or service)', () => {
    assert.ok(!routes.includes("router.get('/team/tree'"), 'GET /api/team/tree must not exist anymore');
    assert.ok(!routes.includes('buildTeamTree'), 'users.routes.ts must not reference the builder');
    assert.ok(!routes.includes('teamTree.js'), 'users.routes.ts must not import the builder module');
    assert.ok(
      !existsSync(new URL('../services/teamTree.ts', import.meta.url)),
      'server/services/teamTree.ts must be deleted',
    );
  });

  it('the /team page is the roster now, not the tree', () => {
    // The rebuilt page reads the team overview (useCallerTeam) + the
    // loaded leads list — it never called the tree endpoint.
    assert.ok(!page.includes("'/api/team/tree'"), 'the roster page must not call the tree endpoint');
    assert.ok(!page.includes('Team tree'), 'no tree rendering on /team anymore');
    assert.ok(!page.includes('Possible business (open pipeline)'), 'no pipeline rollup on /team anymore');
    // What replaced it: the roster table + the retail-style drill-down.
    assert.ok(page.includes('RosterRow'), 'the roster table renders');
    assert.ok(page.includes('ep-roster-row'), 'roster rows are links to the member detail');
    assert.ok(page.includes("searchParams.get('member')"), 'click a member → their detail (?member=)');
    assert.ok(page.includes("searchParams.get('tl')"), 'Manager: click a TL → their member-wise roster (?tl=)');
    // The tree function survives at /team/organogram, linked from the header.
    assert.ok(page.includes("to=\"/team/organogram\""), 'the Organogram link is kept');
  });

  it('the flat tier groups are gone — the roster + TL grouping replace them', () => {
    assert.ok(!page.includes('Managers'), 'no Managers tier group');
    assert.ok(!page.includes('Team Leaders'), 'no Team Leaders tier group');
    assert.ok(page.includes('Avg. active leads'), 'the capacity card is an honest count, not a target %');
    assert.ok(page.includes('Follow-up completion'), 'the progress column is the honest follow-up completion %');
  });
});
