/**
 * enterprise-analytics.test.ts
 * ------------------------------------------------------------------
 * Team Lead / Manager / Admin workspace (2026-11-20): the
 * Analytics layout on /execution-intelligence (fix round 1,
 * 2026-11-19 — leads-over-time area chart, stage pie,
 * NCP-by-area bars, rates card, area table) was REMOVED and
 * every role now renders the performance layout
 * (AgentPerformance, Mahadi's KPI set) on scope-driven leads:
 * the Agent's own leads, the TL's team leads, the Manager's
 * downline, the Admin's org-wide leads minus admin-assigned
 * ones. The Manager additionally gets a TL-grouped breakdown
 * table below the layout. The Analytics code is restorable from
 * git if Mahadi ever asks for it back; keeping ~600 lines of
 * unreachable code would rot. Reported in the PR.
 *
 * The NCP Progress quartile fix (fix round 1) is unchanged: its
 * chart interpolated the period totals at 25/55/80/100% —
 * invented numbers. The buckets now sum the leads that actually
 * fall in each quarter of the selected period, cumulatively.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterpriseHeadingForPath } from '../../src/layouts/enterpriseNav';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Strip block + line comments so documented substitutions don't trip the guards. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const analytics = stripComments(read('src/modules/dashboard/pages/ExecutionIntelligence.tsx'));

describe('Team Performance — every role renders the performance layout on scope-driven leads', () => {
  it('renders AgentPerformance with a role title + scope note, never the Analytics layout', () => {
    assert.ok(analytics.includes('<AgentPerformance'), 'the page renders the shared performance layout');
    assert.ok(analytics.includes('title={title}'), 'the export title follows the role');
    assert.ok(analytics.includes('scopeNote={scopeNote}'), 'the scope line follows the role');
    // The Analytics layout is GONE — no chart/popup/table code survives.
    for (const gone of ['<AreaChart', '<PieChart', '<BarChart', 'ncpByArea', 'stageBreakdown', 'trendPoints', 'setActivePopup', 'handleExportTeamStats']) {
      assert.ok(!analytics.includes(gone), `${gone} is gone with the Analytics layout`);
    }
  });

  it('scopes the leads by display role through the Team Leads split (never widens)', () => {
    assert.ok(analytics.includes('teamLeadsForRole(leads, people, self, role)'), 'the scope split drives the list');
    assert.ok(analytics.includes('useEnterpriseDisplayRole()'), 'the scope follows the display role');
    assert.ok(analytics.includes('useCallerTeam()'), 'the scope comes from the shared team overview');
  });

  it('the Agent keeps the My Performance title and its own-leads scope note', () => {
    assert.ok(analytics.includes("role === 'agent' ? 'My Performance' : 'Team Performance'"), 'Agent = My Performance, everyone else = Team Performance');
    assert.ok(analytics.includes("'all figures are your own scoped leads'"), 'the Agent scope note is unchanged');
  });

  it('the Admin scope note names the admin exclusion', () => {
    assert.ok(analytics.includes('admins excluded'), 'the Admin scope note says admins are excluded');
  });

  it('never fabricates trend data — the server trendData is [] and unused', () => {
    assert.ok(!analytics.includes('trendData'), 'no trendData anywhere on the page');
  });

  it('keeps the sample heading and the Back button', () => {
    assert.ok(analytics.includes('path="/execution-intelligence"'), 'the sample heading via EnterprisePageHeader');
    assert.ok(analytics.includes('<BackButton fallback="/" />'), 'the Back button stays');
  });
});

describe('Team Performance — the Manager TL-grouped breakdown table', () => {
  it('renders below the layout for Managers only, all-time, with honest labelling', () => {
    assert.ok(analytics.includes("role === 'manager' && ("), 'the table is Manager-only');
    assert.ok(analytics.includes('Performance by team lead'), 'the table heading names the grouping');
    assert.ok(analytics.includes('All time · all scoped leads'), 'the table says it is all-time (the period dropdown lives inside AgentPerformance)');
    assert.ok(analytics.includes('groupLeadsByTl(scopedLeads, people, self)'), 'the groups come from the shared TL-grouping helper');
    assert.ok(analytics.includes('agentPerformanceKpis(group.leads)'), 'each row reuses the real KPI computation');
    assert.ok(analytics.includes('Response'), 'response % per TL');
    assert.ok(analytics.includes('Collected Premium'), 'collected premium per TL');
  });

  it('each TL row links to that TL\'s member-wise roster', () => {
    assert.ok(analytics.includes('to={`/team?tl=${encodeURIComponent(group.tl.employeeId)}`}'), 'the TL name links to /team?tl=…');
  });
});

describe('Team Performance — the role-aware titles', () => {
  it('admin, manager and team lead see "Team Performance"; the agent sees "My Performance"', () => {
    assert.equal(enterpriseHeadingForPath('admin', '/execution-intelligence').title, 'Team Performance');
    assert.equal(enterpriseHeadingForPath('manager', '/execution-intelligence').title, 'Team Performance');
    assert.equal(enterpriseHeadingForPath('teamLead', '/execution-intelligence').title, 'Team Performance');
    assert.equal(enterpriseHeadingForPath('agent', '/execution-intelligence').title, 'My Performance');
    assert.equal(
      enterpriseHeadingForPath('admin', '/execution-intelligence').sub,
      'Review team performance and progress.',
      "the Team Performance description",
    );
  });
});

describe('NCP Progress — quartile buckets from real leads, no interpolation', () => {
  const ncp = stripComments(read('src/modules/dashboard/pages/NcpProgress.tsx'));

  it('the chart data sums the leads in each quarter of the period', () => {
    assert.ok(ncp.includes('const ncpTrackingData = useMemo'), 'the chart data is a memo');
    assert.ok(ncp.includes('const inQuartile = leads.filter'), 'each bucket filters the real leads');
    assert.ok(ncp.includes('cumCollected += inQuartile.reduce'), 'collected is cumulative over real leads');
    assert.ok(ncp.includes('cumProjected += inQuartile.reduce'), 'projected is cumulative over real leads');
    assert.ok(ncp.includes('getPeriodRange()'), 'the quarters come from the selected period');
  });

  it('no interpolated percentages survive in the chart data', () => {
    const memo = ncp.slice(ncp.indexOf('const ncpTrackingData = useMemo'));
    const body = memo.slice(0, memo.indexOf('}, [leads, period, selectedDate, customDates]);'));
    for (const invented of ['0.25', '0.55', '0.8', '* 0.25', '* 0.55']) {
      assert.ok(!body.includes(invented), `the old ${invented} interpolation is gone`);
    }
  });

  it('the chart still renders the cumulative series', () => {
    assert.ok(ncp.includes('data={ncpTrackingData}'), 'the chart reads the quartile memo');
    assert.ok(ncp.includes('Collected vs projected potential, cumulative through the period'));
  });
});
