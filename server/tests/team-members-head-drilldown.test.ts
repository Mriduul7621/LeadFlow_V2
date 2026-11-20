/**
 * team-members-head-drilldown.test.ts — Head-first drill-down for
 * the Team Members page (2026-11-20)
 * ------------------------------------------------------------------
 * Mahadi (2026-11-20 06:10): "team member page e manager admin or
 * ceo role er jonno list ta hobe agey department er head der
 * onujayi - tader full team er data onujayi list thakbe, then
 * click korle oi head er nicher member then tar niche ebhabe
 * kore jabe."
 *
 * Correction (2026-11-20 06:12), superseding the Manager part:
 * "Manager der jonno tar immediate nicher member gulo, ebhabe
 * kore drill down hobe" — a Manager's top level is their
 * IMMEDIATE subordinates, uniform for every Manager (including
 * one who is themself a Head). Admin/CEO keep the Department
 * Heads top level, org-wide. Team Lead keeps the direct roster.
 *
 * Part 1: pure helper tests for the drill-down (departmentHeadsOf,
 * directReportsOf, subtreeOf, aggregateSubtree, isCeoPerson) +
 * the Manager/Admin top-level rules + the admin-exclusion proof.
 * Part 2: source guards wiring the page (and the Team Performance
 * link) to the new ?node= drill-down.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateSubtree,
  departmentHeadsOf,
  directReportsOf,
  isCeoPerson,
  scopePeople,
  subtreeOf,
  type MemberCompletion,
} from '../../src/modules/workspace/utils/teamWorkspaceData';
import type { TeamOverviewPerson } from '../../src/modules/team/services/teamOverviewService';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Strip block + line comments so documented substitutions don't trip the guards. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * The org for every drill-down test (the settled ladder: CEO →
 * Head of Department → BE → GM → UM → FA):
 *
 *   CEO ── HEAD1 (Sales) ── BE1 ── GM1 ── UM1 ── FA1, FA2
 *    │       │               │       │       └──── UM2 ── FA3
 *    │       │               │       └──── GM2 ── FA4
 *    │       │               └──── BE2 ── FA5
 *    │       └──── HEAD2 (DSF) ── BE3 ── FA6
 *    └── ORPH1 (manager 'MISSING' — not in the payload)
 *   ADMIN1 (no manager — an admin, never a seller)
 */
function person(overrides: Partial<TeamOverviewPerson> & { employeeId: string }): TeamOverviewPerson {
  return {
    userId: `u-${overrides.employeeId}`,
    employeeId: overrides.employeeId,
    name: `Person ${overrides.employeeId}`,
    designation: overrides.designation ?? null,
    roleName: overrides.roleName ?? null,
    department: overrides.department ?? null,
    managerEmployeeId: overrides.managerEmployeeId ?? null,
    managerName: null,
    tier: 'teamMember',
    directReports: overrides.directReports ?? 0,
    openLeads: overrides.openLeads ?? 0,
    convertedLeads: overrides.convertedLeads ?? 0,
    dueToday: overrides.dueToday ?? 0,
    overdue: overrides.overdue ?? 0,
    totalLeads: overrides.totalLeads ?? 0,
    todayLeads: overrides.todayLeads ?? 0,
    noActionLeads: overrides.noActionLeads ?? 0,
    isSelf: overrides.isSelf ?? false,
  };
}

