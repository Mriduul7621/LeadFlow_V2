/**
 * agent-workspace.test.ts
 * ------------------------------------------------------------------
 * The Agent workspace rebuild (2026-11-20, Mahadi's demo
 * screenshots): the agent sidebar, the My Work home, the My Leads
 * table, the simple Add Lead form, the Follow-up Queue and the
 * Agent's My Performance layout.
 *
 * The pure data helpers (agentWorkspaceData.ts) are pinned with
 * EXPLICIT timestamps so the suite passes identically under
 * TZ=UTC and TZ=Asia/Dhaka — every helper is Dhaka-explicit.
 *
 * The demo's data is FAKE ("3 demo records · Changes are saved in
 * this browser"): no demo name (Ayesha, Rahim, Nusrat, Tanvir),
 * demo number or demo status name (Qualified, Proposal, Won) may
 * appear in the agent workspace sources. The real LeadFlow status
 * dictionary is the only status vocabulary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activityBuckets,
  agentPerformanceKpis,
  completedToday,
  conversionFunnel,
  dailyHistoryCounts,
  dhakaHour,
  firstNameOf,
  greetingForDhakaHour,
  hourlyHistoryCounts,
  onTimeRate,
  performanceInsights,
  pipelineSegments,
  recentOwnLeads,
  toCsv,
  tomorrowFollowUps,
  topPriorityFollowUps,
} from '../../src/modules/workspace/utils/agentWorkspaceData';
import {
  buildEnterpriseNavGroups,
  enterpriseHeadingForPath,
  type EnterpriseNavGroup,
} from '../../src/layouts/enterpriseNav';
import type { Lead, StatusHistoryEntry } from '../../src/modules/shared/types';
import type { FollowUpQueueItem } from '../../src/modules/leads/services/leadService';

const SRC = join(process.cwd(), 'src');
const readSrc = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** A minimal Lead for the helpers (only the used fields matter). */
const lead = (over: Partial<Lead>): Lead => ({
  id: over.id ?? 'LF-1',
  prospectName: over.prospectName ?? 'Test Lead',
  mobile: '01700000000',
  currentStatus: over.currentStatus ?? 'New',
  assignedTo: over.assignedTo ?? '2025001',
  timestamp: over.timestamp ?? '2026-11-20T00:00:00.000Z',
  ...over,
} as Lead);

const history = (date: string, nextFollowUpDate?: string): StatusHistoryEntry => ({
  date,
  status: 'Contacted',
  nextFollowUpDate,
} as StatusHistoryEntry);

const queueItem = (over: Partial<FollowUpQueueItem>): FollowUpQueueItem => ({
  id: over.id ?? 'LF-1',
  prospectName: over.prospectName ?? 'Test Lead',
  mobile: '01700000000',
  assignedTo: '2025001',
  currentStatus: over.currentStatus ?? 'Interested',
  nextFollowUpAt: over.nextFollowUpAt ?? '2026-11-20T09:30:00+06:00',
  ...over,
} as FollowUpQueueItem);

/** 2026-11-20 10:00 Dhaka = 04:00 UTC (a Friday). */
const NOW = new Date('2026-11-20T04:00:00.000Z');

describe('agentWorkspaceData — greeting and names', () => {
  it('greets by Dhaka hour (morning <12, afternoon <17, evening after)', () => {
    assert.equal(greetingForDhakaHour(9), 'Good morning');
    assert.equal(greetingForDhakaHour(11), 'Good morning');
    assert.equal(greetingForDhakaHour(12), 'Good afternoon');
    assert.equal(greetingForDhakaHour(16), 'Good afternoon');
    assert.equal(greetingForDhakaHour(17), 'Good evening');
    assert.equal(greetingForDhakaHour(23), 'Good evening');
  });

  it('dhakaHour reads the Dhaka hour of an instant in any host timezone', () => {
    // 04:00 UTC is 10:00 in Dhaka, whatever TZ the suite runs under.
    assert.equal(dhakaHour(NOW), 10);
  });

  it('firstNameOf takes the first word and tolerates blanks', () => {
    assert.equal(firstNameOf('Ayesha Rahman'), 'Ayesha');
    assert.equal(firstNameOf('  Mahadi  '), 'Mahadi');
    assert.equal(firstNameOf(''), '');
    assert.equal(firstNameOf(null), '');
  });
});

