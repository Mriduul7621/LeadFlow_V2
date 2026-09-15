/**
 * scripts/lib/integrity-checks.mjs — LeadFlow data-integrity invariant catalog
 * ------------------------------------------------------------------------
 * The pure, database-agnostic core of `scripts/verify-data-integrity.mjs`.
 * It is deliberately a plain ES module with NO dependencies so it can be
 * driven by:
 *
 *   - the CLI (a read-only `pg` client against DATABASE_URL), and
 *   - the test-suite (a PGlite pool after the real migrations), which is
 *     how every check is proven against injected corruption.
 *
 * Contract (see docs/DATA_INTEGRITY_AND_RECOVERY.md):
 *
 *   READ-ONLY.  Every query is a SELECT. `runIntegrityChecks` receives a
 *               `queryFn(sql, params)` and never issues INSERT / UPDATE /
 *               DELETE / ALTER / DROP / TRUNCATE / migrations / repairs.
 *               `assertReadOnlySql()` guards the catalog itself and the CLI
 *               additionally runs inside `SET TRANSACTION READ ONLY`.
 *
 *   PRIVACY.    Default output is aggregate counts + invariant names only.
 *               No names, phones, emails, free text, JSON payloads or row
 *               dumps are ever selected. The optional diagnostic mode
 *               fetches a BOUNDED list of opaque row UUIDs (never other
 *               columns) so an operator can locate a violating row.
 *
 *   BOUNDED.    Detection queries are aggregate (COUNT / EXISTS) and never
 *               `SELECT *`; diagnostic samples carry an explicit LIMIT.
 *
 *   SEVERITY.   BLOCKER  — schema-impossible or business-breaking state;
 *                          exit code 1.
 *               WARNING  — drift that degrades correctness (caches,
 *                          shadows, terminal anomalies); exit code 0,
 *                          reported.
 *               INFO     — purely informational counts.
 *
 * The invariant list is the single source of truth for the integrity
 * matrix in the documentation; keep both in sync.
 */

export const SEVERITY = Object.freeze({ BLOCKER: 'BLOCKER', WARNING: 'WARNING', INFO: 'INFO' });

/** Same terminal set as server/utils/businessTime.ts (kept literal: no TS import from .mjs). */
export const TERMINAL_LEAD_STATUSES = Object.freeze(['Converted', 'Not Interested']);

/** Hard cap for diagnostic UUID samples. */
export const DIAGNOSTIC_SAMPLE_LIMIT = 20;

/**
 * Tables the checker relies on. When one is missing (e.g. an old schema)
 * the dependent checks are reported as SKIPPED instead of crashing, and a
 * BLOCKER `schema.required_tables` is raised so the operator applies the
 * migrations first (verify:db-schema is the canonical schema gate).
 */
export const REQUIRED_TABLES = Object.freeze([
  'users',
  'roles',
  'departments',
  'teams',
  'leads',
  'lead_activities',
  'scheduled_activities',
  'notifications',
  'permissions',
  'role_permissions',
  'user_permissions',
  'hierarchies',
]);

/* ==================================================================== */
/* Read-only guard                                                       */
/* ==================================================================== */

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER|COPY|MERGE|CALL|DO)\b/i;

/**
 * Defensive guard: every SQL string in this catalog must be a SELECT/WITH.
 * Throws before the statement reaches the database.
 */
export function assertReadOnlySql(sql) {
  const trimmed = String(sql).trim();
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error(`integrity check refused: statement does not start with SELECT/WITH`);
  }
  // Strip string literals before scanning for forbidden verbs so that e.g.
  // a status literal 'completed' can never trip the guard, but a verb in
  // the executable text always does.
  const withoutLiterals = trimmed.replace(/'(?:[^']|'')*'/g, "''");
  if (FORBIDDEN_SQL.test(withoutLiterals)) {
    throw new Error(`integrity check refused: statement contains a write/DDL verb`);
  }
  return trimmed;
}

/* ==================================================================== */
/* Invariant catalog                                                     */
/* ==================================================================== */

/**
 * Each check:
 *   id          stable identifier `<domain>.<invariant>`
 *   domain      matrix domain
 *   severity    BLOCKER | WARNING | INFO
 *   enforcedBy  'db' | 'app' | 'app+db' | 'none'  (documentation only)
 *   description one line, safe to print
 *   requires    tables that must exist
 *   countSql    SELECT returning a single row with integer column `count`
 *               (the number of violating rows; 0 == PASS)
 *   sampleSql   optional SELECT returning column `id` (opaque UUIDs) with
 *               `LIMIT $1`, used ONLY in diagnostic mode
 *   passWhen    optional predicate `(count) => boolean` overriding count === 0
 *   info        when true the check never fails — its count is reported
 *               as INFO regardless of value
 */