const ORG: TeamOverviewPerson[] = [
  person({ employeeId: 'CEO', designation: 'Chief Executive Officer', roleName: 'CEO', directReports: 2 }),
  person({ employeeId: 'HEAD1', designation: 'Head of Department', roleName: 'HEAD', department: 'Sales', managerEmployeeId: 'CEO', directReports: 2 }),
  person({ employeeId: 'HEAD2', designation: 'Head of Department', roleName: 'HEAD', department: 'DSF', managerEmployeeId: 'CEO', directReports: 1 }),
  person({ employeeId: 'BE1', designation: 'BE', managerEmployeeId: 'HEAD1', directReports: 2, openLeads: 2, convertedLeads: 1, dueToday: 1, overdue: 0, totalLeads: 3 }),
  person({ employeeId: 'BE2', designation: 'BE', managerEmployeeId: 'HEAD1', directReports: 1 }),
  person({ employeeId: 'BE3', designation: 'BE', managerEmployeeId: 'HEAD2', directReports: 1 }),
  person({ employeeId: 'GM1', designation: 'GM', managerEmployeeId: 'BE1', directReports: 2 }),
  person({ employeeId: 'GM2', designation: 'GM', managerEmployeeId: 'BE1', directReports: 1 }),
  person({ employeeId: 'UM1', designation: 'UM', managerEmployeeId: 'GM1', directReports: 2 }),
  person({ employeeId: 'UM2', designation: 'UM', managerEmployeeId: 'GM1', directReports: 1 }),
  person({ employeeId: 'FA1', designation: 'FA', managerEmployeeId: 'UM1', openLeads: 3, convertedLeads: 1, dueToday: 2, overdue: 1, totalLeads: 5 }),
  person({ employeeId: 'FA2', designation: 'FA', managerEmployeeId: 'UM1', openLeads: 2, convertedLeads: 0, dueToday: 0, overdue: 0, totalLeads: 2 }),
  person({ employeeId: 'FA3', designation: 'FA', managerEmployeeId: 'UM2', openLeads: 1, convertedLeads: 2, dueToday: 1, overdue: 0, totalLeads: 4 }),
  person({ employeeId: 'FA4', designation: 'FA', managerEmployeeId: 'GM2', openLeads: 4, convertedLeads: 0, dueToday: 3, overdue: 2, totalLeads: 6 }),
  person({ employeeId: 'FA5', designation: 'FA', managerEmployeeId: 'BE2', openLeads: 0, convertedLeads: 1, dueToday: 0, overdue: 0, totalLeads: 1 }),
  person({ employeeId: 'FA6', designation: 'FA', managerEmployeeId: 'BE3', openLeads: 5, convertedLeads: 3, dueToday: 2, overdue: 1, totalLeads: 7 }),
  person({ employeeId: 'ORPH1', designation: 'FA', managerEmployeeId: 'MISSING', openLeads: 1, totalLeads: 1 }),
  person({ employeeId: 'ADMIN1', roleName: 'ADMIN', openLeads: 9, convertedLeads: 9, dueToday: 9, overdue: 9, totalLeads: 99, noActionLeads: 9 }),
];

const byId = (employeeId: string) => ORG.find(p => p.employeeId === employeeId)!;
const ids = (people: TeamOverviewPerson[]) => people.map(p => p.employeeId);

/** Completed-today counts per member (the memberCompletions shape, hand-built). */
function completionsMap(entries: [string, number][]): Map<string, MemberCompletion> {
  const map = new Map<string, MemberCompletion>();
  for (const [employeeId, completed] of entries) {
    const p = byId(employeeId);
    map.set(employeeId, { completed, dueToday: p.dueToday, overdue: p.overdue, pct: null });
  }
  return map;
}

const COMPLETIONS = completionsMap([
  ['BE1', 1], ['FA1', 1], ['FA2', 2], ['FA3', 0], ['FA4', 1], ['FA5', 0], ['FA6', 3],
]);

/* ------------------------------------------------------------------ */
/* isCeoPerson                                                         */
/* ------------------------------------------------------------------ */

describe('isCeoPerson — the top of the tree', () => {
  it('matches the CEO designation in either form', () => {
    assert.equal(isCeoPerson(byId('CEO')), true);
    assert.equal(isCeoPerson(person({ employeeId: 'X', designation: 'CEO' })), true);
    assert.equal(isCeoPerson(person({ employeeId: 'X', designation: 'Chief Executive Officer' })), true);
  });

  it('matches the CEO role when the designation is blank', () => {
    assert.equal(isCeoPerson(person({ employeeId: 'X', roleName: 'CEO' })), true);
  });

  it('does not match anyone else', () => {
    assert.equal(isCeoPerson(byId('HEAD1')), false);
    assert.equal(isCeoPerson(byId('BE1')), false);
    assert.equal(isCeoPerson(person({ employeeId: 'X' })), false);
  });

  it('a Deputy CEO counts as a CEO root (their reports are the Heads)', () => {
    assert.equal(isCeoPerson(person({ employeeId: 'X', designation: 'Deputy CEO' })), true);
  });
});

/* ------------------------------------------------------------------ */
/* departmentHeadsOf                                                   */
/* ------------------------------------------------------------------ */

