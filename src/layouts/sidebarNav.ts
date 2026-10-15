import {
  Banknote,
  CalendarDays,
  ClipboardList,
  FileText,
  Globe,
  LayoutDashboard,
  MapPinned,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * sidebarNav.ts
 * ------------------------------------------------------------------
 * The left application drawer (hamburger → slide-in sidebar).
 *
 * Every page that used to be reachable only through More → Reports now
 * lives here: the report/analytics pages, the workspace pages, Roadshow
 * Follow-up and the standalone Sales Pipeline. More keeps only the
 * personal/utility entries (profile, notifications, help, about) plus
 * Administration for admins — nothing is duplicated between the two.
 *
 * The sidebar is a UX surface, never a security boundary: every entry is
 * filtered by the SAME resolvers the router uses (`resolveFeatureRouteAccess`
 * for the route module + `canAccess` for the functional permission), and
 * each destination route keeps its own FeatureGate + ProtectedRoute. A role
 * that cannot open a page never sees its sidebar entry either.
 *
 * The builder is a pure function of the caller's access predicates so it
 * is unit-testable without a React tree.
 */

export interface SidebarItem {
  label: string;
  description: string;
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
}

/**
 * Analytics / report pages. Each entry needs BOTH the route module
 * (menuAccess) and its functional `view` permission, exactly like the
 * retired Reports directory enforced.
 */
const ANALYTICS_ITEMS: Array<SidebarItem & { permission: string }> = [
  { label: 'Performance', description: 'Sales execution and performance insights', path: '/execution-intelligence', icon: LayoutDashboard, permission: 'execution_intelligence' },
  { label: 'NCP Progress', description: 'Collected and projected NCP progress', path: '/ncp-progress', icon: Banknote, permission: 'ncp_progress' },
  { label: 'Trends', description: 'Performance over time', path: '/trend-charts', icon: TrendingUp, permission: 'trend_charts' },
  { label: 'Campaigns', description: 'Lead and performance by campaign', path: '/campaign-breakdown', icon: Globe, permission: 'campaign_breakdown' },
];

/** Workspace pages (route module only, same rule as before). */
const WORKSPACE_ITEMS: SidebarItem[] = [
  { label: 'Activities', description: 'Lead activity history and execution records', path: '/activities', icon: ClipboardList },
  { label: 'Task Calendar', description: 'Calls, meetings and tasks by day', path: '/task-calendar', icon: CalendarDays },
  { label: 'Follow-up Queue', description: 'Overdue, today and upcoming follow-ups', path: '/follow-up', icon: ClipboardList },
  { label: 'Team', description: 'Team progress and reporting hierarchy', path: '/team', icon: Users },
];

/** Field operations: roadshows (permission-gated) + the pipeline board. */
const FIELD_ITEMS: SidebarItem[] = [
  { label: 'Roadshow Follow-up', description: 'Plan roadshows, track status and review results', path: '/roadshows', icon: MapPinned },
  { label: 'Sales Pipeline', description: 'Every lead across each sales stage', path: '/sales-pipeline', icon: FileText },
];

export function buildSidebarGroups(access: SidebarAccess): SidebarGroup[] {
  const analytics = ANALYTICS_ITEMS.filter(item =>
    access.canAccess(item.permission, 'view') && access.canOpen(item.path)
  ).map(({ permission: _permission, ...item }) => item);

  const workspace = WORKSPACE_ITEMS.filter(item => access.canOpen(item.path));
  const field = FIELD_ITEMS.filter(item => access.canOpen(item.path));

  const groups: SidebarGroup[] = [
    { title: 'Analytics', items: analytics },
    { title: 'Workspace', items: workspace },
    { title: 'Field', items: field },
  ];
  return groups.filter(group => group.items.length > 0);
}
