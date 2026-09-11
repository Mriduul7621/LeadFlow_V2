import { RolePermission, Team, User, Permissions, RolePermissionGrant } from '../../shared/types';
import { toast } from 'sonner';
import { userService } from '../../users/services/userService';
import { apiRequest, ApiError } from '../../shared/api/http';
import { emitRolesCacheChanged } from '../../shared/utils/localCacheEvents';
import { invalidateSessionCache } from '../../shared/api/sessionCache';
import { coalesceGet } from '../../shared/api/coalesce';
import { useAuthStore } from '../../auth/store/authStore';

const KEYS = {
  ROLES: 'lf_local_roles_permissions',
  TEAMS: 'lf_local_teams',
  PERMS: 'lf_local_fine_permissions',
};

const FINE_PERMISSION_MODULES = [
  'dashboard',
  'lead_generate',
  'lead_upload',
  'lead_tracking',
  'execution_intelligence',
  'ncp_progress',
  'trend_charts',
  'campaign_breakdown',
  'follow_up_strategy',
  'task_calendar',
  'activities',
  'team_progress',
  'user_management'
];

/** Default module/action matrix for a role with no saved row yet. */
function defaultPermissionsFor(roleId: string, roleName?: string): Permissions {
  const roleIdClean = roleId.toLowerCase();
  const isAdminRole = roleIdClean === 'admin' || roleIdClean === 'superadmin';
  const modules: Permissions['modules'] = {};
  FINE_PERMISSION_MODULES.forEach(m => {
    modules[m] = {
      view: isAdminRole,
      create: isAdminRole,
      edit: isAdminRole,
      delete: isAdminRole,
      upload: isAdminRole
    };
  });
  return {
    id: roleIdClean,
    roleId: roleIdClean,
    roleName: roleName || roleId.toUpperCase(),
    modules
  };
}

/** Normalizes an API row to the Permissions contract (roleId lowercase). */
function normalizePermissions(row: Permissions): Permissions {
  const roleId = String(row.roleId || '').toLowerCase();
  return { ...row, id: row.id || roleId, roleId, modules: row.modules || {} };
}

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
  // Same-tab writers must be announced: the browser only emits `storage`
  // events to OTHER tabs, so the permissions hook listens for this
  // instead of polling localStorage on a timer.
  if (key === KEYS.ROLES) emitRolesCacheChanged();
}

/**
 * Invalidation hook for the session-scoped role/menu cache (AppLayout).
 * Called AFTER a successful role or fine-permission save/delete: the
 * saved change is authoritative, so the next render re-fetches instead
 * of serving the pre-change session cache.
 */
function invalidateRoleMenuSessionCache(): void {
  const user = useAuthStore.getState().user;
  if (user?.id) invalidateSessionCache(`roles:${user.id}`);
}

// Seed initial default permissions for built-in clearance levels
export const DEFAULT_ROLE_PERMISSIONS: RolePermission[] = [
  {
    roleId: 'ADMIN',
    roleName: 'System Admin',
    isCustom: false,
    menuAccess: {
      '/': true,
      '/workbench': true,
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
      '/activities': true,
      '/team': true,
      '/users': true,
      '/settings': true
    },
    dataVisibility: 'Organization',
    actions: { view: true, create: true, edit: true, delete: true, approve: true, upload: true }
  }
];

