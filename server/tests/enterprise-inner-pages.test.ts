/**
 * enterprise-inner-pages.test.ts
 * ------------------------------------------------------------------
 * Fix round 1 (2026-11-19): Mahadi's ask — "side bar theke kono
 * page er bhitore gele oi page gulo ei design er and wording er
 * sathe align rekhe design lagbe." Every sidebar-reachable page
 * now renders the sample's heading (eyebrow + H1 + the sample's
 * description) through EnterprisePageHeader, in the sample's
 * design language. Pinned here:
 *
 *   - each sidebar route's page file renders the sample heading
 *     for its own path (Settings' three variants use
 *     OverviewHeading directly — same sample heading, variant
 *     titles);
 *   - no bare "$" in the restyled pages (money is ৳; `$` survives
 *     only as template interpolation `${...}` or a regex end
 *     anchor `$/`);
 *   - every link target in the restyled pages resolves to a real
 *     route registered in App.tsx (same extraction as the homes
 *     guards, plus navigate() calls and query strings).
 *
 * Deliberately NOT restyled (closest sample-aligned layout kept):
 * the LeadQualitySnapshot shared component, the org-chart node
 * cards, LeadList's mobile list + status tabs, the calendar
 * grids, and the shared UserBulkImportModal / EnterpriseAccessPanel
 * components. (TeamOverview's tree rows + StatCard tiles left
 * with the 2026-11-20 Team Members rebuild — Mahadi called the
 * old page "ekta faltu design" — replaced by the roster + drill-
 * down; the org chart itself still lives on /team/organogram.)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Strip block + line comments so documented substitutions don't trip the guards. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Sidebar route -> the page file that renders it. */
const SIDEBAR_PAGES: [string, string][] = [
  ['/activities', 'src/modules/leads/pages/Activities.tsx'],
  ['/administration', 'src/modules/navigation/pages/MorePages.tsx'],
  ['/audit-log', 'src/modules/admin/pages/AuditLogPage.tsx'],
  ['/campaign-breakdown', 'src/modules/dashboard/pages/CampaignBreakdown.tsx'],
  ['/execution-intelligence', 'src/modules/dashboard/pages/ExecutionIntelligence.tsx'],
  ['/follow-up', 'src/modules/leads/pages/FollowUpStrategy.tsx'],
  ['/leads', 'src/modules/leads/pages/LeadList.tsx'],
  // Team Lead / Manager / Admin workspace (2026-11-20): My Leads
  // (own-only), Self Performance, Team User Management.
  ['/leads/my', 'src/modules/leads/pages/LeadList.tsx'],
  ['/performance/self', 'src/modules/dashboard/pages/SelfPerformance.tsx'],
  ['/users/team', 'src/modules/users/pages/TeamUserManagement.tsx'],
  ['/leads/all', 'src/modules/leads/pages/AllLeads.tsx'],
  ['/leads/new', 'src/modules/leads/pages/LeadGenerate.tsx'],
  ['/leads/upload', 'src/modules/leads/pages/LeadUpload.tsx'],
  ['/ncp-progress', 'src/modules/dashboard/pages/NcpProgress.tsx'],
  ['/notifications', 'src/modules/navigation/pages/MorePages.tsx'],
  ['/roadshows', 'src/modules/roadshows/pages/RoadshowPage.tsx'],
  ['/sales-pipeline', 'src/modules/dashboard/pages/SalesPipelinePage.tsx'],
  ['/settings', 'src/modules/settings/pages/ProfileSettings.tsx'],
  ['/task-calendar', 'src/modules/auth/pages/TaskCalendar.tsx'],
  ['/team', 'src/modules/team/pages/TeamOverview.tsx'],
  ['/trend-charts', 'src/modules/dashboard/pages/TrendCharts.tsx'],
  ['/users', 'src/modules/users/pages/UserManagement.tsx'],
  ['/workbench', 'src/modules/workbench/pages/DailyWorkbench.tsx'],
  ['/more', 'src/modules/navigation/pages/MorePages.tsx'],
  ['/help', 'src/modules/navigation/pages/MorePages.tsx'],
  ['/about', 'src/modules/navigation/pages/MorePages.tsx'],
];

/** Pages one click from the sidebar, restyled in the same round. */
const LINKED_PAGES: [string, string][] = [
  ['/team/organogram', 'src/modules/hierarchy/pages/TeamHierarchy.tsx'],
  ['/settings/performance-diagnostics', 'src/modules/settings/pages/PerformanceDiagnostics.tsx'],
  // Lead details edit (2026-11-20): one click from Lead360, the
  // same form as Add Lead in edit mode.
  ['/leads/:id/edit', 'src/modules/leads/pages/LeadGenerate.tsx'],
];

