import { apiRequest, ApiError } from '../../shared/api/http';
import { shouldFallBackToCache } from '../../shared/api/offlinePolicy';

export interface Department {
  id: string;
  name: string;
  code?: string;
  createdDate: string;
  /**
   * F16 Phase C — one department = one MIRROR TEAM. The team is created,
   * renamed and re-rostered by the server; the client only displays it.
   * Absent on rows that came from the offline cache.
   */
  mirrorTeamId?: string | null;
  /** The active PRIMARY head, or null while the department is headless. */
  primaryHead?: { id: string; employeeId: string | null; fullName: string | null } | null;
  /** Active heads (the primary head + every co-head). */
  headCount?: number;
  /** Active members — exactly the people on the mirror team's roster. */
  memberCount?: number;
}

/** Phase C: who heads a department. One primary head + any co-heads. */
export interface DepartmentHeadAssignment {
  /** `null` leaves the department deliberately headless. */
  primaryUserId: string | null;
  coHeadUserIds: string[];
}

export interface DepartmentHeadResult {
  primaryUserId: string | null;
  headUserIds: string[];
  teamId: string | null;
  memberCount: number;
}

export interface HierarchyLayer {
  id?: string;
  parentId?: string | null;
  roleId: string;
  employeeIds: string[];
}

export interface Hierarchy {
  id: string;
  departmentId: string;
  layers: HierarchyLayer[];
  updatedAt: string;
}

/** One employee node of the auto-generated organogram tree. */
export interface OrganogramNode {
  id: string;
  employeeId: string;
  fullName: string;
  name: string;
  designation: string;
  roleId: string;
  roleName: string;
  level: number;
  departmentId: string;
  departmentName: string;
  managerId: string | null;
  managerEmployeeId: string | null;
  isActive: boolean;
  avatarUrl: string;
  directReports: number;
}

/**
 * F16 Phase D — department health shipped with the ladder config: which
 * departments have no head, which are empty, whose mirror team drifted out of
 * step with its memberships, and who belongs to no department at all.
 * `available: false` means the database has no department-members layer yet —
 * the screen then says so instead of showing invented zeros.
 */
export interface DepartmentHealth {
  available: boolean;
  totalDepartments: number;
  headless: Array<{ id: string; name: string; memberCount: number; coHeadCount: number }>;
  empty: Array<{ id: string; name: string }>;
  teamDrift: Array<{
    id: string;
    name: string;
    teamId: string | null;
    membershipCount: number;
    rosterCount: number;
    issues: string[];
  }>;
  membersWithoutDepartment: Array<{ employeeId: string; fullName: string }>;
  multiDepartmentHeads: Array<{ employeeId: string; fullName: string; departmentCount: number }>;
}

/** Company-wide reporting ladder configuration (admin-managed). */
export interface HierarchyConfig {
  levels: Array<{
    level: number;
    roles: Array<{ roleId: string; roleName: string; employeeCount: number }>;
  }>;
  unassignedRoles: Array<{ roleId: string; roleName: string; employeeCount: number }>;
  /** Phase D department health (absent on a pre-046 database). */
  departments?: DepartmentHealth;
  setup: {
    totalUsers: number;
    usersWithManager: number;
    usersWithoutManager: number;
    invalidLinks: Array<{ employeeId: string; employeeName: string; reason: string }>;
  };
  rules: {
    levelGap: number;
    sameDepartmentRequired: boolean;
    level1CrossesDepartments: boolean;
    description: string;
  };
}

/** Reporting-manager candidate for the employee form dropdown. */
export interface ReportingOption {
  id: string;
  employeeId: string;
  fullName: string;
  designation: string;
  departmentName: string;
  roleCode: string;
  roleName: string;
}

const KEYS = {
  DEPT: 'lf_local_departments',
  HIER: 'lf_local_hierarchies',
};

function readCache<T>(key: string): T[] {
  try {
    const data = localStorage.getItem(key);
    return data ? (JSON.parse(data) as T[]) : [];
  } catch {
    return [];
  }
}

function writeCache<T>(key: string, value: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`Failed to write local cache ${key}:`, e);
  }
}

/**
 * orgService.ts
 * ------------------------------------------------------------------
 * Departments + department hierarchy documents. Writes go through the
 * API (and therefore PostgreSQL) FIRST; localStorage is a read cache
 * that is only refreshed after a confirmed database commit.
 */