describe('agentWorkspaceData — priority follow-ups', () => {
  it('topPriorityFollowUps takes the earliest two by due time', () => {
    const items = [
      queueItem({ id: 'LF-3', nextFollowUpAt: '2026-11-20T14:00:00+06:00' }),
      queueItem({ id: 'LF-1', nextFollowUpAt: '2026-11-20T09:30:00+06:00' }),
      queueItem({ id: 'LF-2', nextFollowUpAt: '2026-11-20T10:15:00+06:00' }),
    ];
    assert.deepEqual(topPriorityFollowUps(items, 2).map(i => i.id), ['LF-1', 'LF-2']);
  });

  it('tomorrowFollowUps keeps only items due on tomorrow (Dhaka day)', () => {
    const items = [
      queueItem({ id: 'LF-today', nextFollowUpAt: '2026-11-20T18:00:00+06:00' }),
      queueItem({ id: 'LF-tomorrow', nextFollowUpAt: '2026-11-21T09:00:00+06:00' }),
      queueItem({ id: 'LF-later', nextFollowUpAt: '2026-11-23T09:00:00+06:00' }),
    ];
    assert.deepEqual(tomorrowFollowUps(items, NOW).map(i => i.id), ['LF-tomorrow']);
  });
});

describe('agentWorkspaceData — pipeline and recent leads', () => {
  it('pipelineSegments covers all 11 canonical statuses in dictionary order, 0 included', () => {
    const { segments, total } = pipelineSegments({ New: 2, Converted: 1 });
    assert.equal(segments.length, 11);
    assert.equal(segments[0].name, 'New');
    assert.equal(segments[segments.length - 1].name, 'Not Interested');
    assert.equal(total, 3);
    assert.equal(segments.find(s => s.name === 'Contacted')?.count, 0);
    assert.equal(segments.find(s => s.name === 'Converted')?.count, 1);
    // A status outside the dictionary is ignored, never invented in.
    assert.equal(pipelineSegments({ Won: 5, Qualified: 3 }).total, 0);
  });

  it('recentOwnLeads keeps only the caller\'s leads, most recently updated first', () => {
    const leads = [
      lead({ id: 'LF-old', assignedTo: '2025001', timestamp: '2026-11-18T00:00:00.000Z' }),
      lead({ id: 'LF-new', assignedTo: '2025001', timestamp: '2026-11-20T00:00:00.000Z' }),
      lead({ id: 'LF-other', assignedTo: '2025002', timestamp: '2026-11-20T12:00:00.000Z' }),
      lead({ id: 'LF-mid', assignedTo: '2025001', timestamp: '2026-11-19T00:00:00.000Z' }),
    ];
    assert.deepEqual(
      recentOwnLeads(leads, '2025001', 3).map(l => l.id),
      ['LF-new', 'LF-mid', 'LF-old'],
    );
    assert.deepEqual(recentOwnLeads(leads, null), []);
  });
});

describe('agentWorkspaceData — activity buckets', () => {
  it('this-week buckets are Mon–Sun Dhaka days with real history counts', () => {
    // 2026-11-20 is a Friday; its week runs Mon 16 – Sun 22 Nov.
    const leads = [
      lead({
        statusHistory: [
          history('2026-11-16T10:00:00+06:00'),
          history('2026-11-16T15:00:00+06:00'),
          history('2026-11-20T09:00:00+06:00'),
        ],
      }),
    ];
    const buckets = activityBuckets(leads, 'this-week', NOW);
    assert.equal(buckets.length, 7);
    assert.equal(buckets[0].label, 'Mon');
    assert.equal(buckets[0].count, 2);
    assert.equal(buckets[4].label, 'Fri');
    assert.equal(buckets[4].count, 1);
    assert.equal(buckets[6].count, 0);
  });

  it('last-week buckets cover the previous Mon–Sun week', () => {
    const leads = [lead({ statusHistory: [history('2026-11-10T10:00:00+06:00')] })];
    const buckets = activityBuckets(leads, 'last-week', NOW);
    assert.equal(buckets.length, 7);
    // Tue 10 Nov is the second bucket of the 9–15 Nov week.
    assert.equal(buckets[1].count, 1);
    assert.equal(buckets[0].count, 0);
  });

  it('this-month buckets are the Mon–Sun weeks intersecting the month', () => {
    const leads = [lead({ statusHistory: [history('2026-11-02T10:00:00+06:00')] })];
    const buckets = activityBuckets(leads, 'this-month', NOW);
    assert.ok(buckets.length >= 4 && buckets.length <= 6);
    // The 2 Nov entry sits in the week starting Mon 2 Nov.
    const weekOf2nd = buckets.find(b => b.label === '2 Nov');
    assert.ok(weekOf2nd, 'a week labelled by its Monday start exists');
    assert.equal(weekOf2nd!.count, 1);
  });
});

