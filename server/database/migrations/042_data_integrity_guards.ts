import { query } from "../connection.js";

/**
 * 042 — Data integrity guards (reliability audit)
 * ------------------------------------------------------------------
 * Two narrowly-scoped, data-safe constraints identified by the integrity
 * audit (docs/DATA_INTEGRITY_AND_RECOVERY.md). Both are ADDITIVE, both are
 * idempotent, and both are written so that pre-existing production rows
 * can NEVER make a cold-start migration fail:
 *
 *   1. users_no_self_manager — CHECK (manager_id IS NULL OR manager_id <> id)
 *      A user reporting to themselves breaks the manager-chain walkers
 *      (visibility CTE, reporting_chain recompute, upline notifications).
 *      The application already rejects this on every write path
 *      (validateReportingLink / bulk import 'cannot report to self'), the
 *      seed never writes it, and the dev-demo fallback store has no
 *      equivalent field, so the invariant is safe to enforce at the DB.
 *
 *      Added with NOT VALID: PostgreSQL enforces it for every NEW write
 *      immediately, but does NOT scan or reject existing rows — so a legacy
 *      violation (if one exists) surfaces through the read-only checker
 *      (scripts/verify-data-integrity.mjs, BLOCKER users.self_manager)
 *      instead of taking the whole deployment down at startup. Operators
 *      may VALIDATE CONSTRAINT after the checker reports zero violations.
 *
 *   2. uq_scheduled_activities_completed_activity — UNIQUE partial index on
 *      scheduled_activities(completed_activity_id) WHERE NOT NULL.
 *      Completing a scheduled activity inserts exactly ONE lead_activities
 *      row and links it. Two scheduled rows pointing at the same actual
 *      activity would mean a duplicated completion; the route already
 *      prevents this (FOR UPDATE + status check + single transaction), and
 *      the index makes the "duplicate completion" state impossible at the
 *      storage layer too. Because CREATE UNIQUE INDEX would fail if
 *      duplicates already existed, the index is only created when the
 *      table is currently clean; otherwise a WARNING is raised and the
 *      checker reports the duplicates (BLOCKER
 *      scheduled_activities.duplicate_completion) — never a startup failure.
 *
 * What is deliberately NOT enforced here (detect-only, see the audit doc):
 *   - manager cycles (needs a recursive walk — not expressible as a CHECK),
 *   - reporting_chain / hierarchies derived caches (recomputed by the app),
 *   - custom_fields.assignedTo shadow vs assigned_to (legacy import data),
 *   - notifications.reference_id → leads FK (legacy rows may reference
 *     purged leads; NULL reference_type is a valid client-created row),
 *   - completed/cancelled column coupling on scheduled_activities (legacy
 *     rows and the dev-demo store differ).
 *
 * No data rewrite. No table rewrite (NOT VALID CHECK is metadata-only; the
 * partial unique index only touches rows with a non-null link).
 */
export async function up(): Promise<void> {
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'users_no_self_manager'
           AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_no_self_manager
          CHECK (manager_id IS NULL OR manager_id <> id) NOT VALID;
      END IF;
    END
    $$;
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'uq_scheduled_activities_completed_activity'
      ) THEN
        IF EXISTS (
          SELECT 1 FROM scheduled_activities
           WHERE completed_activity_id IS NOT NULL
           GROUP BY completed_activity_id
          HAVING COUNT(*) > 1
        ) THEN
          RAISE WARNING '042: duplicate scheduled_activities.completed_activity_id rows exist; unique index NOT created. Run scripts/verify-data-integrity.mjs and resolve before re-running.';
        ELSE
          CREATE UNIQUE INDEX uq_scheduled_activities_completed_activity
            ON scheduled_activities(completed_activity_id)
            WHERE completed_activity_id IS NOT NULL;
        END IF;
      END IF;
    END
    $$;
  `);

  console.log("✅ 042_data_integrity_guards migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — the guards remain. Dropping them would re-open the
  // duplicate-completion / self-manager states on purpose, which is an
  // explicit operator decision, not a migration rollback.
  console.log("ℹ️ 042 down() is a no-op to protect production data.");
}
