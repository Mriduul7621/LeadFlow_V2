/**
 * workspace-home-mapping.test.ts — role-home data mapping
 * ------------------------------------------------------------------
 * Phase 1 role-dashboard redesign (2026-11-17): every number on the
 * three role homes at `/` must equal its source endpoint's value —
 * the sample prototype's demo figures are gone, and nothing is
 * invented. Sections:
 *
 *   1. Pure helpers (workspaceData) — ৳ money, Dhaka-day buckets,
 *      greeting, stalled counts, conversion share, pipeline
 *      segments from REAL statuses with dictionary terminal flags.
 *   2. MemberHomeContent (SSR) — KPI equality, drill-down links,
 *      Converted unlinked (no matching drill-down), priority +
 *      recent rows link to Lead360, never-empty.
 *   3. TeamLeadHomeContent (SSR) — KPI equality with the team
 *      totals, all four cards link, member rows never empty.
 *   4. ManagerHomeContent (SSR) — KPI equality, org totals, ৳
 *      pipeline value from the tree, NCP progress, alerts.
 *   5. Currency — ৳ everywhere, never $.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import {
  buildNext7Days,
  conversionShare,
  countStalled,
  dhakaDayKey,
  dhakaDayLabel,
  formatDhakaShort,
  greetingForHour,
  money,
  resolvePipelineSegments,
  type PipelineSegment,
} from '../../src/modules/workspace/utils/workspaceData';
import { MemberHomeContent } from '../../src/modules/workspace/pages/MemberHome';
import { TeamLeadHomeContent } from '../../src/modules/workspace/pages/TeamLeadHome';
import { ManagerHomeContent, type BusinessAlerts } from '../../src/modules/workspace/pages/ManagerHome';
import {
  summarizeTeamTotals,
  type TeamOverviewPerson,
} from '../../src/modules/team/services/teamOverviewService';
import type { FollowUpQueueItem } from '../../src/modules/leads/services/leadService';
import type { Lead } from '../../src/modules/shared/types';
import type { DashboardMetrics } from '../../src/modules/dashboard/services/dashboardService';
import type { WorkspaceTreePerson } from '../../src/modules/workspace/services/teamTreeService';

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, element));
}

const person = (over: Partial<TeamOverviewPerson>): TeamOverviewPerson => ({
  userId: over.employeeId || 'u-x',
  employeeId: 'EMP-X',
  name: 'Person X',
  designation: 'Relationship Officer',
  roleName: 'RO',
  department: 'DSF',
  managerEmployeeId: null,
  managerName: null,
  tier: 'teamMember',
  directReports: 0,
  openLeads: 0,
  convertedLeads: 0,
  dueToday: 0,
  overdue: 0,
  totalLeads: 0,
  todayLeads: 0,
  noActionLeads: 0,
  isSelf: false,
  ...over,
});

const fixturePeople: TeamOverviewPerson[] = [
  person({ userId: 'u-self', employeeId: 'EMP-001', name: 'Lena Lead', isSelf: true, directReports: 2, tier: 'teamLead', openLeads: 3, dueToday: 1, overdue: 1, convertedLeads: 2, totalLeads: 8, todayLeads: 1, noActionLeads: 0 }),
  person({ userId: 'u-a', employeeId: 'EMP-002', name: 'Arif Member', openLeads: 9, dueToday: 2, overdue: 5, convertedLeads: 4, totalLeads: 15, todayLeads: 2, noActionLeads: 2 }),
  person({ userId: 'u-b', employeeId: 'EMP-003', name: 'Bina Member', openLeads: 4, dueToday: 0, overdue: 5, convertedLeads: 1, totalLeads: 9, todayLeads: 0, noActionLeads: 1 }),
  person({ userId: 'u-c', employeeId: 'EMP-004', name: 'Chad Member', openLeads: 2, dueToday: 3, overdue: 0, convertedLeads: 0, totalLeads: 5, todayLeads: 1, noActionLeads: 0 }),
  person({ userId: 'u-d', employeeId: 'EMP-005', name: 'Dina Member', openLeads: 1, dueToday: 0, overdue: 0, convertedLeads: 6, totalLeads: 7, todayLeads: 0, noActionLeads: 0 }),
];

const queueItem = (over: Partial<FollowUpQueueItem>): FollowUpQueueItem => ({
  id: 'q-1',
  prospectName: 'Queue Lead',
  mobile: '01700000000',
  assignedTo: 'EMP001',
  currentStatus: 'Interested',
  nextFollowUpAt: '2026-11-17T10:00:00+06:00',
  dueState: 'today',
  ...over,
});

const leadRow = (over: Partial<Lead>): Lead => ({
  id: 'lead-1',
  creationDate: '2026-11-01',
  prospectName: 'Recent Lead',
  mobile: '01700000000',
  profession: 'Teacher',
  familyMember: 'Self',
  maritalStatus: 'Single',
  hasChild: false,
  area: 'Dhaka',
  source: 'Referral',
  productName: 'Term',
  campaignName: 'Nov',
  assignedTo: 'EMP001',
  currentStatus: 'Interested',
  projectedNCP: 0,
  collectedNCP: 0,
  timestamp: '2026-11-17T00:00:00Z',
  ...over,
});

const pipelineFixture: PipelineSegment[] = [
  { name: 'New', count: 4, terminal: false, won: false, lost: false },
  { name: 'Interested', count: 3, terminal: false, won: false, lost: false },
  { name: 'Converted', count: 2, terminal: true, won: true, lost: false },
  { name: 'Not Interested', count: 1, terminal: true, won: false, lost: true },
];

const metricsFixture = (over: Partial<DashboardMetrics> = {}): DashboardMetrics => ({
  timezone: 'Asia/Dhaka',
  todayDate: '2026-11-17',
  bounds: { todayStart: '2026-11-16T18:00:00Z', tomorrowStart: '2026-11-17T18:00:00Z' },
  period: 'ALL',
  totalLeads: 44,
  activeLeads: 19,
  converted: 13,
  notInterested: 5,
  statusCounts: { New: 4, Contacted: 2, 'No Response': 1, Busy: 1, Interested: 3, 'Follow-up Set': 2, 'Meeting Fixed': 1, 'Meeting Completed': 1, 'Pipeline Locked': 0, Converted: 13, 'Not Interested': 5 } as DashboardMetrics['statusCounts'],
  newLeads: 4,
  responses: 10,
  pipeline: 19,
  pipelineLocked: 0,
  alerts: 11,
  contacted: 8,
  meetings: 2,
  followUps: 17,
  projected: 1000000,
  collected: 500000,
  sumAssured: 5000000,
  conversionRate: '29.5%',
  conversionRateValue: 29.5,
  avgResponseTAT: null,
  followUpsQueue: { overdue: 11, today: 6, upcoming: 4, all: 21 },
  followUpCounts: { overdue: 11, today: 6, upcoming: 4, all: 21 },
  agentStats: [
    { name: 'Arif Member', employeeId: 'EMP-002', assigned: 15, converted: 4, collected: 200000, projected: 400000 } as DashboardMetrics['agentStats'][number],
    { name: 'Dina Member', employeeId: 'EMP-005', assigned: 7, converted: 6, collected: 300000, projected: 300000 } as DashboardMetrics['agentStats'][number],
  ],
  teamStats: [],
  campaignStats: [],
  ...over,
});

const treeRoot = (over: Partial<WorkspaceTreePerson> = {}): WorkspaceTreePerson => ({
  userId: 'u-root',
  employeeId: 'EMP-H',
  name: 'Hana Head',
  designation: 'Business Head',
  roleName: 'BH',
  department: 'DSF',
  managerEmployeeId: null,
  tier: 'manager',
  directReports: 2,
  openLeads: 5,
  convertedLeads: 3,
  dueToday: 1,
  isSelf: false,
  childrenIds: ['u-a', 'u-b'],
  overdue: 2,
  convertedThisMonth: 1,
  pipelineValue: 250000,
  subtree: { people: 5, openLeads: 19, converted: 13, pipelineValue: 1250000, dueToday: 6, overdue: 11, convertedThisMonth: 1 },
  subtreeStatusCounts: {},
  ...over,
});

/* ================================================================ */
/* 1. Pure helpers                                                   */
/* ================================================================ */

