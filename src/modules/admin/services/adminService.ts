import { RolePermission, Team, User, Permissions } from '../../shared/types';
import { toast } from 'sonner';
import { userService } from '../../users/services/userService';
import { apiRequest, ApiError } from '../../shared/api/http';

const KEYS = {
  ROLES: 'lf_local_roles_permissions',
  TEAMS: 'lf_local_teams',
};

function readCache<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeCache<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`Failed to write local cache ${key}:`, e);
  }
}

// Seed initial default permissions for built-in clearance levels
export const DEFAULT_ROLE_PERMISSIONS: RolePermission[] = [
  {
    roleId: 'ADMIN',
    roleName: 'System Admin',
    isCustom: false,
    menuAccess: {
      '/': true,
      '/leads/new': true,
      '/leads/upload': true,
      '/leads/all': true,
      '/leads': true,
      '/execution-intelligence': true,
      '/ncp-progress': true,
      '/trend-charts': true,
      '/campaign-breakdown': true,
      '/follow-up': true,
      '/task-calendar': true,
      '/team': true,
      '/users': true,
      '/settings': true
    },
    dataVisibility: 'Organization',
    actions: { view: true, create: true, edit: true, delete: true, approve: true, upload: true }
  }
];

export function ensureFeaturePermissions(role: RolePermission): RolePermission {
  const defaults: Record<string, Record<string, boolean>> = {
    dashboard: {
      view: true,
      view_calls_stats: true,
      view_pipeline_ncp: true,
      view_division_table: true,
      view_ncp_chart: true,
      view_trend_chart: true,
      view_campaign_pie: true,
      view_critical_alerts: true,
      view_agent_table: true,
      view_task_calendar: true
    },
    lead_generate: { view: true, create: true },
    lead_upload: { view: true, upload: true, delete: true },
    lead_tracking: { view: true, status_update: true },
    execution_intelligence: { view: true },
    ncp_progress: { view: true },
    trend_charts: { view: true },
    campaign_breakdown: { view: true },
    follow_up_strategy: { view: true },
    task_calendar: { view: true },
    team_progress: { view: true },
    user_management: {
      view: true,
      dept_view: true, dept_create: true, dept_edit: true, dept_delete: true,
      role_view: true, role_create: true, role_edit: true, role_delete: true,
      user_view: true, user_create: true, user_edit: true, user_delete: true,
      hier_view: true, hier_create: true, hier_edit: true, hier_delete: true
    },
    settings_control: {
      view: true,
      view_profile: true,
      view_security: true,
      view_notifications: true,
      view_system: true,
      view_sync: true,
      configure_parameters: true
    }
  };

  const roleIdUpper = (role.roleId || '').toUpperCase();

  if (!role.featurePermissions) {
    const f: Record<string, Record<string, boolean>> = JSON.parse(JSON.stringify(defaults));

    if (roleIdUpper === 'ADMIN' || roleIdUpper === 'SUPERADMIN' || roleIdUpper === 'ADMINISTRATOR') {
      Object.keys(f).forEach(feat => {
        Object.keys(f[feat]).forEach(subK => {
          f[feat][subK] = true;
        });
      });
    } else {
      // Dynamically initialize values according to role menuAccess & actions boundaries
      Object.keys(f).forEach(feat => {
        let route = '';
        if (feat === 'dashboard') route = '/';
        else if (feat === 'lead_generate') route = '/leads/new';
        else if (feat === 'lead_upload') route = '/leads/upload';
        else if (feat === 'lead_tracking') route = '/leads';
        else if (feat === 'execution_intelligence') route = '/execution-intelligence';
        else if (feat === 'ncp_progress') route = '/ncp-progress';
        else if (feat === 'trend_charts') route = '/trend-charts';
        else if (feat === 'campaign_breakdown') route = '/campaign-breakdown';
        else if (feat === 'follow_up_strategy') route = '/follow-up';
        else if (feat === 'task_calendar') route = '/task-calendar';
        else if (feat === 'team_progress') route = '/team';
        else if (feat === 'user_management') route = '/users';
        else if (feat === 'settings_control') route = '/settings';

        const isRouteEnabled = role.menuAccess?.[route] ?? false;
        f[feat].view = isRouteEnabled;

        Object.keys(f[feat]).forEach(subK => {
          if (subK === 'view') return;
          if (feat === 'lead_generate' && subK === 'create') {
            f[feat][subK] = role.actions?.create ?? false;
          } else if (feat === 'lead_upload' && subK === 'upload') {
            f[feat][subK] = role.actions?.upload ?? false;
          } else if (feat === 'lead_upload' && subK === 'delete') {
            f[feat][subK] = role.actions?.delete ?? false;
          } else if (feat === 'lead_tracking' && subK === 'status_update') {
            f[feat][subK] = role.actions?.edit ?? false;
          } else if (feat === 'user_management') {
            f[feat][subK] = false;
          } else if (feat === 'settings_control') {
            if (subK === 'configure_parameters' || subK === 'view_sync') {
              f[feat][subK] = (roleIdUpper === 'ADMIN' || roleIdUpper === 'SUPERADMIN' || roleIdUpper === 'ADMINISTRATOR');
            } else {
              f[feat][subK] = isRouteEnabled;
            }
          } else {
            f[feat][subK] = isRouteEnabled;
          }
        });
      });
    }
    role.featurePermissions = f;
  } else {
    const f = { ...role.featurePermissions };
    Object.keys(defaults).forEach(featK => {
      if (!f[featK]) {
        f[featK] = { ...defaults[featK] };
      } else {
        f[featK] = { ...defaults[featK], ...f[featK] };
      }
    });
    role.featurePermissions = f;
  }

  return role;
}