describe('departmentHeadsOf — the Admin/CEO top level', () => {
  it('with a visible CEO: the CEO\'s direct reports are the Heads, the CEO never is', () => {
    assert.deepEqual(ids(departmentHeadsOf(ORG)), ['HEAD1', 'HEAD2', 'ORPH1']);
  });

  it('the orphan root still appears (nobody is ever dropped)', () => {
    assert.ok(ids(departmentHeadsOf(ORG)).includes('ORPH1'));
  });

  it('without a visible CEO: the roots themselves are the Heads', () => {
    const noCeo = ORG.filter(p => p.employeeId !== 'CEO');
    assert.deepEqual(ids(departmentHeadsOf(noCeo)), ['HEAD1', 'HEAD2', 'ORPH1']);
  });

  it('with an admin-role CEO: the CEO row is filtered and the Heads become roots', () => {
    const ceoAdmin = ORG.map(p =>
      p.employeeId === 'CEO' ? { ...p, roleName: 'ADMIN' } : p,
    );
    assert.deepEqual(ids(departmentHeadsOf(ceoAdmin)), ['HEAD1', 'HEAD2', 'ORPH1']);
  });

  it('an admin is never a Head, even when passed the raw org', () => {
    assert.ok(!ids(departmentHeadsOf(ORG)).includes('ADMIN1'));
  });

  it('a CEO direct report with no reports is still a top-level row (a leaf, not dropped)', () => {
    const org = [
      person({ employeeId: 'CEO', designation: 'CEO' }),
      person({ employeeId: 'EA1', managerEmployeeId: 'CEO' }),
    ];
    assert.deepEqual(ids(departmentHeadsOf(org)), ['EA1']);
  });

  it('a manager cycle falls back to the people with reports', () => {
    const cyclic = [
      person({ employeeId: 'A', managerEmployeeId: 'B' }),
      person({ employeeId: 'B', managerEmployeeId: 'A' }),
    ];
    assert.deepEqual(ids(departmentHeadsOf(cyclic)), ['A', 'B']);
  });

  it('empty in, empty out', () => {
    assert.deepEqual(departmentHeadsOf([]), []);
  });
});

/* ------------------------------------------------------------------ */
/* directReportsOf + subtreeOf                                         */
/* ------------------------------------------------------------------ */

describe('directReportsOf + subtreeOf — the tier walk', () => {
  it('direct reports are the next tier only, sorted by name', () => {
    assert.deepEqual(ids(directReportsOf(ORG, 'HEAD1')), ['BE1', 'BE2']);
    assert.deepEqual(ids(directReportsOf(ORG, 'BE1')), ['GM1', 'GM2']);
    assert.deepEqual(ids(directReportsOf(ORG, 'GM1')), ['UM1', 'UM2']);
    assert.deepEqual(ids(directReportsOf(ORG, 'FA1')), []);
  });

  it('matching is case-insensitive and a self-manager link is ignored', () => {
    assert.deepEqual(ids(directReportsOf(ORG, 'head1')), ['BE1', 'BE2']);
    const selfManaged = [
      person({ employeeId: 'S1', managerEmployeeId: 'S1' }),
      person({ employeeId: 'S2', managerEmployeeId: 'S1' }),
    ];
    assert.deepEqual(ids(directReportsOf(selfManaged, 'S1')), ['S2']);
  });

  it('the subtree includes the root person and every descendant', () => {
    const head1 = subtreeOf(ORG, 'HEAD1');
    assert.equal(head1.length, 12);
    assert.ok(ids(head1).includes('HEAD1'));
    assert.ok(ids(head1).includes('FA5'));
    assert.ok(ids(head1).includes('UM2'));
    assert.ok(!ids(head1).includes('HEAD2'));
    assert.ok(!ids(head1).includes('FA6'));
  });

  it('a leaf subtree is just themself; a missing id is empty; a cycle terminates', () => {
    assert.deepEqual(ids(subtreeOf(ORG, 'FA1')), ['FA1']);
    assert.deepEqual(subtreeOf(ORG, 'NOBODY'), []);
    const cyclic = [
      person({ employeeId: 'A', managerEmployeeId: 'B' }),
      person({ employeeId: 'B', managerEmployeeId: 'A' }),
    ];
    assert.deepEqual(ids(subtreeOf(cyclic, 'A')).sort(), ['A', 'B']);
  });
});

/* ------------------------------------------------------------------ */
/* aggregateSubtree                                                    */
/* ------------------------------------------------------------------ */

describe('aggregateSubtree — one group row\'s honest numbers', () => {
  it('sums the whole subtree, root included (HEAD1: 12 people)', () => {
    const agg = aggregateSubtree(ORG, 'HEAD1', COMPLETIONS);
    assert.equal(agg.members.length, 12);
    assert.equal(agg.totals.open, 12);
    assert.equal(agg.totals.totalLeads, 21);
    assert.equal(agg.totals.converted, 5);
    assert.equal(agg.followUpsDue, 10);
    assert.equal(agg.needsAttention, true);
  });

  it('the completion % is the ONE member definition, summed over the subtree', () => {
    // HEAD1: completed 5 (BE1 1 + FA1 1 + FA2 2 + FA4 1), due 7, overdue 3 → 5/15 = 33%.
    assert.equal(aggregateSubtree(ORG, 'HEAD1', COMPLETIONS).pct, 33);
    // HEAD2: completed 3 (FA6), due 2, overdue 1 → 3/6 = 50%.
    assert.equal(aggregateSubtree(ORG, 'HEAD2', COMPLETIONS).pct, 50);
  });

  it('a leaf with nothing due or done shows "—" (pct null), never 0%', () => {
    const agg = aggregateSubtree(ORG, 'FA5', COMPLETIONS);
    assert.equal(agg.members.length, 1);
    assert.equal(agg.pct, null);
    assert.equal(agg.needsAttention, false);
  });

  it('an admin\'s numbers never leak into an aggregate', () => {
    // ADMIN1 carries 99 total leads; no subtree total may include them.
    const agg = aggregateSubtree(ORG, 'HEAD1', COMPLETIONS);
    assert.equal(agg.totals.totalLeads, 21);
    assert.ok(!ids(agg.members).includes('ADMIN1'));
  });
});

