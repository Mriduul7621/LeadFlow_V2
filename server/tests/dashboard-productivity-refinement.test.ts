/**
 * PR #24 productivity refinement, retargeted at the role-home MemberHome
 * (Phase 1 role-dashboard redesign, 2026-11-17): real React rendering
 * for the member home's presentation component, plus narrow
 * source/compile guards for its wiring. Uses the existing node:test +
 * React stack; no browser, DB or extra requests.
 *
 * RETIRED with Dashboard.tsx (2026-11-17): TodayTomorrowPanel,
 * ExecutiveSnapshot, resolveRange and the period picker. Today /
 * Tomorrow execution lives on the Daily Workbench now (see
 * daily-workbench.test.ts for its ordering/dedup/skeleton pins);
 * the member home has no period filter — its pipeline is always
 * all-time and its KPIs are today / this-month by construction.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';
import { MemberHomeContent } from '../../src/modules/workspace/pages/MemberHome';
import { buildNext7Days } from '../../src/modules/workspace/utils/workspaceData';
import type { FollowUpQueueItem } from '../../src/modules/leads/services/leadService';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MEMBER_HOME_PATH = path.join(ROOT, 'src/modules/workspace/pages/MemberHome.tsx');
const source = fs.readFileSync(MEMBER_HOME_PATH, 'utf8');
const main = source.slice(source.indexOf('export default function MemberHome()'));

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(MemoryRouter, null, element));
}

function followUp(id: string, nextFollowUpAt: string, dueState: FollowUpQueueItem['dueState'] = 'today'): FollowUpQueueItem {
  return {
    id,
    prospectName: `Queue ${id}`,
    mobile: '01700000000',
    assignedTo: 'EMP001',
    currentStatus: 'Interested',
    nextFollowUpAt,
    dueState,
  };
}

const contentProps = {
  userName: 'Lena Lead',
  dateLine: 'Tuesday, 17 November 2026',
  greeting: 'Good morning',
  assigned: 8,
  dueToday: 1,
  overdue: 1,
  convertedThisMonth: 2 as number | null,
  priority: [followUp('p-1', '2026-11-16T10:00:00+06:00', 'overdue')],
  priorityTotal: 2,
  dailyLoading: false,
  chartDays: buildNext7Days([], new Date('2026-11-17T06:00:00Z')),
  chartTruncated: false,
  pipeline: [
    { name: 'New', count: 4, terminal: false, won: false, lost: false },
    { name: 'Converted', count: 2, terminal: true, won: true, lost: false },
  ],
  recentLeads: [],
  recentLeadsLoading: false,
  canCreateLead: true,
  hasTeam: false,
};

describe('Member home productivity refinement — rendering + guards', () => {
  it('icons are explicitly imported from lucide-react and render as icons, not DOM globals', () => {
    const ast = ts.createSourceFile(MEMBER_HOME_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const iconImport = ast.statements.find((node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'lucide-react');
    const bindings = iconImport?.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    for (const name of ['AlertTriangle', 'CalendarClock', 'Layers', 'Plus', 'RefreshCw', 'TrendingUp']) {
      assert.ok(bindings.elements.some((item) => item.name.text === name), `${name} must be an explicit lucide-react import`);
    }
    const html = render(React.createElement(MemberHomeContent, contentProps));
    assert.match(html, /lucide-triangle-alert/, 'the Overdue card renders its icon');
    assert.match(html, /lucide-calendar-clock/, 'the Due-today card renders its icon');
    assert.match(html, /lucide-layers/, 'the Assigned card renders its icon');
    assert.match(html, /lucide-trending-up/, 'the Converted card renders its icon');
  });

  it('MemberHome.tsx compiles without unresolved identifiers or unused imports, helpers and local computations', () => {
    const config = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    const program = ts.createProgram([MEMBER_HOME_PATH], {
      ...parsed.options,
      noUnusedLocals: true,
      noUnusedParameters: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter((item) => !item.file || path.resolve(item.file.fileName) === MEMBER_HOME_PATH)
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
    assert.deepEqual(diagnostics, []);
  });

  it('the KPI cards render their values and link to their drill-downs (Converted excepted)', () => {
    const html = render(React.createElement(MemberHomeContent, contentProps));
    assert.ok(html.includes('aria-label="Assigned leads: 8 — view details"'));
    assert.ok(html.includes('aria-label="Due today: 1 — view details"'));
    assert.ok(html.includes('aria-label="Overdue: 1 — view details"'));
    assert.ok(html.includes('href="/team/kpi/totalLeads"'));
    assert.ok(html.includes('href="/team/kpi/dueToday"'));
    assert.ok(html.includes('href="/team/kpi/overdue"'));
    assert.ok(!html.includes('href="/team/kpi/converted"'),
      'Converted-this-month has no matching drill-down (the converted drill-down is all-time)');
  });

  it('shows loading skeletons instead of false empty states while the daily reads are pending', () => {
    assert.match(main, /dailyLoading=\{dailyLoading\}/);
    const html = render(React.createElement(MemberHomeContent, { ...contentProps, dailyLoading: true }));
    assert.match(html, /aria-label="Loading follow-ups"/);
    assert.match(html, /aria-label="Loading activity chart"/);
    assert.doesNotMatch(html, /Nothing due — no follow-ups are overdue or due today\./);
    const recent = render(React.createElement(MemberHomeContent, { ...contentProps, recentLeadsLoading: true }));
    assert.match(recent, /aria-label="Loading recent leads"/);
    assert.doesNotMatch(recent, /No recent leads yet\./);
  });

  it('only shows the empty states after the daily reads settle', () => {
    const html = render(React.createElement(MemberHomeContent, {
      ...contentProps,
      priority: [],
      priorityTotal: 0,
      recentLeads: [],
    }));
    assert.ok(html.includes('Nothing due — no follow-ups are overdue or due today.'));
    assert.ok(html.includes('No recent leads yet.'));
    assert.doesNotMatch(html, /aria-label="Loading follow-ups"/);
  });

  it('keeps every overdue/today/upcoming bucket reachable without the retired card', () => {
    // The three-bucket card was removed from Home; the buckets themselves are
    // still first-class destinations. The Overdue KPI card links into the
    // queue via the drill-down, and the queue strategy page still serves
    // ?bucket=overdue|today|upcoming.
    const html = render(React.createElement(MemberHomeContent, contentProps));
    assert.match(html, /Overdue/);
    assert.match(html, /lucide-triangle-alert/);
    const strategy = fs.readFileSync(path.join(ROOT, 'src/modules/leads/pages/FollowUpStrategy.tsx'), 'utf8');
    assert.match(strategy, /bucket=overdue|'overdue'/);
    assert.match(strategy, /searchParams|useSearchParams/);
    assert.equal((source.match(/FollowUpDiscipline/g) || []).length, 0, 'the retired card must not come back to the member home');
  });

  it('fixes rounded-[10x] and preserves the Add Lead action', () => {
    assert.doesNotMatch(source, /rounded-\[10x\]/);
    assert.match(source, /to="\/leads\/new" className="lf-primary-action" aria-label="Add Lead"/);
    assert.match(main, /canAccess\('lead_generate', 'create'\)/);
  });

  it('adds no full lead fetch or new daily requests; summaries use only the existing loaded arrays', () => {
    // No network read may be introduced by the presentation layer — with the
    // single, explicitly BOUNDED exception of the Recent Leads strip: it asks
    // for five rows (never the full list) and only when the local mirror is
    // empty. The KPI loader must remain free of every lead read (below).
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /\bgetLeads\s*\(/, 'the full lead list must never be fetched here');
    assert.equal(
      (source.match(/leadService\.getRecentLeads\(5\)/g) || []).length,
      1,
      'exactly one bounded recent-leads read (limit 5)',
    );
    assert.ok(!source.includes('localStorage'), 'no direct localStorage access');
    // The ONE permitted local source is the read-only mirror of server data
    // (`localDb.getLeads()`), used by Recent Leads: it performs no request,
    // and it is explicitly forbidden inside the KPI loader (perf-phase2 G
    // enforces the same boundary).
    assert.equal(
      (source.match(/localDb\.getRecentLeads\(/g) || []).length,
      1,
      'exactly one capped mirror read (Recent Leads) — never a second data source',
    );
    {
      const kpiStart = source.indexOf('const loadDashboardData');
      const kpiEnd = source.indexOf('const loadDailyExecution');
      assert.ok(!source.slice(kpiStart, kpiEnd).includes('localDb'), 'the KPI loader must not read the mirror');
    }
    // Three server-authoritative bucket reads (overdue / today /
    // upcoming) — never one bucket=all read, which would truncate.
    assert.equal((source.match(/leadService\.getFollowUpQueue\(/g) || []).length, 3);
    assert.match(source, /getFollowUpQueue\(\{ bucket: 'overdue', limit: 50 \}\)/);
    assert.match(source, /getFollowUpQueue\(\{ bucket: 'today', limit: 50 \}\)/);
    assert.match(source, /getFollowUpQueue\(\{ bucket: 'upcoming', limit: 50 \}\)/);
    assert.doesNotMatch(source, /bucket: 'all'/, 'no bucket=all read may replace the three buckets');
    // Scheduled work lives on the Task Calendar page, not on the home.
    assert.ok(!source.includes('scheduledActivityService'), 'the member home must not read scheduled activities');
    assert.ok(!source.includes('scheduled_activities'), 'the member home must not reference scheduled_activities');
    const content = source.slice(source.indexOf('export function MemberHomeContent('), source.indexOf('export default function MemberHome()'));
    assert.doesNotMatch(content, /Service\.|\bfetch\s*\(/, 'the content component never fetches');
  });

  it('keeps the personal-work sections in order and leaves the analysis pages off Home', () => {
    // Role-home order: greeting + KPI grid, then Priority follow-ups,
    // My pipeline, the 7-day chart, Recent Leads. The pipeline board,
    // follow-up discipline, needs-attention and the embedded calendar
    // live on their own pages.
    const content = source.slice(source.indexOf('export function MemberHomeContent('));
    const order = ['Priority follow-ups', 'My pipeline', 'Follow-ups due · next 7 days', 'Recent leads'];
    let previous = -1;
    for (const section of order) {
      const index = content.indexOf(section);
      assert.ok(index > previous, `${section} must follow the previous section`);
      previous = index;
    }
    assert.ok(!content.includes('<TaskCalendar'), 'Home must not embed the calendar any more');
    assert.ok(!content.includes('<SalesPipeline'), 'Home must not embed the pipeline board any more');
    assert.ok(!content.includes('FollowUpDiscipline'), 'Home must not embed follow-up discipline');
    assert.ok(!content.includes('NeedsAttentionSection'), 'Home must not embed needs-attention');
    assert.ok(!content.includes('LeadQualitySnapshot'), 'the Lead Quality snapshot lives on the Sales Pipeline page');
    assert.doesNotMatch(source, /Lead Status Distribution/);
    // Recent Leads stays: it is personal, not analytical.
    assert.match(content, /lf-recent-list/);
  });

  it('has no period filter: the pipeline is all-time, the KPIs are today / this-month by construction', () => {
    // resolveRange and the Today/WTD/MTD/LMTD/YTD/Custom picker retired
    // with Dashboard.tsx. The member home must not grow one back: its
    // pipeline reads the full status counts (period ALL) and its KPI
    // cards read the overview self row + converted-this-month.
    assert.ok(!source.includes('resolveRange'), 'no period resolver on the member home');
    assert.ok(!source.includes('LMTD') && !source.includes('WTD'), 'no period keys on the member home');
    assert.ok(!source.includes('Date Range'), 'no date-range control on the member home');
    assert.match(main, /dashboardService\.getDashboard\(\{ period: 'ALL' \}\)/, 'the pipeline read is always all-time');
  });
});