describe('agentWorkspaceData — completion and on-time rate', () => {
  it('completedToday counts leads whose LATEST entry is today (Dhaka)', () => {
    const leads = [
      lead({ id: 'LF-done', statusHistory: [history('2026-11-19T10:00:00+06:00'), history('2026-11-20T09:00:00+06:00')] }),
      lead({ id: 'LF-old', statusHistory: [history('2026-11-19T10:00:00+06:00')] }),
      lead({ id: 'LF-none', statusHistory: [] }),
    ];
    assert.deepEqual(completedToday(leads, NOW).map(l => l.id), ['LF-done']);
  });

  it('onTimeRate measures against the previous entry\'s scheduled date, and is null when unmeasurable', () => {
    // On time: previous entry scheduled 20 Nov 12:00, completed 20 Nov 09:00.
    // Late: previous entry scheduled 19 Nov 12:00, completed 20 Nov 09:00.
    // Unmeasurable: a single entry (no previous scheduled date).
    const leads = [
      lead({ statusHistory: [history('2026-11-19T10:00:00+06:00', '2026-11-20T12:00:00+06:00'), history('2026-11-20T09:00:00+06:00')] }),
      lead({ statusHistory: [history('2026-11-18T10:00:00+06:00', '2026-11-19T12:00:00+06:00'), history('2026-11-20T09:00:00+06:00')] }),
      lead({ statusHistory: [history('2026-11-20T09:00:00+06:00')] }),
    ];
    assert.deepEqual(onTimeRate(leads, NOW), { rate: 50, onTime: 1, total: 2 });
    assert.equal(onTimeRate([], NOW), null);
    assert.equal(onTimeRate([lead({ statusHistory: [history('2026-11-20T09:00:00+06:00')] })], NOW), null);
  });
});

