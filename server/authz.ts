import { getPool } from './database/connection.js';

export async function getScopedEmployeeIds(employeeId: string, role: string): Promise<Set<string> | null> {
  if (role === 'ADMIN') return null;

  const pool = getPool();
  if (!pool) return new Set([employeeId]);

  try {
    const result = await pool.query<{ employee_id: string; manager_id: string | null }>(
      'SELECT employee_id, manager_id FROM users'
    );
    const children = new Map<string, string[]>();
    for (const row of result.rows) {
      if (!row.manager_id) continue;
      const members = children.get(row.manager_id) || [];
      members.push(row.employee_id);
      children.set(row.manager_id, members);
    }

    const scoped = new Set<string>([employeeId]);
    const pending = [employeeId];
    while (pending.length > 0) {
      const managerId = pending.pop()!;
      for (const child of children.get(managerId) || []) {
        if (!scoped.has(child)) {
          scoped.add(child);
          pending.push(child);
        }
      }
    }
    return scoped;
  } catch {
    return new Set([employeeId]);
  }
}