export const INTEGRITY_CHECKS = Object.freeze([
  /* ---------------------------- users -------------------------------- */
  {
    id: 'users.self_manager',
    domain: 'users',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'app+db',
    description: 'No user is their own manager (manager_id <> id).',
    requires: ['users'],
    countSql: `SELECT COUNT(*)::int AS count FROM users WHERE manager_id IS NOT NULL AND manager_id = id`,
    sampleSql: `SELECT id FROM users WHERE manager_id IS NOT NULL AND manager_id = id ORDER BY id LIMIT $1`,
  },
  {
    id: 'users.manager_cycle',
    domain: 'users',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'app',
    description: 'No manager_id chain returns to its starting user (bounded recursive walk, depth < 100).',
    requires: ['users'],
    countSql: `WITH RECURSIVE walk AS (
      SELECT u.id AS start_id, u.manager_id AS cur, 1 AS depth
        FROM users u WHERE u.manager_id IS NOT NULL
      UNION ALL
      SELECT w.start_id, u.manager_id, w.depth + 1
        FROM walk w JOIN users u ON u.id = w.cur
       WHERE u.manager_id IS NOT NULL AND w.depth < 100 AND w.cur <> w.start_id
    )
    SELECT COUNT(DISTINCT start_id)::int AS count FROM walk WHERE cur = start_id`,
    sampleSql: `WITH RECURSIVE walk AS (
      SELECT u.id AS start_id, u.manager_id AS cur, 1 AS depth
        FROM users u WHERE u.manager_id IS NOT NULL
      UNION ALL
      SELECT w.start_id, u.manager_id, w.depth + 1
        FROM walk w JOIN users u ON u.id = w.cur
       WHERE u.manager_id IS NOT NULL AND w.depth < 100 AND w.cur <> w.start_id
    )
    SELECT DISTINCT start_id AS id FROM walk WHERE cur = start_id ORDER BY id LIMIT $1`,
  },
  {
    id: 'users.manager_dangling',
    domain: 'users',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every manager_id references an existing user (FK users.manager_id → users ON DELETE SET NULL).',
    requires: ['users'],
    countSql: `SELECT COUNT(*)::int AS count FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.manager_id IS NOT NULL AND m.id IS NULL`,
    sampleSql: `SELECT u.id FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.manager_id IS NOT NULL AND m.id IS NULL ORDER BY u.id LIMIT $1`,
  },
  {
    id: 'users.role_dangling',
    domain: 'users',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every users.role_id references an existing role (FK).',
    requires: ['users', 'roles'],
    countSql: `SELECT COUNT(*)::int AS count FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.role_id IS NOT NULL AND r.id IS NULL`,
    sampleSql: `SELECT u.id FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.role_id IS NOT NULL AND r.id IS NULL ORDER BY u.id LIMIT $1`,
  },
  {
    id: 'users.department_dangling',
    domain: 'users',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every users.department_id references an existing department (FK).',
    requires: ['users', 'departments'],
    countSql: `SELECT COUNT(*)::int AS count FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.department_id IS NOT NULL AND d.id IS NULL`,
    sampleSql: `SELECT u.id FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.department_id IS NOT NULL AND d.id IS NULL ORDER BY u.id LIMIT $1`,
  },
  {
    id: 'users.team_dangling',
    domain: 'users',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every users.team_id references an existing team (FK).',
    requires: ['users', 'teams'],
    countSql: `SELECT COUNT(*)::int AS count FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.team_id IS NOT NULL AND t.id IS NULL`,
    sampleSql: `SELECT u.id FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.team_id IS NOT NULL AND t.id IS NULL ORDER BY u.id LIMIT $1`,
  },
  {
    id: 'users.manager_inactive',
    domain: 'users',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'Active users do not report to an inactive manager (validated on save; can drift when a manager is deactivated later).',
    requires: ['users'],
    countSql: `SELECT COUNT(*)::int AS count FROM users u JOIN users m ON m.id = u.manager_id WHERE u.is_active IS DISTINCT FROM FALSE AND m.is_active = FALSE`,
    sampleSql: `SELECT u.id FROM users u JOIN users m ON m.id = u.manager_id WHERE u.is_active IS DISTINCT FROM FALSE AND m.is_active = FALSE ORDER BY u.id LIMIT $1`,
  },
  {
    id: 'users.reporting_chain_stale',
    domain: 'users',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'Derived cache users.reporting_chain[0] equals the direct manager\u2019s employee_id (recomputed by the app after every hierarchy write; upline notifications read it).',
    requires: ['users'],
    countSql: `SELECT COUNT(*)::int AS count FROM users u
      LEFT JOIN users m ON m.id = u.manager_id
     WHERE (u.manager_id IS NOT NULL AND (jsonb_typeof(u.reporting_chain) <> 'array' OR u.reporting_chain->>0 IS DISTINCT FROM m.employee_id))
        OR (u.manager_id IS NULL AND jsonb_typeof(u.reporting_chain) = 'array' AND jsonb_array_length(u.reporting_chain) > 0)`,
    sampleSql: `SELECT u.id FROM users u
      LEFT JOIN users m ON m.id = u.manager_id
     WHERE (u.manager_id IS NOT NULL AND (jsonb_typeof(u.reporting_chain) <> 'array' OR u.reporting_chain->>0 IS DISTINCT FROM m.employee_id))
        OR (u.manager_id IS NULL AND jsonb_typeof(u.reporting_chain) = 'array' AND jsonb_array_length(u.reporting_chain) > 0)
     ORDER BY u.id LIMIT $1`,
  },
  {
    id: 'users.hierarchies_mismatch',
    domain: 'users',
    severity: SEVERITY.INFO,
    enforcedBy: 'app',
    description: 'Derived table hierarchies(user_id, manager_id) mirrors users.manager_id (write-only cache today; informational).',
    requires: ['users', 'hierarchies'],
    countSql: `SELECT COUNT(*)::int AS count FROM users u
      FULL OUTER JOIN hierarchies h ON h.user_id = u.id
     WHERE (u.manager_id IS NOT NULL AND (h.user_id IS NULL OR h.manager_id IS DISTINCT FROM u.manager_id))
        OR (u.manager_id IS NULL AND h.user_id IS NOT NULL)`,
    info: true,
  },

  /* ---------------------------- leads -------------------------------- */
  {
    id: 'leads.assigned_to_dangling',
    domain: 'leads',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every leads.assigned_to references an existing user (FK ON DELETE SET NULL).',
    requires: ['leads', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.assigned_to IS NOT NULL AND u.id IS NULL`,
    sampleSql: `SELECT l.id FROM leads l LEFT JOIN users u ON u.id = l.assigned_to WHERE l.assigned_to IS NOT NULL AND u.id IS NULL ORDER BY l.id LIMIT $1`,
  },
  {
    id: 'leads.created_by_dangling',
    domain: 'leads',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every leads.created_by references an existing user (FK ON DELETE SET NULL).',
    requires: ['leads', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads l LEFT JOIN users u ON u.id = l.created_by WHERE l.created_by IS NOT NULL AND u.id IS NULL`,
    sampleSql: `SELECT l.id FROM leads l LEFT JOIN users u ON u.id = l.created_by WHERE l.created_by IS NOT NULL AND u.id IS NULL ORDER BY l.id LIMIT $1`,
  },
  {
    id: 'leads.lead_code_missing',
    domain: 'leads',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'Every lead has a non-blank lead_code (UNIQUE at the DB but nullable; every API writer sets one, readers fall back to the row id).',
    requires: ['leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads WHERE lead_code IS NULL OR btrim(lead_code) = ''`,
    sampleSql: `SELECT id FROM leads WHERE lead_code IS NULL OR btrim(lead_code) = '' ORDER BY id LIMIT $1`,
  },
  {
    id: 'leads.soft_delete_inconsistent',
    domain: 'leads',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'is_deleted = TRUE rows carry deleted_at, and is_deleted = FALSE rows do not (all soft-delete writers set both).',
    requires: ['leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads WHERE (is_deleted = TRUE AND deleted_at IS NULL) OR (is_deleted = FALSE AND deleted_at IS NOT NULL)`,
    sampleSql: `SELECT id FROM leads WHERE (is_deleted = TRUE AND deleted_at IS NULL) OR (is_deleted = FALSE AND deleted_at IS NOT NULL) ORDER BY id LIMIT $1`,
  },
  {
    id: 'leads.deleted_with_open_schedule',
    domain: 'leads',
    severity: SEVERITY.WARNING,
    enforcedBy: 'none',
    description: 'Soft-deleted leads have no open (status = scheduled) scheduled activities (deleting a lead does not cancel its schedule today; readers filter is_deleted).',
    requires: ['leads', 'scheduled_activities'],
    countSql: `SELECT COUNT(DISTINCT l.id)::int AS count FROM leads l JOIN scheduled_activities sa ON sa.lead_id = l.id WHERE l.is_deleted = TRUE AND sa.status = 'scheduled'`,
    sampleSql: `SELECT DISTINCT l.id FROM leads l JOIN scheduled_activities sa ON sa.lead_id = l.id WHERE l.is_deleted = TRUE AND sa.status = 'scheduled' ORDER BY l.id LIMIT $1`,
  },
  {
    id: 'leads.terminal_with_open_schedule',
    domain: 'leads',
    severity: SEVERITY.WARNING,
    enforcedBy: 'none',
    description: 'Terminal leads (Converted / Not Interested) have no open scheduled activities (queue/quality readers exclude terminal leads, so these are orphaned work items).',
    requires: ['leads', 'scheduled_activities'],
    countSql: `SELECT COUNT(DISTINCT l.id)::int AS count FROM leads l JOIN scheduled_activities sa ON sa.lead_id = l.id
      WHERE l.is_deleted = FALSE AND l.current_status = ANY($1::text[]) AND sa.status = 'scheduled'`,
    countParams: () => [[...TERMINAL_LEAD_STATUSES]],
    sampleSql: `SELECT DISTINCT l.id FROM leads l JOIN scheduled_activities sa ON sa.lead_id = l.id
      WHERE l.is_deleted = FALSE AND l.current_status = ANY($2::text[]) AND sa.status = 'scheduled' ORDER BY l.id LIMIT $1`,
    sampleParams: () => [[...TERMINAL_LEAD_STATUSES]],
  },
  {
    id: 'leads.terminal_with_future_follow_up',
    domain: 'leads',
    severity: SEVERITY.WARNING,
    enforcedBy: 'none',
    description: 'Terminal leads do not carry a future next_follow_up_at (a closed lead should not be re-queued).',
    requires: ['leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads l
      WHERE l.is_deleted = FALSE AND l.current_status = ANY($1::text[]) AND l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at > NOW()`,
    countParams: () => [[...TERMINAL_LEAD_STATUSES]],
    sampleSql: `SELECT l.id FROM leads l
      WHERE l.is_deleted = FALSE AND l.current_status = ANY($2::text[]) AND l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at > NOW() ORDER BY l.id LIMIT $1`,
    sampleParams: () => [[...TERMINAL_LEAD_STATUSES]],
  },
  {
    id: 'leads.owner_shadow_mismatch',
    domain: 'leads',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'custom_fields.assignedTo (legacy display shadow) agrees with the canonical assigned_to user\u2019s employee_id when both are present (PostgreSQL assigned_to is authoritative; readers never trust the shadow).',
    requires: ['leads', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads l JOIN users u ON u.id = l.assigned_to
      WHERE l.is_deleted = FALSE
        AND jsonb_typeof(l.custom_fields) = 'object'
        AND COALESCE(btrim(l.custom_fields->>'assignedTo'), '') <> ''
        AND UPPER(btrim(l.custom_fields->>'assignedTo')) <> UPPER(u.employee_id)`,
    sampleSql: `SELECT l.id FROM leads l JOIN users u ON u.id = l.assigned_to
      WHERE l.is_deleted = FALSE
        AND jsonb_typeof(l.custom_fields) = 'object'
        AND COALESCE(btrim(l.custom_fields->>'assignedTo'), '') <> ''
        AND UPPER(btrim(l.custom_fields->>'assignedTo')) <> UPPER(u.employee_id)
      ORDER BY l.id LIMIT $1`,
  },

  /* ----------------------- assignment history ------------------------ */
  {
    id: 'assignment_history.latest_owner_mismatch',
    domain: 'assignment_history',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'The latest assignment_history entry\u2019s toEmployeeId equals the current owner\u2019s employee_id (history is appended in the same UPSERT as the owner change; legacy imports may predate it).',
    requires: ['leads', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.is_deleted = FALSE
       AND jsonb_typeof(l.assignment_history) = 'array'
       AND jsonb_array_length(l.assignment_history) > 0
       AND (
         (l.assigned_to IS NOT NULL AND UPPER(COALESCE(l.assignment_history->-1->>'toEmployeeId', '')) <> UPPER(COALESCE(u.employee_id, '')))
         OR (l.assigned_to IS NULL AND COALESCE(btrim(l.assignment_history->-1->>'toEmployeeId'), '') <> '')
       )`,
    sampleSql: `SELECT l.id FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
     WHERE l.is_deleted = FALSE
       AND jsonb_typeof(l.assignment_history) = 'array'
       AND jsonb_array_length(l.assignment_history) > 0
       AND (
         (l.assigned_to IS NOT NULL AND UPPER(COALESCE(l.assignment_history->-1->>'toEmployeeId', '')) <> UPPER(COALESCE(u.employee_id, '')))
         OR (l.assigned_to IS NULL AND COALESCE(btrim(l.assignment_history->-1->>'toEmployeeId'), '') <> '')
       )
     ORDER BY l.id LIMIT $1`,
  },
  {
    id: 'assignment_history.duplicate_entry_ids',
    domain: 'assignment_history',
    severity: SEVERITY.WARNING,
    enforcedBy: 'none',
    description: 'No lead has two assignment_history entries with the same entry id (a retried assignment would append the same `assign_<ts>` id twice).',
    requires: ['leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM (
      SELECT l.id FROM leads l, jsonb_array_elements(CASE WHEN jsonb_typeof(l.assignment_history) = 'array' THEN l.assignment_history ELSE '[]'::jsonb END) e
       WHERE e->>'id' IS NOT NULL
       GROUP BY l.id, e->>'id' HAVING COUNT(*) > 1
    ) d`,
    sampleSql: `SELECT DISTINCT id FROM (
      SELECT l.id FROM leads l, jsonb_array_elements(CASE WHEN jsonb_typeof(l.assignment_history) = 'array' THEN l.assignment_history ELSE '[]'::jsonb END) e
       WHERE e->>'id' IS NOT NULL
       GROUP BY l.id, e->>'id' HAVING COUNT(*) > 1
    ) d ORDER BY id LIMIT $1`,
  },
  {
    id: 'assignment_history.unknown_employee_ids',
    domain: 'assignment_history',
    severity: SEVERITY.INFO,
    enforcedBy: 'none',
    description: 'assignment_history toEmployeeId values that no longer resolve to a user (deleted users leave historical references; informational).',
    requires: ['leads', 'users'],
    countSql: `SELECT COUNT(DISTINCT l.id)::int AS count FROM leads l,
      jsonb_array_elements(CASE WHEN jsonb_typeof(l.assignment_history) = 'array' THEN l.assignment_history ELSE '[]'::jsonb END) e
      WHERE COALESCE(btrim(e->>'toEmployeeId'), '') <> ''
        AND NOT EXISTS (SELECT 1 FROM users u WHERE UPPER(u.employee_id) = UPPER(btrim(e->>'toEmployeeId')))`,
    info: true,
  },

  /* -------------------------- lead_activities ------------------------ */
  {
    id: 'lead_activities.lead_dangling',
    domain: 'lead_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every lead_activities.lead_id references an existing lead (FK ON DELETE CASCADE).',
    requires: ['lead_activities', 'leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM lead_activities a LEFT JOIN leads l ON l.id = a.lead_id WHERE l.id IS NULL`,
    sampleSql: `SELECT a.id FROM lead_activities a LEFT JOIN leads l ON l.id = a.lead_id WHERE l.id IS NULL ORDER BY a.id LIMIT $1`,
  },
  {
    id: 'lead_activities.created_by_dangling',
    domain: 'lead_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every lead_activities.created_by references an existing user (FK ON DELETE SET NULL).',
    requires: ['lead_activities', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM lead_activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.created_by IS NOT NULL AND u.id IS NULL`,
    sampleSql: `SELECT a.id FROM lead_activities a LEFT JOIN users u ON u.id = a.created_by WHERE a.created_by IS NOT NULL AND u.id IS NULL ORDER BY a.id LIMIT $1`,
  },

  /* ----------------------- scheduled_activities ---------------------- */
  {
    id: 'scheduled_activities.lead_dangling',
    domain: 'scheduled_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every scheduled_activities.lead_id references an existing lead (FK ON DELETE CASCADE).',
    requires: ['scheduled_activities', 'leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE l.id IS NULL`,
    sampleSql: `SELECT sa.id FROM scheduled_activities sa LEFT JOIN leads l ON l.id = sa.lead_id WHERE l.id IS NULL ORDER BY sa.id LIMIT $1`,
  },
  {
    id: 'scheduled_activities.assigned_to_dangling',
    domain: 'scheduled_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every scheduled_activities.assigned_to references an existing user (FK ON DELETE SET NULL).',
    requires: ['scheduled_activities', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM scheduled_activities sa LEFT JOIN users u ON u.id = sa.assigned_to WHERE sa.assigned_to IS NOT NULL AND u.id IS NULL`,
    sampleSql: `SELECT sa.id FROM scheduled_activities sa LEFT JOIN users u ON u.id = sa.assigned_to WHERE sa.assigned_to IS NOT NULL AND u.id IS NULL ORDER BY sa.id LIMIT $1`,
  },
  {
    id: 'scheduled_activities.status_domain',
    domain: 'scheduled_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'status is one of scheduled / completed / cancelled (CHECK constraint, migration 039).',
    requires: ['scheduled_activities'],
    countSql: `SELECT COUNT(*)::int AS count FROM scheduled_activities WHERE status IS NULL OR status NOT IN ('scheduled', 'completed', 'cancelled')`,
    sampleSql: `SELECT id FROM scheduled_activities WHERE status IS NULL OR status NOT IN ('scheduled', 'completed', 'cancelled') ORDER BY id LIMIT $1`,
  },
  {
    id: 'scheduled_activities.completed_without_activity',
    domain: 'scheduled_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'app',
    description: 'Every completed scheduled activity has completed_at AND links an existing lead_activities row (completion is a single transaction: INSERT activity + UPDATE schedule).',
    requires: ['scheduled_activities', 'lead_activities'],
    countSql: `SELECT COUNT(*)::int AS count FROM scheduled_activities sa
      LEFT JOIN lead_activities a ON a.id = sa.completed_activity_id
     WHERE sa.status = 'completed' AND (sa.completed_at IS NULL OR sa.completed_activity_id IS NULL OR a.id IS NULL)`,
    sampleSql: `SELECT sa.id FROM scheduled_activities sa
      LEFT JOIN lead_activities a ON a.id = sa.completed_activity_id
     WHERE sa.status = 'completed' AND (sa.completed_at IS NULL OR sa.completed_activity_id IS NULL OR a.id IS NULL)
     ORDER BY sa.id LIMIT $1`,
  },
  {
    id: 'scheduled_activities.completed_activity_wrong_lead',
    domain: 'scheduled_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'app',
    description: 'The linked completion activity belongs to the same lead as the scheduled activity.',
    requires: ['scheduled_activities', 'lead_activities'],
    countSql: `SELECT COUNT(*)::int AS count FROM scheduled_activities sa JOIN lead_activities a ON a.id = sa.completed_activity_id WHERE a.lead_id <> sa.lead_id`,
    sampleSql: `SELECT sa.id FROM scheduled_activities sa JOIN lead_activities a ON a.id = sa.completed_activity_id WHERE a.lead_id <> sa.lead_id ORDER BY sa.id LIMIT $1`,
  },
  {
    id: 'scheduled_activities.duplicate_completion',
    domain: 'scheduled_activities',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'app+db',
    description: 'No two scheduled activities link the same completion activity (one completion = one actual activity; unique partial index from migration 042).',
    requires: ['scheduled_activities'],
    countSql: `SELECT COUNT(*)::int AS count FROM (
      SELECT completed_activity_id FROM scheduled_activities WHERE completed_activity_id IS NOT NULL GROUP BY completed_activity_id HAVING COUNT(*) > 1
    ) d`,
    sampleSql: `SELECT completed_activity_id AS id FROM scheduled_activities WHERE completed_activity_id IS NOT NULL GROUP BY completed_activity_id HAVING COUNT(*) > 1 ORDER BY id LIMIT $1`,
  },
  {
    id: 'scheduled_activities.open_with_completion_fields',
    domain: 'scheduled_activities',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'scheduled / cancelled rows carry no completion fields (completed_at, completed_by, completed_activity_id).',
    requires: ['scheduled_activities'],
    countSql: `SELECT COUNT(*)::int AS count FROM scheduled_activities WHERE status <> 'completed' AND (completed_at IS NOT NULL OR completed_by IS NOT NULL OR completed_activity_id IS NOT NULL)`,
    sampleSql: `SELECT id FROM scheduled_activities WHERE status <> 'completed' AND (completed_at IS NOT NULL OR completed_by IS NOT NULL OR completed_activity_id IS NOT NULL) ORDER BY id LIMIT $1`,
  },

  /* --------------------------- notifications ------------------------- */
  {
    id: 'notifications.user_dangling',
    domain: 'notifications',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every notifications.user_id references an existing user (FK ON DELETE CASCADE).',
    requires: ['notifications', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM notifications n LEFT JOIN users u ON u.id = n.user_id WHERE u.id IS NULL`,
    sampleSql: `SELECT n.id FROM notifications n LEFT JOIN users u ON u.id = n.user_id WHERE u.id IS NULL ORDER BY n.id LIMIT $1`,
  },
  {
    id: 'notifications.lead_reference_dangling',
    domain: 'notifications',
    severity: SEVERITY.WARNING,
    enforcedBy: 'none',
    description: 'reference_type = lead rows point at an existing lead (no FK by design: legacy rows may outlive purged leads).',
    requires: ['notifications', 'leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM notifications n LEFT JOIN leads l ON l.id = n.reference_id
      WHERE n.reference_type = 'lead' AND n.reference_id IS NOT NULL AND l.id IS NULL`,
    sampleSql: `SELECT n.id FROM notifications n LEFT JOIN leads l ON l.id = n.reference_id
      WHERE n.reference_type = 'lead' AND n.reference_id IS NOT NULL AND l.id IS NULL ORDER BY n.id LIMIT $1`,
  },
  {
    id: 'notifications.recipient_key_mismatch',
    domain: 'notifications',
    severity: SEVERITY.WARNING,
    enforcedBy: 'app',
    description: 'recipient_key (display employee_id) matches the recipient user\u2019s employee_id when set.',
    requires: ['notifications', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE COALESCE(btrim(n.recipient_key), '') <> '' AND UPPER(btrim(n.recipient_key)) <> UPPER(u.employee_id)`,
    sampleSql: `SELECT n.id FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE COALESCE(btrim(n.recipient_key), '') <> '' AND UPPER(btrim(n.recipient_key)) <> UPPER(u.employee_id) ORDER BY n.id LIMIT $1`,
  },
  {
    id: 'notifications.idempotency_key_duplicate',
    domain: 'notifications',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'No two notifications share a non-null idempotency_key (UNIQUE partial index idx_notifications_idempotency_key, PR #44).',
    requires: ['notifications'],
    countSql: `SELECT COUNT(*)::int AS count FROM (
      SELECT idempotency_key FROM notifications WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING COUNT(*) > 1
    ) d`,
    sampleSql: `SELECT MIN(id::text)::uuid AS id FROM notifications WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING COUNT(*) > 1 ORDER BY id LIMIT $1`,
  },
  {
    id: 'notifications.idempotency_index_present',
    domain: 'notifications',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'The UNIQUE partial index idx_notifications_idempotency_key exists (guarantees retry-safe notification creation).',
    requires: ['notifications'],
    countSql: `SELECT (1 - COUNT(*))::int AS count FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_notifications_idempotency_key' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%idempotency_key IS NOT NULL%'`,
  },

  /* ------------------------------ rbac ------------------------------- */
  {
    id: 'rbac.role_permissions_dangling',
    domain: 'rbac',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every role_permissions row references an existing role and permission (FKs ON DELETE CASCADE).',
    requires: ['role_permissions', 'roles', 'permissions'],
    countSql: `SELECT COUNT(*)::int AS count FROM role_permissions rp
      LEFT JOIN roles r ON r.id = rp.role_id LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE r.id IS NULL OR p.id IS NULL`,
    sampleSql: `SELECT rp.role_id AS id FROM role_permissions rp
      LEFT JOIN roles r ON r.id = rp.role_id LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE r.id IS NULL OR p.id IS NULL ORDER BY rp.role_id LIMIT $1`,
  },
  {
    id: 'rbac.user_permissions_dangling',
    domain: 'rbac',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every user_permissions row references an existing user and permission (FKs ON DELETE CASCADE).',
    requires: ['user_permissions', 'users', 'permissions'],
    countSql: `SELECT COUNT(*)::int AS count FROM user_permissions up
      LEFT JOIN users u ON u.id = up.user_id LEFT JOIN permissions p ON p.id = up.permission_id
     WHERE u.id IS NULL OR p.id IS NULL`,
    sampleSql: `SELECT up.user_id AS id FROM user_permissions up
      LEFT JOIN users u ON u.id = up.user_id LEFT JOIN permissions p ON p.id = up.permission_id
     WHERE u.id IS NULL OR p.id IS NULL ORDER BY up.user_id LIMIT $1`,
  },
  {
    id: 'rbac.duplicate_role_grants',
    domain: 'rbac',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'No duplicate (role_id, permission_id) grants (composite PK).',
    requires: ['role_permissions'],
    countSql: `SELECT COUNT(*)::int AS count FROM (SELECT role_id, permission_id FROM role_permissions GROUP BY role_id, permission_id HAVING COUNT(*) > 1) d`,
  },
  {
    id: 'rbac.duplicate_user_grants',
    domain: 'rbac',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'No duplicate (user_id, permission_id) overrides (composite PK).',
    requires: ['user_permissions'],
    countSql: `SELECT COUNT(*)::int AS count FROM (SELECT user_id, permission_id FROM user_permissions GROUP BY user_id, permission_id HAVING COUNT(*) > 1) d`,
  },
  {
    id: 'rbac.permission_code_blank',
    domain: 'rbac',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every permission has a non-blank permission_code (UNIQUE NOT NULL).',
    requires: ['permissions'],
    countSql: `SELECT COUNT(*)::int AS count FROM permissions WHERE permission_code IS NULL OR btrim(permission_code) = ''`,
  },

  /* ------------------------- teams / departments --------------------- */
  {
    id: 'teams.department_dangling',
    domain: 'teams',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every team belongs to an existing department (FK ON DELETE RESTRICT).',
    requires: ['teams', 'departments'],
    countSql: `SELECT COUNT(*)::int AS count FROM teams t LEFT JOIN departments d ON d.id = t.department_id WHERE t.department_id IS NOT NULL AND d.id IS NULL`,
    sampleSql: `SELECT t.id FROM teams t LEFT JOIN departments d ON d.id = t.department_id WHERE t.department_id IS NOT NULL AND d.id IS NULL ORDER BY t.id LIMIT $1`,
  },
  {
    id: 'teams.leader_dangling',
    domain: 'teams',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'Every teams.leader_id references an existing user (FK ON DELETE SET NULL).',
    requires: ['teams', 'users'],
    countSql: `SELECT COUNT(*)::int AS count FROM teams t LEFT JOIN users u ON u.id = t.leader_id WHERE t.leader_id IS NOT NULL AND u.id IS NULL`,
    sampleSql: `SELECT t.id FROM teams t LEFT JOIN users u ON u.id = t.leader_id WHERE t.leader_id IS NOT NULL AND u.id IS NULL ORDER BY t.id LIMIT $1`,
  },

  /* --------------------------- table volumes ------------------------- */
  {
    id: 'volume.users',
    domain: 'volume',
    severity: SEVERITY.INFO,
    enforcedBy: 'none',
    description: 'Row count: users (estimate-free exact count; informational).',
    requires: ['users'],
    countSql: `SELECT COUNT(*)::int AS count FROM users`,
    info: true,
  },
  {
    id: 'volume.leads_active',
    domain: 'volume',
    severity: SEVERITY.INFO,
    enforcedBy: 'none',
    description: 'Row count: active (non-deleted) leads.',
    requires: ['leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads WHERE is_deleted = FALSE`,
    info: true,
  },
  {
    id: 'volume.leads_deleted',
    domain: 'volume',
    severity: SEVERITY.INFO,
    enforcedBy: 'none',
    description: 'Row count: soft-deleted leads.',
    requires: ['leads'],
    countSql: `SELECT COUNT(*)::int AS count FROM leads WHERE is_deleted = TRUE`,
    info: true,
  },
  {
    id: 'volume.scheduled_open',
    domain: 'volume',
    severity: SEVERITY.INFO,
    enforcedBy: 'none',
    description: 'Row count: open scheduled activities.',
    requires: ['scheduled_activities'],
    countSql: `SELECT COUNT(*)::int AS count FROM scheduled_activities WHERE status = 'scheduled'`,
    info: true,
  },
]);

/* ==================================================================== */
/* Runner                                                                */
/* ==================================================================== */

/**
 * Discover which required tables exist (read-only information_schema).
 */
export async function discoverTables(queryFn) {
  const res = await queryFn(
    assertReadOnlySql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    ),
    []
  );
  return new Set(res.rows.map((r) => String(r.table_name)));
}

/**
 * Run the full catalog.
 *
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} queryFn
 * @param {{ diagnostic?: boolean, sampleLimit?: number, checks?: readonly any[] }} [opts]
 * @returns {Promise<IntegrityReport>}
 */
export async function runIntegrityChecks(queryFn, opts = {}) {
  const diagnostic = Boolean(opts.diagnostic);
  const sampleLimit = Math.max(1, Math.min(Number(opts.sampleLimit) || DIAGNOSTIC_SAMPLE_LIMIT, DIAGNOSTIC_SAMPLE_LIMIT));
  const catalog = opts.checks || INTEGRITY_CHECKS;

  const existing = await discoverTables(queryFn);
  const missingTables = REQUIRED_TABLES.filter((t) => !existing.has(t));

  const results = [];

  // Schema precondition (BLOCKER when a required table is absent).
  results.push({
    id: 'schema.required_tables',
    domain: 'schema',
    severity: SEVERITY.BLOCKER,
    enforcedBy: 'db',
    description: 'All tables the integrity catalog depends on exist (apply migrations / run verify:db-schema first).',
    status: missingTables.length === 0 ? 'PASS' : 'FAIL',
    count: missingTables.length,
    // Table names are schema identifiers, not data — safe to print.
    detail: missingTables.length ? `missing: ${missingTables.join(', ')}` : null,
    sample: [],
  });

  for (const check of catalog) {
    const missing = (check.requires || []).filter((t) => !existing.has(t));
    if (missing.length) {
      results.push({
        id: check.id,
        domain: check.domain,
        severity: check.severity,
        enforcedBy: check.enforcedBy,
        description: check.description,
        status: 'SKIPPED',
        count: null,
        detail: `table missing: ${missing.join(', ')}`,
        sample: [],
      });
      continue;
    }

    let count = null;
    let status;
    let detail = null;
    let sample = [];
    try {
      const params = typeof check.countParams === 'function' ? check.countParams() : [];
      const res = await queryFn(assertReadOnlySql(check.countSql), params);
      count = Number(res.rows?.[0]?.count ?? 0);
      if (!Number.isFinite(count)) count = 0;
      const pass = check.info ? true : (typeof check.passWhen === 'function' ? check.passWhen(count) : count === 0);
      if (check.info) status = 'INFO';
      else if (pass) status = 'PASS';
      else status = check.severity === SEVERITY.BLOCKER ? 'FAIL' : 'WARN';

      if (diagnostic && !check.info && !pass && check.sampleSql) {
        const sampleParams = [sampleLimit, ...(typeof check.sampleParams === 'function' ? check.sampleParams() : [])];
        const s = await queryFn(assertReadOnlySql(check.sampleSql), sampleParams);
        // Opaque identifiers only; anything that is not a UUID-looking value
        // is dropped so a mis-written sample query can never leak data.
        sample = (s.rows || [])
          .map((r) => String(r.id ?? ''))
          .filter((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
          .slice(0, sampleLimit);
      }
    } catch (err) {
      // A failing detection query is itself a finding: report it as ERROR
      // (treated as BLOCKER for exit-code purposes) with a sanitized message.
      status = 'ERROR';
      detail = sanitizeError(err);
    }

    results.push({
      id: check.id,
      domain: check.domain,
      severity: check.severity,
      enforcedBy: check.enforcedBy,
      description: check.description,
      status,
      count,
      detail,
      sample,
    });
  }

  return summarize(results, { diagnostic, sampleLimit });
}

function sanitizeError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split(/\r?\n/)[0].replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://[redacted]').slice(0, 200);
}

/**
 * Aggregate the per-check results into the report shape consumed by the
 * CLI and the tests.
 */
export function summarize(results, meta = {}) {
  const counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0, SKIPPED: 0, ERROR: 0 };
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const blockers = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  const warnings = results.filter((r) => r.status === 'WARN');
  const overall = blockers.length ? 'FAIL' : warnings.length ? 'WARN' : 'PASS';
  return {
    overall,
    exitCode: blockers.length ? 1 : 0,
    counts,
    blockers: blockers.map((r) => r.id),
    warnings: warnings.map((r) => r.id),
    results,
    meta: { diagnostic: Boolean(meta.diagnostic), sampleLimit: meta.sampleLimit ?? null, generatedAt: new Date().toISOString() },
  };
}

/**
 * Human-readable, PII-free report lines. Every line is built from the
 * invariant id, status, severity and an integer count; diagnostic samples
 * are opaque UUIDs only.
 */
export function formatReport(report) {
  const lines = [];
  lines.push(`LeadFlow data integrity — overall ${report.overall}`);
  lines.push(
    `  checks: ${report.results.length}  pass=${report.counts.PASS} warn=${report.counts.WARN} fail=${report.counts.FAIL} info=${report.counts.INFO} skipped=${report.counts.SKIPPED} error=${report.counts.ERROR}`
  );
  lines.push('');
  let lastDomain = null;
  for (const r of report.results) {
    if (r.domain !== lastDomain) {
      lines.push(`[${r.domain}]`);
      lastDomain = r.domain;
    }
    const count = r.count === null ? '-' : String(r.count);
    lines.push(`  ${pad(r.status, 7)} ${pad(r.severity, 7)} ${pad(r.id, 52)} count=${count}`);
    if (r.detail) lines.push(`          ${r.detail}`);
    if (r.sample && r.sample.length) lines.push(`          sample ids (${r.sample.length}): ${r.sample.join(', ')}`);
  }
  lines.push('');
  if (report.blockers.length) lines.push(`BLOCKERS (${report.blockers.length}): ${report.blockers.join(', ')}`);
  if (report.warnings.length) lines.push(`WARNINGS (${report.warnings.length}): ${report.warnings.join(', ')}`);
  lines.push(`RESULT: ${report.overall} (exit ${report.exitCode})`);
  return lines.join('\n');
}

function pad(v, n) {
  const s = String(v);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