export const orgService = {
  // --- ORGANOGRAM (auto-generated from users.manager_id) ---
  async getOrganogram(): Promise<{ nodes: OrganogramNode[]; roots: string[] }> {
    return apiRequest<{ nodes: OrganogramNode[]; roots: string[] }>('/api/organogram');
  },

  // --- COMPANY-WIDE REPORTING LADDER ---
  async getHierarchyConfig(): Promise<HierarchyConfig> {
    return apiRequest<HierarchyConfig>('/api/hierarchy-config');
  },

  async saveHierarchyConfig(assignments: Array<{ roleId: string; level: number }>): Promise<HierarchyConfig> {
    const body = await apiRequest<{ success: boolean; data: HierarchyConfig }>('/api/hierarchy-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments }),
    });
    return body.data;
  },

  /** Reporting-manager candidates: one or two levels up, same department
   *  (Level 1 / CEO candidates are department-agnostic). */
  async getReportingOptions(role: string, departmentId?: string): Promise<ReportingOption[]> {
    const query = new URLSearchParams({ role });
    if (departmentId) query.set('departmentId', departmentId);
    return apiRequest<ReportingOption[]>(`/api/users/reporting-options?${query.toString()}`);
  },

  // --- DEPARTMENTS ---
  async getDepartments(): Promise<Department[]> {
    try {
      const cloudDepts = await apiRequest<Department[]>('/api/departments');
      writeCache(KEYS.DEPT, cloudDepts);
      return cloudDepts;
    } catch (err) {
      if (err instanceof ApiError && !shouldFallBackToCache(err.status)) throw err;
      return readCache<Department>(KEYS.DEPT);
    }
  },

  /**
   * Create (no `id`) or rename/update (with `id`) a department.
   *
   * A new department must NOT invent an id client-side: the server owns the
   * UUID primary key (and the mirror team that hangs off it). The offline
   * cache is refreshed from the server response.
   */
  async saveDepartment(dept: { id?: string; name: string; description?: string }): Promise<Department> {
    const saved = await apiRequest<Department>('/api/departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dept),
    });
    const depts = await this.getDepartments().catch(() => readCache<Department>(KEYS.DEPT));
    const idx = depts.findIndex(d => d.id === saved.id || (dept.id && d.id === dept.id));
    if (idx > -1) depts[idx] = saved;
    else depts.push(saved);
    writeCache(KEYS.DEPT, depts);
    return saved;
  },

  /**
   * Set a department's heads (Phase C). Every head must already be an ACTIVE
   * member of the department — the server answers 400 otherwise, and its
   * message is what the UI shows. Saving also re-syncs the mirror team:
   * the primary head becomes its leader.
   */
  async setDepartmentHeads(
    departmentId: string,
    assignment: DepartmentHeadAssignment
  ): Promise<DepartmentHeadResult> {
    return apiRequest<DepartmentHeadResult>(
      `/api/departments/${encodeURIComponent(departmentId)}/heads`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assignment),
      }
    );
  },

  async deleteDepartment(deptId: string): Promise<boolean> {
    await apiRequest(`/api/departments/${encodeURIComponent(deptId)}`, { method: 'DELETE' });
    const depts = readCache<Department>(KEYS.DEPT).filter(d => d.id !== deptId);
    writeCache(KEYS.DEPT, depts);
    return true;
  },

  // --- HIERARCHIES ---
  async getHierarchies(): Promise<Hierarchy[]> {
    try {
      const cloudHiers = await apiRequest<Hierarchy[]>('/api/hierarchies');
      writeCache(KEYS.HIER, cloudHiers);
      return cloudHiers;
    } catch (err) {
      if (err instanceof ApiError && !shouldFallBackToCache(err.status)) throw err;
      return readCache<Hierarchy>(KEYS.HIER);
    }
  },

  async saveHierarchy(hier: Hierarchy): Promise<Hierarchy> {
    const saved = await apiRequest<Hierarchy>('/api/hierarchies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hier),
    });
    const hiers = await this.getHierarchies().catch(() => readCache<Hierarchy>(KEYS.HIER));
    const idx = hiers.findIndex(h => h.departmentId === saved.departmentId);
    if (idx > -1) hiers[idx] = saved;
    else hiers.push(saved);
    writeCache(KEYS.HIER, hiers);
    return saved;
  },
};
