import { seedRoles } from "./seeds/roles.seed.js";
import { seedMetadata } from "./seeds/metadata.seed.js";
import { seedWorkflow } from "./seeds/workflow.seed.js";
import { seedLeadStatus } from "./seeds/status.seed.js";
import { seedFormBuilder } from "./seeds/form.seed.js";

export async function runSeeds(): Promise<void> {

    console.log("========================================");
    console.log("🌱 Running Database Seeds");
    console.log("========================================");

    await seedRoles();

    await seedMetadata();

    await seedWorkflow();

    await seedLeadStatus();

    await seedFormBuilder();

    console.log("========================================");
    console.log("✅ All Seeds Completed");
    console.log("========================================");

}