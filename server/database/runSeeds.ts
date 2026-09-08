import { seedRoles } from "./seeds/roles.seed";
import { seedMetadata } from "./seeds/metadata.seed";
import { seedWorkflow } from "./seeds/workflow.seed";
import { seedLeadStatus } from "./seeds/status.seed";
import { seedFormBuilder } from "./seeds/form.seed";

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