export function ensureFeaturePermissions(role: RolePermission): RolePermission {
  // Feature Access is MODULE / PAGE VISIBILITY ONLY ({ view } per feature).
  // Granular actions live in the canonical permission layer
  // (permissions × role_permissions) and are never stored here.
  const defaults: Record<string, Record<string, boolean>> = {
    dashboard: { view: true },
    // Daily Workbench is a newly introduced feature (PR #27/28). It must
    // default FAIL-CLOSED so existing custom/restricted roles do not
    // silently gain access just because their record predates the feature.
    // ADMIN/SUPERADMIN still get full access via the explicit bypass below;
    // an admin must grant /workbench to non-admin roles explicitly.
    workbench: { view: false },
    activities: { view: true },
    task_calendar: { view: true },
    follow_up_strategy: { view: true },
    lead_tracking: { view: true },
    lead_generate: { view: true },
    lead_upload: { view: true },
    // All Leads defaults FAIL-CLOSED for roles with no legacy signal; the
    // backfill below seeds it from the pre-existing view_all_leads_tab /
    // menuAccess['/leads/all'] so existing roles keep their effective access.
    all_leads: { view: false },
    execution_intelligence: { view: true },
    ncp_progress: { view: true },
    trend_charts: { view: true },
    campaign_breakdown: { view: true },
    team_progress: { view: true },
    user_management: { view: true },
    settings_control: { view: true }
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
      // Dynamically initialize values according to role menuAccess boundaries:
      // every feature is a page toggle driven by its route's menu access.
      Object.keys(f).forEach(feat => {
        let route = '';
        if (feat === 'dashboard') route = '/';
        else if (feat === 'workbench') route = '/workbench';
        else if (feat === 'lead_generate') route = '/leads/new';
        else if (feat === 'lead_upload') route = '/leads/upload';
        else if (feat === 'all_leads') route = '/leads/all';
        else if (feat === 'lead_tracking') route = '/leads';
        else if (feat === 'execution_intelligence') route = '/execution-intelligence';
        else if (feat === 'ncp_progress') route = '/ncp-progress';
        else if (feat === 'trend_charts') route = '/trend-charts';
        else if (feat === 'campaign_breakdown') route = '/campaign-breakdown';
        else if (feat === 'follow_up_strategy') route = '/follow-up';
        else if (feat === 'task_calendar') route = '/task-calendar';
        else if (feat === 'activities') route = '/activities';
        else if (feat === 'team_progress') route = '/team';
        else if (feat === 'user_management') route = '/users';
        else if (feat === 'settings_control') route = '/settings';

        const isRouteEnabled = role.menuAccess?.[route] ?? false;
        f[feat].view = isRouteEnabled;
      });
    }
    role.featurePermissions = f;
  } else {
    const f = { ...role.featurePermissions };
    Object.keys(defaults).forEach(featK => {
      if (!f[featK]) {
        f[featK] = { ...defaults[featK] };
      } else {
        // Merge preserves any legacy sub-option keys already stored for the
        // role (they are no longer exposed in the editor but must not be
        // silently wiped by a metadata read).
        f[featK] = { ...defaults[featK], ...f[featK] };
      }
    });
    role.featurePermissions = f;
  }

  // Legacy compatibility backfill: "All Leads" used to be the
  // `view_all_leads_tab` sub-option stored inside lead_tracking. It is now
  // the standalone `all_leads` feature. Seed it from the strongest legacy
  // signal WITHOUT silently enabling it — a role that had the tab off (or
  // has no signal at all) stays off.
  const storedFeaturePermissions = role.featurePermissions as Record<string, Record<string, boolean>>;
  if (roleIdUpper !== 'ADMIN' && roleIdUpper !== 'SUPERADMIN' && roleIdUpper !== 'ADMINISTRATOR'
      && storedFeaturePermissions.all_leads?.view === undefined) {
    const legacyTab = storedFeaturePermissions.lead_tracking?.view_all_leads_tab;
    const fromMenu = role.menuAccess?.['/leads/all'];
    storedFeaturePermissions.all_leads = { view: legacyTab ?? fromMenu ?? false };
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
      // GET read: AppLayout reads roles on every remount; a StrictMode
      // double-effect (or a remount racing the first response) must not
      // double the round-trip.
      const cloudRoles = await coalesceGet('/api/roles', () => apiRequest<RolePermission[]>('/api/roles'));
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
    // Server confirmed the change: the session role/menu cache is stale.
    invalidateRoleMenuSessionCache();
    return finalized;
  },

  async deleteRole(roleId: string): Promise<boolean> {
    if (['ADMIN'].includes(String(roleId).toUpperCase())) {
      toast.error('The Super Admin system role cannot be deleted.');
      return false;
    }
    await apiRequest(`/api/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
    writeCache(KEYS.ROLES, cachedRoles().filter(r => String(r.roleId).toUpperCase() !== String(roleId).toUpperCase()));
    // Server confirmed the deletion: the session role/menu cache is stale.
    invalidateRoleMenuSessionCache();
    return true;
  },

  // --- CANONICAL ROLE ACTION PERMISSIONS (permissions × role_permissions) ---
  // The granular action layer Admin edits in Role Feature Access. Persisted
  // server-side (NOT localStorage-only) and enforced by hasPermissionCode().
  async getRolePermissions(roleId: string): Promise<RolePermissionGrant[]> {
    const body = await apiRequest<{ success?: boolean; data: RolePermissionGrant[] }>(
      `/api/roles/${encodeURIComponent(roleId)}/permissions`
    );
    return Array.isArray(body?.data) ? body.data : [];
  },

  async saveRolePermissions(roleId: string, grants: Array<{ code: string; allowed: boolean }>): Promise<void> {
    await apiRequest(`/api/roles/${encodeURIComponent(roleId)}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: grants }),
    });
    // The saved grants change what the signed-in users of this role may do:
    // invalidate the session-scoped permission sheet so the next check sees
    // the new grants.
    const user = useAuthStore.getState().user;
    if (user?.id) invalidateSessionCache(`userPermissions:${user.id}`);
    invalidateRoleMenuSessionCache();
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

  // --- FINE-GRAINED MODULE PERMISSIONS (PostgreSQL-authoritative) ---
  // Reads go to GET /api/permissions first with the localStorage copy as
  // a read-only cache; writes MUST commit through the API before the
  // cache is touched, and 4xx failures are never swallowed.
  async getPermissionsList(): Promise<Permissions[]> {
    try {
      const cloud = await apiRequest<Permissions[]>('/api/permissions');
      const normalized = cloud.map(normalizePermissions);
      writeCache(KEYS.PERMS, normalized);
      return normalized;
    } catch (err) {
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return readCache<Permissions[]>(KEYS.PERMS, []).map(normalizePermissions);
    }
  },

  async getPermissionsByRoleId(roleId: string, roleName?: string): Promise<Permissions> {
    const roleIdClean = roleId.toLowerCase();
    try {
      const row = await apiRequest<Permissions>(`/api/permissions/${encodeURIComponent(roleIdClean)}`);
      const normalized = normalizePermissions(row);
      const list = readCache<Permissions[]>(KEYS.PERMS, []).map(normalizePermissions);
      const idx = list.findIndex(p => p.roleId === roleIdClean);
      if (idx > -1) list[idx] = normalized;
      else list.push(normalized);
      writeCache(KEYS.PERMS, list);
      return normalized;
    } catch (err) {
      // No saved row for this role: return the default matrix WITHOUT
      // persisting it. Reads must never manufacture database writes;
      // the caller saves explicitly when the user edits permissions.
      if (err instanceof ApiError && err.status === 404) {
        return defaultPermissionsFor(roleIdClean, roleName);
      }
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      const cached = readCache<Permissions[]>(KEYS.PERMS, [])
        .map(normalizePermissions)
        .find(p => p.roleId === roleIdClean);
      return cached || defaultPermissionsFor(roleIdClean, roleName);
    }
  },

  async savePermissions(perms: Permissions): Promise<Permissions> {
    const saved = await apiRequest<Permissions>('/api/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(perms),
    });
    const normalized = normalizePermissions({ ...perms, ...saved });
    const list = readCache<Permissions[]>(KEYS.PERMS, []).map(normalizePermissions);
    const idx = list.findIndex(p => p.roleId === normalized.roleId);
    if (idx > -1) list[idx] = normalized;
    else list.push(normalized);
    writeCache(KEYS.PERMS, list);
    return normalized;
  },

  async deletePermissions(roleId: string): Promise<boolean> {
    if (['ADMIN', 'SUPERADMIN'].includes(String(roleId).toUpperCase())) {
      toast.error('The Super Admin permission matrix cannot be deleted.');
      return false;
    }
    await apiRequest(`/api/permissions/${encodeURIComponent(roleId)}`, { method: 'DELETE' });
    writeCache(
      KEYS.PERMS,
      readCache<Permissions[]>(KEYS.PERMS, [])
        .map(normalizePermissions)
        .filter(p => p.roleId !== String(roleId).toLowerCase())
    );
    return true;
  }
};
