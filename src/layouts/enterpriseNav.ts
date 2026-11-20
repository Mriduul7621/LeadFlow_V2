import {
  Activity,
  BarChart3,
  CalendarDays,
  ClipboardList,
  Clock,
  FileText,
  Globe,
  LayoutDashboard,
  MapPinned,
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
 * Agent workspace (2026-11-20, Mahadi's demo screenshots): the
 * agent nav is ONE WORKSPACE group — My Work, Activities, My
 * Leads, Follow-up Queue, My Performance, Task Calendar, Roadshow
 * — with no ACCOUNT group (the sidebar-bottom profile block in
 * AppLayout carries the settings gear instead). Daily Workbench,
 * Sales Pipeline, Add Lead and NCP Progress left the agent
 * sidebar with that rebuild; their routes stay live and the other
 * roles keep their entries. The mobile bottom bar is unchanged
 * for the agent (My Work / My Leads / Workbench / Add Lead).
 *
 * Team Lead / Manager / Admin workspace (2026-11-20, Mahadi's
 * four demo screenshots + words — "ebar now complete koro"):
 * all three roles get ONE WORKSPACE group in his exact order,
 * and NO ACCOUNT group (the profile block + settings gear now
 * render for every role, and Notifications live behind the
 * topbar bell for every role). Team Lead: Team Overview, Team
 * Leads, My Leads, Lead Intake, Follow-up Monitor, Team
 * Members, Team Performance, Self Performance, Task Calendar,
 * Roadshow, Activities, User Management (grant-gated, see
 * below). Manager: the same minus My Leads and Add Lead, with
 * My Performance instead of Self Performance. Admin: Team
 * Overview, All Leads, Lead Intake, Lead Pool, Follow-up
 * Monitor, Team Members, Team Performance, Task Calendar,
 * Roadshow, Activities, Users & Roles — plus the unchanged
 * CONFIGURATION and ADMINISTRATION groups; no My Leads / My
 * Performance / Add Lead (an admin is not a seller).
 *
 * Items that left the TL/Manager/Admin sidebars with this
 * rebuild (routes stay live by URL, reported to Mahadi):
 * Daily Workbench, Sales Pipeline, Campaigns, Trends &
 * Reports, NCP Progress, and the ACCOUNT group. Lead Pool
 * stays in the ADMIN sidebar only (the admin distributes) —
 * TL/Manager distribute through Reassign instead, and the TL's
 * own-created unassigned leads surface in Team Leads.
 *
 * Grant-gated nav items: an item may carry `grant` (a
 * featureId + actionKey pair). It renders ONLY when the server
 * permission sheet has settled AND the grant resolves — so the
 * User Management item never flashes for an ungranted TL on a
 * slow connection (the role-matrix fallback maps unknown action
 * keys to `view`, which would wrongly show it).
 *
 * Follow-up Monitor: the sidebar label is "Follow-up Monitor"
 * for TL/Manager/Admin, but the demo page's own H1 is
 * "Follow-up Queue" — Mahadi asked to follow the demo exactly,
 * so enterpriseHeadingForPath special-cases /follow-up to the
 * demo H1 for every role (the agent nav label is already
 * "Follow-up Queue").
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
  /**
   * True once the server permission sheet has loaded. Grant-gated
   * items (see `NavItemDef.grant`) stay hidden until this is true,
   * so a role-matrix fallback can never flash them in.
   */
  grantsSettled?: boolean;
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
  Roadshow: 'Track roadshow activity and follow-up actions.',
  'Task Calendar': 'Review tasks and scheduled work.',
  'Team Members': 'Review member workload and support needs.',
  'Team Performance': 'Review team performance and progress.',
  Activities: 'Review calls, meetings, messages and notes.',
  'My Leads': 'Manage your assigned leads and next actions.',
  'My Performance': 'Track progress, activity and conversion trends.',
  'Add Lead': 'Capture a prospect with the required details.',
  // Team Lead / Manager / Admin workspace (2026-11-20): sample-voice
  // descriptions for the new labels, so their headings never render
  // an empty subtitle.
  'Team Overview': 'Your team at a glance — leads, follow-ups and activity.',
  'Team Leads': 'Review your team members\u2019 leads and next actions.',
  'All Leads': 'Search and inspect every lead in the organisation.',
  'Follow-up Monitor': 'Prioritize overdue and upcoming follow-ups.',
  'Self Performance': 'Track your own progress, activity and conversion trends.',
  'User Management': 'Review your team and add new employees.',
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

type NavItemDef = EnterpriseNavItem & {
  permission?: string;
  /**
   * Grant gate (2026-11-20): the item renders only when the server
   * permission sheet has settled AND `canAccess(featureId,
   * actionKey)` passes. Used for User Management
   * (`users.add_employee`) — a TL/Manager without the grant never
   * sees the item.
   */
  grant?: { featureId: string; actionKey: string };
};

/** Admin-only addition (not in the sample — see the header note). */
const ADMIN_ITEMS: NavItemDef[] = [
  { label: 'Administration', path: '/administration', icon: Wrench },
];

function navItemsFor(role: EnterpriseRole): Array<{ title: string; items: NavItemDef[] }> {
  if (role === 'admin') {
    // Admin workspace (2026-11-20, Mahadi): ONE WORKSPACE group in
    // his order — Team Overview (org-wide), All Leads, Lead Intake,
    // Lead Pool (the admin distributes; the only role that keeps
    // it), Follow-up Monitor, Team Members, Team Performance, Task
    // Calendar, Roadshow, Activities, Users & Roles — then the
    // unchanged CONFIGURATION and ADMINISTRATION groups. NO My
    // Leads / My Performance / Add Lead: an admin is not a seller
    // and never appears in report data. NO ACCOUNT group: the
    // profile block + settings gear render for every role now, and
    // Notifications live behind the topbar bell.
    return [
      {
        title: 'WORKSPACE',
        items: [
          { label: 'Team Overview', path: '/', icon: LayoutDashboard },
          { label: 'All Leads', path: '/leads', icon: ClipboardList },
          { label: 'Lead Intake', path: '/leads/upload', icon: Upload },
          { label: 'Lead Pool', path: '/leads/all', icon: ClipboardList },
          { label: 'Follow-up Monitor', path: '/follow-up', icon: FileText },
          { label: 'Team Members', path: '/team', icon: Users },
          { label: 'Team Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
          { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
          { label: 'Roadshow', path: '/roadshows', icon: MapPinned },
          { label: 'Activities', path: '/activities', icon: Activity },
          { label: 'Users & Roles', path: '/users', icon: UserCog },
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
      { title: 'ADMINISTRATION', items: ADMIN_ITEMS },
    ];
  }
  if (role === 'manager') {
    // Manager workspace (2026-11-20, Mahadi): the Team Lead
    // workspace minus My Leads and Add Lead, with My Performance
    // (own data) instead of Self Performance. Lead Intake stays
    // (upload), and User Management appears only with the
    // admin-granted `users.add_employee` grant. Daily Workbench,
    // Sales Pipeline, Campaigns, Trends & Reports and NCP Progress
    // left the manager sidebar with this rebuild — their routes
    // stay live by URL.
    return [
      {
        title: 'WORKSPACE',
        items: [
          { label: 'Team Overview', path: '/', icon: LayoutDashboard },
          { label: 'Team Leads', path: '/leads', icon: ClipboardList },
          { label: 'Lead Intake', path: '/leads/upload', icon: Upload },
          { label: 'Follow-up Monitor', path: '/follow-up', icon: FileText },
          { label: 'Team Members', path: '/team', icon: Users },
          { label: 'Team Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
          { label: 'My Performance', path: '/performance/self', icon: TrendingUp },
          { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
          { label: 'Roadshow', path: '/roadshows', icon: MapPinned },
          { label: 'Activities', path: '/activities', icon: Activity },
          { label: 'User Management', path: '/users/team', icon: UserCog, grant: { featureId: 'user_management', actionKey: 'add_employee' } },
        ],
      },
    ];
  }
  if (role === 'teamLead') {
    // Team Lead workspace (2026-11-20, Mahadi's demo screenshots +
    // words): ONE WORKSPACE group in his exact order — Team
    // Overview, Team Leads (members-only), My Leads (own-only,
    // directly below), Lead Intake, Follow-up Monitor, Team
    // Members, Team Performance, Self Performance, Task Calendar,
    // Roadshow, Activities, User Management (grant-gated). NO
    // Daily Workbench sidebar item (the route stays live by URL)
    // and NO Add Lead sidebar item — Add Lead is a button on Team
    // Overview, like the agent's. The demo's "Manage team" and
    // "Assign leads" buttons were dropped on his word.
    return [
      {
        title: 'WORKSPACE',
        items: [
          { label: 'Team Overview', path: '/', icon: LayoutDashboard },
          { label: 'Team Leads', path: '/leads', icon: ClipboardList },
          { label: 'My Leads', path: '/leads/my', icon: ClipboardList },
          { label: 'Lead Intake', path: '/leads/upload', icon: Upload },
          { label: 'Follow-up Monitor', path: '/follow-up', icon: FileText },
          { label: 'Team Members', path: '/team', icon: Users },
          { label: 'Team Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
          { label: 'Self Performance', path: '/performance/self', icon: TrendingUp },
          { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
          { label: 'Roadshow', path: '/roadshows', icon: MapPinned },
          { label: 'Activities', path: '/activities', icon: Activity },
          { label: 'User Management', path: '/users/team', icon: UserCog, grant: { featureId: 'user_management', actionKey: 'add_employee' } },
        ],
      },
    ];
  }
  // Agent workspace (2026-11-20, Mahadi's demo screenshots): ONE
  // WORKSPACE group, in his exact order — My Work, Activities right
  // after it, My Leads, Follow-up Queue, My Performance, Task
  // Calendar, Roadshow. NO ACCOUNT group: Profile & Settings /
  // Notifications leave the agent sidebar — the profile block at
  // the sidebar bottom (AppLayout) carries the settings gear, the
  // topbar bell opens the notification panel, and the topbar
  // profile chip stays as it is. Four items left the agent sidebar
  // with this rebuild (all reported to Mahadi for veto; the routes
  // stay live and other roles keep them): Daily Workbench and Sales
  // Pipeline (not in the demo), Add Lead (a button on My Work and
  // My Leads instead), and NCP Progress (not in the demo).
  return [
    {
      title: 'WORKSPACE',
      items: [
        { label: 'My Work', path: '/', icon: LayoutDashboard },
        { label: 'Activities', path: '/activities', icon: Activity },
        { label: 'My Leads', path: '/leads', icon: ClipboardList },
        { label: 'Follow-up Queue', path: '/follow-up', icon: FileText },
        { label: 'My Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
        { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
        { label: 'Roadshow', path: '/roadshows', icon: MapPinned },
      ],
    },
  ];
}

export function buildEnterpriseNavGroups(access: EnterpriseNavAccess): EnterpriseNavGroup[] {
  const passes = (item: NavItemDef): boolean => {
    if (item.permission && !access.canAccess(item.permission, 'view')) return false;
    // Grant-gated items (User Management): hidden until the server
    // permission sheet has settled AND the grant resolves — the
    // role-matrix fallback maps unknown action keys to `view`,
    // which would wrongly show the item on a slow connection.
    if (item.grant) {
      if (access.grantsSettled !== true) return false;
      if (!access.canAccess(item.grant.featureId, item.grant.actionKey)) return false;
    }
    return access.canOpen(item.path);
  };

  // No dedupe by path: several sample items legitimately share a
  // real destination (Team Leads / My Leads / All Leads all land
  // on /leads or /leads/my across roles; Team Performance lands on
  // /execution-intelligence for three roles) — but never within
  // ONE role's nav, so the active state is always unambiguous.
  // (The Admin CONFIGURATION group used to share /settings/system
  // across three items; the 2026-11-19 fix round split it into
  // three distinct routes for exactly that reason.)
  const groups: EnterpriseNavGroup[] = [];
  for (const group of navItemsFor(access.role)) {
    const items: EnterpriseNavItem[] = group.items
      .filter(passes)
      .map(({ permission: _permission, grant: _grant, ...entry }) => entry);
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
  // Team Lead / Manager / Admin bottom tabs (2026-11-20): Mahadi
  // did not specify these — they follow the new sidebar's first
  // four working pages per role (reported to him for veto). The
  // agent's tabs are unchanged.
  admin: [
    { label: 'Team Overview', path: '/', icon: LayoutDashboard },
    { label: 'All Leads', path: '/leads', icon: ClipboardList },
    { label: 'Users & Roles', path: '/users', icon: UserCog },
    { label: 'Team Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
  ],
  manager: [
    { label: 'Team Overview', path: '/', icon: LayoutDashboard },
    { label: 'Team Leads', path: '/leads', icon: ClipboardList },
    { label: 'Team Members', path: '/team', icon: Users },
    { label: 'Team Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
  ],
  teamLead: [
    { label: 'Team Overview', path: '/', icon: LayoutDashboard },
    { label: 'Team Leads', path: '/leads', icon: ClipboardList },
    { label: 'Follow-up Monitor', path: '/follow-up', icon: FileText },
    { label: 'Team Members', path: '/team', icon: Users },
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
  '/leads/my': 'My Leads',
  '/performance/self': 'Self Performance',
  '/users/team': 'User Management',
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
  '/team/organogram': 'Team Members',
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
  // Follow-up Monitor (2026-11-20 demo): the sidebar label is
  // "Follow-up Monitor" for TL/Manager/Admin, but the demo page's
  // own H1 is "Follow-up Queue" — Mahadi asked to follow the demo
  // exactly, so the heading stays "Follow-up Queue" for every role
  // (the agent nav label is already "Follow-up Queue"). Flagged in
  // the PR report: sidebar and H1 deliberately differ here.
  if (pathname === '/follow-up') {
    return { title: 'Follow-up Queue', sub: ENTERPRISE_PAGE_DESCRIPTIONS['Follow-up Queue'] ?? '' };
  }
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
