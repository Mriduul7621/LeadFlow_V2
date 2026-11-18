import {
  Activity,
  BarChart3,
  Banknote,
  Bell,
  CalendarDays,
  ClipboardList,
  FolderKanban,
  GitBranch,
  HelpCircle,
  LayoutDashboard,
  ListChecks,
  MapPinned,
  Settings,
  ShieldCheck,
  Target,
  TrendingUp,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * Role navigation mirrors the approved LeadFlow Enterprise Workspace HTML.
 * This is navigation only: Feature Access, Action Permissions and server-side
 * Data Visibility continue to be enforced by the existing route/API guards.
 * Task Calendar is intentionally linked to the existing page without changing
 * its component, styling, data contract or workflow.
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
  canOpen: (route: string) => boolean;
  canAccess: (featureId: string, actionKey: string) => boolean;
}

const item = (label: string, description: string, path: string, icon: LucideIcon): SidebarItem => ({
  label, description, path, icon,
});

const ACCOUNT = [
  item('Profile & Settings', 'Manage your profile and personal preferences', '/settings', Settings),
  item('Notifications', 'View important updates and reminders', '/notifications', Bell),
  item('Help & Support', 'Get help using LeadFlow', '/help', HelpCircle),
];

const ROLE_GROUPS: Record<string, SidebarGroup[]> = {
  ADMIN: [
    { title: 'WORKSPACE', items: [
      item('Overview', 'Organization administration overview', '/', LayoutDashboard),
      item('Users & Roles', 'Manage users, roles and access', '/users', Users),
      item('Teams & Hierarchy', 'Manage the organization structure', '/team/organogram', GitBranch),
      item('Lead Intake', 'Import and validate incoming leads', '/leads/upload', UserPlus),
      item('Lead Pool', 'Review and manage the unassigned lead pool', '/leads/all', ClipboardList),
      item('Assignment Rules', 'Configure lead routing and assignment', '/settings/system'),
    ] },
    { title: 'INSIGHTS', items: [
      item('Analytics', 'Organization-wide performance insights', '/execution-intelligence', BarChart3),
      item('Audit Log', 'Review administrative activity records', '/audit-log', ShieldCheck),
    ] },
    { title: 'CONFIGURATION', items: [
      item('Status & Pipeline', 'Manage pipeline and status configuration', '/settings/system?tab=workflow', GitBranch),
      item('Products & Campaigns', 'Manage product and campaign metadata', '/settings/system?tab=dropdowns', FolderKanban),
      item('System Settings', 'Configure LeadFlow system settings', '/settings/system', Settings),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
  SUPERADMIN: [
    { title: 'WORKSPACE', items: [
      item('Overview', 'Organization administration overview', '/', LayoutDashboard),
      item('Users & Roles', 'Manage users, roles and access', '/users', Users),
      item('Teams & Hierarchy', 'Manage the organization structure', '/team/organogram', GitBranch),
      item('Lead Intake', 'Import and validate incoming leads', '/leads/upload', UserPlus),
      item('Lead Pool', 'Review and manage the unassigned lead pool', '/leads/all', ClipboardList),
      item('Assignment Rules', 'Configure lead routing and assignment', '/settings/system?tab=assignment', ListChecks),
    ] },
    { title: 'INSIGHTS', items: [
      item('Analytics', 'Organization-wide performance insights', '/execution-intelligence', BarChart3),
      item('Audit Log', 'Review administrative activity records', '/administration', ShieldCheck),
    ] },
    { title: 'CONFIGURATION', items: [
      item('Status & Pipeline', 'Manage pipeline and status configuration', '/sales-pipeline', GitBranch),
      item('Products & Campaigns', 'Review products and campaign performance', '/campaign-breakdown', FolderKanban),
      item('System Settings', 'Configure LeadFlow system settings', '/settings/system', Settings),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
  MANAGER: [
    { title: 'WORKSPACE', items: [
      item('Overview', 'Managed team overview', '/', LayoutDashboard),
      item('Teams', 'Review managed teams and members', '/team', Users),
      item('Leads', 'Manage leads within your authorized scope', '/leads', ClipboardList),
      item('Follow-up Queue', 'Prioritize due and overdue follow-ups', '/follow-up', Target),
      item('Sales Pipeline', 'Track lead movement across pipeline stages', '/sales-pipeline', GitBranch),
    ] },
    { title: 'PERFORMANCE', items: [
      item('Performance', 'Review team execution and results', '/execution-intelligence', BarChart3),
      item('Campaigns', 'Review campaign performance', '/campaign-breakdown', FolderKanban),
      item('Trends & Reports', 'Explore performance trends and reports', '/trend-charts', TrendingUp),
      item('NCP Progress', 'Track collected and projected NCP', '/ncp-progress', Banknote),
    ] },
    { title: 'FIELD EXECUTION', items: [
      item('Roadshow Follow-up', 'Track roadshow execution and follow-up', '/roadshows', MapPinned),
      item('Task Calendar', 'View scheduled calls, meetings and tasks', '/task-calendar', CalendarDays),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
  TEAMLEAD: [
    { title: 'MY TEAM', items: [
      item('Overview', 'Your team execution overview', '/', LayoutDashboard),
      item('Team Members', 'Review your direct team members', '/team', Users),
      item('Lead Distribution', 'Review and distribute team leads', '/leads/all', ClipboardList),
      item('Follow-up Queue', 'Prioritize your team follow-ups', '/follow-up', Target),
      item('Activities', 'Review team activity history', '/activities', Activity),
      item('Task Calendar', 'View scheduled calls, meetings and tasks', '/task-calendar', CalendarDays),
    ] },
    { title: 'PERFORMANCE', items: [
      item('Team Performance', 'Review team performance metrics', '/execution-intelligence', BarChart3),
      item('Roadshow Follow-up', 'Track roadshow execution and follow-up', '/roadshows', MapPinned),
      item('NCP Progress', 'Track collected and projected NCP', '/ncp-progress', Banknote),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
  TL: [
    { title: 'MY TEAM', items: [
      item('Overview', 'Your team execution overview', '/', LayoutDashboard),
      item('Team Members', 'Review your direct team members', '/team', Users),
      item('Lead Distribution', 'Review and distribute team leads', '/leads/all', ClipboardList),
      item('Follow-up Queue', 'Prioritize your team follow-ups', '/follow-up', Target),
      item('Activities', 'Review team activity history', '/activities', Activity),
      item('Task Calendar', 'View scheduled calls, meetings and tasks', '/task-calendar', CalendarDays),
    ] },
    { title: 'PERFORMANCE', items: [
      item('Team Performance', 'Review team performance metrics', '/execution-intelligence', BarChart3),
      item('Roadshow Follow-up', 'Track roadshow execution and follow-up', '/roadshows', MapPinned),
      item('NCP Progress', 'Track collected and projected NCP', '/ncp-progress', Banknote),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
  RM: [
    { title: 'MY TEAM', items: [
      item('Overview', 'Your team execution overview', '/', LayoutDashboard),
      item('Team Members', 'Review your direct team members', '/team', Users),
      item('Lead Distribution', 'Review and distribute team leads', '/leads/all', ClipboardList),
      item('Follow-up Queue', 'Prioritize your team follow-ups', '/follow-up', Target),
      item('Activities', 'Review team activity history', '/activities', Activity),
      item('Task Calendar', 'View scheduled calls, meetings and tasks', '/task-calendar', CalendarDays),
    ] },
    { title: 'PERFORMANCE', items: [
      item('Team Performance', 'Review team performance metrics', '/execution-intelligence', BarChart3),
      item('Roadshow Follow-up', 'Track roadshow execution and follow-up', '/roadshows', MapPinned),
      item('NCP Progress', 'Track collected and projected NCP', '/ncp-progress', Banknote),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
  AGENT: [
    { title: 'MY WORK', items: [
      item('Overview', 'Your personal work overview', '/workbench', LayoutDashboard),
      item('My Leads', 'View and manage your assigned leads', '/leads', ClipboardList),
      item('Add Lead', 'Capture a new lead', '/leads/new', UserPlus),
      item('Follow-up Queue', 'Prioritize your due follow-ups', '/follow-up', Target),
      item('Activities', 'Review your activity history', '/activities', Activity),
      item('Task Calendar', 'View your scheduled calls, meetings and tasks', '/task-calendar', CalendarDays),
    ] },
    { title: 'MY PERFORMANCE', items: [
      item('Performance', 'Review your sales performance', '/execution-intelligence', BarChart3),
      item('NCP Progress', 'Track your collected and projected NCP', '/ncp-progress', Banknote),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
  EMPLOYEE: [
    { title: 'MY WORK', items: [
      item('Overview', 'Your personal work overview', '/workbench', LayoutDashboard),
      item('My Leads', 'View and manage your assigned leads', '/leads', ClipboardList),
      item('Add Lead', 'Capture a new lead', '/leads/new', UserPlus),
      item('Follow-up Queue', 'Prioritize your due follow-ups', '/follow-up', Target),
      item('Activities', 'Review your activity history', '/activities', Activity),
      item('Task Calendar', 'View your scheduled calls, meetings and tasks', '/task-calendar', CalendarDays),
    ] },
    { title: 'MY PERFORMANCE', items: [
      item('Performance', 'Review your sales performance', '/execution-intelligence', BarChart3),
      item('NCP Progress', 'Track your collected and projected NCP', '/ncp-progress', Banknote),
    ] },
    { title: 'ACCOUNT', items: ACCOUNT },
  ],
};

export function buildSidebarGroups(access: SidebarAccess, roleName = ''): SidebarGroup[] {
  const role = String(roleName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const configured = ROLE_GROUPS[role] || ROLE_GROUPS.AGENT;
  return configured
    .map((group) => ({
      ...group,
      items: group.items.filter((entry) => {
        if (!access.canOpen(entry.path.split('?')[0])) return false;
        // Analytics/report pages must continue to honor their functional
        // view permission as well as the route-level Feature Access gate.
        if (['/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown'].includes(entry.path)) {
          const permission = entry.path === '/execution-intelligence' ? 'execution_intelligence'
            : entry.path === '/ncp-progress' ? 'ncp_progress'
            : entry.path === '/trend-charts' ? 'trend_charts' : 'campaign_breakdown';
          return access.canAccess(permission, 'view');
        }
        return true;
      }),
    }))
    .filter((group) => group.items.length > 0);
}
