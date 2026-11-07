/**
 * reportingChains.ts — the ONE derivation of the reporting tree.
 * ------------------------------------------------------------------
 * reporting_chain / subordinates are DERIVED data: they are a pure
 * function of users.manager_id (the single source link) and are never
 * edited by hand. This module owns that derivation so every writer —
 * user create / edit / delete in routes/production/users.routes.ts
 * (which re-exports this function for its historical importers) and
 * migration 053's one-time repair of already-stale rows — runs the
 * exact same recompute. (Same layering precedent as
 * database/roleAccessDefaults.ts, shared by the routes and migration
 * 045.)
 */

/**
 * Server-authoritative recompute of reporting_chain / subordinates for all
 * users (derived from users.manager_id), plus the era-B `hierarchies` sync
 * rows. Called after any user create/update/delete that can change the tree.
 *
 * Every database error propagates to the caller: the caller runs this
 * inside the same transaction as the user write and rolls the whole
 * transaction back on failure, so NOTHING here may swallow errors.
 * (Exported for regression tests; the HTTP routes remain the only callers
 * in production code.)
 */
export async function recomputeReportingChains(exec: { query: Function }): Promise<void> {
  const result = await exec.query('SELECT id, employee_id, manager_id FROM users');
  const byId = new Map<string, { id: string; employeeId: string; managerId: string | null }>();
  for (const row of result.rows) {
    byId.set(row.id, { id: row.id, employeeId: row.employee_id, managerId: row.manager_id || null });
  }
  const childrenOf = new Map<string, string[]>();
  for (const u of byId.values()) {
    if (!u.managerId) continue;
    const list = childrenOf.get(u.managerId) || [];
    list.push(u.id);
    childrenOf.set(u.managerId, list);
  }

  const chainMemo = new Map<string, string[]>();
  const chainOf = (id: string, guard: Set<string>): string[] => {
    if (chainMemo.has(id)) return chainMemo.get(id)!;
    const user = byId.get(id);
    if (!user || !user.managerId || guard.has(id)) return [];
    guard.add(id);
    const manager = byId.get(user.managerId);
    const chain = manager ? [manager.employeeId, ...chainOf(user.managerId, guard)] : [];
    guard.delete(id);
    chainMemo.set(id, chain);
    return chain;
  };

  const subsMemo = new Map<string, string[]>();
  const subsOf = (id: string): string[] => {
    if (subsMemo.has(id)) return subsMemo.get(id)!;
    const kids = childrenOf.get(id) || [];
    const all: string[] = [];
    for (const kid of kids) {
      const kidUser = byId.get(kid);
      if (kidUser) all.push(kidUser.employeeId, ...subsOf(kid));
    }
    subsMemo.set(id, all);
    return all;
  };

  for (const user of byId.values()) {
    const chain = chainOf(user.id, new Set());
    const subs = subsOf(user.id);
    await exec.query(
      `UPDATE users SET reporting_chain = $2, subordinates = $3, updated_at = NOW() WHERE id = $1`,
      [user.id, JSON.stringify(chain), JSON.stringify(subs)]
    );
    if (user.managerId) {
      await exec.query(
        `INSERT INTO hierarchies (user_id, manager_id, level, path, created_at, updated_at)
         VALUES ($1, $2, GREATEST($3, 1), $4, NOW(), NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           manager_id = EXCLUDED.manager_id,
           level = EXCLUDED.level,
           path = EXCLUDED.path,
           updated_at = NOW()`,
        [user.id, user.managerId, chain.length + 1, JSON.stringify(chain)]
      );
    } else {
      // No error swallowing here: a failed DELETE inside the caller's
      // transaction would abort that transaction, and the caller must see
      // the failure so it can roll back instead of committing partial data.
      await exec.query('DELETE FROM hierarchies WHERE user_id = $1', [user.id]);
    }
  }
}