describe('inner pages — every sidebar page renders the sample heading', () => {
  for (const [route, file] of [...SIDEBAR_PAGES, ...LINKED_PAGES]) {
    it(`${route} (${file})`, () => {
      const code = stripComments(read(file));
      // MorePages routes most headings through PageHeading (which
      // renders EnterprisePageHeader); More itself uses the header
      // directly. Either form counts — both render the sample's
      // heading for the path.
      //
      // /leads and /leads/my are the exceptions to the literal
      // check: LeadList renders ONE header whose path is a ternary
      // (`listScope === 'my' ? '/leads/my' : '/leads'`), so the
      // file contains both routes as string literals, not as
      // path="…". Accept the literal there. Same for /leads/new
      // and /leads/:id/edit: LeadGenerate renders ONE header whose
      // path is a ternary on isEditMode.
      const ternaryRoutes = ['/leads/my', '/leads', '/leads/new', '/leads/:id/edit'];
      const heading =
        code.includes(`<PageHeading path="${route}"`) ||
        (code.includes('<EnterprisePageHeader') && code.includes(`path="${route}"`)) ||
        (ternaryRoutes.includes(route) && code.includes('<EnterprisePageHeader') && code.includes(`'${route}'`));
      assert.ok(heading, `${file} renders the sample heading for ${route}`);
    });
  }

  it('the three settings variants render the sample heading with their own titles', () => {
    const settings = stripComments(read('src/modules/settings/pages/Settings.tsx'));
    for (const title of ['Status & Pipeline', 'Products & Campaigns', 'System Settings']) {
      assert.ok(settings.includes(`title="${title}"`), `Settings renders the "${title}" heading`);
    }
  });

  it('no restyled page keeps a hand-rolled H1 next to the sample heading', () => {
    // A page that renders EnterprisePageHeader must not also render
    // its own <h1> — one heading per page, the sample's.
    const files = new Set([...SIDEBAR_PAGES, ...LINKED_PAGES].map(([, f]) => f));
    for (const file of files) {
      if (file.endsWith('Settings.tsx')) continue; // variants use OverviewHeading, covered above
      const code = stripComments(read(file));
      assert.ok(!code.includes('<h1'), `${file} must not render its own <h1>`);
    }
  });
});

describe('inner pages — no bare "$" (money is ৳)', () => {
  const files = new Set([
    ...SIDEBAR_PAGES.map(([, f]) => f),
    ...LINKED_PAGES.map(([, f]) => f),
    'src/modules/settings/pages/Settings.tsx',
  ]);
  for (const file of files) {
    it(file, () => {
      // `$` survives only as template interpolation `${...}` or a
      // regex end anchor `$/` (email/date validation patterns).
      const code = stripComments(read(file))
        .replaceAll('${', '')
        .replaceAll('$/', '');
      assert.ok(!code.includes('$'), `${file} carries a bare dollar sign`);
    });
  }
});