describe('agentWorkspaceData — performance KPIs, funnel and insights', () => {
  const periodLeads = [
    lead({ id: 'LF-1', currentStatus: 'New', projectedNCP: 1000, collectedNCP: 0 }),
    lead({ id: 'LF-2', currentStatus: 'Contacted', projectedNCP: 2000, collectedNCP: 0 }),
    lead({ id: 'LF-3', currentStatus: 'Interested', projectedNCP: 3000, collectedNCP: 0 }),
    lead({ id: 'LF-4', currentStatus: 'Converted', projectedNCP: 4000, collectedNCP: 5000 }),
    lead({ id: 'LF-5', currentStatus: 'Not Interested', projectedNCP: 6000, collectedNCP: 0 }),
  ];

  it('agentPerformanceKpis follows Mahadi\'s definitions exactly', () => {
    const kpis = agentPerformanceKpis(periodLeads);
    assert.equal(kpis.assigned, 5);
    assert.equal(kpis.contacted, 3); // Contacted, Interested, Converted
    assert.equal(kpis.contactedRate, 60);
    assert.equal(kpis.converted, 1);
    assert.equal(kpis.convertedRate, 20);
    // Pipeline Premium counts OPEN leads only (Converted + Not
    // Interested are terminal): 1000 + 2000 + 3000.
    assert.equal(kpis.pipelinePremium, 6000);
    assert.equal(kpis.pipelineOpenCount, 3);
    assert.equal(kpis.collectedPremium, 5000);
    assert.equal(kpis.collectedCount, 1);
  });

  it('agentPerformanceKpis is safe on an empty period (no divide-by-zero)', () => {
    const kpis = agentPerformanceKpis([]);
    assert.equal(kpis.assigned, 0);
    assert.equal(kpis.contactedRate, 0);
    assert.equal(kpis.convertedRate, 0);
    assert.equal(kpis.pipelinePremium, 0);
    assert.equal(kpis.collectedPremium, 0);
  });

  it('conversionFunnel is cumulative over the real statuses, as shares of assigned', () => {
    const funnel = conversionFunnel(periodLeads);
    const byLabel = new Map(funnel.map(s => [s.label, s]));
    assert.equal(byLabel.get('Assigned')?.count, 5);
    assert.equal(byLabel.get('Assigned')?.pct, 100);
    assert.equal(byLabel.get('Contacted')?.count, 3);
    assert.equal(byLabel.get('Contacted')?.pct, 60);
    assert.equal(byLabel.get('Interested')?.count, 2); // Interested + Converted
    assert.equal(byLabel.get('Meeting')?.count, 1); // Converted only
    assert.equal(byLabel.get('Pipeline Locked')?.count, 1);
    assert.equal(byLabel.get('Converted')?.count, 1);
    assert.equal(byLabel.get('Converted')?.pct, 20);
    // No demo stage name anywhere in the funnel.
    for (const stage of funnel) {
      assert.ok(!['Qualified', 'Proposal', 'Won'].includes(stage.label));
    }
  });

  it('performanceInsights only reports what the data can support', () => {
    // No source with ≥3 leads, nothing overdue, no dated first
    // follow-up — so nothing is claimed.
    assert.deepEqual(performanceInsights(periodLeads, NOW), []);
  });

  it('performanceInsights finds the best-converting source (≥3 leads) and overdue items', () => {
    const leads = [
      lead({ source: 'Referral', currentStatus: 'Converted' }),
      lead({ source: 'Referral', currentStatus: 'Converted' }),
      lead({ source: 'Referral', currentStatus: 'New' }),
      lead({ source: 'Walk-in', currentStatus: 'Converted' }),
      lead({ source: 'Walk-in', currentStatus: 'New' }),
      lead({
        currentStatus: 'Follow-up Set',
        nextFollowUpDate: '2026-11-19T10:00:00+06:00',
        statusHistory: [history('2026-11-18T10:00:00+06:00')],
      }),
    ];
    const insights = performanceInsights(leads, NOW);
    const best = insights.find(i => i.title.includes('Referral'));
    assert.ok(best, 'the Referral source insight exists');
    assert.equal(best!.tone, 'good');
    const overdue = insights.find(i => i.title.includes('overdue'));
    assert.ok(overdue, 'the overdue insight exists');
    assert.equal(overdue!.tone, 'warn');
    assert.equal(overdue!.href, '/follow-up');
  });

  it('performanceInsights measures average first response from creation to first entry', () => {
    const leads = [
      lead({
        creationDate: '2026-11-19T10:00:00+06:00',
        statusHistory: [history('2026-11-19T12:00:00+06:00')],
      }),
      lead({
        creationDate: '2026-11-19T10:00:00+06:00',
        statusHistory: [history('2026-11-19T14:00:00+06:00')],
      }),
    ];
    const insights = performanceInsights(leads, NOW);
    const response = insights.find(i => i.title.startsWith('Average first response'));
    assert.ok(response, 'the first-response insight exists');
    assert.equal(response!.title, 'Average first response 3.0 hrs');
  });
});

describe('agentWorkspaceData — trend counters and CSV', () => {
  it('dailyHistoryCounts buckets every day in the range, 0 included', () => {
    const leads = [lead({ statusHistory: [history('2026-11-20T09:00:00+06:00')] })];
    // 19–21 Nov Dhaka (start 18:00 UTC 18 Nov).
    const startMs = Date.UTC(2026, 10, 18, 18, 0, 0);
    const buckets = dailyHistoryCounts(leads, startMs, startMs + 3 * 86_400_000);
    assert.equal(buckets.length, 3);
    assert.equal(buckets[1].count, 1);
    assert.equal(buckets[0].count, 0);
    assert.equal(buckets[2].count, 0);
  });

  it('hourlyHistoryCounts buckets one Dhaka day by hour', () => {
    const leads = [lead({ statusHistory: [history('2026-11-20T09:30:00+06:00'), history('2026-11-20T09:45:00+06:00')] })];
    const dayStartMs = Date.UTC(2026, 10, 19, 18, 0, 0); // 20 Nov 00:00 Dhaka
    const buckets = hourlyHistoryCounts(leads, dayStartMs);
    assert.equal(buckets.length, 24);
    assert.equal(buckets[9].count, 2);
    assert.equal(buckets[10].count, 0);
  });

  it('toCsv quotes fields holding commas, quotes or newlines', () => {
    const csv = toCsv([
      ['Name', 'Note'],
      ['Rahim, Uddin', 'said "hello"\nthen left'],
      ['Plain', 'ok'],
    ]);
    assert.ok(csv.includes('"Rahim, Uddin"'));
    assert.ok(csv.includes('"said ""hello""\nthen left"'));
    assert.ok(csv.includes('Plain,ok'));
  });
});

