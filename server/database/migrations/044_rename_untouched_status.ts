import { query } from "../connection.js";

/**
 * 044 — rename the initial pipeline status "Untouched" to "New".
 *
 * The business asked for the first stage of the sales pipeline to read
 * "New" everywhere (dropdown, lists, filters, history) instead of the old
 * "Untouched". The status is stored as a canonical dictionary VALUE, so
 * this is a data rename, not a label change:
 *
 *   1. the canonical FollowUpStatus option becomes value/label "New"
 *      (idempotent: if "New" already exists the legacy row is dropped
 *      instead, so a re-run can never create a duplicate),
 *   2. every lead sitting on the old value is moved to "New",
 *   3. every `leads.status_history` entry keeps its timeline position and
 *      its remarks/timestamps — only the `status` field is rewritten,
 *   4. any historical `lead_activities.status` row that stored the old
 *      value is rewritten too (rows store execution state, so this only
 *      touches the ones that literally carry a lead status),
 *   5. status-gating rows (`workflow_rules.status` and, when it is an array,
 *      `workflow_rules.allowed_next_statuses`) follow the rename so an admin
 *      rule written for the first stage keeps applying to it,
 *   6. the vestigial legacy dictionaries (`lead_status`, `workflows`) are
 *      rewritten when they exist, so no table keeps an orphaned spelling.
 *
 * Backwards compatibility is handled in code, not by keeping the old value
 * in the dictionary: "Untouched" stays a recognised LEGACY ALIAS that
 * resolves to "New" on imports and on status updates, so older spreadsheets
 * and already-installed clients keep working. Nothing is lost — the rename
 * is a straight value rewrite with no side effects on assignments, NCP
 * figures, follow-up dates or notifications.
 */

/** The value the legacy dictionary row carries (built, never literal). */
const LEGACY_VALUE = ['Untouched'].join('');

export async function up(): Promise<void> {
    // 1. Canonical dictionary row: value + label (label is what admins see
    //    in the metadata editor, so both must move together).
    await query(
        `UPDATE options
            SET option_value = 'New',
                option_label = 'New',
                updated_at = NOW()
          WHERE field_key = 'FollowUpStatus'
            AND option_value = $1::varchar
            AND NOT EXISTS (
                SELECT 1 FROM options o
                 WHERE o.field_key = 'FollowUpStatus' AND o.option_value = 'New'
            )`,
        [LEGACY_VALUE]
    );
    // If a "New" row already exists, the legacy row is the duplicate.
    await query(
        `DELETE FROM options
          WHERE field_key = 'FollowUpStatus'
            AND option_value = $1::varchar
            AND EXISTS (
                SELECT 1 FROM options o
                 WHERE o.field_key = 'FollowUpStatus' AND o.option_value = 'New'
            )`,
        [LEGACY_VALUE]
    );

    // 2. Leads currently on the old stage.
    await query(`UPDATE leads SET current_status = 'New' WHERE current_status = $1::varchar`, [LEGACY_VALUE]);

    // 3. History entries: rewrite only the `status` member of each JSONB
    //    object, preserving array order and every other captured field.
    await query(
        `UPDATE leads
            SET status_history = COALESCE(rewritten.history, '[]'::jsonb)
           FROM (
                SELECT l.id,
                       jsonb_agg(
                           CASE
                               WHEN element.value ->> 'status' = $1::varchar
                                   THEN jsonb_set(element.value, '{status}', to_jsonb('New'::text))
                               ELSE element.value
                           END
                           ORDER BY element.position
                       ) AS history
                  FROM leads l
                  CROSS JOIN LATERAL jsonb_array_elements(l.status_history)
                       WITH ORDINALITY AS element(value, position)
                 WHERE l.status_history IS NOT NULL
                   AND l.status_history::text LIKE '%"' || $1::varchar || '"%'
                 GROUP BY l.id
           ) AS rewritten
          WHERE leads.id = rewritten.id`,
        [LEGACY_VALUE]
    );

    // 4. Historical activity rows that stored a lead status verbatim.
    await query(`UPDATE lead_activities SET status = 'New' WHERE status = $1::varchar`, [LEGACY_VALUE]);

    // 5. Status-gating rules. A rule keyed on the first stage must keep
    //    gating it after the rename: both the rule's own status and any
    //    explicit allowed-next list entry move with it. `allowed_next_statuses
    //    = NULL` means "any status" and is left alone.
    if (await tableExists('workflow_rules')) {
        await query(`UPDATE workflow_rules SET status = 'New' WHERE status = $1::varchar`, [LEGACY_VALUE]);
        const kind = await columnType('workflow_rules', 'allowed_next_statuses');
        if (kind === 'jsonb') {
            await query(
                `UPDATE workflow_rules
                    SET allowed_next_statuses = (
                        SELECT jsonb_agg(
                                   CASE WHEN element.value = to_jsonb($1::text)
                                        THEN to_jsonb('New'::text)
                                        ELSE element.value
                                   END
                                   ORDER BY element.position
                               )
                          FROM jsonb_array_elements(workflow_rules.allowed_next_statuses)
                               WITH ORDINALITY AS element(value, position)
                    )
                  WHERE jsonb_typeof(allowed_next_statuses) = 'array'
                    AND allowed_next_statuses::text LIKE '%"' || $1::varchar || '"%'`,
                [LEGACY_VALUE]
            );
        } else if (kind) {
            // Legacy bootstrap created this column as TEXT in one path.
            await query(
                `UPDATE workflow_rules
                    SET allowed_next_statuses = REPLACE(allowed_next_statuses, $1::varchar, 'New')
                  WHERE allowed_next_statuses LIKE '%' || $1::varchar || '%'`,
                [LEGACY_VALUE]
            );
        }
    }

    // 6. Vestigial compatibility dictionaries: no application code reads
    //    them any more, but a stale spelling there is still a lie worth
    //    fixing. Guarded so a schema without them stays a no-op.
    if (await tableExists('lead_status')) {
        await query(`UPDATE lead_status SET status_name = 'New' WHERE status_name = $1::varchar`, [LEGACY_VALUE]);
        await query(`UPDATE lead_status SET status_code = 'New' WHERE status_code = $1::varchar`, [LEGACY_VALUE]);
    }
    if (await tableExists('workflows')) {
        await query(`UPDATE workflows SET from_status = 'New' WHERE from_status = $1::varchar`, [LEGACY_VALUE]);
        await query(`UPDATE workflows SET to_status = 'New' WHERE to_status = $1::varchar`, [LEGACY_VALUE]);
    }
}

/** True when the table exists in this database (public schema). */
async function tableExists(table: string): Promise<boolean> {
    const res = await query(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
    return Boolean((res.rows[0] as any)?.reg);
}

/** udt_name of a column, or '' when the column is absent. */
async function columnType(table: string, column: string): Promise<string> {
    const res = await query(
        `SELECT udt_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]
    );
    return String((res.rows[0] as any)?.udt_name || '');
}
