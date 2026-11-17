import {
  Activity,
  Banknote,
  BarChart3,
  Bell,
  CalendarDays,
  ClipboardList,
  Clock,
  FileText,
  Gauge,
  Globe,
  LayoutDashboard,
  MapPinned,
  Network,
  Settings as SettingsIcon,
  Target,
  TrendingUp,
  UserCog,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceRole } from './workspaceRole';
import { WORKSPACE_HOME_LABELS } from './workspaceRole';

/**
 * sidebarNav.ts — the role-based sidebar (role-dashboard redesign,
 * Phase 1, 2026-11-17)
 * ------------------------------------------------------------------
 * The sample prototype's sidebar, rebuilt on LeadFlow's real routes
 * and real permissions. The nav is ROLE-based, never a role-switcher:
 * the caller sees exactly one workspace (member / team lead /
 * manager), derived from their real scope by deriveWorkspaceRole —
 * there is no control that switches it.
 *
 * Easy names are DISPLAY LABELS ONLY — every route is unchanged:
 *
 *   Member   My Work / My Leads / Follow-up Queue / My Performance /
 *            Activities
 *   Team Lead Team Overview / Team Leads / Follow-up Monitor /
 *            Team Members / Organogram / Team Performance / Activities
 *   Manager  Business Overview / All Leads / Sales Pipeline / Teams /
 *            Organogram / Analytics / Activities
 *
 * Shared: Task Calendar, Roadshows, Follow-up Strategy, Notifications.
 * Administration (permission-gated): Users, Settings, System
 * (the Danger Zone lives there), Performance Diagnostics.
 * Help / About live in the sidebar footer (AppLayout), not here.
 * There is NO Targets entry — LeadFlow has no targets data model
 * yet (Phase 3); no dead links.
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

export interface SidebarItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

export interface SidebarGroup {
  title: string;
  items: SidebarItem[];
}

export interface SidebarAccess {
  /** Route-level module gate (featureRouteAccess) for a router path. */
  canOpen: (route: string) => boolean;
  /** Functional action permission (`view` on the module). */
  canAccess: (featureId: string, actionKey: string) => boolean;
  /** The caller's derived workspace role (never a switcher). */
  role: WorkspaceRole;
}

/**
 * The role workspace pages. The home entry's label is the workspace
 * home name; the leads / follow-up / team / performance entries are
 * the easy names for the same unchanged routes.
 */