describe('workspaceData — pure helpers', () => {
  it('money formats ৳ with grouping and never $', () => {
    assert.equal(money(1250000), '৳1,250,000');
    assert.equal(money(0), '৳0');
    assert.equal(money(999), '৳999');
    assert.ok(!money(100).includes('$'), 'no dollar sign anywhere');
  });

  it('dhakaDayKey groups by the Dhaka calendar day, not UTC', () => {
    // 18:30 UTC on 16 Nov is already 00:30 on 17 Nov in Dhaka.
    assert.equal(dhakaDayKey(new Date('2026-11-16T18:30:00Z')), '2026-11-17');
    assert.equal(dhakaDayKey(new Date('2026-11-16T17:59:59Z')), '2026-11-16');
    assert.equal(dhakaDayLabel('2026-11-17'), 'Tue 17');
  });

  it('buildNext7Days buckets follow-ups by Dhaka day over the next 7 days', () => {
    const now = new Date('2026-11-17T06:00:00Z'); // 12:00 Dhaka, Tuesday 17 Nov
    const days = buildNext7Days([
      queueItem({ id: 'a', nextFollowUpAt: '2026-11-17T15:00:00+06:00' }),
      queueItem({ id: 'b', nextFollowUpAt: '2026-11-17T16:00:00+06:00' }),
      queueItem({ id: 'c', nextFollowUpAt: '2026-11-19T09:00:00+06:00' }),
      queueItem({ id: 'd', nextFollowUpAt: '2026-11-16T09:00:00+06:00' }), // yesterday: outside the window
      queueItem({ id: 'e', nextFollowUpAt: '2026-11-25T09:00:00+06:00' }), // day 8: outside the window
    ], now);
    assert.equal(days.length, 7, 'exactly seven buckets');
    assert.deepEqual(days.map(d => d.dayKey), [
      '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23',
    ]);
    assert.deepEqual(days.map(d => d.count), [2, 0, 1, 0, 0, 0, 0]);
    assert.equal(days[0].isToday, true);
    assert.ok(days.slice(1).every(d => !d.isToday));
    assert.deepEqual(buildNext7Days([], now).map(d => d.count), [0, 0, 0, 0, 0, 0, 0], 'an empty queue is seven zero buckets, never a missing chart');
  });

  it('greetingForHour follows the Dhaka hour', () => {
    assert.equal(greetingForHour(7), 'Good morning');
    assert.equal(greetingForHour(13), 'Good afternoon');
    assert.equal(greetingForHour(19), 'Good evening');
    assert.equal(greetingForHour(23), 'Good evening');
  });

  it('formatDhakaShort renders a Dhaka date', () => {
    assert.equal(formatDhakaShort('2026-11-17T10:00:00+06:00'), '17 Nov');
  });

  it('countStalled counts only items overdue by more than N days', () => {
    const now = new Date('2026-11-17T06:00:00Z');
    const items = [
      queueItem({ id: 'old', nextFollowUpAt: '2026-11-01T10:00:00+06:00' }), // 16 days overdue
      queueItem({ id: 'edge', nextFollowUpAt: '2026-11-02T18:00:00Z' }), // exactly at the 14-day cutoff: not stalled (strictly before)
      queueItem({ id: 'fresh', nextFollowUpAt: '2026-11-16T10:00:00+06:00' }), // 1 day overdue
      queueItem({ id: 'future', nextFollowUpAt: '2026-11-20T10:00:00+06:00' }), // not due yet
    ];
    assert.equal(countStalled(items, 14, now), 1);
    assert.equal(countStalled([], 14, now), 0);
  });

  it('conversionShare is 0 with no denominator, never NaN', () => {
    assert.equal(conversionShare(0, 0), 0);
    assert.equal(conversionShare(3, 6), 1 / 3);
    assert.equal(conversionShare(6, 0), 1);
  });

  it('resolvePipelineSegments uses real statuses with dictionary terminal flags', () => {
    const segments = resolvePipelineSegments(
      { New: 4, Interested: 3, Converted: 2, 'Not Interested': 1, 'Custom Stage': 5 },
      [
        { type: 'FollowUpStatus', value: 'New', status: 'Active', meta: {} },
        { type: 'FollowUpStatus', value: 'Interested', status: 'Active', meta: {} },
        { type: 'FollowUpStatus', value: 'Converted', status: 'Active', meta: { isTerminal: true, isWon: true } },
        { type: 'FollowUpStatus', value: 'Not Interested', status: 'Active', meta: { isTerminal: true, isLost: true } },
        { type: 'FollowUpStatus', value: 'Custom Stage', status: 'Active', meta: { isTerminal: true, isLost: true } },
      ],
    );
    const byName = new Map(segments.map(s => [s.name, s]));
    assert.equal(byName.get('New')?.count, 4);
    assert.equal(byName.get('New')?.terminal, false);
    assert.equal(byName.get('Converted')?.terminal, true);
    assert.equal(byName.get('Converted')?.won, true);
    assert.equal(byName.get('Not Interested')?.lost, true);
    assert.equal(byName.get('Custom Stage')?.terminal, true, 'a dictionary terminal wins over the hardcoded names');
    assert.ok(!segments.some(s => ['Won', 'Lost', 'Qualified', 'Proposal'].includes(s.name)),
      'the sample prototype generic stages must never appear');
    const empty = resolvePipelineSegments({}, []);
    assert.equal(empty.length, 12, 'every known stage is listed (never-empty rule)');
    assert.ok(empty.every(s => s.count === 0), 'no statuses, no counts — never a fabricated bar');
  });

  it('resolvePipelineSegments falls back to Converted/Not Interested when the dictionary is empty', () => {
    const segments = resolvePipelineSegments({ New: 2, Converted: 1, 'Not Interested': 1 }, []);
    const byName = new Map(segments.map(s => [s.name, s]));
    assert.equal(byName.get('Converted')?.terminal, true);
    assert.equal(byName.get('Converted')?.won, true);
    assert.equal(byName.get('Not Interested')?.lost, true);
    assert.equal(byName.get('New')?.terminal, false);
  });
});

