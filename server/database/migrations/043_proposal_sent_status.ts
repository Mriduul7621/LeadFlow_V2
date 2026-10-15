import { query } from "../connection.js";

/**
 * 043 — make the canonical lead-status dictionary complete; add "Proposal Sent".
 *
 * The mobile Update Lead flow (agent tracking) needs a distinct stage for
 * "proposal has been sent to the prospect" — between Meeting/Follow-up and
 * Converted — with its own capture (product, sum assured, projected FYCP).
 * Statuses are validated server-side against active FollowUpStatus options,
 * so the option must exist before the status can ever be persisted.
 *
 * Every canonical status is inserted idempotently (WHERE NOT EXISTS per
 * row). Existing deployments already have the other statuses, so only
 * "Proposal Sent" lands; brand-new installs get the full initial dictionary
 * from this migration as well, which keeps later seeds from being skipped
 * by an early options-row presence check.
 */
export async function up(): Promise<void> {
    const statuses: Array<[string, number]> = [
        ["Untouched", 10],
        ["Contacted", 20],
        ["No Response", 30],
        ["Busy", 40],
        ["Interested", 50],
        ["Follow-up Set", 60],
        ["Meeting Fixed", 70],
        ["Meeting Completed", 80],
        ["Proposal Sent", 85],
        ["Pipeline Locked", 90],
        ["Converted", 100],
        ["Not Interested", 110],
    ];
    for (const [value, sortOrder] of statuses) {
        await query(
            `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active)
             SELECT 'FollowUpStatus', $1::varchar, $1::varchar, $2, FALSE, TRUE
             WHERE NOT EXISTS (
                 SELECT 1 FROM options
                 WHERE field_key = 'FollowUpStatus' AND option_value = $1::varchar
             );`,
            [value, sortOrder]
        );
    }
}
