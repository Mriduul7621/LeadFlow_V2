/**
 * team-manager-admin-workspace.test.ts — Team Lead / Manager / Admin workspaces (2026-11-20)
 * ------------------------------------------------------------------
 * Mahadi's spec (2026-11-20 04:07, 4 demo screenshots + words —
 * "ebar now complete koro"): one Team Overview component with three
 * scopes, the Team Leads / My Leads scope split, the Manager
 * TL-group drill-down, the Follow-up Monitor Team/Self toggle, the
 * rebuilt Team Members roster, the reassign fix (never for a plain
 * Agent), and the admin-granted Employee add for TL/Manager.
 *
 * Part 1 (this file): pure helper tests for teamWorkspaceData
 * (scope splits, KPI definitions, drill-down grouping, at-risk),
 * source guards for the reassign visibility hook, the Follow-up
 * Monitor toggle, the honest-metric labels (no target % anywhere),
 * and the PGlite proof for migration 063 + POST /api/users/employee.
 *
 * The navs are pinned in enterprise-nav.test.ts, the bottom tabs in
 * enterprise-bottom-nav.test.ts, the homes in
 * enterprise-homes-source-guards.test.ts, the performance layout in
 * enterprise-analytics.test.ts, the route gates in
 * feature-route-access.test.ts, and the server reassign rule in
 * tl-lead-assignment.test.ts / tl-bulk-import-gate.test.ts.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  atRiskLeads,
  contactedCount,
  followUpHealth,
  groupLeadsByTl,
  isAdminPerson,
  isoWeekNumber,
  leadCreatorEmployeeId,
  memberCompletions,
  memberStatus,
  myLeadsFor,
  scopeLeadsByAssignee,
  scopePeople,
  teamLeadsForRole,
  teamNameFor,
  tlAncestorOf,
} from '../../src/modules/workspace/utils/teamWorkspaceData';
import { summarizeTeamTotals } from '../../src/modules/team/services/teamOverviewService';
import type { TeamOverviewPerson } from '../../src/modules/team/services/teamOverviewService';
import type { Lead } from '../../src/modules/shared/types';
import type { FollowUpQueueItem } from '../../src/modules/leads/services/leadService';
import { _setTestPoolForTest, _resetPoolsForTest, closePool } from '../database/connection.js';
import { getPGliteInstanceAsync, createPGlitePoolAsync, resetPGlite } from '../database/pglitePool.js';
import productionRoutes from '../routes/production.routes.js';
import { JWT_SECRET } from '../routes/production/shared.js';
import { seedRoles } from '../database/seeds/roles.seed.js';
import { applyDefaultRoleAccess } from '../database/roleAccessDefaults.js';
import { DEFAULT_GRANTS } from '../../src/modules/shared/access/roleGrantDefaults.js';

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
 * The org for every scope test:
 *
 *   CEO1 ── MGR1 ── TL001 ── EMPA ── EMPC
 *    │       │       └──── EMPB
 *    │       └──── TL002 ── EMPD
 *    └── OUT1
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
  person({ employeeId: 'CEO1', roleName: 'CEO', directReports: 2 }),
  person({ employeeId: 'MGR1', roleName: 'MANAGER', managerEmployeeId: 'CEO1', directReports: 2 }),
  person({ employeeId: 'TL001', roleName: 'TEAM_LEAD', managerEmployeeId: 'MGR1', directReports: 2, department: 'North Team', isSelf: false }),
  person({ employeeId: 'EMPA', roleName: 'EMPLOYEE', managerEmployeeId: 'TL001', directReports: 1, openLeads: 3, convertedLeads: 1, dueToday: 2, overdue: 1, totalLeads: 5, noActionLeads: 1 }),
  person({ employeeId: 'EMPB', roleName: 'EMPLOYEE', managerEmployeeId: 'TL001', openLeads: 2, convertedLeads: 0, dueToday: 0, overdue: 0, totalLeads: 2, noActionLeads: 0 }),
  person({ employeeId: 'EMPC', roleName: 'EMPLOYEE', managerEmployeeId: 'EMPA', openLeads: 1, convertedLeads: 2, dueToday: 1, overdue: 0, totalLeads: 4, noActionLeads: 0 }),
  person({ employeeId: 'TL002', roleName: 'TEAM_LEAD', managerEmployeeId: 'MGR1', directReports: 1 }),
  person({ employeeId: 'EMPD', roleName: 'EMPLOYEE', managerEmployeeId: 'TL002', openLeads: 4, convertedLeads: 0, dueToday: 3, overdue: 2, totalLeads: 6, noActionLeads: 1 }),
  person({ employeeId: 'OUT1', roleName: 'EMPLOYEE', managerEmployeeId: 'CEO1' }),
  person({ employeeId: 'ADMIN1', roleName: 'ADMIN', openLeads: 9, convertedLeads: 9, dueToday: 9, overdue: 9, totalLeads: 99, noActionLeads: 9 }),
];

const byId = (employeeId: string) => ORG.find(p => p.employeeId === employeeId)!;

/** A lead with only the fields the helpers read (cast — the type is wide). */
function lead(overrides: Partial<Lead> & { id: string }): Lead {
  return {
    id: overrides.id,
    customerName: `Lead ${overrides.id}`,
    mobile: '01700000000',
    currentStatus: overrides.currentStatus ?? 'New',
    assignedTo: overrides.assignedTo ?? '',
    assignedBy: '',
    createdBy: overrides.createdBy ?? null,
    createdByEmployeeId: overrides.createdByEmployeeId ?? '',
    timestamp: overrides.timestamp ?? '2026-11-20T04:00:00.000Z',
    creationDate: overrides.creationDate,
    nextFollowUpDate: overrides.nextFollowUpDate,
    statusHistory: overrides.statusHistory ?? [],
    ...overrides,
  } as Lead;
}

