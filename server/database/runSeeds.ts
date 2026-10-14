/**
 * runSeeds.ts — one-time baseline seeds, ledger-gated
 * ------------------------------------------------------------------
 * The seed routines themselves are unchanged and still self-guard (they
 * count rows before inserting). What changed is that a process boot no
 * longer pays for that check on every cold start: the first successful
 * seed run is recorded in the schema ledger, and later boots skip the
 * whole step with ZERO round trips.
 *
 * Set LEADFLOW_FORCE_SEEDS=1 to re-run the (idempotent) seed routines on
 * purpose — e.g. after restoring an empty database.
 */

import { seedRoles } from "./seeds/roles.seed.js";
import { seedMetadata } from "./seeds/metadata.seed.js";
import { seedWorkflow } from "./seeds/workflow.seed.js";
import { seedLeadStatus } from "./seeds/status.seed.js";
import { seedFormBuilder } from "./seeds/form.seed.js";
import { SEED_LEDGER_MARKER, readAppliedIds, recordApplied } from "./migrationLedger.js";

export interface SeedRunResult {
    /** True when the baseline seed marker was already present. */
    skipped: boolean;
    durationMs: number;
}

export async function runSeeds(): Promise<SeedRunResult> {
    const startedAt = Date.now();

    const forced = String(process.env.LEADFLOW_FORCE_SEEDS || "").trim() === "1";
    if (!forced) {
        try {
            const applied = await readAppliedIds();
            if (applied.has(SEED_LEDGER_MARKER)) {
                console.log("✅ Baseline seeds already applied (skipped)");
                return { skipped: true, durationMs: Date.now() - startedAt };
            }
        } catch {
            // Fall through: if the ledger is unreadable we still seed the
            // old way, because each seed routine is idempotent.
        }
    }

    console.log("========================================");
    console.log("🌱 Running Database Seeds");
    console.log("========================================");

    await seedRoles();

    await seedMetadata();

    await seedWorkflow();

    await seedLeadStatus();

    await seedFormBuilder();

    // Marked only after every routine returned successfully.
    try {
        await recordApplied(SEED_LEDGER_MARKER, Date.now() - startedAt);
    } catch {
        // A ledger write failure must not fail the boot: the seeds are
        // idempotent and would simply re-run (self-guarded) next time.
    }

    console.log("========================================");
    console.log("✅ All Seeds Completed");
    console.log("========================================");

    return { skipped: false, durationMs: Date.now() - startedAt };
}
