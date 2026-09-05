import { checkDatabaseHealth } from "./connection";
import { runMigrations } from "./runMigrations";
import { runSeeds } from "./runSeeds";

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