const LEADS: Lead[] = [
  // L1: member-assigned, TL-created (appears in BOTH Team Leads and My Leads).
  lead({ id: 'L1', assignedTo: 'EMPA', createdByEmployeeId: 'TL001', currentStatus: 'Contacted' }),
  // L2: the TL's own lead.
  lead({ id: 'L2', assignedTo: 'TL001', createdByEmployeeId: 'TL001', currentStatus: 'Interested' }),
  // L3: member-assigned, member-created.
  lead({ id: 'L3', assignedTo: 'EMPB', createdByEmployeeId: 'EMPA', currentStatus: 'New' }),
  // L4: outsider-assigned, member-created.
  lead({ id: 'L4', assignedTo: 'OUT1', createdByEmployeeId: 'EMPA', currentStatus: 'New' }),
  // L5: unassigned, TL-created (distribution stock).
  lead({ id: 'L5', assignedTo: '', createdByEmployeeId: 'TL001', currentStatus: 'New' }),
  // L6: unassigned, member-created.
  lead({ id: 'L6', assignedTo: '', createdByEmployeeId: 'EMPA', currentStatus: 'New' }),
  // L7: admin-assigned (never in any report data).
  lead({ id: 'L7', assignedTo: 'ADMIN1', createdByEmployeeId: 'ADMIN1', currentStatus: 'Converted' }),
  // L8: the other TL's member.
  lead({ id: 'L8', assignedTo: 'EMPD', createdByEmployeeId: 'TL002', currentStatus: 'Follow-up Set' }),
  // L9: the manager's own lead.
  lead({ id: 'L9', assignedTo: 'MGR1', createdByEmployeeId: 'MGR1', currentStatus: 'New' }),
];

const ids = (leads: Lead[]) => leads.map(l => l.id).sort();

describe('isoWeekNumber — the real ISO week of a Dhaka date', () => {
  it('pins known weeks (2026-11-20 is week 47, as in the demo)', () => {
    assert.equal(isoWeekNumber(new Date('2026-01-01T06:00:00.000Z')), 1, 'Jan 1 2026 (Thu) is week 1');
    assert.equal(isoWeekNumber(new Date('2026-01-05T06:00:00.000Z')), 2, 'Jan 5 2026 (Mon) is week 2');
    assert.equal(isoWeekNumber(new Date('2026-11-20T06:00:00.000Z')), 47, 'Nov 20 2026 (Fri) is week 47');
    assert.equal(isoWeekNumber(new Date('2025-12-29T06:00:00.000Z')), 1, 'Dec 29 2025 (Mon) is week 1 of 2026');
    assert.equal(isoWeekNumber(new Date('2026-12-31T06:00:00.000Z')), 53, 'Dec 31 2026 (Thu) is week 53');
  });

  it('uses the Dhaka date, not the UTC date (a 00:30 Dhaka instant is the next day)', () => {
    // 2025-12-31T18:30Z is 2026-01-01 00:30 in Dhaka — week 1, not week 53.
    assert.equal(isoWeekNumber(new Date('2025-12-31T18:30:00.000Z')), 1);
  });
});

describe('scopePeople — the in-scope people per role, admins removed', () => {
  it('Team Lead: self + the full downline (grand-reports included)', () => {
    const people = scopePeople(ORG, byId('TL001'), 'teamLead').map(p => p.employeeId).sort();
    assert.deepEqual(people, ['EMPA', 'EMPB', 'EMPC', 'TL001']);
  });

  it('Manager: self + the full downline across teams', () => {
    const people = scopePeople(ORG, byId('MGR1'), 'manager').map(p => p.employeeId).sort();
    assert.deepEqual(people, ['EMPA', 'EMPB', 'EMPC', 'EMPD', 'MGR1', 'TL001', 'TL002']);
  });

  it('Admin: everyone visible minus admin-role users (never a seller)', () => {
    const people = scopePeople(ORG, byId('ADMIN1'), 'admin').map(p => p.employeeId);
    assert.ok(!people.includes('ADMIN1'), 'the admin themself is excluded');
    assert.equal(people.length, ORG.length - 1, 'everyone else stays');
  });

  it('Agent: just the caller themself', () => {
    assert.deepEqual(scopePeople(ORG, byId('EMPA'), 'agent').map(p => p.employeeId), ['EMPA']);
  });

  it('isAdminPerson matches ADMIN / SUPERADMIN case-insensitively', () => {
    assert.equal(isAdminPerson(byId('ADMIN1')), true);
    assert.equal(isAdminPerson(person({ employeeId: 'X1', roleName: 'superadmin' })), true);
    assert.equal(isAdminPerson(byId('CEO1')), false);
    assert.equal(isAdminPerson(byId('MGR1')), false);
  });
});

describe('summarizeTeamTotals over the scope — the server overview totals, admins excluded', () => {
  // The shared helper (teamOverviewService) sums the scope — the
  // team-workspace module must NOT keep its own duplicate summation
  // (scopeTotals was removed as a duplicate).
  it('sums every column over the TL scope (the admin row must not leak in)', () => {
    const totals = summarizeTeamTotals(scopePeople(ORG, byId('TL001'), 'teamLead'));
    assert.deepEqual(totals, {
      totalLeads: 11, // 5 + 2 + 4 + 0 (TL001 carries none in the fixture)
      open: 6,
      dueToday: 3,
      overdue: 1,
      converted: 3,
      todayCollection: 0,
      noAction: 1,
    });
  });

  it('the Admin scope totals exclude the admin row (99 leads must not inflate them)', () => {
    const totals = summarizeTeamTotals(scopePeople(ORG, byId('ADMIN1'), 'admin'));
    assert.equal(totals.totalLeads, 17, '5 + 2 + 4 + 6, not +99');
    assert.equal(totals.overdue, 3, '1 + 2, not +9');
  });
});

