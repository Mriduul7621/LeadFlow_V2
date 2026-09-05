export interface Department {
  id: string;
  name: string;
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

export const orgService = {
  // --- DEPARTMENTS ---
  async getDepartments(): Promise<Department[]> {
    try {
      const res = await fetch('/api/departments');
      if (res.ok) {
        const cloudDepts: Department[] = await res.json();
        localStorage.setItem(KEYS.DEPT, JSON.stringify(cloudDepts));
        return cloudDepts;
      }
    } catch (error) {
      console.warn('PostgreSQL fetch departments fallback to local storage:', error);
    }
    const data = localStorage.getItem(KEYS.DEPT);
    return data ? JSON.parse(data) : [];
  },

  async saveDepartment(dept: Department): Promise<Department> {
    const depts = await this.getDepartments();
    const idx = depts.findIndex(d => d.id === dept.id);
    if (idx > -1) {
      depts[idx] = dept;
    } else {
      depts.push(dept);
    }
    localStorage.setItem(KEYS.DEPT, JSON.stringify(depts));

    try {
      await fetch('/api/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dept)
      });
    } catch (error) {
      console.warn('PostgreSQL save department fallback to local storage:', error);
    }
    return dept;
  },

  async deleteDepartment(deptId: string): Promise<boolean> {
    const depts = await this.getDepartments();
    const filtered = depts.filter(d => d.id !== deptId);
    localStorage.setItem(KEYS.DEPT, JSON.stringify(filtered));

    try {
      await fetch(`/api/departments/${deptId}`, {
        method: 'DELETE'
      });
      return true;
    } catch (error) {
      console.warn('PostgreSQL delete department fallback to local storage:', error);
      return true;
    }
  },

  // --- HIERARCHIES ---
  async getHierarchies(): Promise<Hierarchy[]> {
    try {
      const res = await fetch('/api/hierarchies');
      if (res.ok) {
        const cloudHiers: Hierarchy[] = await res.json();
        localStorage.setItem(KEYS.HIER, JSON.stringify(cloudHiers));
        return cloudHiers;
      }
    } catch (error) {
      console.warn('PostgreSQL fetch hierarchies fallback to local storage:', error);
    }
    const data = localStorage.getItem(KEYS.HIER);
    return data ? JSON.parse(data) : [];
  },

  async saveHierarchy(hier: Hierarchy): Promise<Hierarchy> {
    const hiers = await this.getHierarchies();
    const idx = hiers.findIndex(h => h.id === hier.id);
    if (idx > -1) {
      hiers[idx] = hier;
    } else {
      hiers.push(hier);
    }
    localStorage.setItem(KEYS.HIER, JSON.stringify(hiers));

    try {
      await fetch('/api/hierarchies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hier)
      });
    } catch (error) {
      console.warn('PostgreSQL save hierarchy fallback:', error);
    }
    return hier;
  }
};
