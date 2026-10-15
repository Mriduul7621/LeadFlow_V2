/**
 * departmentMirror.ts
 * ------------------------------------------------------------------
 * The department ⇄ team sync behind Phase C (USER_MANAGEMENT_DESIGN_NOTE
 * §5–6, decisions locked 2026-10-15):
 *
 *   1. one department = one MIRROR TEAM, kept in step automatically —
 *      created with the department, renamed with it,
 *   2. membership follows `users.department_id`: assigning a person to a
 *      department puts them in that department's team, and moving them
 *      CLOSES the old membership (`left_at`) instead of deleting it, so
 *      last month's view of "who was in which team" still resolves,
 *   3. heads: at most one active PRIMARY head per department (the database
 *      enforces it), any number of co-heads — all of them are `is_head`,
 *      and only the primary leads the mirror team (`teams.leader_id`).
 *
 * Everything here takes a `client` so callers run it inside the SAME
 * transaction as the user/department write it belongs to. A membership
 * that is out of step with its department is exactly the "one user, two
 * answers" class of bug this project keeps removing.
 *
 * The legacy `team_members` table (employees-centric) is updated on a
 * best-effort basis only: it references `employees(id)` through
 * `users.employee_record_id`, which API-created users do not carry on a
 * fresh install. The product's own membership table is
 * `department_members`.
 */

export interface MirrorTeamSyncResult {
  teamId: string | null;
  memberCount: number;
  leaderId: string | null;
}