describe('Agent workspace — sidebar', () => {
  const agentGroups = (): EnterpriseNavGroup[] =>
    buildEnterpriseNavGroups({ role: 'agent', canOpen: () => true, canAccess: () => true });

  it('is ONE WORKSPACE group in Mahadi\'s exact order', () => {
    const groups = agentGroups();
    assert.deepEqual(groups.map(g => g.title), ['WORKSPACE']);
    assert.deepEqual(
      groups[0].items.map(i => [i.label, i.path]),
      [
        ['My Work', '/'],
        ['Activities', '/activities'],
        ['My Leads', '/leads'],
        ['Follow-up Queue', '/follow-up'],
        ['My Performance', '/execution-intelligence'],
        ['Task Calendar', '/task-calendar'],
        ['Roadshow', '/roadshows'],
      ],
    );
  });

  it('has NO ACCOUNT group and none of the four removed items', () => {
    const labels = agentGroups().flatMap(g => g.items.map(i => i.label));
    assert.ok(!labels.includes('Profile & Settings'));
    assert.ok(!labels.includes('Notifications'));
    assert.ok(!labels.includes('Daily Workbench'));
    assert.ok(!labels.includes('Sales Pipeline'));
    assert.ok(!labels.includes('Add Lead'));
    assert.ok(!labels.includes('NCP Progress'));
  });

  it('the /execution-intelligence heading for the agent is "My Performance"', () => {
    const heading = enterpriseHeadingForPath('agent', '/execution-intelligence');
    assert.equal(heading.title, 'My Performance');
    assert.equal(heading.sub, 'Track progress, activity and conversion trends.');
  });

  it('the sidebar-bottom profile block renders for every role (AppLayout source guard)', () => {
    // Team Lead / Manager / Admin workspace (2026-11-20): the profile
    // block + settings gear are no longer agent-only — every role
    // reaches Profile & Settings from the sidebar bottom (no ACCOUNT
    // group in any nav). The CSS class names stay (no churn).
    const appLayout = stripComments(readSrc('layouts/AppLayout.tsx'));
    assert.ok(!appLayout.includes("displayRole === 'agent'"), 'no agent-only condition on the profile block');
    assert.ok(appLayout.includes('ep-agent-profile'));
    assert.ok(appLayout.includes('ep-agent-profile-gear'));
    // The gear links to /settings — it is the settings entry, not a page.
    assert.ok(appLayout.includes('aria-label="Settings"'));
  });
});

