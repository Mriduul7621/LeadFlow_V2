import { query } from "../connection.js";
import { recomputeReportingChains } from "../reportingChains.js";

/**
 * 053 — one-time repair of reporting chains left stale by user
 * deletes (organogram fix 3 of 3).
 * ------------------------------------------------------------------
 * Before this fix, DELETE /api/users/:id never recomputed the
 * reporting tree (the edit path always did). The manager_id foreign
 * key (ON DELETE SET NULL) quietly nulled the deleted person's
 * reports, and the DERIVED columns kept the ghost:
 *
 *   - reports' reporting_chain still named the deleted employee —
 *     and because resolveUplineRecipients (SLA escalation) PREFERS
 *     the stored chain, the dead level was silently skipped;
 *   - the deleted employee kept appearing in their former manager's
 *     subordinates, the downline source for data visibility;
 *   - hierarchies sync rows kept stale paths.
 *
 * reporting_chain / subordinates / hierarchies are DERIVED data — a
 * pure function of users.manager_id — so the repair is simply to run
 * the same server-authoritative recompute every create / edit /
 * delete now runs (database/reportingChains.ts, shared verbatim).
 * It rewrites ONLY derived columns from the current manager_id
 * links; it never invents or rewrites a source manager_id link
 * (reports whose manager was deleted in the past stay manager-less
 * in the source column — an admin re-points them in the UI; their
 * derived chains are rebuilt consistently with that reality).
 *
 * Idempotent by construction: the recompute is a pure derivation,
 * so a re-run produces the same values. down() is a deliberate
 * no-op — the pre-repair values were wrong by definition, and
 * restoring them would re-break the chains.
 *
 * Guarded like migration 052: on a schema too old to carry the
 * derived columns (or the hierarchies table) the repair skips —
 * such a database has no derived chains to repair.
 */

async function hasDerivedChainColumns(): Promise<boolean> {
    const result = await query<{ ok: boolean }>(
        `SELECT (
             EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'users' AND column_name = 'reporting_chain')
             AND EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'users' AND column_name = 'subordinates')
             AND EXISTS (SELECT 1 FROM information_schema.tables
                      WHERE table_name = 'hierarchies')
         ) AS ok`
    );
    return Boolean(result.rows[0]?.ok);
}

export async function up(): Promise<void> {
    if (!(await hasDerivedChainColumns())) {
        console.log("⏭️  053_delete_chain_repair skipped (derived chain columns not present)");
        return;
    }
    await recomputeReportingChains({ query });
    console.log("✅ 053_delete_chain_repair migrated");
}

export async function down(): Promise<void> {
    // No-op by design: this migration repairs derived data; there is
    // no earlier derived state worth restoring.
    console.log("↩️  053_delete_chain_repair reverted (no-op: derived-data repair)");
}