/* ================================================================ */
/* 2. MemberHomeContent                                              */
/* ================================================================ */

describe('MemberHomeContent — KPI equality, links, never-empty', () => {
  const baseProps = {
    userName: 'Lena Lead',
    dateLine: 'Tuesday, 17 November 2026',
    greeting: 'Good morning',
    assigned: 8,
    dueToday: 1,
    overdue: 1,
    convertedThisMonth: 2 as number | null,
    priority: [queueItem({ id: 'q-1', prospectName: 'Overdue One', dueState: 'overdue' })],
    priorityTotal: 2,
    dailyLoading: false,
    chartDays: buildNext7Days([], new Date('2026-11-17T06:00:00Z')),
    chartTruncated: false,
    pipeline: pipelineFixture,
    recentLeads: [leadRow({ id: 'lead-9', prospectName: 'Recent Rina' })],
    recentLeadsLoading: false,
    canCreateLead: true,
    hasTeam: false,
  };

  it('renders the greeting and the four KPI values exactly as given', () => {
    const html = render(React.createElement(MemberHomeContent, baseProps));
    assert.ok(html.includes('Good morning, Lena'), 'greeting + first name');
    assert.ok(html.includes('Tuesday, 17 November 2026'), 'Dhaka date line');
    assert.ok(html.includes('aria-label="Assigned leads: 8 — view details"'));
    assert.ok(html.includes('aria-label="Due today: 1 — view details"'));
    assert.ok(html.includes('aria-label="Overdue: 1 — view details"'));
    assert.ok(html.includes('Converted this month'), 'the converted card is labelled by month');
    assert.ok(html.includes('>2<'), 'converted-this-month renders its value');
  });

  it('Assigned / Due today / Overdue link to their drill-downs; Converted does not', () => {
    const html = render(React.createElement(MemberHomeContent, baseProps));
    assert.ok(html.includes('href="/team/kpi/totalLeads"'), 'Assigned leads drills to Total Lead');
    assert.ok(html.includes('href="/team/kpi/dueToday"'), 'Due today drills to its list');
    assert.ok(html.includes('href="/team/kpi/overdue"'), 'Overdue drills to its list');
    // Converted-this-month has NO matching drill-down: the 'converted'
    // drill-down is all-time and would show a different count than the
    // card, so the card is deliberately unlinked.
    assert.ok(!html.includes('href="/team/kpi/converted"'), 'Converted must not link to the all-time drill-down');
    assert.ok(!html.includes('aria-label="Converted: 2 — view details"'), 'no view-details label on the unlinked card');
  });

  it('priority and recent rows link to Lead360', () => {
    const html = render(React.createElement(MemberHomeContent, baseProps));
    assert.ok(html.includes('href="/leads/q-1"'), 'a priority follow-up opens its lead');
    assert.ok(html.includes('Overdue One'), 'the priority row names the lead');
    assert.ok(html.includes('href="/leads/lead-9"'), 'a recent lead opens Lead360');
    assert.ok(html.includes('Recent Rina'), 'the recent row names the lead');
    assert.ok(html.includes('Showing 1 of 2 follow-ups.'), 'the priority cap is stated, not silently applied');
  });

  it('never renders a blank home: all-zero props still show every card and section', () => {
    const html = render(React.createElement(MemberHomeContent, {
      ...baseProps,
      assigned: 0, dueToday: 0, overdue: 0, convertedThisMonth: 0,
      priority: [], priorityTotal: 0, recentLeads: [],
    }));
    assert.ok(html.includes('aria-label="Assigned leads: 0 — view details"'), 'zero is a value on the card');
    assert.ok(html.includes('aria-label="Overdue: 0 — view details"'));
    assert.ok(html.includes('Nothing due — no follow-ups are overdue or due today.'), 'the priority empty state says so plainly');
    assert.ok(html.includes('No recent leads yet.'), 'the recent empty state says so plainly');
    assert.ok(html.includes('Add your first lead'), 'the empty state offers the create action');
  });

  it('a pending converted count shows a dash, never a false 0', () => {
    const html = render(React.createElement(MemberHomeContent, { ...baseProps, convertedThisMonth: null }));
    assert.ok(html.includes('>–<'), 'the tree read is still pending — a dash, not 0');
  });

  it('shows the Team/My-work switch only to callers with a team', () => {
    const withTeam = render(React.createElement(MemberHomeContent, { ...baseProps, hasTeam: true }));
    assert.ok(withTeam.includes('Team') && withTeam.includes('My work'), 'the switch renders for a team holder');
    const withoutTeam = render(React.createElement(MemberHomeContent, { ...baseProps, hasTeam: false }));
    assert.ok(!withoutTeam.includes('My work'), 'a leaf member never sees the switch');
  });
});

