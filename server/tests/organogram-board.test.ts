/**
 * organogram-board.test.ts — /team/organogram board rebuild
 * ------------------------------------------------------------------
 * Mahadi approved the organogram sample (2026-11-21) and ordered the
 * rebuild in that design. The page shows the viewing user's reporting
 * world as a board — ancestor chain (root first, viewer last), the
 * viewer's direct reports as branch cards, their reports as a flat
 * leaf row, and the downline summary card — derived from the live
 * organogram (GET /api/organogram, users.manager_id). No demo data:
 * the sample's names never appear on the page.
 *
 * This file pins:
 *  - the pure derivation (organogramBoard.ts): chain order, branch
 *    and leaf rows, downline + front-line-team counts, role labels,
 *    initials, viewer fallbacks, cycle safety;
 *  - the H1 fix: the route's label and heading are now
 *    "Teams & Hierarchy" / "Review reporting lines and team
 *    structure." (the old fallback title must not return);
 *  - the page structure (source guards): the board markup, the
 *    summary strings, real data loading — and the absence of the
 *    removed pieces (BackButton, tabs, search, zoom) and of every
 *    demo name from the sample.
 *
 * Fixture names are invented test names, deliberately unlike the
 * sample's demo names. Fixture shapes match the production
 * /api/organogram payload (employeeId / roleId = role_code /
 * roleName / designation / level / managerEmployeeId / isActive).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildOrganogramBoardView,
  organogramRoleLabel,
  personInitials,
  formatPeopleCount,
  formatTeamCount,
  type OrganogramBoardNodeInput,
} from '../../src/modules/hierarchy/utils/organogramBoard.js';
import {
  enterpriseHeadingForPath,
  enterpriseLabelForPath,
} from '../../src/layouts/enterpriseNav';

const ROOT = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function node(
  employeeId: string,
  name: string,
  roleId: string,
  roleName: string,
  level: number,
  managerEmployeeId: string | null,
): OrganogramBoardNodeInput {
  return {
    employeeId,
    name,
    roleId,
    roleName,
    designation: '',
    level,
    managerEmployeeId,
    isActive: true,
  };
}

// A realistic ladder: CEO → Head → BE → GM → DGM → AGM → BM (the
// viewer) → 2 UMs → 4 FAs, plus a second GM branch under the BE
// (GM2 → UM → 2 FAs) so the team aggregation is non-trivial.
function ladderNodes(): OrganogramBoardNodeInput[] {
  return [
    node('E001', 'Zara Karim', 'CEO', 'Chief Executive Officer', 1, null),
    node('E002', 'Yusuf Ali', 'HEAD', 'Head of Department', 2, 'E001'),
    node('E003', 'Xenia Roy', 'BE', 'Business Executive', 3, 'E002'),
    node('E004', 'Wahid Das', 'GM', 'General Manager', 4, 'E003'),
    node('E005', 'Vera Sen', 'DGM', 'Deputy General Manager', 5, 'E004'),
    node('E006', 'Umar Ghosh', 'AGM', 'Assistant General Manager', 6, 'E005'),
    node('E007', 'Tara Bose', 'BM', 'Branch Manager', 7, 'E006'),
    node('E008', 'Sara Mia', 'UM', 'Unit Manager', 8, 'E007'),
    node('E009', 'Rafi Uddin', 'UM', 'Unit Manager', 8, 'E007'),
    node('E010', 'Nina', 'FA', 'Field Associate', 9, 'E008'),
    node('E011', 'Omar', 'FA', 'Field Associate', 9, 'E008'),
    node('E012', 'Pia', 'FA', 'Field Associate', 9, 'E009'),
    node('E013', 'Qasim', 'FA', 'Field Associate', 9, 'E009'),
    node('E014', 'Lina Hoque', 'GM', 'General Manager', 4, 'E003'),
    node('E015', 'Kabir Shah', 'UM', 'Unit Manager', 8, 'E014'),
    node('E016', 'Dina', 'FA', 'Field Associate', 9, 'E015'),
    node('E017', 'Evan', 'FA', 'Field Associate', 9, 'E015'),
  ];
}

describe('organogram board — view derivation', () => {
  it('chains root → viewer in ladder order', () => {
    const view = buildOrganogramBoardView(ladderNodes(), 'E007');
    assert.deepEqual(
      view.chain.map((p) => p.employeeId),
      ['E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E007'],
    );
    assert.equal(view.viewer?.employeeId, 'E007');
    assert.equal(view.viewerInTree, true);
    assert.equal(view.empty, false);
    assert.equal(view.totalPeople, 17);
  });

  it('branches the viewer\u2019s direct reports and flattens the grandchildren', () => {
    const view = buildOrganogramBoardView(ladderNodes(), 'E007');
    // Same level, so alphabetical: Rafi (E009) before Sara (E008).
    assert.deepEqual(
      view.branch.map((p) => p.employeeId),
      ['E009', 'E008'],
    );
    // Flat leaf row, in branch order (the sample's single FA row):
    // Rafi's FAs first, then Sara's, alphabetical inside each.
    assert.deepEqual(
      view.leafRow.map((p) => p.employeeId),
      ['E012', 'E013', 'E010', 'E011'],
    );
  });

  it('counts every descendant as downline, not just the visible rows', () => {
    const view = buildOrganogramBoardView(ladderNodes(), 'E007');
    const byId = new Map(view.chain.map((p) => [p.employeeId, p]));
    assert.equal(byId.get('E001')?.downline, 16);
    assert.equal(byId.get('E002')?.downline, 15);
    assert.equal(byId.get('E003')?.downline, 14);
    assert.equal(byId.get('E004')?.downline, 9);
    assert.equal(byId.get('E007')?.downline, 6);
    assert.equal(view.viewerDownline, 6);
    assert.equal(view.branch[0].downline, 2);
    assert.equal(view.leafRow[0].downline, 0);
    assert.equal(view.leafRow[0].hasReports, false);
    assert.equal(view.branch[0].hasReports, true);
  });

  it('counts front-line teams (a manager whose reports are all leaves)', () => {
    const view = buildOrganogramBoardView(ladderNodes(), 'E007');
    const byId = new Map(view.chain.map((p) => [p.employeeId, p]));
    // Three UM-led teams in the org: E008, E009, E015.
    assert.equal(byId.get('E001')?.teams, 3);
    assert.equal(byId.get('E003')?.teams, 3);
    assert.equal(byId.get('E004')?.teams, 2);
    assert.equal(byId.get('E007')?.teams, 2);
    assert.equal(view.viewerTeams, 2);
    // A UM's own downline holds no team below them.
    assert.equal(view.branch[0].teams, 0);
  });

  it('marks only the CEO row as the CEO (blue styling)', () => {
    const view = buildOrganogramBoardView(ladderNodes(), 'E007');
    assert.deepEqual(
      view.chain.map((p) => p.isCeo),
      [true, false, false, false, false, false, false],
    );
    assert.equal(view.chain[0].roleLabel, 'CHIEF EXECUTIVE OFFICER');
    assert.equal(view.chain[2].roleLabel, 'BE • RBM');
  });

  it('a leaf viewer gets the full chain and empty branch rows', () => {
    const view = buildOrganogramBoardView(ladderNodes(), 'E010');
    assert.equal(view.chain.length, 9);
    assert.equal(view.chain[8].employeeId, 'E010');
    assert.deepEqual(view.branch, []);
    assert.deepEqual(view.leafRow, []);
    assert.equal(view.viewerDownline, 0);
    assert.equal(view.viewerTeams, 0);
  });

  it('a CEO viewer gets the single-row chain and the top branch', () => {
    const view = buildOrganogramBoardView(ladderNodes(), 'E001');
    assert.deepEqual(
      view.chain.map((p) => p.employeeId),
      ['E001'],
    );
    assert.deepEqual(
      view.branch.map((p) => p.employeeId),
      ['E002'],
    );
    assert.deepEqual(
      view.leafRow.map((p) => p.employeeId),
      ['E003'],
    );
  });

  it('a viewer missing from the tree anchors at the first root', () => {
    // An ADMIN viewer is not in the tree (the API excludes
    // ADMIN/SUPERADMIN rows): the view anchors at the CEO root.
    const view = buildOrganogramBoardView(ladderNodes(), 'E999');
    assert.equal(view.viewerInTree, false);
    assert.equal(view.viewer?.employeeId, 'E001');
    assert.deepEqual(
      view.chain.map((p) => p.employeeId),
      ['E001'],
    );
    assert.equal(view.viewerDownline, 16);
    assert.equal(view.viewerTeams, 3);
  });

  it('an empty tree is an empty view, not a crash', () => {
    const view = buildOrganogramBoardView([], 'E001');
    assert.equal(view.empty, true);
    assert.equal(view.viewer, null);
    assert.deepEqual(view.chain, []);
    assert.equal(view.totalPeople, 0);
  });

  it('a corrupt manager cycle terminates instead of looping', () => {
    const nodes = [
      node('X001', 'Cycle One', 'BM', 'Branch Manager', 7, 'X002'),
      node('X002', 'Cycle Two', 'UM', 'Unit Manager', 8, 'X001'),
    ];
    const view = buildOrganogramBoardView(nodes, 'X001');
    assert.deepEqual(
      view.chain.map((p) => p.employeeId),
      ['X002', 'X001'],
    );
    assert.equal(view.viewerDownline, 1);
  });
});

describe('organogram board — role labels and initials', () => {
  it('maps every ladder code to the board label', () => {
    const cases: Array<[string, string, string, string]> = [
      ['CEO', 'Chief Executive Officer', '', 'CHIEF EXECUTIVE OFFICER'],
      ['HEAD', 'Head of Department', '', 'HEAD OF DEPARTMENT'],
      ['BE', 'Business Executive', '', 'BE • RBM'],
      ['RBM', '', '', 'BE • RBM'],
      ['GM', 'General Manager', '', 'GENERAL MANAGER'],
      ['DGM', 'Deputy General Manager', '', 'DEPUTY GENERAL MANAGER'],
      ['AGM', 'Assistant General Manager', '', 'ASST. GENERAL MANAGER'],
      ['BM', 'Branch Manager', '', 'BRANCH MANAGER'],
      ['UM', 'Unit Manager', '', 'UNIT MANAGER'],
      ['FA', 'Field Associate', '', 'FA'],
      ['RO', 'Relationship Officer', '', 'RO'],
      ['MANAGER', 'Manager', '', 'MANAGER'],
      ['TEAM_LEAD', 'Team Lead', '', 'TEAM LEAD'],
      ['EMPLOYEE', 'Employee', '', 'EMPLOYEE'],
    ];
    for (const [code, name, designation, expected] of cases) {
      assert.equal(organogramRoleLabel(code, name, designation), expected, code);
    }
  });

  it('falls back to the role name, then the designation, then uppercased raw', () => {
    assert.equal(organogramRoleLabel('', 'Business Executive', ''), 'BE • RBM');
    assert.equal(organogramRoleLabel('', '', 'Branch Manager'), 'BRANCH MANAGER');
    assert.equal(organogramRoleLabel('ZZZ', 'Mystery Role', ''), 'MYSTERY ROLE');
    assert.equal(organogramRoleLabel('', '', ''), 'EMPLOYEE');
  });

  it('derives initials from first + last name', () => {
    assert.equal(personInitials('Zara Karim'), 'ZK');
    assert.equal(personInitials('Nina'), 'N');
    assert.equal(personInitials('Md. Abdur Rahman Khan'), 'MK');
    assert.equal(personInitials(''), '?');
    assert.equal(personInitials('   '), '?');
  });

  it('formats people / team counts with singulars', () => {
    assert.equal(formatPeopleCount(0), '0 people');
    assert.equal(formatPeopleCount(1), '1 person');
    assert.equal(formatPeopleCount(24), '24 people');
    assert.equal(formatTeamCount(1), '1 team');
    assert.equal(formatTeamCount(6), '6 teams');
  });
});

describe('organogram board — the H1 fix', () => {
  it('the route label and heading are the board title, not the old fallback', () => {
    assert.equal(
      enterpriseLabelForPath([], '/team/organogram'),
      'Teams & Hierarchy',
    );
    const heading = enterpriseHeadingForPath('manager', '/team/organogram');
    assert.equal(heading.title, 'Teams & Hierarchy');
    assert.equal(heading.sub, 'Review reporting lines and team structure.');
  });

  it('the real Team Members page keeps its own label and subtitle', () => {
    const heading = enterpriseHeadingForPath('manager', '/team');
    assert.equal(heading.title, 'Team Members');
    assert.equal(heading.sub, 'Review member workload and support needs.');
  });
});

describe('organogram board — page structure (source guards)', () => {
  const page = () => read('src/modules/hierarchy/pages/TeamHierarchy.tsx');
  const css = () => read('src/index.css');

  it('renders the header from the nav label and the board from the live tree', () => {
    assert.ok(page().includes('EnterprisePageHeader'), 'header via the nav label');
    assert.ok(page().includes('path="/team/organogram"'), 'header path');
    assert.ok(page().includes('buildOrganogramBoardView'), 'derives the board view');
    assert.ok(page().includes('OrganogramBoard'), 'renders the board component');
    assert.ok(page().includes('orgService.getOrganogram()'), 'real tree data');
    assert.ok(page().includes('userService.getAllUsers()'), 'real roster data');
  });

  it('carries the summary card and the tap hint, verbatim', () => {
    assert.ok(page().includes('in your downline'), 'summary: downline');
    assert.ok(page().includes('1 reporting line each'), 'summary: one reporting line');
    assert.ok(
      page().includes('Tap a person to open their team view.'),
      'summary: tap hint',
    );
  });

  it('never renders the old fallback title', () => {
    assert.ok(!page().includes('Team Members'), 'the old H1 must not return');
  });

  it('has none of the removed pieces: back button, tabs, search, zoom', () => {
    for (const gone of [
      'BackButton',
      'setActiveTab',
      'searchQuery',
      'handleZoomIn',
      'handleZoomOut',
      "t('orgChart')",
      "t('listView')",
      'renderTreeNode',
    ]) {
      assert.ok(!page().includes(gone), `${gone} must be gone (the board has none)`);
    }
  });

  it('never hardcodes a demo name from the approved sample', () => {
    for (const demo of [
      'Arif Hossain',
      'Farhana Karim',
      'Tanvir Ahmed',
      'Nusrat Jahan',
      'Imran Chowdhury',
      'Sharmin Akter',
      'Rashed Khan',
      'Mim Akter',
      'Tania Rahman',
      'Sabbir',
      'Jahid',
      'Kamal',
      'Sohel',
    ]) {
      assert.ok(!page().includes(demo), `demo name ${demo} must not appear on the page`);
    }
  });

  it('keeps the tap-to-detail interaction', () => {
    assert.ok(page().includes('onSelect={handleSelect}'), 'tap opens the team view');
    assert.ok(page().includes('setSelectedMember'), 'the detail slide-over survives');
    assert.ok(page().includes('leadService.getLeads'), 'detail stats still load per member');
  });

  it('the board styles exist with the sample tokens', () => {
    for (const cls of [
      '.orgb-wrap',
      '.orgb-tree',
      '.orgb-node',
      '.orgb-node--ceo',
      '.orgb-av--olive',
      '.orgb-av--blue',
      '.orgb-av--grey',
      '.orgb-conn',
      '.orgb-branch',
      '.orgb-branch--leaf',
      '.orgb-bnode',
      '.orgb-fnode',
      '.orgb-card',
    ]) {
      assert.ok(css().includes(cls), `${cls} must exist in index.css`);
    }
    assert.ok(css().includes('rgba(3, 89, 179, .4)'), 'CEO blue border token');
  });
});