describe('inner pages — every link target is a real App.tsx route', () => {
  /** Route patterns registered in App.tsx (`path: '/...'`), incl. `:param` segments. */
  const appRoutes = [...read('src/App.tsx').matchAll(/path: '([^']+)'/g)].map(m => m[1]);

  /** Does `route` match `pattern` (`:param` matches one segment)? */
  const matchesRoute = (pattern: string, route: string): boolean => {
    const patternParts = pattern.split('/');
    const routeParts = route.split('/');
    if (patternParts.length !== routeParts.length) return false;
    return patternParts.every((part, i) => part.startsWith(':') || part === routeParts[i]);
  };

  const isRealRoute = (route: string): boolean =>
    appRoutes.some(pattern => pattern !== '*' && matchesRoute(pattern, route));

  interface LinkSite {
    kind: 'static' | 'template';
    value: string;
  }

  /** Every link site in a page: `to="..."`, `to: '...'`, template `to`s, and navigate() calls. */
  const linkSites = (src: string): LinkSite[] => {
    const sites: LinkSite[] = [];
    for (const m of src.matchAll(/to="([^"]+)"/g)) sites.push({ kind: 'static', value: m[1] });
    for (const m of src.matchAll(/to:\s*'([^']+)'/g)) sites.push({ kind: 'static', value: m[1] });
    for (const m of src.matchAll(/to:\s*`([^`]+)`/g)) sites.push({ kind: 'template', value: m[1] });
    for (const m of src.matchAll(/to=\{`([^`]+)`\}/g)) sites.push({ kind: 'template', value: m[1] });
    for (const m of src.matchAll(/to=\{[^}]*'(\/[^']+)'[^}]*\}/g)) sites.push({ kind: 'static', value: m[1] });
    for (const m of src.matchAll(/navigate\('([^']+)'/g)) sites.push({ kind: 'static', value: m[1] });
    for (const m of src.matchAll(/navigate\(`([^`]+)`/g)) sites.push({ kind: 'template', value: m[1] });
    return sites;
  };

  it('App.tsx registers the routes the inner pages link to', () => {
    for (const route of ['/', '/users', '/team', '/team/organogram', '/leads', '/leads/new', '/leads/:id', '/leads/my', '/performance/self', '/users/team', '/workbench', '/task-calendar', '/roadshows', '/sales-pipeline', '/ncp-progress', '/team/kpi/:kpi', '/settings/status-pipeline', '/settings/products-campaigns', '/settings/system']) {
      assert.ok(appRoutes.includes(route), `App.tsx registers ${route}`);
    }
  });

  // Exact site counts pin the extraction itself: if a regex stops
  // matching a link shape, the count drops and this fails loudly
  // instead of silently checking fewer links.
  const EXPECTED_SITES: Record<string, number> = {
    'src/modules/leads/pages/Activities.tsx': 1,
    'src/modules/dashboard/pages/SalesPipelinePage.tsx': 3,
    // Agent workspace rebuild (2026-11-20): 3 — the row's Lead360
    // navigation, the row's Update link, and the outcome dialog's
    // "Open the full update page" link.
    'src/modules/leads/pages/FollowUpStrategy.tsx': 3,
    'src/modules/settings/pages/ProfileSettings.tsx': 0,
    'src/modules/dashboard/pages/CampaignBreakdown.tsx': 0,
    'src/modules/dashboard/pages/TrendCharts.tsx': 0,
    // Branding + About/Help (2026-11-20): 12 — the logout navigate
    // (/login), the notification lead navigate (template, /leads/…),
    // and the Help page's 10 inline links (/leads/new, /leads,
    // /follow-up, /task-calendar, /roadshows, /leads/upload,
    // /performance/self, /execution-intelligence, /notifications,
    // /settings). Delete requests (2026-11-20): 13 — plus the
    // notification delete-request navigate (/leads/delete-requests).
    'src/modules/navigation/pages/MorePages.tsx': 13,
    'src/modules/dashboard/pages/NcpProgress.tsx': 0,
    'src/modules/roadshows/pages/RoadshowPage.tsx': 0,
    'src/modules/leads/pages/LeadUpload.tsx': 0,
    // Head-first drill-down (2026-11-20): 6 — the Organogram link,
    // the Invite member link, the breadcrumb top link (/team), the
    // breadcrumb ancestor link (template, /team?node=…), the member
    // detail's lead rows, and the member detail's follow-up rows.
    // The roster-row link is built in a variable (rowTo), so the
    // extractor cannot see it — its two shapes are pinned in
    // team-members-head-drilldown.test.ts instead.
    'src/modules/team/pages/TeamOverview.tsx': 6,
    'src/modules/hierarchy/pages/TeamHierarchy.tsx': 0,
    // Agent workspace rebuild (2026-11-20): 6 — the ?leadId= deep
    // link, the mobile row open, the mobile update, the mobile
    // chevron, the desktop row open, the desktop update. (The
    // Timeline and Edit buttons are gone; the quick view lives in
    // LeadQuickViewModal.tsx.) Team Lead / Manager / Admin
    // workspace (2026-11-20): +5 — the Manager TL-group link, the
    // Manager member link, the two All-teams back links, and the
    // /leads/my page-gate redirect.
    'src/modules/leads/pages/LeadList.tsx': 11,
    'src/modules/leads/pages/AllLeads.tsx': 1,
    'src/modules/workbench/pages/DailyWorkbench.tsx': 16,
    'src/modules/auth/pages/TaskCalendar.tsx': 5,
    'src/modules/users/pages/UserManagement.tsx': 0,
    // Lead details edit (2026-11-20): 3 — save → Lead360, Cancel
    // → Lead360, and the load-error screen's Back to Leads.
    'src/modules/leads/pages/LeadGenerate.tsx': 3,
    'src/modules/settings/pages/PerformanceDiagnostics.tsx': 1,
    // Team Lead / Manager / Admin workspace (2026-11-20): 1 — the
    // Manager breakdown table's TL link (/team?node=…).
    'src/modules/dashboard/pages/ExecutionIntelligence.tsx': 1,
    // New pages (2026-11-20): 1 each — the page-gate redirect
    // (SelfPerformance -> /execution-intelligence,
    // TeamUserManagement -> /).
    'src/modules/dashboard/pages/SelfPerformance.tsx': 1,
    'src/modules/users/pages/TeamUserManagement.tsx': 1,
    'src/modules/settings/pages/Settings.tsx': 1,
  };

  for (const [file, expected] of Object.entries(EXPECTED_SITES)) {
    it(`${file}: every link target resolves to a registered route`, () => {
      const sites = linkSites(stripComments(read(file)));
      assert.equal(sites.length, expected, `${file} link-site count (extraction drift?)`);
      for (const site of sites) {
        const normalized = site.kind === 'template'
          ? site.value.replace(/\$\{[^}]+\}/g, ':param')
          : site.value;
        // Query strings ride on a real route (/leads?leadId=...).
        const base = normalized.split('?')[0];
        assert.ok(normalized.startsWith('/'), `${file}: link target ${site.value} starts with /`);
        assert.ok(isRealRoute(base), `${file}: ${site.value} is not a registered App.tsx route`);
      }
    });
  }
});
