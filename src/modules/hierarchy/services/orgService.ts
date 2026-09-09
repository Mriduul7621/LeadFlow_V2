import { apiRequest, ApiError } from '../../shared/api/http';

export interface Department {
  id: string;
  name: string;
  code?: string;
  createdDate: string;
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
  // --- DEPARTMENTS ---
  async getDepartments(): Promise<Department[]> {
    try {
      const cloudDepts = await apiRequest<Department[]>('/api/departments');
      writeCache(KEYS.DEPT, cloudDepts);
      return cloudDepts;
    } catch (err) {
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return readCache<Department>(KEYS.DEPT);
    }
  },

  async saveDepartment(dept: Department): Promise<Department> {
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
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
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
