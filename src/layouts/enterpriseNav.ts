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
 * are the sample's EXACT words; every item links to a real LeadFlow
 * page. The nav is ROLE-based, never a role-switcher: the caller sees
 * exactly one workspace (admin / manager / team lead / agent),
 * derived from their real scope and role by deriveEnterpriseRole —
 * there is no control that switches it.
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
 * Two sample items share one real destination, honestly: "Status &
 * Pipeline" and "Products & Campaigns" both land on System settings
 * (/settings/system), where the metadata engine (dropdowns tab)
 * holds the FollowUpStatus / Product / Campaign types and the DZ-6
 * stage-rules editor lives in the Danger Zone.
 *
 * Two additions are NOT in the sample and are added so no kept
 * feature loses its only entry point (both reported in the PR body):
 *   - "Follow-up Strategy" (/follow-up) in every role's work group:
 *     the sample's "Follow-up Queue" maps to the Daily Workbench
 *     (/workbench), but Follow-up Strategy is a second, distinct
 *     queue page (bucket deep-links, linked from the Sales Pipeline
 *     page) with no other nav home. The old sidebar carried it as
 *     "Follow-up Queue"; it keeps its real page name here so the
 *     two queues are never confused.
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
  'Follow-up Strategy': 'Work the follow-up queue by bucket: overdue, today, upcoming.',
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
          { label: 'Follow-up Strategy', path: '/follow-up', icon: Clock },
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
          { label: 'Status & Pipeline', path: '/settings/system', icon: SlidersHorizontal },
          { label: 'Products & Campaigns', path: '/settings/system', icon: Globe },
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
          { label: 'Follow-up Queue', path: '/workbench', icon: Clock },
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
          { label: 'Follow-up Strategy', path: '/follow-up', icon: Clock },
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
          { label: 'Follow-up Queue', path: '/workbench', icon: Clock },
          { label: 'Follow-up Strategy', path: '/follow-up', icon: FileText },
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
        { label: 'Follow-up Queue', path: '/workbench', icon: Clock },
        { label: 'Follow-up Strategy', path: '/follow-up', icon: FileText },
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

  // No dedupe by path: the Admin CONFIGURATION group maps three
  // sample items to one real page (/settings/system) and the sample
  // shows all three labels — each names a different configuration
  // area the user finds on that page (the metadata engine holds the
  // FollowUpStatus / Product / Campaign types; the Danger Zone holds
  // the stage rules). The sidebar's active state resolves the shared
  // destination to a single highlight (see AppLayout).
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
  '/settings/performance-diagnostics': 'Performance Diagnostics',
  '/team/kpi': 'KPI detail',
  '/team/organogram': 'Teams & Hierarchy',
  '/team': 'Team',
  '/users': 'Users & Roles',
  '/workbench': 'Follow-up Queue',
  '/follow-up': 'Follow-up Strategy',
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
