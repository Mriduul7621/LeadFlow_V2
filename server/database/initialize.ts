import { checkDatabaseHealth } from "./connection.js";
import { runMigrations, type MigrationRunResult } from "./runMigrations.js";
import { runSeeds, type SeedRunResult } from "./runSeeds.js";

export interface InitializeOptions {
    /** Skip the migration step (e.g. a deploy step already migrated). */
    skipMigrations?: boolean;
    /** Skip the seed step (e.g. a deploy step already seeded). */
    skipSeeds?: boolean;
}

export interface InitializeResult {
    healthy: boolean;
    migrations: MigrationRunResult | null;
    seeds: SeedRunResult | null;
    /** True when every step was a no-op (current schema, seeded). */
    noOp: boolean;
    durationMs: number;
}

/**
 * Read the runtime-migration policy.
 *
 *   LEADFLOW_RUNTIME_MIGRATIONS=auto (default)
 *       Ensure the schema at boot. Cost is small and bounded: the ledger
 *       makes a current schema a 2-round-trip check, so this is the safe
 *       default for every runtime (Vercel serverless, Docker, dev).
 *
 *   LEADFLOW_RUNTIME_MIGRATIONS=off
 *       Never touch DDL at boot; assume the deploy step ran
 *       `npm run migrate:production`. The boot still verifies the schema
 *       version and logs loudly when migrations are pending, so the
 *       deployment cannot silently run against a stale schema.
 */
export function resolveRuntimeMigrationMode(env: NodeJS.ProcessEnv = process.env): "auto" | "off" {
    return String(env.LEADFLOW_RUNTIME_MIGRATIONS || "").trim().toLowerCase() === "off" ? "off" : "auto";
}

/**
 * Bring the database to a usable state: reachable + schema current +
 * baseline reference data seeded.
 *
 * Every step is idempotent and cheap when already done (see
 * database/migrationLedger.ts for the measured before/after cost).
 */
export async function initializeDatabase(
    options: InitializeOptions = {}
): Promise<InitializeResult> {
    const startedAt = Date.now();
    const skipMigrations = options.skipMigrations ?? resolveRuntimeMigrationMode() === "off";

    console.log("========================================");
    console.log("🚀 Initializing LeadFlow Database");
    console.log("========================================");

    const healthy = await checkDatabaseHealth();

    if (!healthy) {

        throw new Error("Database connection failed.");

    }

    const migrations = skipMigrations ? null : await runMigrations();

    const seeds = options.skipSeeds ? null : await runSeeds();

    const noOp = migrations !== null && migrations.upToDate && seeds !== null && seeds.skipped;

    console.log("========================================");
    console.log("✅ Database Initialization Completed");
    console.log("========================================");

    return { healthy, migrations, seeds, noOp, durationMs: Date.now() - startedAt };
}