/* ------------------------------------------------------------------ */
/* Top-level rules per role (Mahadi 2026-11-20 06:10 + 06:12)          */
/* ------------------------------------------------------------------ */

describe('top levels — Admin sees Heads, Manager sees immediate subordinates', () => {
  it('Admin: the Heads, org-wide, admins excluded', () => {
    const sellers = scopePeople(ORG, byId('ADMIN1'), 'admin');
    assert.ok(!ids(sellers).includes('ADMIN1'));
    assert.deepEqual(ids(departmentHeadsOf(sellers)), ['HEAD1', 'HEAD2', 'ORPH1']);
  });

  it('Manager: immediate subordinates only, not the whole downline', () => {
    const self = { ...byId('BE1'), isSelf: true };
    const roster = scopePeople(ORG, self, 'manager');
    assert.equal(roster.length, 9); // BE1 + 8 downline
    assert.deepEqual(ids(directReportsOf(roster, 'BE1')), ['GM1', 'GM2']);
  });

  it('a Manager who IS a Head still starts at their immediate subordinates (the 06:12 correction)', () => {
    const self = { ...byId('HEAD1'), isSelf: true };
    const roster = scopePeople(ORG, self, 'manager');
    assert.deepEqual(ids(directReportsOf(roster, 'HEAD1')), ['BE1', 'BE2']);
    // NOT the Heads list — a Head-Manager drills their own next tier.
    assert.ok(!ids(directReportsOf(roster, 'HEAD1')).includes('HEAD2'));
  });

  it('Team Lead keeps the flat roster (self + full downline, unchanged)', () => {
    const self = { ...byId('UM1'), isSelf: true };
    assert.deepEqual(ids(scopePeople(ORG, self, 'teamLead')), ['UM1', 'FA1', 'FA2']);
  });
});

/* ------------------------------------------------------------------ */
/* Source guards — the page + the Team Performance link                */
/* ------------------------------------------------------------------ */

describe('Head-first drill-down — source guards', () => {
  const page = stripComments(read('src/modules/team/pages/TeamOverview.tsx'));
  const analytics = stripComments(read('src/modules/dashboard/pages/ExecutionIntelligence.tsx'));

  it('the page drills on ?node=, with ?tl= only as the legacy alias', () => {
    assert.ok(page.includes("searchParams.get('node')"), 'the drill node param (?node=)');
    assert.ok(page.includes("searchParams.get('tl')"), 'the legacy ?tl= alias');
  });

  it('the page wires the drill-down helpers', () => {
    assert.ok(page.includes('departmentHeadsOf'), 'Admin top level = department heads');
    assert.ok(page.includes('directReportsOf'), 'Manager top level = immediate subordinates');
    assert.ok(page.includes('aggregateSubtree'), 'group rows aggregate the whole subtree');
  });

  it('the old Manager TL grouping is gone from /team (it still serves the other pages)', () => {
    assert.ok(!page.includes('tlAncestorOf'), 'no TL-ancestor grouping on /team anymore');
    assert.ok(!page.includes('Teams by team lead'), 'no TL-group card anymore');
  });

  it('the breadcrumb climbs back up the tiers', () => {
    assert.ok(page.includes('All departments'), 'Admin breadcrumb top');
    assert.ok(page.includes('All direct reports'), 'Manager breadcrumb top');
    assert.ok(page.includes('crumbs'), 'the ancestor chain renders');
  });

  it('the caller can never be their own drill node', () => {
    assert.ok(page.includes('node.isSelf'), 'a self node falls back to the top level');
  });

  it('group rows drill (?node=) and leaf rows open the member detail (?member=)', () => {
    // The roster-row URL is built in a variable (rowTo), so the
    // link-site guard cannot see it — pin both shapes here.
    assert.ok(page.includes('`/team?node=${encodeURIComponent(person.employeeId)}`'), 'group rows link to /team?node=…');
    assert.ok(page.includes("params.set('member'"), 'leaf rows keep the ?member= deep link');
    assert.ok(page.includes("Open ${person.name}'s team"), 'group rows label the team, not a detail');
  });

  it('Team Performance links to the drill-down (?node=), not the retired ?tl=', () => {
    assert.ok(analytics.includes('/team?node='), 'the TL name links to /team?node=…');
    assert.ok(!analytics.includes('/team?tl='), 'no /team?tl= link survives');
  });
});
