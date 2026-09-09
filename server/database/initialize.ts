import { checkDatabaseHealth } from "./connection.js";
import { runMigrations } from "./runMigrations.js";
import { runSeeds } from "./runSeeds.js";

export async function initializeDatabase(): Promise<void> {

    console.log("========================================");
    console.log("🚀 Initializing LeadFlow Database");
    console.log("========================================");

    const healthy = await checkDatabaseHealth();

    if (!healthy) {

        throw new Error("Database connection failed.");

    }

    await runMigrations();

    await runSeeds();

    console.log("========================================");
    console.log("✅ Database Initialization Completed");
    console.log("========================================");

}