/** Trim a team code to the column limit (VARCHAR(30)). */
function mirrorTeamCode(departmentCode: string): string {
  return `D_${String(departmentCode || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 30);
}

let warnedMissingLayer = false;

function warnMissingLayerOnce(): void {
  if (warnedMissingLayer) return;
  warnedMissingLayer = true;
  console.warn(
    'Department mirror layer is not installed (migration 046) — department ⇄ team synchronization is skipped on this database.'
  );
}

/**
 * Is the Phase C layer installed — `department_members` (migration 046) plus
 * `teams.is_department_mirror`?
 *
 * Every product boot applies 046 before the API serves traffic, but minimal
 * schemas exist in the wild (several regression fixtures build a `users`
 * table without it), and a user write must keep working there instead of
 * turning into a 500. The probe is READ-ONLY on purpose: these functions run
 * inside the caller's transaction, and a failing statement would abort the
 * caller's COMMIT even if the JS error were swallowed.
 */
export async function hasDepartmentMirrorLayer(client: any): Promise<boolean> {
  try {
    const probe = await client.query(
      `SELECT to_regclass('public.department_members') IS NOT NULL AS has_members,
              EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'teams' AND column_name = 'is_department_mirror'
              ) AS has_mirror_column`
    );
    const row = probe.rows[0];
    const installed = Boolean(row?.has_members && row?.has_mirror_column);
    if (!installed) warnMissingLayerOnce();
    return installed;
  } catch {
    warnMissingLayerOnce();
    return false;
  }
}

/**
 * The department's mirror team, created on first use. `team_code` is
 * derived from the department code so a re-created team keeps the same
 * handle; a code collision from a manually-made team falls back to a
 * suffixed code rather than failing the department save.
 */
export async function ensureMirrorTeam(client: any, departmentId: string): Promise<string | null> {
  if (!(await hasDepartmentMirrorLayer(client))) return null;
  const existing = await client.query(
    `SELECT id FROM teams WHERE department_id = $1 AND is_department_mirror LIMIT 1`,
    [departmentId]
  );
  if (existing.rows[0]) {
    // The department is the single source of truth for the mirror team's
    // name: renaming a department renames its team (and can never spawn a
    // second one), because the row is found by `department_id` first.
    await client.query(
      `UPDATE teams t
          SET team_name = d.department_name, updated_at = NOW()
         FROM departments d
        WHERE t.id = $1
          AND d.id = $2
          AND t.team_name IS DISTINCT FROM d.department_name`,
      [existing.rows[0].id, departmentId]
    );
    return existing.rows[0].id;
  }

  const dept = await client.query(
    `SELECT department_code, department_name FROM departments WHERE id = $1 LIMIT 1`,
    [departmentId]
  );
  const row = dept.rows[0];
  if (!row) return null;

  for (const code of [mirrorTeamCode(row.department_code), mirrorTeamCode(`${row.department_code}_T`), `D_${String(departmentId).slice(0, 8)}`]) {
    try {
      const created = await client.query(
        `INSERT INTO teams (team_code, team_name, department_id, description, is_active, is_department_mirror, member_ids, created_at, updated_at)
         VALUES ($1, $2, $3, 'Department team (auto-managed)', TRUE, TRUE, '[]'::jsonb, NOW(), NOW())
         RETURNING id`,
        [code, row.department_name, departmentId]
      );
      return created.rows[0].id;
    } catch (error: any) {
      // 23505 = unique violation on team_code: try the next candidate.
      if (error?.code !== '23505') throw error;
    }
  }
  return null;
}

/**
 * Is the optional legacy identity layer (employees ⇄ team_members) present?
 * Read-only catalogue lookups, so the probe itself can never abort the
 * caller's transaction. Deliberately NOT memoized: one process can talk to
 * more than one database (tests, worker + server), and a cached boolean
 * from the wrong schema is worse than two cheap catalog reads.
 */
async function hasLegacyIdentityLayer(client: any): Promise<boolean> {
  try {
    const probe = await client.query(
      `SELECT to_regclass('public.team_members') IS NOT NULL AS has_team_members,
              EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'users' AND column_name = 'employee_record_id'
              ) AS has_employee_record_id`
    );
    return Boolean(probe.rows[0]?.has_team_members && probe.rows[0]?.has_employee_record_id);
  } catch {
    return false;
  }
}

/**
 * Recompute the mirror team's roster and leader from the membership table.
 * Also mirrors into `team_members` when an employee record is resolvable —
 * best-effort, never fatal (a missing identity row must not fail the
 * department write).
 */
export async function syncMirrorTeam(client: any, departmentId: string): Promise<MirrorTeamSyncResult> {
  const teamId = await ensureMirrorTeam(client, departmentId);
  if (!teamId) return { teamId: null, memberCount: 0, leaderId: null };

  const members = await client.query(
    // Deterministic roster order: `joined_at` alone can tie when two people
    // join in the same millisecond, and a roster that reorders itself between
    // reads is a bug report waiting to happen.
    `SELECT user_id FROM department_members WHERE department_id = $1 AND is_active
      ORDER BY joined_at ASC, user_id ASC`,
    [departmentId]
  );
  const memberIds: string[] = members.rows.map((r: any) => r.user_id);

  const head = await client.query(
    `SELECT user_id FROM department_members
      WHERE department_id = $1 AND is_primary_head AND is_active LIMIT 1`,
    [departmentId]
  );
  const leaderId: string | null = head.rows[0]?.user_id || null;

  await client.query(
    `UPDATE teams SET member_ids = $2::jsonb, leader_id = $3, updated_at = NOW() WHERE id = $1`,
    [teamId, JSON.stringify(memberIds), leaderId]
  );

  // Best-effort legacy mirror (skipped whenever the employee layer has no
  // row for this user, which is the normal case on a fresh install).
  //
  // Transaction safety: `syncMirrorTeam` runs INSIDE the caller's
  // transaction (department save, user create/update). In PostgreSQL a
  // failed statement aborts the whole transaction, so a best-effort branch
  // that merely swallowed the JS error would still have poisoned the
  // caller's COMMIT — the next statement would answer "current transaction
  // is aborted". The legacy write therefore runs under a SAVEPOINT, and a
  // read-only capability probe decides up front whether the optional layer
  // is even installed.
  if (memberIds.length > 0 && (await hasLegacyIdentityLayer(client))) {
    await client.query('SAVEPOINT legacy_team_members_mirror');
    try {
      await client.query(
        `INSERT INTO team_members (team_id, employee_id, is_leader, is_active, joined_at)
         SELECT $1, e.id, (e.user_id IS NOT NULL), TRUE, NOW()
           FROM employees e
          WHERE e.employee_id IN (
            SELECT u.employee_id FROM users u WHERE u.id = ANY($2::uuid[])
          )
         ON CONFLICT (team_id, employee_id) DO UPDATE SET is_active = TRUE, left_at = NULL`,
        [teamId, memberIds]
      );
      await client.query('RELEASE SAVEPOINT legacy_team_members_mirror');
    } catch {
      /* legacy layer absent or unmapped: the product membership stands */
      try {
        await client.query('ROLLBACK TO SAVEPOINT legacy_team_members_mirror');
      } catch {
        /* the savepoint is already gone — nothing left to release */
      }
    }
  }

  return { teamId, memberCount: memberIds.length, leaderId };
}

/**
 * Point a person's PRIMARY membership at `departmentId` (or close it when
 * null): the old department's row is closed with `left_at`, a new row is
 * opened with `joined_at`. Additional (non-primary) memberships are left
 * untouched. Both affected mirror teams are re-synced.
 */
export async function syncUserDepartmentMembership(
  client: any,
  userId: string,
  departmentId: string | null
): Promise<void> {
  if (!(await hasDepartmentMirrorLayer(client))) return;
  const previous = await client.query(
    `SELECT department_id FROM department_members WHERE user_id = $1 AND is_primary AND is_active`,
    [userId]
  );
  const previousIds: string[] = previous.rows.map((r: any) => r.department_id);

  // Close every active PRIMARY membership that is not the target.
  await client.query(
    `UPDATE department_members
        SET is_active = FALSE, left_at = NOW(), updated_at = NOW(),
            is_head = FALSE, is_primary_head = FALSE
      WHERE user_id = $1 AND is_primary AND is_active
        AND ($2::uuid IS NULL OR department_id <> $2)`,
    [userId, departmentId]
  );

  if (departmentId) {
    await client.query(
      `INSERT INTO department_members (department_id, user_id, is_primary, is_active, joined_at, left_at, created_at, updated_at)
       VALUES ($1, $2, TRUE, TRUE, NOW(), NULL, NOW(), NOW())
       ON CONFLICT (department_id, user_id) DO UPDATE SET
         is_primary = TRUE,
         is_active = TRUE,
         left_at = NULL,
         joined_at = CASE WHEN department_members.is_active THEN department_members.joined_at ELSE NOW() END,
         updated_at = NOW()`,
      [departmentId, userId]
    );
  }

  // Re-sync the affected mirror teams (old one loses a member, new one gains).
  const touched = new Set<string>([...previousIds, ...(departmentId ? [departmentId] : [])]);
  for (const id of touched) {
    await syncMirrorTeam(client, id);
  }
}

/**
 * Replace a person's EXTRA (non-primary) department memberships with exactly
 * `extraDepartmentIds` — the admin-facing half of decision (2) in the
 * user-management design: one primary department plus optional extra seats.
 *
 * A person with a seat in two departments can HEAD both (decision (1): one
 * head, many departments), and their "my team" visibility follows every
 * active seat. Seats that are dropped are CLOSED (is_active = FALSE +
 * left_at), never deleted, and a dropped seat also releases any head flag on
 * it — a head can never be somebody who left the department.
 *
 * Only non-primary rows are touched: the primary seat is owned by
 * `syncUserDepartmentMembership`. Every affected mirror team is re-synced in
 * the same transaction, so a team roster can never disagree with the
 * membership table. Returns the person's active department ids afterwards.
 */
export async function setUserExtraMemberships(
  client: any,
  userId: string,
  primaryDepartmentId: string | null,
  extraDepartmentIds: string[]
): Promise<string[]> {
  if (!(await hasDepartmentMirrorLayer(client))) return [];
  const wanted = Array.from(new Set((extraDepartmentIds || []).filter(Boolean)))
    .filter(id => id !== primaryDepartmentId);

  const before = await client.query(
    `SELECT department_id FROM department_members
      WHERE user_id = $1 AND is_active AND NOT is_primary`,
    [userId]
  );
  const beforeIds: string[] = before.rows.map((r: any) => r.department_id);

  await client.query(
    `UPDATE department_members
        SET is_active = FALSE, left_at = NOW(), updated_at = NOW(),
            is_head = FALSE, is_primary_head = FALSE
      WHERE user_id = $1 AND is_active AND NOT is_primary
        AND NOT (department_id = ANY($2::uuid[]))`,
    [userId, wanted]
  );

  if (wanted.length > 0) {
    await client.query(
      `INSERT INTO department_members (department_id, user_id, is_primary, is_active, is_head, is_primary_head, joined_at, left_at, created_at, updated_at)
       SELECT seat, $1, FALSE, TRUE, FALSE, FALSE, NOW(), NULL, NOW(), NOW()
         FROM unnest($2::uuid[]) AS seat
       ON CONFLICT (department_id, user_id) DO UPDATE SET
         is_active = TRUE,
         is_primary = FALSE,
         left_at = NULL,
         updated_at = NOW()`,
      [userId, wanted]
    );
  }

  const touched = new Set<string>([...beforeIds, ...wanted]);
  for (const id of touched) {
    await syncMirrorTeam(client, id);
  }
  return getUserDepartmentIds(client, userId);
}

/** Close every active membership of a person (departure / deactivation). */
export async function closeUserMemberships(client: any, userId: string): Promise<void> {
  if (!(await hasDepartmentMirrorLayer(client))) return;
  const rows = await client.query(
    `SELECT DISTINCT department_id FROM department_members WHERE user_id = $1 AND is_active`,
    [userId]
  );
  await client.query(
    `UPDATE department_members
        SET is_active = FALSE, left_at = NOW(), updated_at = NOW(),
            is_head = FALSE, is_primary_head = FALSE
      WHERE user_id = $1 AND is_active`,
    [userId]
  );
  for (const row of rows.rows) {
    await syncMirrorTeam(client, row.department_id);
  }
}

/**
 * Every department `userId` is an ACTIVE member of (primary seat or extra
 * seat) — the product truth behind "my team" visibility. Returns an empty
 * list when migration 046 is not installed, so callers can fall back to the
 * legacy `users.department_id` column.
 */
export async function getUserDepartmentIds(client: any, userId: string): Promise<string[]> {
  if (!userId || !(await hasDepartmentMirrorLayer(client))) return [];
  try {
    const rows = await client.query(
      `SELECT department_id FROM department_members WHERE user_id = $1 AND is_active`,
      [userId]
    );
    return rows.rows.map((r: any) => String(r.department_id)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Active memberships for EVERY member, keyed by user id — one query for the
 * whole roster (the users list needs it per row, and a per-row query would
 * turn a list read into N+1).
 */
export async function getMembershipDepartmentMap(client: any): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!(await hasDepartmentMirrorLayer(client))) return map;
  try {
    const rows = await client.query(
      `SELECT user_id, department_id FROM department_members WHERE is_active`
    );
    for (const r of rows.rows) {
      const key = String(r.user_id);
      const list = map.get(key) || [];
      list.push(String(r.department_id));
      map.set(key, list);
    }
  } catch {
    /* layer absent mid-flight: treat as "no memberships known" */
  }
  return map;
}

export interface DepartmentHeadAssignment {
  /** Exactly one primary head — or null to leave the department headless. */
  primaryUserId: string | null;
  /** Co-heads in addition to the primary one. */
  coHeadUserIds: string[];
}

export interface DepartmentHeadWriteResult {
  primaryUserId: string | null;
  headUserIds: string[];
  teamId: string | null;
  memberCount: number;
}

/**
 * Replace a department's heads. Memberships must exist (a head is one of
 * the department's people), which also keeps the mirror team's leader in
 * the roster. Returns the stored assignment.
 */
export async function setDepartmentHeads(
  client: any,
  departmentId: string,
  assignment: DepartmentHeadAssignment
): Promise<DepartmentHeadWriteResult> {
  if (!(await hasDepartmentMirrorLayer(client))) {
    throw new Error('Department heads need the department-members table (migration 046), which this database does not have.');
  }
  const requested = Array.from(new Set([
    ...(assignment.primaryUserId ? [assignment.primaryUserId] : []),
    ...(assignment.coHeadUserIds || []),
  ]));

  if (requested.length > 0) {
    const known = await client.query(
      `SELECT user_id FROM department_members WHERE department_id = $1 AND is_active AND user_id = ANY($2::uuid[])`,
      [departmentId, requested]
    );
    const knownIds = new Set(known.rows.map((r: any) => r.user_id));
    const missing = requested.filter(id => !knownIds.has(id));
    if (missing.length > 0) {
      throw Object.assign(
        new Error('Every head must be an active member of the department.'),
        { statusCode: 400, meta: { missing } }
      );
    }
  }

  // Clear the old flags first: the partial unique index allows only one
  // active primary head, so the new one cannot be written before the old
  // one is unset.
  await client.query(
    `UPDATE department_members
        SET is_head = FALSE, is_primary_head = FALSE, updated_at = NOW()
      WHERE department_id = $1 AND (is_head OR is_primary_head)`,
    [departmentId]
  );

  if (requested.length > 0) {
    await client.query(
      `UPDATE department_members
          SET is_head = TRUE,
              is_primary_head = (user_id = $2::uuid),
              updated_at = NOW()
        WHERE department_id = $1 AND user_id = ANY($3::uuid[])`,
      [departmentId, assignment.primaryUserId, requested]
    );
  }

  const synced = await syncMirrorTeam(client, departmentId);
  return {
    primaryUserId: assignment.primaryUserId,
    headUserIds: requested,
    teamId: synced.teamId,
    memberCount: synced.memberCount,
  };
}