function finalizeRole(role: RolePermission): RolePermission {
  const isAdm = String(role.roleId || '').toUpperCase() === 'ADMIN';
  return {
    ...ensureFeaturePermissions(role),
    isCustom: !isAdm && role.isCustom !== false,
    dataVisibility: role.dataVisibility || 'Own',
  };
}

/** Loads a fresh copy of the local role cache (client-side copy only). */
function cachedRoles(): RolePermission[] {
  return readCache<RolePermission[]>(KEYS.ROLES, []).map(r => finalizeRole(r));
}

export const adminService = {
  // --- ROLES & PERMISSIONS WORKSPACE ---
  async getRoles(): Promise<RolePermission[]> {
    try {
      const cloudRoles = await apiRequest<RolePermission[]>('/api/roles');
      const sorted = [...cloudRoles].sort((a, b) => {
        if (String(a.roleId).toUpperCase() === 'ADMIN') return -1;
        if (String(b.roleId).toUpperCase() === 'ADMIN') return 1;
        return String(a.roleName || a.roleId).localeCompare(String(b.roleName || b.roleId));
      });
      const finalized = sorted.map(finalizeRole);
      writeCache(KEYS.ROLES, finalized);
      return finalized;
    } catch (err) {
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      const cached = cachedRoles();
      if (cached.length > 0) return cached;
      return DEFAULT_ROLE_PERMISSIONS.map(finalizeRole);
    }
  },

  async saveRole(role: RolePermission): Promise<RolePermission> {
    const saved = await apiRequest<RolePermission>('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(role),
    });
    const finalized = finalizeRole({ ...role, ...saved, roleId: saved.roleId || role.roleId });
    const roles = cachedRoles();
    const idx = roles.findIndex(r => String(r.roleId).toUpperCase() === String(finalized.roleId).toUpperCase());
    if (idx > -1) roles[idx] = finalized;
    else roles.push(finalized);
    writeCache(KEYS.ROLES, roles);
    return finalized;
  },

  async deleteRole(roleId: string): Promise<boolean> {
    if (['ADMIN'].includes(String(roleId).toUpperCase())) {
      toast.error('The Super Admin system role cannot be deleted.');
      return false;
    }
    await apiRequest(`/api/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
    writeCache(KEYS.ROLES, cachedRoles().filter(r => String(r.roleId).toUpperCase() !== String(roleId).toUpperCase()));
    return true;
  },

  // --- TEAMS WORKSPACE ---
  async getTeams(): Promise<Team[]> {
    try {
      const cloudTeams = await apiRequest<Team[]>('/api/teams');
      writeCache(KEYS.TEAMS, cloudTeams);
      return cloudTeams;
    } catch (err) {
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return readCache<Team[]>(KEYS.TEAMS, []);
    }
  },

  /**
   * Saves the team through the API first, then reconciles each member's
   * teamId through updateUser - every one of those calls is a confirmed
   * database write, and any failure aborts with an error.
   */
  async saveTeam(team: Team): Promise<Team> {
    const saved = await apiRequest<Team>('/api/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(team),
    });
    const allUsers = await userService.getAllUsers();
    for (const u of allUsers) {
      const isMember = saved.memberIds.includes(u.employeeId) || u.employeeId === saved.leaderId;
      if (isMember) {
        if (u.teamId !== saved.id) {
          await userService.updateUser(u.id, { teamId: saved.id });
        }
      } else if (u.teamId === saved.id || u.teamId === team.id) {
        await userService.updateUser(u.id, { teamId: '' });
      }
    }
    const teams = await this.getTeams().catch(() => readCache<Team[]>(KEYS.TEAMS, []));
    const idx = teams.findIndex(t => t.id === saved.id);
    if (idx > -1) teams[idx] = saved;
    else teams.push(saved);
    writeCache(KEYS.TEAMS, teams);
    return saved;
  },

  async deleteTeam(teamId: string): Promise<boolean> {
    await apiRequest(`/api/teams/${encodeURIComponent(teamId)}`, { method: 'DELETE' });
    const allUsers = await userService.getAllUsers();
    for (const u of allUsers) {
      if (u.teamId === teamId) {
        await userService.updateUser(u.id, { teamId: '' });
      }
    }
    writeCache(KEYS.TEAMS, readCache<Team[]>(KEYS.TEAMS, []).filter(t => t.id !== teamId));
    return true;
  },

  // --- MODULE ACTIONS AND PERMISSIONS (client-side config only) ---
  async getPermissionsList(): Promise<Permissions[]> {
    return readCache<Permissions[]>('lf_local_fine_permissions', []);
  },

  async getPermissionsByRoleId(roleId: string, roleName?: string): Promise<Permissions> {
    const roleIdClean = roleId.toLowerCase();
    const list = readCache<Permissions[]>('lf_local_fine_permissions', []);
    const found = list.find(p => p.roleId === roleIdClean);
    if (found) return found;

    // Default configuration if missing
    const defaultModules: Record<string, { view: boolean; create: boolean; edit: boolean; delete: boolean; upload: boolean }> = {};
    const moduleKeys = [
      'dashboard',
      'lead_generate',
      'lead_upload',
      'lead_tracking',
      'execution_intelligence',
      'ncp_progress',
      'trend_charts',
      'campaign_breakdown',
      'follow_up_strategy',
      'team_progress',
      'user_management'
    ];

    const isAdminRole = roleIdClean === 'admin' || roleIdClean === 'superadmin';

    moduleKeys.forEach(m => {
      defaultModules[m] = {
        view: isAdminRole,
        create: isAdminRole,
        edit: isAdminRole,
        delete: isAdminRole,
        upload: isAdminRole
      };
    });

    const newPerm: Permissions = {
      id: roleIdClean,
      roleId: roleIdClean,
      roleName: roleName || roleId.toUpperCase(),
      modules: defaultModules
    };

    await this.savePermissions(newPerm);
    return newPerm;
  },

  async savePermissions(perms: Permissions): Promise<Permissions> {
    const list = readCache<Permissions[]>('lf_local_fine_permissions', []);
    const idx = list.findIndex(p => p.roleId === perms.roleId);
    if (idx > -1) list[idx] = perms;
    else list.push(perms);
    writeCache('lf_local_fine_permissions', list);
    return perms;
  },

  async deletePermissions(roleId: string): Promise<boolean> {
    writeCache('lf_local_fine_permissions', readCache<Permissions[]>('lf_local_fine_permissions', []).filter(p => p.roleId !== roleId));
    return true;
  }
};