/* ================================================================ */
/* 3. TeamLeadHomeContent                                            */
/* ================================================================ */

describe('TeamLeadHomeContent — KPI equality, links, never-empty', () => {
  const totals = summarizeTeamTotals(fixturePeople); // open 19, dueToday 6, overdue 11, converted 13, total 44, today 4, noAction 3
  const baseProps = {
    people: fixturePeople,
    scope: 'Team',
    chartDays: buildNext7Days([], new Date('2026-11-17T06:00:00Z')),
    chartTruncated: false,
    chartLoading: false,
  };

  it('the four KPI cards equal the team totals', () => {
    assert.deepEqual(totals, { open: 19, dueToday: 6, overdue: 11, converted: 13, totalLeads: 44, todayCollection: 4, noAction: 3 });
    const html = render(React.createElement(TeamLeadHomeContent, baseProps));
    assert.ok(html.includes('aria-label="Open leads: 19 — view details"'));
    assert.ok(html.includes('aria-label="Overdue: 11 — view details"'));
    assert.ok(html.includes('aria-label="No Action Alert: 3 — view details"'));
    assert.ok(html.includes('aria-label="Converted: 13 — view details"'));
    assert.ok(html.includes('5 people in your team · Team scope'), 'the scope is shown');
  });

  it('every KPI card links to its drill-down', () => {
    const html = render(React.createElement(TeamLeadHomeContent, baseProps));
    for (const kpi of ['open', 'overdue', 'noAction', 'converted']) {
      assert.ok(html.includes(`href="/team/kpi/${kpi}"`), `the ${kpi} card links to its drill-down`);
    }
  });

  it('member performance lists every member, best first, with 0s intact', () => {
    const html = render(React.createElement(TeamLeadHomeContent, baseProps));
    // Converted desc: Dina (6), Arif (4), Lena (2), Bina (1), Chad (0).
    const order = ['Dina Member', 'Arif Member', 'Lena Lead', 'Bina Member', 'Chad Member'].map(n => html.indexOf(n));
    assert.ok(order.every((v, i) => v >= 0 && (i === 0 || order[i - 1] < v)), 'members render best-first');
    assert.ok(html.includes('0 converted · 2 open'), 'the zero-converted member still shows their counts');
    assert.ok(html.includes('href="/team"'), 'member rows link through to My Team');
  });

  it('at-risk lists only members with no-action leads, worst first', () => {
    const html = render(React.createElement(TeamLeadHomeContent, baseProps));
    assert.ok(html.includes('2 no action'), 'Arif has 2 no-action leads');
    assert.ok(html.includes('1 no action'), 'Bina has 1');
    const arifAt = html.indexOf('Arif Member', html.indexOf('At-risk'));
    const binaAt = html.indexOf('Bina Member', html.indexOf('At-risk'));
    assert.ok(arifAt >= 0 && binaAt > arifAt, 'worst first');
    assert.ok(html.includes('href="/team/kpi/noAction"'), 'the at-risk card links to the drill-down');
  });

  it('an all-zero team still renders every card and the all-clear states', () => {
    const zeroPeople = fixturePeople.map(p => ({
      ...p, openLeads: 0, convertedLeads: 0, dueToday: 0, overdue: 0, totalLeads: 0, todayLeads: 0, noActionLeads: 0,
    }));
    const html = render(React.createElement(TeamLeadHomeContent, { ...baseProps, people: zeroPeople }));
    assert.ok(html.includes('aria-label="Open leads: 0 — view details"'));
    assert.ok(html.includes('aria-label="No Action Alert: 0 — view details"'));
    assert.ok(html.includes('No at-risk leads — every lead had a first action within 48 hours.'), 'the at-risk all-clear');
    assert.ok(html.includes('Dina Member'), 'zero members are still listed');
  });
});

