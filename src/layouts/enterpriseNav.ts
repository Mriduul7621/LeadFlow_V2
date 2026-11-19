import {
  Activity,
  Banknote,
  BarChart3,
  Bell,
  CalendarDays,
  ClipboardList,
  Clock,
  FileText,
  Globe,
  LayoutDashboard,
  MapPinned,
  Network,
  Plus,
  Settings as SettingsIcon,
  SlidersHorizontal,
  TrendingUp,
  Upload,
  UserCog,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { EnterpriseRole } from './enterpriseRole';

/**
 * enterpriseNav.ts — the role-based sidebar (Enterprise Preview
 * redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * The sample prototype's sidebar, rebuilt on LeadFlow's real routes
 * and real permissions. Group titles, item labels and page subtitles
 * are the sample's EXACT words — except where Mahadi renamed a label
 * to match its page (see "Follow-up Queue" below); every item links
 * to a real LeadFlow page. The nav is ROLE-based, never a
 * role-switcher: the caller sees exactly one workspace (admin /
 * manager / team lead / agent), derived from their real scope and
 * role by deriveEnterpriseRole — there is no control that switches
 * it.
 *
 * Sample items with NO real LeadFlow page are OMITTED (never a dead
 * link, never a fake page):
 *
 *   Assignment Rules (Admin) — auto-assignment is a Metadata Engine
 *     flag with no dedicated page; its switch lives in System
 *     settings, which the Admin nav already reaches.
 *   Audit Log (Admin) — audit rows are written server-side but no
 *     audit-viewer UI exists anywhere in the app.
 *   Lead Distribution (Team Lead) — the Team Members page (/team)
 *     already IS the workload/allocation view; a second item to the
 *     same route would be a duplicate.
 *
 * The Admin CONFIGURATION group is three DISTINCT pages (fix round,
 * 2026-11-19 — Mahadi found all three landing on /settings/system,
 * which lit all three active at once): Status & Pipeline
 * (/settings/status-pipeline: lead statuses + workflow rules),
 * Products & Campaigns (/settings/products-campaigns: the Product
 * and Campaign metadata types) and System Settings
 * (/settings/system: everything else, including the Danger Zone).
 * Each is its own route, so exactly one nav item is ever active.
 *
 * Two additions are NOT in the sample and are added so no kept
 * feature loses its only entry point (both reported in the PR body):
 *   - "Follow-up Queue" (/follow-up) in every role's work group:
 *     the sample's "Follow-up Queue" label originally mapped to the
 *     Daily Workbench (/workbench), but Mahadi (2026-11-19) found
 *     the two names did not match their pages — the labels were
 *     effectively swapped. The fix renamed the labels to match the
 *     pages and moved NO data: /workbench is "Daily Workbench" (My
 *     numbers, Daily Summary, Roadshows today, Execution Queue,
 *     Completed Today, Tomorrow Preview) and /follow-up is
 *     "Follow-up Queue" (Overdue / Due Today / Upcoming buckets —
 *     its own H1 already said so). The old "Follow-up Strategy"
 *     label is gone: strategy config lives in Settings (Strategy
 *     Parameters), not on a queue page. The mobile bottom bar
 *     shortens "Daily Workbench" to "Workbench" (tab width).
 *   - ADMINISTRATION (Admin role only) with Administration
 *     (/administration): the Administration page is the only route
 *     to Performance Diagnostics, so it stays one tap away for
 *     admins. Performance Diagnostics itself is deliberately NOT a
 *     sidebar entry (standing rule: it belongs to Administration).
 * Help / About live in the sidebar footer (AppLayout), not here.
 * The /more directory page has no entry: every destination it
 * lists is reachable elsewhere in this nav or the footer.
 *
 * The sidebar is a UX surface, never a security boundary: every entry
 * is filtered by the SAME resolvers the router uses
 * (`resolveFeatureRouteAccess` for the route module + `canAccess` for
 * the functional permission), and each destination route keeps its own
 * FeatureGate + ProtectedRoute. A role that cannot open a page never
 * sees its sidebar entry either.
 *
 * The builder is a pure function of the caller's role and access
 * predicates so it is unit-testable without a React tree.
 */

export interface EnterpriseNavItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

export interface EnterpriseNavGroup {
  title: string;
  items: EnterpriseNavItem[];
}

export interface EnterpriseNavAccess {
  /** Route-level module gate (featureRouteAccess) for a router path. */
  canOpen: (route: string) => boolean;
  /** Functional action permission (`view` on the module). */
  canAccess: (featureId: string, actionKey: string) => boolean;
  /** The caller's derived enterprise role (never a switcher). */
  role: EnterpriseRole;
}

/** Page subtitles, verbatim from the sample's `descriptions`. */
export const ENTERPRISE_PAGE_DESCRIPTIONS: Record<string, string> = {
  'Users & Roles': 'Manage users and review access across permission layers.',
  'Teams & Hierarchy': 'Review reporting lines and team structure.',
  'Lead Intake': 'Monitor uploads, validation and import exceptions.',
  'Lead Pool': 'Review unassigned leads and controlled distribution.',
  Analytics: 'Explore performance indicators and authorized records.',
  'Status & Pipeline': 'Review lead stages and status definitions.',
  'Products & Campaigns': 'Review catalog and campaign information.',
  'System Settings': 'Review protected platform configuration.',
  Teams: 'Compare managed teams and workload.',
  Leads: 'Search and inspect leads within your authorized scope.',
  'Follow-up Queue': 'Prioritize overdue and upcoming follow-ups.',
  'Daily Workbench': 'Your day at a glance — numbers, follow-ups due, roadshows and tomorrow.',
  'Sales Pipeline': 'Understand stage volume and conversion bottlenecks.',
  Performance: 'Review target pacing and activity performance.',
  Campaigns: 'Compare lead volume and campaign outcomes.',
  'Trends & Reports': 'Explore trends and authorized reports.',
  'NCP Progress': 'Track NCP progress against target.',
  'Roadshow Follow-up': 'Track roadshow activity and follow-up actions.',
  'Task Calendar': 'Review tasks and scheduled work.',
  'Team Members': 'Review member workload and support needs.',
  'Team Performance': 'Review team performance and progress.',
  Activities: 'Review calls, meetings, messages and notes.',
  'My Leads': 'Manage your assigned leads and next actions.',
  'Add Lead': 'Capture a prospect with the required details.',
  'Profile & Settings': 'Manage personal profile and preferences.',
  Notifications: 'Review important updates.',
  // Additions (not in the sample — the pages exist only in LeadFlow):
  // plain descriptions in the sample's voice, so their headings never
  // render an empty subtitle.
  Administration: 'Manage access and lead operations.',
  More: 'More pages and account actions.',
  Help: 'Guidance for everyday LeadFlow tasks.',
  About: 'What LeadFlow helps your team do.',
  'Performance Diagnostics': 'System diagnostics and request performance.',
  'KPI detail': 'Leads behind a KPI card.',
  Team: 'Compare managed teams and workload.',
};

type NavItemDef = EnterpriseNavItem & { permission?: string };

const ACCOUNT_ITEMS: NavItemDef[] = [
  { label: 'Profile & Settings', path: '/settings', icon: SettingsIcon },
  { label: 'Notifications', path: '/notifications', icon: Bell },
];

/** Admin-only addition (not in the sample — see the header note). */
const ADMIN_ITEMS: NavItemDef[] = [
  { label: 'Administration', path: '/administration', icon: Wrench },
];

function navItemsFor(role: EnterpriseRole): Array<{ title: string; items: NavItemDef[] }> {
  if (role === 'admin') {
    return [
      {
        title: 'WORKSPACE',
        items: [
          { label: 'Overview', path: '/', icon: LayoutDashboard },
          { label: 'Users & Roles', path: '/users', icon: UserCog },
          { label: 'Teams & Hierarchy', path: '/team', icon: Network },
          { label: 'Lead Intake', path: '/leads/upload', icon: Upload },
          { label: 'Lead Pool', path: '/leads/all', icon: ClipboardList },
          { label: 'Follow-up Queue', path: '/follow-up', icon: FileText },
        ],
      },
      {
        title: 'INSIGHTS',
        items: [
          { label: 'Analytics', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
        ],
      },
      {
        title: 'CONFIGURATION',
        items: [
          { label: 'Status & Pipeline', path: '/settings/status-pipeline', icon: SlidersHorizontal },
          { label: 'Products & Campaigns', path: '/settings/products-campaigns', icon: Globe },
          { label: 'System Settings', path: '/settings/system', icon: SettingsIcon },
        ],
      },
      { title: 'ACCOUNT', items: ACCOUNT_ITEMS },
      { title: 'ADMINISTRATION', items: ADMIN_ITEMS },
    ];
  }
  if (role === 'manager') {
    return [
      {
        title: 'WORKSPACE',
        items: [
          { label: 'Overview', path: '/', icon: LayoutDashboard },
          { label: 'Teams', path: '/team', icon: Users },
          { label: 'Leads', path: '/leads', icon: ClipboardList },
          { label: 'Daily Workbench', path: '/workbench', icon: Clock },
          { label: 'Sales Pipeline', path: '/sales-pipeline', icon: FileText },
        ],
      },
      {
        title: 'INSIGHTS',
        items: [
          { label: 'Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
          { label: 'Campaigns', path: '/campaign-breakdown', icon: Globe, permission: 'campaign_breakdown' },
          { label: 'Trends & Reports', path: '/trend-charts', icon: TrendingUp, permission: 'trend_charts' },
          { label: 'NCP Progress', path: '/ncp-progress', icon: Banknote, permission: 'ncp_progress' },
        ],
      },
      {
        title: 'FIELD EXECUTION',
        items: [
          { label: 'Roadshow Follow-up', path: '/roadshows', icon: MapPinned },
          { label: 'Follow-up Queue', path: '/follow-up', icon: FileText },
          { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
        ],
      },
      { title: 'ACCOUNT', items: ACCOUNT_ITEMS },
    ];
  }
  if (role === 'teamLead') {
    return [
      {
        title: 'WORKSPACE',
        items: [
          { label: 'Overview', path: '/', icon: LayoutDashboard },
          { label: 'Team Members', path: '/team', icon: Users },
          // Team Lead lead creation (2026-11-19, Mahadi): a team lead
          // uploads sheets (Lead Intake, gated by the teamLeadAllowed
          // route predicate) and adds single leads (Add Lead, already
          // open to everyone) — new leads default to the creator, and
          // the lead list shows the TL's own + assigned leads first.
          { label: 'Lead Intake', path: '/leads/upload', icon: Upload },
          { label: 'Add Lead', path: '/leads/new', icon: Plus },
          { label: 'Daily Workbench', path: '/workbench', icon: Clock },
          { label: 'Follow-up Queue', path: '/follow-up', icon: FileText },
          { label: 'Activities', path: '/activities', icon: Activity },
          { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
        ],
      },
      {
        title: 'PERFORMANCE',
        items: [
          { label: 'Team Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
          { label: 'Roadshow Follow-up', path: '/roadshows', icon: MapPinned },
        ],
      },
      { title: 'ACCOUNT', items: ACCOUNT_ITEMS },
    ];
  }
  return [
    {
      title: 'MY WORK',
      items: [
        { label: 'Overview', path: '/', icon: LayoutDashboard },
        { label: 'My Leads', path: '/leads', icon: ClipboardList },
        { label: 'Add Lead', path: '/leads/new', icon: ClipboardList },
        { label: 'Daily Workbench', path: '/workbench', icon: Clock },
        { label: 'Follow-up Queue', path: '/follow-up', icon: FileText },
        { label: 'Activities', path: '/activities', icon: Activity },
        { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
      ],
    },
    {
      title: 'MY PERFORMANCE',
      items: [
        { label: 'Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
        { label: 'NCP Progress', path: '/ncp-progress', icon: Banknote, permission: 'ncp_progress' },
      ],
    },
    { title: 'ACCOUNT', items: ACCOUNT_ITEMS },
  ];
}

export function buildEnterpriseNavGroups(access: EnterpriseNavAccess): EnterpriseNavGroup[] {
  const passes = (item: NavItemDef): boolean => {
    if (item.permission && !access.canAccess(item.permission, 'view')) return false;
    return access.canOpen(item.path);
  };

  // No dedupe by path: several sample items legitimately share a
  // real destination (Teams / Team Members / Teams & Hierarchy all
  // land on /team; Analytics / Performance / Team Performance all
  // land on /execution-intelligence) — but never within ONE role's
  // nav, so the active state is always unambiguous. (The Admin
  // CONFIGURATION group used to share /settings/system across
  // three items; the 2026-11-19 fix round split it into three
  // distinct routes for exactly that reason.)
  const groups: EnterpriseNavGroup[] = [];
  for (const group of navItemsFor(access.role)) {
    const items: EnterpriseNavItem[] = group.items
      .filter(passes)
      .map(({ permission: _permission, ...entry }) => entry);
    if (items.length > 0) groups.push({ title: group.title, items });
  }
  return groups;
}

/**
 * The mobile bottom navigation (fix round, 2026-11-19 — Mahadi
 * asked for a fixed bottom bar on his phone): the role's 3–4 most
 * important pages, Overview always first. It follows the DISPLAY
 * role, so a super admin previewing another role sees that role's
 * tabs. The bar itself is mobile-only (CSS hides it at desktop
 * widths, at the same 720px breakpoint as the drawer).
 *
 * The tabs are the same destinations the sidebar offers, filtered
 * by the SAME access predicates — a tab the user could not open
 * would be a dead button, so it never renders. The agent's first
 * tab is labelled "My Work" (the agent home's H1), not "Overview".
 */
export interface EnterpriseBottomNavTab {
  label: string;
  path: string;
  icon: LucideIcon;
}

interface BottomNavTabDef extends EnterpriseBottomNavTab {
  /** Functional permission gate, as in the sidebar (Analytics only). */
  permission?: string;
}

const BOTTOM_NAV_TABS: Record<EnterpriseRole, BottomNavTabDef[]> = {
  admin: [
    { label: 'Overview', path: '/', icon: LayoutDashboard },
    { label: 'Users & Roles', path: '/users', icon: UserCog },
    { label: 'Lead Pool', path: '/leads/all', icon: ClipboardList },
    { label: 'Analytics', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
  ],
  manager: [
    { label: 'Overview', path: '/', icon: LayoutDashboard },
    { label: 'Teams', path: '/team', icon: Users },
    { label: 'Analytics', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
    { label: 'Lead Pool', path: '/leads/all', icon: ClipboardList },
  ],
  teamLead: [
    { label: 'Overview', path: '/', icon: LayoutDashboard },
    { label: 'Team Members', path: '/team', icon: Users },
    { label: 'Lead Pool', path: '/leads/all', icon: ClipboardList },
    { label: 'Workbench', path: '/workbench', icon: Clock },
  ],
  agent: [
    { label: 'My Work', path: '/', icon: LayoutDashboard },
    { label: 'My Leads', path: '/leads', icon: ClipboardList },
    { label: 'Workbench', path: '/workbench', icon: Clock },
    { label: 'Add Lead', path: '/leads/new', icon: Plus },
  ],
};

export function buildEnterpriseBottomNavTabs(access: EnterpriseNavAccess): EnterpriseBottomNavTab[] {
  const passes = (tab: BottomNavTabDef): boolean => {
    if (tab.permission && !access.canAccess(tab.permission, 'view')) return false;
    return access.canOpen(tab.path);
  };
  return BOTTOM_NAV_TABS[access.role]
    .filter(passes)
    .map(({ permission: _permission, ...tab }) => tab);
}

/**
 * The bottom bar's active tab: the same longest-prefix rule as the
 * sidebar (exact for '/', prefix for the rest). Tabs never share a
 * path within one role, so the match is always unambiguous.
 */
export function enterpriseBottomNavActivePath(tabs: EnterpriseBottomNavTab[], pathname: string): string | null {
  let best: { path: string; length: number } | null = null;
  for (const tab of tabs) {
    const matches = tab.path === '/'
      ? pathname === '/'
      : pathname === tab.path || pathname.startsWith(`${tab.path}/`);
    if (!matches) continue;
    if (!best || tab.path.length > best.length) best = { path: tab.path, length: tab.path.length };
  }
  return best?.path ?? null;
}

/**
 * Breadcrumb labels for routes that never appear in the sidebar
 * (deep links, dialogs-as-pages, the More directory). The topbar
 * prefers the sidebar entry's own label; this map is the fallback
 * so a breadcrumb never shows a raw path segment.
 */
const FALLBACK_LABELS: Record<string, string> = {
  '/leads/new': 'Add Lead',
  '/leads/upload': 'Lead Intake',
  '/leads/all': 'Lead Pool',
  '/leads': 'Leads',
  '/administration': 'Administration',
  '/more': 'More',
  '/help': 'Help',
  '/about': 'About',
  '/settings': 'Profile & Settings',
  '/settings/system': 'System Settings',
  '/settings/status-pipeline': 'Status & Pipeline',
  '/settings/products-campaigns': 'Products & Campaigns',
  '/settings/performance-diagnostics': 'Performance Diagnostics',
  '/team/kpi': 'KPI detail',
  '/team/organogram': 'Teams & Hierarchy',
  '/team': 'Team',
  '/users': 'Users & Roles',
  '/workbench': 'Daily Workbench',
  '/follow-up': 'Follow-up Queue',
  '/activities': 'Activities',
  '/task-calendar': 'Task Calendar',
  '/roadshows': 'Roadshow Follow-up',
  '/sales-pipeline': 'Sales Pipeline',
  '/execution-intelligence': 'Analytics',
  '/ncp-progress': 'NCP Progress',
  '/trend-charts': 'Trends & Reports',
  '/campaign-breakdown': 'Campaigns',
  '/notifications': 'Notifications',
};

/** The breadcrumb label for a pathname, from the resolved sidebar groups. */
export function enterpriseLabelForPath(groups: EnterpriseNavGroup[], pathname: string): string {
  // Exact sidebar match first: /leads is the agent's "My Leads", not
  // the fallback's generic "Leads".
  for (const group of groups) {
    for (const item of group.items) {
      if (item.path === pathname) return item.label;
    }
  }
  // Then the exact fallback: /leads/new is "Add Lead", not its parent
  // sidebar entry — an exact label always beats a prefix match.
  if (FALLBACK_LABELS[pathname]) return FALLBACK_LABELS[pathname];
  // Longest-prefix match: /leads/123 resolves to the /leads entry.
  let best: { label: string; length: number } | null = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.path === '/') continue;
      if (pathname.startsWith(`${item.path}/`)) {
        if (!best || item.path.length > best.length) best = { label: item.label, length: item.path.length };
      }
    }
  }
  if (best) return best.label;
  // Then the longest fallback prefix (/team/kpi/:kpi).
  let fallback: { label: string; length: number } | null = null;
  for (const [prefix, label] of Object.entries(FALLBACK_LABELS)) {
    if (pathname.startsWith(`${prefix}/`) && (!fallback || prefix.length > fallback.length)) {
      fallback = { label, length: prefix.length };
    }
  }
  if (fallback) return fallback.label;
  if (pathname.startsWith('/leads/') && pathname.endsWith('/update')) return 'Update lead';
  if (pathname.startsWith('/leads/')) return 'Lead details';
  return 'LeadFlow';
}

/**
 * The sidebar's active item: the entry whose path matches the
 * current pathname — exact, or the longest prefix for deep links
 * (/leads/123 activates /leads; /team/kpi/overdue activates
 * /team). Ties resolve to the LAST item in nav order, so exactly
 * one highlight ever shows. (The Admin CONFIGURATION group used
 * to tie three labels to /settings/system; the 2026-11-19 fix
 * round gave each its own route, so the tie-break is now only a
 * safety net for future shared destinations.)
 *
 * Pure and directly unit-testable — AppLayout imports it.
 */
export function enterpriseActivePath(groups: EnterpriseNavGroup[], pathname: string): string | null {
  let best: { path: string; length: number; order: number } | null = null;
  let order = 0;
  for (const group of groups) {
    for (const item of group.items) {
      order += 1;
      const matches = item.path === '/'
        ? pathname === '/'
        : pathname === item.path || pathname.startsWith(`${item.path}/`);
      if (!matches) continue;
      if (!best || item.path.length > best.length || (item.path.length === best.length && order > best.order)) {
        best = { path: item.path, length: item.path.length, order };
      }
    }
  }
  return best?.path ?? null;
}

export interface EnterprisePageHeading {
  /** The sample's nav label for this page, for this role. */
  title: string;
  /** The sample's description for the label ('' when none exists). */
  sub: string;
}

/**
 * The sample-aligned heading for a sidebar page: the title is the
 * role's own nav label for the route (the agent's "My Leads", not
 * the generic "Leads"; the admin's "Analytics", the manager's
 * "Performance"), and the subtitle is the sample's `descriptions`
 * entry for that label. Inner pages render it through
 * EnterprisePageHeader so every page's heading speaks the
 * sample's words. Deep links fall back to the breadcrumb label.
 */
export function enterpriseHeadingForPath(role: EnterpriseRole, pathname: string): EnterprisePageHeading {
  const groups = buildEnterpriseNavGroups({
    role,
    canOpen: () => true,
    canAccess: () => true,
  });
  for (const group of groups) {
    for (const item of group.items) {
      if (item.path === pathname) {
        return { title: item.label, sub: ENTERPRISE_PAGE_DESCRIPTIONS[item.label] ?? '' };
      }
    }
  }
  const label = enterpriseLabelForPath(groups, pathname);
  return { title: label, sub: ENTERPRISE_PAGE_DESCRIPTIONS[label] ?? '' };
}