function workspaceItemsFor(role: WorkspaceRole): Array<SidebarItem & { permission?: string }> {
  const home: SidebarItem = { label: WORKSPACE_HOME_LABELS[role], path: '/', icon: LayoutDashboard };
  if (role === 'member') {
    return [
      home,
      { label: 'My Leads', path: '/leads', icon: ClipboardList },
      { label: 'Follow-up Queue', path: '/workbench', icon: Clock },
      { label: 'My Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
      { label: 'Activities', path: '/activities', icon: Activity },
    ];
  }
  if (role === 'teamLead') {
    return [
      home,
      { label: 'Team Leads', path: '/leads', icon: ClipboardList },
      { label: 'Follow-up Monitor', path: '/workbench', icon: Clock },
      { label: 'Team Members', path: '/team', icon: Users },
      { label: 'Organogram', path: '/team/organogram', icon: Network },
      { label: 'Team Performance', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
      { label: 'Activities', path: '/activities', icon: Activity },
    ];
  }
  return [
    home,
    { label: 'All Leads', path: '/leads/all', icon: ClipboardList },
    { label: 'Sales Pipeline', path: '/sales-pipeline', icon: FileText },
    { label: 'Teams', path: '/team', icon: Users },
    { label: 'Organogram', path: '/team/organogram', icon: Network },
    { label: 'Analytics', path: '/execution-intelligence', icon: BarChart3, permission: 'execution_intelligence' },
    { label: 'Activities', path: '/activities', icon: Activity },
  ];
}

/**
 * The remaining analytics pages. Each entry needs BOTH the route
 * module (menuAccess) and its functional `view` permission, exactly
 * like the retired Reports directory enforced. The primary analytics
 * page (/execution-intelligence) lives in the workspace group above
 * under its easy name; these three stay reachable here.
 */
const ANALYTICS_ITEMS: Array<SidebarItem & { permission: string }> = [
  { label: 'NCP Progress', path: '/ncp-progress', icon: Banknote, permission: 'ncp_progress' },
  { label: 'Trends', path: '/trend-charts', icon: TrendingUp, permission: 'trend_charts' },
  { label: 'Campaigns', path: '/campaign-breakdown', icon: Globe, permission: 'campaign_breakdown' },
];

/** Shared pages (route module only). */
const GENERAL_ITEMS: SidebarItem[] = [
  { label: 'Task Calendar', path: '/task-calendar', icon: CalendarDays },
  { label: 'Roadshows', path: '/roadshows', icon: MapPinned },
  { label: 'Follow-up Strategy', path: '/follow-up', icon: Target },
  { label: 'Notifications', path: '/notifications', icon: Bell },
];

/**
 * Administration (route module only — the routes themselves are
 * ADMIN-only in Feature Access, so a non-admin never sees these).
 * System is the Settings.tsx page: the Danger Zone lives there.
 */
const ADMIN_ITEMS: SidebarItem[] = [
  { label: 'Users', path: '/users', icon: UserCog },
  { label: 'Settings', path: '/settings', icon: SettingsIcon },
  { label: 'System', path: '/settings/system', icon: Wrench },
  { label: 'Performance Diagnostics', path: '/settings/performance-diagnostics', icon: Gauge },
];

export function buildSidebarGroups(access: SidebarAccess): SidebarGroup[] {
  const passes = (item: SidebarItem & { permission?: string }): boolean => {
    if (item.permission && !access.canAccess(item.permission, 'view')) return false;
    return access.canOpen(item.path);
  };

  const workspace = workspaceItemsFor(access.role)
    .filter(passes)
    .map(({ permission: _permission, ...item }) => item as SidebarItem);
  const analytics = ANALYTICS_ITEMS.filter(item =>
    access.canAccess(item.permission, 'view') && access.canOpen(item.path)
  ).map(({ permission: _permission, ...item }) => item);
  const general = GENERAL_ITEMS.filter(item => access.canOpen(item.path));
  const admin = ADMIN_ITEMS.filter(item => access.canOpen(item.path));

  const groups: SidebarGroup[] = [
    { title: 'Workspace', items: workspace },
    { title: 'Analytics', items: analytics },
    { title: 'General', items: general },
    { title: 'Administration', items: admin },
  ];
  return groups.filter(group => group.items.length > 0);
}

/**
 * Breadcrumb labels for routes that never appear in the sidebar
 * (deep links, dialogs-as-pages, the More directory). The topbar
 * prefers the sidebar entry's own label; this map is the fallback
 * so a breadcrumb never shows a raw path segment.
 */
const FALLBACK_LABELS: Record<string, string> = {
  '/leads/new': 'Add Lead',
  '/leads/upload': 'Bulk Upload',
  '/leads/all': 'All Leads',
  '/leads': 'Leads',
  '/administration': 'Administration',
  '/more': 'More',
  '/help': 'Help',
  '/about': 'About',
  '/settings': 'Profile',
  '/settings/system': 'System',
  '/settings/performance-diagnostics': 'Performance Diagnostics',
  '/team/kpi': 'KPI detail',
  '/team/organogram': 'Organogram',
  '/team': 'Team',
  '/users': 'Users',
};

/** The breadcrumb label for a pathname, from the resolved sidebar groups. */
export function sidebarLabelForPath(groups: SidebarGroup[], pathname: string): string {
  // Exact sidebar match first: /leads is the member's "My Leads", not
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