/* ================================================================ */
/* 4. ManagerHomeContent                                             */
/* ================================================================ */

describe('ManagerHomeContent — KPI equality, org totals, ৳ value', () => {
  const alerts: BusinessAlerts = {
    overdue: 11, noAction: 3, stalled14: 2, stalledTruncated: false, oldestOverdueDays: 21,
  };
  const baseProps = {
    people: fixturePeople,
    scope: 'Organization',
    metrics: metricsFixture(),
    roots: [treeRoot()],
    pipeline: pipelineFixture,
    alerts,
    dailyLoading: false,
  };

  it('Total Lead and Converted equal the org totals and link to their drill-downs', () => {
    const html = render(React.createElement(ManagerHomeContent, baseProps));
    assert.ok(html.includes('aria-label="Total Lead: 44 — view details"'), 'Total Lead sums the whole visible set');
    assert.ok(html.includes('aria-label="Converted: 13 — view details"'));
    assert.ok(html.includes('href="/team/kpi/totalLeads"'));
    assert.ok(html.includes('href="/team/kpi/converted"'));
    assert.ok(html.includes('Organization scope'), 'the scope is shown');
  });

  it('NCP progress and pipeline value render from the real endpoints, in ৳', () => {
    const html = render(React.createElement(ManagerHomeContent, baseProps));
    assert.ok(html.includes('50%'), 'collected 500,000 of projected 1,000,000 is 50%');
    assert.ok(html.includes('৳1,250,000'), 'pipeline value is the roots\' subtree rollup, in taka');
    assert.ok(html.includes('৳500,000'), 'collected NCP renders in taka');
  });

  it('team comparison lists every root with their subtree rollup', () => {
    const html = render(React.createElement(ManagerHomeContent, baseProps));
    assert.ok(html.includes('Hana Head') && html.includes('EMP-H'), 'the root row names the team head');
    assert.ok(html.includes('5 people · 19 open · 13 converted'), 'the subtree rollup rides on the row');
  });

  it('top performers come from the dashboard agent stats, best first', () => {
    const html = render(React.createElement(ManagerHomeContent, baseProps));
    const dinaAt = html.indexOf('Dina Member');
    const arifAt = html.indexOf('Arif Member');
    assert.ok(dinaAt >= 0 && arifAt > dinaAt, 'Dina (6 converted) before Arif (4)');
    assert.ok(!html.includes('Lead source performance'), 'there is no lead-source aggregation — the card is omitted, not faked');
  });

  it('business alerts render the real counts, honestly labelled', () => {
    const html = render(React.createElement(ManagerHomeContent, baseProps));
    assert.ok(html.includes('11 overdue follow-ups'), 'the overdue count');
    assert.ok(html.includes('3 leads with no first action'), 'the no-action count');
    assert.ok(html.includes('2 leads stalled over 14 days'), 'leads overdue by more than 14 days');
    assert.ok(html.includes('Oldest overdue follow-up is 21 days old'), 'the oldest overdue age');
    const truncated = render(React.createElement(ManagerHomeContent, {
      ...baseProps,
      alerts: { ...alerts, stalledTruncated: true },
    }));
    assert.ok(truncated.includes('At least 2 leads stalled over 14 days'), 'a truncated queue read is labelled as a floor, not an exact count');
  });

  it('an all-zero organisation still renders every card and section', () => {
    const zeroPeople = fixturePeople.map(p => ({
      ...p, openLeads: 0, convertedLeads: 0, dueToday: 0, overdue: 0, totalLeads: 0, todayLeads: 0, noActionLeads: 0,
    }));
    const html = render(React.createElement(ManagerHomeContent, {
      ...baseProps,
      people: zeroPeople,
      metrics: metricsFixture({ collected: 0, projected: 0, agentStats: [] }),
      roots: [],
      alerts: { overdue: 0, noAction: 0, stalled14: 0, stalledTruncated: false, oldestOverdueDays: null },
    }));
    assert.ok(html.includes('aria-label="Total Lead: 0 — view details"'));
    assert.ok(html.includes('৳0'), 'zero pipeline value still renders');
    assert.ok(html.includes('No teams in scope yet.'), 'the empty team state says so plainly');
  });
});