describe('leadCreatorEmployeeId — creator matching in either id space', () => {
  const peopleByUserId = new Map(ORG.map(p => [p.userId, p]));

  it('prefers the employee id when the server exposed it', () => {
    assert.equal(
      leadCreatorEmployeeId(lead({ id: 'X', createdByEmployeeId: 'empa', createdBy: 'u-EMPB' }), peopleByUserId),
      'EMPA',
    );
  });

  it('falls back to the users.id UUID through the roster map', () => {
    assert.equal(
      leadCreatorEmployeeId(lead({ id: 'X', createdBy: 'u-EMPC' }), peopleByUserId),
      'EMPC',
    );
  });

  it('returns empty for an unknown UUID and for no creator at all', () => {
    assert.equal(leadCreatorEmployeeId(lead({ id: 'X', createdBy: 'u-NOBODY' }), peopleByUserId), '');
    assert.equal(leadCreatorEmployeeId(lead({ id: 'X' }), peopleByUserId), '');
  });
});

describe('teamLeadsForRole — the Team Leads page set per role (Mahadi’s 2026-11-20 correction)', () => {
  it('Team Lead: members-only — NOT the TL’s own leads', () => {
    // L1 member-assigned ✓, L3 member-assigned ✓, L4 member-created
    // outsider-assigned ✓, L5 TL-created unassigned ✓ (distribution
    // stock), L6 member-created unassigned ✓ (a member's lead — the
    // TL distributes it too). L2 is the TL's OWN lead → My Leads,
    // not Team Leads. L7 admin-assigned, L8 the other TL's team.
    assert.deepEqual(ids(teamLeadsForRole(LEADS, ORG, byId('TL001'), 'teamLead')), ['L1', 'L3', 'L4', 'L5', 'L6']);
  });

  it('Team Lead: a TL-created lead assigned to a member appears in BOTH Team Leads and My Leads', () => {
    // Inherent in Mahadi's two definitions (assignee ∈ downline /
    // creator = self) — reported as such, not "fixed" away.
    const team = ids(teamLeadsForRole(LEADS, ORG, byId('TL001'), 'teamLead'));
    const mine = ids(myLeadsFor(LEADS, ORG, byId('TL001')));
    assert.ok(team.includes('L1'), 'L1 is in Team Leads (assignee EMPA)');
    assert.ok(mine.includes('L1'), 'L1 is in My Leads (creator TL001)');
  });

  it('Manager: assignee or creator in scope; unassigned needs a creator in scope', () => {
    // Everything except L7 (admin-assigned, admin-created).
    assert.deepEqual(ids(teamLeadsForRole(LEADS, ORG, byId('MGR1'), 'manager')), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L8', 'L9']);
  });

  it('Admin: every visible lead except admin-assigned ones (unassigned included)', () => {
    assert.deepEqual(ids(teamLeadsForRole(LEADS, ORG, byId('ADMIN1'), 'admin')), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L8', 'L9']);
  });

  it('Agent: unchanged — the server scope is already own-only', () => {
    assert.equal(teamLeadsForRole(LEADS, ORG, byId('EMPA'), 'agent'), LEADS, 'the list passes through untouched');
  });
});

describe('myLeadsFor — the TL’s My Leads set (assigned OR created by the TL)', () => {
  it('carries exactly the TL’s own leads', () => {
    assert.deepEqual(ids(myLeadsFor(LEADS, ORG, byId('TL001'))), ['L1', 'L2', 'L5']);
  });

  it('never carries a member’s lead the TL did not create', () => {
    const mine = ids(myLeadsFor(LEADS, ORG, byId('TL001')));
    assert.ok(!mine.includes('L3'), 'L3 belongs to EMPB, created by EMPA');
    assert.ok(!mine.includes('L4'), 'L4 belongs to OUT1, created by EMPA');
  });
});

describe('scopeLeadsByAssignee — the home aggregates count assignees, not creators', () => {
  it('counts only leads owned by someone in scope', () => {
    const scopeIds = new Set(scopePeople(ORG, byId('TL001'), 'teamLead').map(p => p.employeeId));
    // L4 is member-created but outsider-owned: it belongs to the
    // Team Leads page list, NOT to the home totals.
    assert.deepEqual(ids(scopeLeadsByAssignee(LEADS, scopeIds)), ['L1', 'L2', 'L3']);
  });
});

describe('contactedCount — the Agent definition, reused at team scope', () => {
  it('counts the contacted statuses only', () => {
    // L1 Contacted, L2 Interested, L7 Converted, L8 Follow-up Set.
    // (Converted IS a contacted status in the Agent definition —
    // a converted lead was reached at least once.)
    assert.equal(contactedCount(LEADS), 4);
  });
});

describe('memberCompletions — ONE follow-up completion % definition, both pages', () => {
  // now = 2026-11-20 10:00 Dhaka. The history entry at 09:00 Dhaka
  // falls on the same Dhaka day under BOTH test timezones.
  const NOW = new Date('2026-11-20T04:00:00.000Z'); // 10:00 Dhaka
  const doneToday = lead({
    id: 'DONE1',
    assignedTo: 'EMPA',
    statusHistory: [{ date: '2026-11-20T03:00:00.000Z', status: 'Contacted' } as any],
  });

  it('completed / (completed + due + overdue), rounded', () => {
    const completions = memberCompletions(ORG, [doneToday], NOW);
    // EMPA: 1 completed, 2 due, 1 overdue → 1/4 = 25%.
    assert.deepEqual(completions.get('EMPA'), { completed: 1, dueToday: 2, overdue: 1, pct: 25 });
  });

  it('null ("—") when nothing was due or done', () => {
    const completions = memberCompletions(ORG, [doneToday], NOW);
    assert.deepEqual(completions.get('EMPB'), { completed: 0, dueToday: 0, overdue: 0, pct: null });
  });

  it('counts completions per assignee only (a TL completion is not a member’s)', () => {
    const tlDone = lead({
      id: 'DONE2',
      assignedTo: 'TL001',
      statusHistory: [{ date: '2026-11-20T03:00:00.000Z', status: 'Contacted' } as any],
    });
    const completions = memberCompletions(ORG, [doneToday, tlDone], NOW);
    assert.equal(completions.get('EMPA')!.completed, 1);
    assert.equal(completions.get('TL001')!.completed, 1);
    assert.equal(completions.get('TL001')!.pct, 100, '1 / (1 + 0 + 0)');
  });
});

describe('followUpHealth — three independent bars from real activity', () => {
  const NOW = new Date('2026-11-20T04:00:00.000Z'); // 10:00 Dhaka
  const scope = scopePeople(ORG, byId('TL001'), 'teamLead');

  it('Due today / Overdue are shares of the follow-up universe', () => {
    const done = lead({
      id: 'DONE1',
      assignedTo: 'EMPA',
      statusHistory: [{ date: '2026-11-20T03:00:00.000Z', status: 'Contacted' } as any],
    });
    const health = followUpHealth(scope, [done], NOW);
    // Universe = 1 completed + 3 due + 1 overdue = 5.
    assert.equal(health.completed, 1);
    assert.equal(health.total, 5);
    assert.equal(health.dueTodayPct, 60, '3/5');
    assert.equal(health.overduePct, 20, '1/5');
  });

  it('On time is null when nothing completed today is measurable (never invented)', () => {
    // A single history entry has no previous scheduled date — unmeasurable.
    const done = lead({
      id: 'DONE1',
      assignedTo: 'EMPA',
      statusHistory: [{ date: '2026-11-20T03:00:00.000Z', status: 'Contacted' } as any],
    });
    assert.equal(followUpHealth(scope, [done], NOW).onTimePct, null);
  });

  it('On time is the real rate when measurable (logged by the previous entry’s date)', () => {
    const onTime = lead({
      id: 'ONTIME',
      assignedTo: 'EMPA',
      statusHistory: [
        { date: '2026-11-19T03:00:00.000Z', status: 'Follow-up Set', nextFollowUpDate: '2026-11-20T05:00:00.000Z' } as any,
        { date: '2026-11-20T03:00:00.000Z', status: 'Contacted' } as any,
      ],
    });
    const late = lead({
      id: 'LATE',
      assignedTo: 'EMPB',
      statusHistory: [
        { date: '2026-11-19T03:00:00.000Z', status: 'Follow-up Set', nextFollowUpDate: '2026-11-20T01:00:00.000Z' } as any,
        { date: '2026-11-20T03:00:00.000Z', status: 'Contacted' } as any,
      ],
    });
    assert.equal(followUpHealth(scope, [onTime, late], NOW).onTimePct, 50, '1 of 2 on time');
  });

  it('an empty universe is 0/0, not a division error', () => {
    const health = followUpHealth([], [], NOW);
    assert.deepEqual(
      { total: health.total, dueTodayPct: health.dueTodayPct, overduePct: health.overduePct, onTimePct: health.onTimePct },
      { total: 0, dueTodayPct: 0, overduePct: 0, onTimePct: null },
    );
  });
});

describe('atRiskLeads — overdue follow-up OR no activity in 48h', () => {
  const NOW = new Date('2026-11-20T04:00:00.000Z'); // 10:00 Dhaka
  const overdueItem = (id: string): FollowUpQueueItem => ({ id, leadId: id } as unknown as FollowUpQueueItem);

  it('overdue items come first (earliest due first), then no-activity (oldest first)', () => {
    const overdueLead = lead({
      id: 'OD1', assignedTo: 'EMPA', currentStatus: 'Follow-up Set',
      nextFollowUpDate: '2026-11-18T04:00:00.000Z',
      timestamp: '2026-11-19T04:00:00.000Z',
    });
    const quietOld = lead({
      id: 'Q1', assignedTo: 'EMPB', currentStatus: 'New',
      timestamp: '2026-11-15T04:00:00.000Z', // 5 days ago
    });
    const quietNew = lead({
      id: 'Q2', assignedTo: 'EMPB', currentStatus: 'New',
      timestamp: '2026-11-17T04:00:00.000Z', // 3 days ago
    });
    const result = atRiskLeads([quietNew, quietOld, overdueLead], [overdueItem('OD1')], NOW);
    assert.deepEqual(result.map(r => [r.lead.id, r.reason]), [
      ['OD1', 'overdue'],
      ['Q1', 'no-activity'],
      ['Q2', 'no-activity'],
    ]);
  });

  it('a scheduled future follow-up is never at-risk', () => {
    const scheduled = lead({
      id: 'S1', assignedTo: 'EMPA', currentStatus: 'New',
      timestamp: '2026-11-10T04:00:00.000Z', // 10 days ago — but worked
      nextFollowUpDate: '2026-11-21T04:00:00.000Z', // tomorrow
    });
    assert.deepEqual(atRiskLeads([scheduled], [], NOW), []);
  });

  it('recent activity (under 48h) is not at-risk, and terminal leads never are', () => {
    const fresh = lead({ id: 'F1', assignedTo: 'EMPA', currentStatus: 'New', timestamp: '2026-11-19T05:00:00.000Z' });
    const converted = lead({ id: 'C1', assignedTo: 'EMPA', currentStatus: 'Converted', timestamp: '2026-11-01T04:00:00.000Z' });
    const notInterested = lead({ id: 'N1', assignedTo: 'EMPA', currentStatus: 'Not Interested', timestamp: '2026-11-01T04:00:00.000Z' });
    assert.deepEqual(atRiskLeads([fresh, converted, notInterested], [overdueItem('C1')], NOW), []);
  });

  it('an overdue item with no loaded lead is skipped, never fabricated', () => {
    assert.deepEqual(atRiskLeads([], [overdueItem('GHOST')], NOW), []);
  });
});

describe('tlAncestorOf + groupLeadsByTl — the Manager drill-down (Manager → TL → member → lead)', () => {
  it('walks up to the nearest person with ≥1 direct report; a TL is their own group', () => {
    assert.equal(tlAncestorOf(ORG, 'EMPC', 'MGR1')!.employeeId, 'EMPA');
    assert.equal(tlAncestorOf(ORG, 'EMPB', 'MGR1')!.employeeId, 'TL001');
    assert.equal(tlAncestorOf(ORG, 'TL001', 'MGR1')!.employeeId, 'TL001');
    assert.equal(tlAncestorOf(ORG, 'EMPD', 'MGR1')!.employeeId, 'TL002');
    assert.equal(tlAncestorOf(ORG, 'MGR1', 'MGR1')!.employeeId, 'MGR1');
  });

  it('the caller is the fallback group for their own leads', () => {
    // OUT1's manager is CEO1 (2 reports) — OUT1 groups under CEO1,
    // not under the caller.
    assert.equal(tlAncestorOf(ORG, 'OUT1', 'MGR1')!.employeeId, 'CEO1');
  });

  it('is cycle-safe and returns null when no TL exists on the walk', () => {
    const cyclic = [
      person({ employeeId: 'A', managerEmployeeId: 'B' }),
      person({ employeeId: 'B', managerEmployeeId: 'A' }),
    ];
    assert.equal(tlAncestorOf(cyclic, 'A', 'MGR1'), null);
    assert.equal(tlAncestorOf([], 'EMPA', 'MGR1'), null);
  });

  it('groups every lead under its owner’s TL (unassigned under the creator’s TL), newest first', () => {
    const groups = groupLeadsByTl(LEADS, ORG, byId('MGR1'));
    const byTl = new Map(groups.map(g => [g.tl.employeeId, g.leads.map(l => l.id)]));
    // EMPA's group: L1 (owner EMPA) + L6 (unassigned, creator EMPA).
    assert.deepEqual(byTl.get('EMPA')!.sort(), ['L1', 'L6']);
    // TL001's group: L2 (owner TL001), L3 (owner EMPB), L5 (unassigned, creator TL001).
    assert.deepEqual(byTl.get('TL001')!.sort(), ['L2', 'L3', 'L5']);
    // TL002's group: L8 (owner EMPD).
    assert.deepEqual(byTl.get('TL002'), ['L8']);
    // L4 (owner OUT1) groups under CEO1; L7 (owner ADMIN1) has no
    // TL ancestor in the payload — it groups under the caller.
    assert.deepEqual(byTl.get('CEO1'), ['L4']);
    assert.deepEqual(byTl.get('MGR1')!.sort(), ['L7', 'L9']);
  });

  it('groups sort by TL name', () => {
    const groups = groupLeadsByTl(LEADS, ORG, byId('MGR1'));
    const names = groups.map(g => g.tl.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  it('no lead is ever dropped — an ownerless, creatorless lead groups under the caller', () => {
    const orphan = lead({ id: 'ORPHAN', assignedTo: '', createdByEmployeeId: '' });
    const groups = groupLeadsByTl([orphan], ORG, byId('MGR1'));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tl.employeeId, 'MGR1');
    assert.deepEqual(groups[0].leads.map(l => l.id), ['ORPHAN']);
  });
});

describe('memberStatus + teamNameFor — the roster status and the home subtitle', () => {
  it('overdue work needs attention; otherwise on track', () => {
    assert.equal(memberStatus(byId('EMPA')), 'Needs attention');
    assert.equal(memberStatus(byId('EMPB')), 'On track');
  });

  it('Admin sees "Whole organisation"; TL/Manager see their department, else "{firstName}’s team"', () => {
    assert.equal(teamNameFor(byId('ADMIN1'), 'admin', 'Admin One'), 'Whole organisation');
    assert.equal(teamNameFor(byId('TL001'), 'teamLead', 'Imran Hossain'), 'North Team');
    assert.equal(teamNameFor(byId('MGR1'), 'manager', 'Imran Hossain'), 'Imran’s team');
    assert.equal(teamNameFor(byId('MGR1'), 'manager', null), 'My’s team');
  });
});

describe('Reassign visibility — the shared hook (never for a plain Agent)', () => {
  const hook = stripComments(read('src/modules/leads/hooks/useCanReassign.ts'));

  it('hides Reassign when the DISPLAY role is agent (super-admin preview-as-Agent)', () => {
    assert.ok(hook.includes("if (displayRole === 'agent') return false;"), 'preview-as-Agent hides the button');
  });

  it('allows Admin, anyone with a team, and Managers — and only with the leads.assign grant', () => {
    assert.ok(hook.includes("userRoleUpper === 'ADMIN' || userRoleUpper === 'SUPERADMIN'"), 'admins pass');
    assert.ok(hook.includes('callerHasTeam(callerTeam.overview?.people)'), 'team leads pass on the tree fact');
    assert.ok(hook.includes("realRole === 'manager'"), 'managers pass on the derived role');
    assert.ok(hook.includes("if (!isAdmin && !hasTeam && !isManager) return false;"), 'a plain agent fails all three arms');
    assert.ok(hook.includes("canAccess('lead_tracking', 'reassign_global_leads')"), 'the grant is enforced last');
  });

  it('Lead360 and the lead list BOTH use the hook (no inline gate to drift)', () => {
    for (const file of ['src/modules/leads/pages/Lead360.tsx', 'src/modules/leads/pages/LeadList.tsx']) {
      const code = stripComments(read(file));
      assert.ok(code.includes("import { useCanReassign } from '../hooks/useCanReassign';"), `${file} imports the hook`);
      assert.ok(code.includes('const canReassign = useCanReassign();'), `${file} calls the hook`);
      assert.ok(!code.includes('reassign_global_leads'), `${file} must not inline the grant check`);
    }
  });

  it('the target picker follows the real role and never offers an admin', () => {
    const dialog = stripComments(read('src/modules/leads/components/ReassignLeadDialog.tsx'));
    assert.ok(dialog.includes('downlineOf'), 'a Team Lead picks from their downline');
    assert.ok(dialog.includes('isAdminPerson'), 'admin-role people are excluded from targets');
  });
});

describe('Follow-up Monitor — the Team/Self toggle (Team Lead only)', () => {
  const page = stripComments(read('src/modules/leads/pages/FollowUpStrategy.tsx'));

  it('renders a Team / Self toggle above the list, Team Lead only', () => {
    assert.ok(page.includes('ep-scope-toggle'), 'the toggle renders');
    assert.ok(page.includes("useState<'team' | 'self'>('team')"), 'the toggle state is team | self, defaulting to team');
    assert.ok(page.includes("displayRole === 'teamLead'"), 'only the Team Lead sees the toggle');
  });

  it('Self loads the caller’s own follow-ups through the assignedTo param', () => {
    assert.ok(page.includes('assignedTo: user.employeeId'), 'the Self load narrows by assignee');
    assert.ok(page.includes('leadService.getFollowUpQueue({ bucket, limit: 100, assignedTo: user.employeeId })'), 'the Self load is a second, narrowed queue read');
    assert.ok(page.includes("listScope === 'self' ? selfData?.items : data?.items"), 'the list (not the KPI cards) follows the toggle');
  });

  it('the KPI cards stay team-wide (the toggle changes the LIST only)', () => {
    // The KPI cards render from the team bucket load (`data`), not
    // from the Self result — the toggle note says so plainly.
    assert.ok(page.includes('ep-scope-toggle-note'), 'the toggle carries an explanatory note');
  });

  it('Manager groups the list by Team Lead (expandable groups, member sub-groups)', () => {
    assert.ok(page.includes('managerGroups'), 'the Manager grouping memo exists');
    assert.ok(page.includes('ep-tlgroup'), 'the TL group cards render');
    assert.ok(page.includes('expandedTls'), 'the groups expand');
  });
});

describe('Honest metrics — no target % anywhere in the new workspaces', () => {
  const NEW_FILES = [
    'src/modules/workspace/pages/TeamOverviewHome.tsx',
    'src/modules/team/pages/TeamOverview.tsx',
    'src/modules/dashboard/pages/ExecutionIntelligence.tsx',
    'src/modules/dashboard/pages/SelfPerformance.tsx',
    'src/modules/users/pages/TeamUserManagement.tsx',
    'src/modules/leads/pages/FollowUpStrategy.tsx',
    'src/modules/leads/pages/LeadList.tsx',
  ];

  it('no invented target / capacity metric renders (Phase 3 is undecided)', () => {
    for (const file of NEW_FILES) {
      const code = stripComments(read(file));
      for (const banned of ['Target progress', 'Avg. target', 'Capacity used', 'Monthly target', 'target %', 'Target %']) {
        assert.ok(!code.includes(banned), `${file} must not render "${banned}"`);
      }
    }
  });

  it('the member % is labelled Follow-up completion in both places (ONE definition)', () => {
    assert.ok(stripComments(read('src/modules/workspace/pages/TeamOverviewHome.tsx')).includes('Follow-up completion'), 'Team Overview labels the member %');
    assert.ok(stripComments(read('src/modules/team/pages/TeamOverview.tsx')).includes('Follow-up completion'), 'Team Members labels the member % the same way');
  });

  it('the capacity substitution is an honest count (Avg. active leads)', () => {
    const team = stripComments(read('src/modules/team/pages/TeamOverview.tsx'));
    assert.ok(team.includes('Avg. active leads'), 'the Team Members KPI card is Avg. active leads');
    assert.ok(!team.includes('Capacity used'), 'no Capacity used card');
  });
});

describe('usePermissions — the add_employee compound action maps to users.add_employee', () => {
  it('COMPOUND_ACTION_TO_CODE carries add_employee (else the grant would fall through to users.view)', () => {
    const hook = stripComments(read('src/modules/shared/hooks/usePermissions.ts'));
    assert.ok(hook.includes("add_employee: 'add_employee'"), 'add_employee maps to the users.add_employee code');
  });
});

describe('Task Calendar — dual bookings (own vs team, visually distinguished)', () => {
  const cal = stripComments(read('src/modules/auth/pages/TaskCalendar.tsx'));

  it('every event carries isOwn + ownerName, resolved from the team overview roster', () => {
    assert.ok(cal.includes('isOwn: boolean'), 'CalendarEvent carries isOwn');
    assert.ok(cal.includes('ownerName?: string | null'), 'CalendarEvent carries ownerName');
    assert.ok(cal.includes('useCallerTeam()'), 'owner names come from the team overview');
    assert.ok(cal.includes('ownerNameByUserId'), 'the roster maps users.id to names');
  });

  it('team bookings render distinguished (dashed pill, T marker, legend) in every view', () => {
    assert.ok(cal.includes("'is-team'"), 'month pills + time-grid events mark team bookings');
    assert.ok(cal.includes('lf-cal-pill-team'), 'the T marker renders on month pills');
    assert.ok(cal.includes('ep-cal-legend'), 'the legend explains the two kinds');
    assert.ok(cal.includes('Team booking'), 'the detail modal names team bookings');
  });

  it('edit behaviour is unchanged — the existing gate still owns it', () => {
    assert.ok(cal.includes("canEditScheduled = canAccess('lead_tracking', 'edit')"), 'the edit gate is untouched');
  });
});


/* ------------------------------------------------------------------ */
/* Part 2 — migration 063 + POST /api/users/employee (PGlite)         */
/* ------------------------------------------------------------------ */

// Sign with the server's own secret (shared.js captures it at module
// load, before any test-time env assignment can take effect).
const sign = (p: Record<string, any>) => jwt.sign(p, JWT_SECRET, { expiresIn: '1h' });

describe('Migration 063 + POST /api/users/employee — the admin-granted Employee add (PGlite, real grants)', () => {
  let app: express.Express;
  let pool: any;
  let adminId: string;
  let deptId: string;
  let ceo: any;
  let tl: any;
  let e1: any;
  let mgr: any;
  let agent: any;

  const adminToken = () => sign({ id: adminId, employeeId: 'ADMIN1', role: 'ADMIN', email: 'admin@test.com' });
  const tokenFor = (u: any, role: string) => sign({ id: u.id, employeeId: u.employeeId, role, email: u.email });

  const addUser = async (employeeId: string, role: string, managerId?: string) => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        employeeId,
        fullName: `Person ${employeeId}`,
        email: `${employeeId.toLowerCase()}@test.com`,
        role,
        departmentId: deptId,
        managerId: role === 'CEO' ? undefined : (managerId || ceo.id),
        status: 'Active',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  /** Grant one permission code to one role (the Roles & Access save path, minus the UI). */
  const grantCode = async (roleCode: string, permissionCode: string) => {
    const role: any = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = $1 LIMIT 1`, [roleCode]);
    const perm: any = await pool.query(`SELECT id FROM permissions WHERE permission_code = $1 LIMIT 1`, [permissionCode]);
    assert.ok(role.rows.length === 1, `role ${roleCode} exists`);
    assert.ok(perm.rows.length === 1, `permission ${permissionCode} exists`);
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id, is_allowed) VALUES ($1, $2, TRUE) ON CONFLICT DO NOTHING`,
      [role.rows[0].id, perm.rows[0].id],
    );
  };

  before(async () => {
    // A non-empty DATABASE_URL is the `useDb()` flag; the pool itself
    // is in-memory PGlite (no real server is contacted). Assembled
    // from fragments: a literal here would be redacted on write.
    process.env.DATABASE_URL = ['postgres', '://', 'test', '@', 'localhost', '/test'].join('');
    process.env.NODE_ENV = 'test';
    await resetPGlite();
    await getPGliteInstanceAsync();
    pool = await createPGlitePoolAsync();
    _setTestPoolForTest(pool);

    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    await seedRoles();
    await applyDefaultRoleAccess();

    const adminRole = await pool.query(`SELECT id FROM roles WHERE UPPER(role_code) = 'ADMIN' LIMIT 1`);
    const admin = await pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active)
       VALUES ('ADMIN1', 'System Admin', 'admin@test.com', 'x', $1, TRUE) RETURNING id`,
      [adminRole.rows[0].id]
    );
    adminId = admin.rows[0].id;

    app = express();
    app.use(express.json());
    app.use('/api', productionRoutes);
  });

  after(async () => {
    await closePool();
    _resetPoolsForTest();
    delete process.env.DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM audit_logs');
    await pool.query('DELETE FROM leads');
    await pool.query('DELETE FROM department_members');
    await pool.query(`DELETE FROM teams WHERE is_department_mirror`);
    await pool.query(`DELETE FROM users WHERE employee_id <> 'ADMIN1'`);
    await pool.query('DELETE FROM departments');
    await pool.query(`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE UPPER(role_code) IN ('TEAM_LEAD', 'MANAGER', 'EMPLOYEE'))`);

    const dept = await request(app)
      .post('/api/departments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ name: 'Sales', code: 'SALES' });
    assert.equal(dept.status, 200, JSON.stringify(dept.body));
    deptId = dept.body.id;

    ceo = await addUser('CEO1', 'CEO');
    tl = await addUser('TL001', 'TEAM_LEAD');
    e1 = await addUser('EMP001', 'EMPLOYEE', tl.id);
    mgr = await addUser('MGR1', 'MANAGER');
    agent = await addUser('AGENT1', 'EMPLOYEE');
  });

  it('migration 063 seeds the users.add_employee definition (Users / ADD_EMPLOYEE), idempotently', async () => {
    const rows: any = await pool.query(
      `SELECT permission_code, module_name, action_name FROM permissions WHERE permission_code = 'users.add_employee'`
    );
    assert.equal(rows.rows.length, 1, 'exactly one definition row');
    assert.deepEqual(
      [rows.rows[0].permission_code, rows.rows[0].module_name, rows.rows[0].action_name],
      ['users.add_employee', 'Users', 'ADD_EMPLOYEE'],
    );
    // Re-running the migration is a no-op (ON CONFLICT DO NOTHING).
    const { runMigrations } = await import('../database/runMigrations.js');
    await runMigrations();
    const again: any = await pool.query(
      `SELECT COUNT(*) AS n FROM permissions WHERE permission_code = 'users.add_employee'`
    );
    assert.equal(Number(again.rows[0].n), 1, 'still exactly one row after a re-run');
  });

  it('NO role holds users.add_employee by default — the admin grants it per role', () => {
    for (const [role, grants] of Object.entries(DEFAULT_GRANTS)) {
      assert.ok(!grants.includes('users.add_employee'), `${role} must not hold users.add_employee by default`);
    }
  });

  it('a Team Lead WITHOUT the grant is refused — 403, nothing written', async () => {
    const res = await request(app)
      .post('/api/users/employee')
      .set('Authorization', `Bearer ${tokenFor(tl, 'TEAM_LEAD')}`)
      .send({
        fullName: 'New Hire',
        employeeId: 'NEW001',
        email: 'new001@test.com',
        password: 'TempPass123',
        mustChangePassword: true,
      });
    assert.equal(res.status, 403, `ungranted TL add should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
    const rows: any = await pool.query(`SELECT COUNT(*) AS n FROM users WHERE employee_id = 'NEW001'`);
    assert.equal(Number(rows.rows[0].n), 0, 'no user was created');
  });

  it('a granted Team Lead adds an Employee who reports to them, in their department', async () => {
    await grantCode('TEAM_LEAD', 'users.add_employee');
    const res = await request(app)
      .post('/api/users/employee')
      .set('Authorization', `Bearer ${tokenFor(tl, 'TEAM_LEAD')}`)
      .send({
        fullName: 'New Hire',
        employeeId: 'NEW001',
        email: 'new001@test.com',
        phone: '01700000901',
        designation: 'Relationship Officer',
        password: 'TempPass123',
        mustChangePassword: true,
      });
    assert.equal(res.status, 201, `granted TL add should succeed, got ${res.status} ${JSON.stringify(res.body)}`);

    const rows: any = await pool.query(
      `SELECT u.employee_id, u.manager_id, u.department_id, u.must_change_password, r.role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.employee_id = 'NEW001'`
    );
    assert.equal(rows.rows.length, 1, 'the employee was created');
    const created = rows.rows[0];
    assert.equal(created.role_code, 'EMPLOYEE', 'the new user is an Employee');
    assert.equal(created.manager_id, tl.id, 'the new user reports to the adding Team Lead');
    assert.equal(created.department_id, deptId, 'the new user is in the TL’s department');
    assert.equal(created.must_change_password, true, 'the temp password must change on first login');
  });

  it('the server FORCES Employee + reports-to-caller — a hostile payload cannot escalate', async () => {
    await grantCode('TEAM_LEAD', 'users.add_employee');
    const res = await request(app)
      .post('/api/users/employee')
      .set('Authorization', `Bearer ${tokenFor(tl, 'TEAM_LEAD')}`)
      .send({
        fullName: 'Sneaky Hire',
        employeeId: 'NEW002',
        email: 'new002@test.com',
        password: 'TempPass123',
        mustChangePassword: true,
        // The caller tries to create a MANAGER reporting to the CEO.
        role: 'MANAGER',
        roleCode: 'MANAGER',
        managerId: ceo.id,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows: any = await pool.query(
      `SELECT u.manager_id, r.role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.employee_id = 'NEW002'`
    );
    assert.equal(rows.rows[0].role_code, 'EMPLOYEE', 'role=MANAGER in the payload is ignored — still an Employee');
    assert.equal(rows.rows[0].manager_id, tl.id, 'managerId=CEO in the payload is ignored — still reports to the TL');
  });

  it('a granted Manager adds an Employee the same way', async () => {
    await grantCode('MANAGER', 'users.add_employee');
    const res = await request(app)
      .post('/api/users/employee')
      .set('Authorization', `Bearer ${tokenFor(mgr, 'MANAGER')}`)
      .send({
        fullName: 'Manager Hire',
        employeeId: 'NEW003',
        email: 'new003@test.com',
        password: 'TempPass123',
        mustChangePassword: true,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows: any = await pool.query(
      `SELECT u.manager_id, r.role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.employee_id = 'NEW003'`
    );
    assert.equal(rows.rows[0].role_code, 'EMPLOYEE');
    assert.equal(rows.rows[0].manager_id, mgr.id, 'the new user reports to the adding Manager');
  });

  it('a plain agent WITHOUT the grant is refused too (the grant is the gate, not the role code)', async () => {
    const res = await request(app)
      .post('/api/users/employee')
      .set('Authorization', `Bearer ${tokenFor(agent, 'EMPLOYEE')}`)
      .send({
        fullName: 'Agent Hire',
        employeeId: 'NEW004',
        email: 'new004@test.com',
        password: 'TempPass123',
        mustChangePassword: true,
      });
    assert.equal(res.status, 403, `ungranted agent add should be 403, got ${res.status} ${JSON.stringify(res.body)}`);
  });
});
