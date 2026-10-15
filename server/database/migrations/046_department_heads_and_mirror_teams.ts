import { query } from "../connection.js";

/**
 * 046 — department heads + the department mirror team.
 * ------------------------------------------------------------------
 * BUSINESS RULE (locked 2026-10-15, see USER_MANAGEMENT_DESIGN_NOTE §6):
 *   - every department has at most ONE primary head, plus any number of
 *     co-heads; the head may lead several departments,
 *   - a person has ONE primary department and may hold additional
 *     memberships,
 *   - one department = one MIRROR TEAM (same name) whose members are the
 *     department's people — the head leads that team,
 *   - membership carries history (`joined_at` / `left_at`): moving a
 *     manager or a head must change what people can see TODAY without
 *     rewriting what happened LAST MONTH.
 *
 * Why a new `department_members` table instead of extending
 * `team_members`: that table's `employee_id` references `employees(id)`,
 * the vestigial identity layer — on a fresh install `users` created
 * through the API never receive an `employee_record_id`, so membership
 * written there would silently vanish. The live product speaks `users`;
 * this table does too, and the mirror-team sync still best-effort copies
 * into `team_members` whenever an employee record does exist.
 *
 * The "at most one primary head" rule is enforced BY THE DATABASE (partial
 * unique index), not by application discipline — two concurrent saves
 * cannot produce two primary heads.
 *
 * Idempotent: safe on an existing database, and the backfill runs once
 * because it only touches rows that do not exist yet.
 */
export async function up(): Promise<void> {
    // The mirror-team columns live on `teams`; migration 035 adds
    // leader_id/member_ids, but re-asserting them here keeps THIS migration
    // runnable on a database restored from a partial fixture (and in tests
    // that only replay the department/team/user slice). IF NOT EXISTS, so
    // it is a no-op wherever 035 already ran.
    await query(`
        ALTER TABLE teams
          ADD COLUMN IF NOT EXISTS leader_id UUID,
          ADD COLUMN IF NOT EXISTS member_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS department_members (
            department_id UUID NOT NULL,
            user_id UUID NOT NULL,
            -- exactly one primary membership per person (their department);
            -- false marks an additional membership in another department
            is_primary BOOLEAN NOT NULL DEFAULT TRUE,
            -- a head of this department (primary or co-head)
            is_head BOOLEAN NOT NULL DEFAULT FALSE,
            -- THE primary head: at most ONE active per department
            is_primary_head BOOLEAN NOT NULL DEFAULT FALSE,
            joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
            left_at TIMESTAMP,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (department_id, user_id),
            CONSTRAINT fk_department_members_department
                FOREIGN KEY (department_id) REFERENCES departments(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            CONSTRAINT fk_department_members_user
                FOREIGN KEY (user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        );
    `);

    // The locked rule, enforced by the database itself: one active primary
    // head per department. Partial index => historical/inactive rows are
    // free, so a former head's history survives a change of head.
    await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_department_primary_head
        ON department_members(department_id)
        WHERE is_primary_head AND is_active;
    `);

    // One mirror team per department.
    await query(`
        ALTER TABLE teams
          ADD COLUMN IF NOT EXISTS is_department_mirror BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_department_mirror
        ON teams(department_id)
        WHERE is_department_mirror;
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_department_members_user
        ON department_members(user_id);
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_department_members_head
        ON department_members(department_id)
        WHERE is_head AND is_active;
    `);

    // ---- backfill (runs once: only rows that do not exist yet) ----------
    // 1. a mirror team for every existing department
    await query(`
        INSERT INTO teams (team_code, team_name, department_id, description, is_active, is_department_mirror, member_ids, created_at, updated_at)
        SELECT
            ('D_' || UPPER(REPLACE(d.department_code, ' ', '_'))) ,
            d.department_name,
            d.id,
            'Department team (auto-managed)',
            TRUE,
            TRUE,
            '[]'::jsonb,
            NOW(),
            NOW()
        FROM departments d
        WHERE NOT EXISTS (
            SELECT 1 FROM teams t
            WHERE t.department_id = d.id AND t.is_department_mirror
        )
        ON CONFLICT (team_code) DO NOTHING;
    `);

    // 2. every user's primary department becomes a primary membership
    await query(`
        INSERT INTO department_members (department_id, user_id, is_primary, joined_at, is_active, created_at, updated_at)
        SELECT u.department_id, u.id, TRUE, COALESCE(u.created_at, NOW()), TRUE, NOW(), NOW()
        FROM users u
        WHERE u.department_id IS NOT NULL
        ON CONFLICT (department_id, user_id) DO NOTHING;
    `);

    // 3. mirror teams pick up the members/leaders that now exist
    await query(`
        UPDATE teams t
        SET member_ids = COALESCE(m.list, '[]'::jsonb), updated_at = NOW()
        FROM (
            SELECT department_id, jsonb_agg(user_id) AS list
            FROM department_members
            WHERE is_active
            GROUP BY department_id
        ) m
        WHERE t.is_department_mirror AND t.department_id = m.department_id;
    `);

    console.log("✅ 046_department_heads_and_mirror_teams migrated");
}

export async function down(): Promise<void> {
    // Mirror teams are marked, not guessed: only the ones this migration
    // would have created are removed.
    await query(`DELETE FROM teams WHERE is_department_mirror`);
    await query(`DROP TABLE IF EXISTS department_members;`);
    await query(`DROP INDEX IF EXISTS uq_teams_department_mirror;`);
    await query(`ALTER TABLE teams DROP COLUMN IF EXISTS is_department_mirror;`);
}