/* ================================================================ */
/* 5. Currency                                                       */
/* ================================================================ */

describe('role homes — currency is ৳ everywhere, never $', () => {
  it('no rendered home contains a dollar sign', () => {
    const member = render(React.createElement(MemberHomeContent, {
      userName: 'Lena Lead', dateLine: 'Tuesday, 17 November 2026', greeting: 'Good morning',
      assigned: 8, dueToday: 1, overdue: 1, convertedThisMonth: 2,
      priority: [], priorityTotal: 0, dailyLoading: false,
      chartDays: buildNext7Days([], new Date('2026-11-17T06:00:00Z')), chartTruncated: false,
      pipeline: pipelineFixture, recentLeads: [], recentLeadsLoading: false,
      canCreateLead: true, hasTeam: false,
    }));
    const lead = render(React.createElement(TeamLeadHomeContent, {
      people: fixturePeople, scope: 'Team',
      chartDays: buildNext7Days([], new Date('2026-11-17T06:00:00Z')), chartTruncated: false, chartLoading: false,
    }));
    const manager = render(React.createElement(ManagerHomeContent, {
      people: fixturePeople, scope: 'Organization', metrics: metricsFixture(),
      roots: [treeRoot()], pipeline: pipelineFixture,
      alerts: { overdue: 11, noAction: 3, stalled14: 2, stalledTruncated: false, oldestOverdueDays: 21 },
      dailyLoading: false,
    }));
    for (const [name, html] of [['member', member], ['team lead', lead], ['manager', manager]] as const) {
      assert.ok(!html.includes('$'), `${name} home must not render a dollar sign`);
    }
    assert.ok(manager.includes('৳'), 'the manager home renders taka');
  });
});