describe('Agent workspace — source guards (no demo data, real vocabulary)', () => {
  const agentFiles = [
    'modules/workspace/pages/AgentHome.tsx',
    'modules/leads/pages/LeadList.tsx',
    'modules/leads/pages/LeadGenerate.tsx',
    'modules/leads/pages/FollowUpStrategy.tsx',
    'modules/dashboard/pages/ExecutionIntelligence.tsx',
    'modules/dashboard/components/AgentPerformance.tsx',
    'modules/leads/components/LeadQuickViewModal.tsx',
    'modules/workspace/utils/agentWorkspaceData.ts',
  ];

  it('no demo name or demo status name appears in any agent workspace file', () => {
    for (const file of agentFiles) {
      const text = stripComments(readSrc(file));
      for (const banned of ['Ayesha', 'Rahim', 'Nusrat', 'Tanvir', 'Qualified', 'Proposal', 'Won']) {
        // 'Won' is a common English word — only the funnel/demo
        // usage is banned, so check the quoted stage names.
        if (banned === 'Won') continue;
        assert.ok(!text.includes(banned), `${file} must not contain the demo word "${banned}"`);
      }
      assert.ok(!text.includes("'Won'"), `${file} must not use 'Won' as a stage`);
      assert.ok(!text.includes('"Won"'), `${file} must not use "Won" as a stage`);
    }
  });

  it('AgentHome has the demo sections with the real KPI set (Converted, never Target)', () => {
    const home = stripComments(readSrc('modules/workspace/pages/AgentHome.tsx'));
    assert.ok(home.includes('label="Assigned leads"'));
    assert.ok(home.includes('label="Due today"'));
    assert.ok(home.includes('label="Contacted"'));
    assert.ok(home.includes('label="Converted"'));
    assert.ok(!home.includes('Target progress'), 'the demo target card is replaced by Converted');
    assert.ok(home.includes('Priority follow-ups'));
    assert.ok(home.includes('My pipeline'));
    assert.ok(home.includes('Weekly activity'));
    assert.ok(home.includes('Recent leads'));
    assert.ok(home.includes('PERSONAL WORKSPACE'.toLowerCase()) || home.includes('Personal workspace'));
    // The greeting is time-based, from the real user name.
    assert.ok(home.includes('greetingForDhakaHour'));
    assert.ok(home.includes('firstNameOf'));
  });

  it('LeadGenerate has the simple first screen, More details, email and assign-to', () => {
    const form = stripComments(readSrc('modules/leads/pages/LeadGenerate.tsx'));
    assert.ok(form.includes("register('email')"));
    assert.ok(form.includes("register('assignedTo')"));
    assert.ok(form.includes('More details'));
    assert.ok(form.includes('showMoreDetails'));
    // Nothing was removed: every extra field still renders.
    for (const field of ['profession', 'occupation', 'maritalStatus', 'familyMember', 'division', 'district', 'thana', 'residenceAddress', 'officeAddress', 'productName', 'campaignName']) {
      assert.ok(form.includes(`'${field}'`), `the ${field} field must still exist`);
    }
    // A failed submit re-opens More details when an error hides inside.
    assert.ok(form.includes('handleSubmit(onSubmit, onInvalid)'));
    assert.ok(form.includes('onInvalid'));
  });

  it('FollowUpStrategy has the four KPI cards, the outcome flow and the tip', () => {
    const queue = stripComments(readSrc('modules/leads/pages/FollowUpStrategy.tsx'));
    assert.ok(queue.includes('label="Due today"'));
    assert.ok(queue.includes('label="Upcoming"'));
    assert.ok(queue.includes('label="Completed"'));
    assert.ok(queue.includes('label="On-time rate"'));
    assert.ok(queue.includes('updateLeadStatus'), 'checking a row calls the real update flow');
    assert.ok(queue.includes('Add follow-up'));
    // The tip bar's wording (split across two JSX lines in the source).
    assert.ok(queue.includes('log the outcome and schedule the'));
    assert.ok(queue.includes('next follow-up to keep your pipeline accurate'));
    // The bucket deep-link contract survives.
    assert.ok(queue.includes("searchParams.get('bucket')"));
    // The upcoming subline is honest — never "Next 7 days".
    assert.ok(queue.includes('Scheduled ahead'));
    assert.ok(!queue.includes('Next 7 days'));
  });

  it('ExecutionIntelligence renders the performance layout for every role; AgentPerformance carries Mahadi\'s KPIs', () => {
    // Team Lead / Manager / Admin workspace (2026-11-20): the ~600-line
    // Analytics layout was REMOVED — all roles render AgentPerformance
    // with scope-driven leads (the Agent layout, team/org scope for
    // the other roles). The role branch survives only for the title.
    const page = stripComments(readSrc('modules/dashboard/pages/ExecutionIntelligence.tsx'));
    assert.ok(page.includes("role === 'agent'"), 'the title still branches on the display role');
    assert.ok(page.includes('<AgentPerformance'));
    assert.ok(!page.includes('stageBreakdown'), 'the Analytics layout is gone');
    assert.ok(!page.includes('trendPoints'), 'the Analytics layout is gone');
    assert.ok(!page.includes('ncpByArea'), 'the Analytics layout is gone');
    const perf = stripComments(readSrc('modules/dashboard/components/AgentPerformance.tsx'));
    assert.ok(perf.includes('label="Total Response"'));
    assert.ok(perf.includes('label="Pipeline Premium"'));
    assert.ok(perf.includes('label="Converted ratio"'));
    assert.ok(perf.includes('label="Total Collected Premium"'));
    assert.ok(perf.includes('Conversion funnel'));
    assert.ok(perf.includes('Performance insights'));
    assert.ok(perf.includes('Export'));
    assert.ok(perf.includes('toCsv('), 'Export downloads a real CSV');
  });

  it('LeadList has the demo columns, the priority filter and the quick view', () => {
    const list = stripComments(readSrc('modules/leads/pages/LeadList.tsx'));
    assert.ok(list.includes('<th>Lead</th>'));
    assert.ok(list.includes('<th>Source</th>'));
    assert.ok(list.includes('<th>Owner</th>'));
    assert.ok(list.includes('<th>Priority</th>'));
    assert.ok(list.includes('<th>Stage</th>'));
    assert.ok(list.includes('<th>Created</th>'));
    assert.ok(list.includes('Search name, phone or lead ID'));
    assert.ok(list.includes('priorityFilter'));
    assert.ok(list.includes('<LeadQuickViewModal'));
    assert.ok(list.includes('View ↗'));
    // The fake call toast and the dead pager are gone.
    assert.ok(!list.includes('Initiating secure call'));
    assert.ok(!list.includes('handleCall'));
  });
});
