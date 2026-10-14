/**
 * runMigrations.ts — ledger-backed, single-writer schema migrations
 * ------------------------------------------------------------------
 * Behavior contract (unchanged): the same migration functions run in the
 * same order and stay idempotent. What changed is the COST of a boot:
 *
 *   before: every boot re-ran all 36 migrations (226 round trips on an
 *           already-current schema — see database/migrationLedger.ts)
 *   after : a current schema costs 2 round trips; only genuinely pending
 *           migrations execute, each recorded the moment it succeeds.
 *
 * Guards added on top:
 *   - a PostgreSQL advisory lock makes concurrent cold starts safe (the
 *     second instance skips instead of racing DDL);
 *   - a pre-existing legacy database is adopted (see tryAdoptLegacySchema)
 *     instead of being replayed;
 *   - the outcome is returned so entrypoints/scripts can log one line.
 */

import { up as departments } from "./migrations/001_departments.js";
import { up as roles } from "./migrations/002_roles.js";
import { up as teams } from "./migrations/003_teams.js";
import { up as users } from "./migrations/004_users.js";
import { up as hierarchies } from "./migrations/005_hierarchies.js";
import { up as metadata } from "./migrations/006_metadata.js";
import { up as options } from "./migrations/007_options.js";
import { up as forms } from "./migrations/008_forms.js";
import { up as workflows } from "./migrations/009_workflows.js";
import { up as notifications } from "./migrations/010_notifications.js";
import { up as products } from "./migrations/011_products.js";
import { up as campaigns } from "./migrations/012_campaigns.js";
import { up as leadStatus } from "./migrations/013_lead_status.js";
import { up as leads } from "./migrations/014_leads.js";
import { up as identityCompatibility } from "./migrations/022_identity_compatibility.js";
import { up as employees } from "./migrations/023_employees.js";
import { up as employeeDepartments } from "./migrations/024_employee_departments.js";
import { up as permissions } from "./migrations/025_permissions.js";
import { up as rolePermissions } from "./migrations/026_role_permissions.js";
import { up as userPermissions } from "./migrations/027_user_permissions.js";
import { up as userVisibility } from "./migrations/028_user_visibility.js";
import { up as teamMembers } from "./migrations/029_team_members.js";
import { up as employeeReporting } from "./migrations/030_employee_reporting.js";
import { up as sessions } from "./migrations/031_sessions.js";
import { up as auditLogs } from "./migrations/032_audit_logs.js";
import { up as territories } from "./migrations/033_territories.js";
import { up as userTerritories } from "./migrations/034_user_territories.js";
import { up as persistenceHarmonization } from "./migrations/035_leadflow_persistence_harmonization.js";
import { up as finePermissions } from "./migrations/036_fine_permissions.js";
import { up as leadActivities } from "./migrations/037_lead_activities.js";
import { up as followupQueueIndexes } from "./migrations/038_followup_queue_indexes.js";
import { up as scheduledActivities } from "./migrations/039_scheduled_activities.js";
import { up as notificationReliability } from "./migrations/040_notification_reliability.js";
import { up as scheduledActivityOpenIndex } from "./migrations/041_scheduled_activity_open_index.js";
import { up as roadshows } from "./migrations/042_roadshows.js";

import {
  loadLedger,
  readAppliedIds,
  recordApplied,
  tryAdoptLegacySchema,
  withMigrationLock,
} from "./migrationLedger.js";

interface Migration {

    /** Stable ledger id — never rename an id that has shipped. */
    id: string;

    name: string;

    run: () => Promise<void>;

}

const migrations: Migration[] = [

    { id: "001_departments", name: "Departments", run: departments },

    { id: "002_roles", name: "Roles", run: roles },

    { id: "003_teams", name: "Teams", run: teams },

    { id: "004_users", name: "Users", run: users },

    { id: "005_hierarchies", name: "Hierarchies", run: hierarchies },

    { id: "006_metadata", name: "Metadata", run: metadata },

    { id: "007_options", name: "Options", run: options },

    { id: "008_forms", name: "Forms", run: forms },

    { id: "009_workflows", name: "Workflows", run: workflows },

    { id: "010_notifications", name: "Notifications", run: notifications },

    { id: "011_products", name: "Products", run: products },

    { id: "012_campaigns", name: "Campaigns", run: campaigns },

    { id: "013_lead_status", name: "Lead Status", run: leadStatus },

    { id: "014_leads", name: "Leads", run: leads },

    { id: "022_identity_compatibility", name: "Identity Compatibility", run: identityCompatibility },

    { id: "023_employees", name: "Employees", run: employees },

    { id: "024_employee_departments", name: "Employee Departments", run: employeeDepartments },

    { id: "025_permissions", name: "Permissions", run: permissions },

    { id: "026_role_permissions", name: "Role Permissions", run: rolePermissions },

    { id: "027_user_permissions", name: "User Permissions", run: userPermissions },

    { id: "028_user_visibility", name: "User Visibility", run: userVisibility },

    { id: "029_team_members", name: "Team Members", run: teamMembers },

    { id: "030_employee_reporting", name: "Employee Reporting", run: employeeReporting },

    { id: "031_sessions", name: "Sessions", run: sessions },

    { id: "032_audit_logs", name: "Audit Logs", run: auditLogs },

    { id: "033_territories", name: "Territories", run: territories },

    { id: "034_user_territories", name: "User Territories", run: userTerritories },

    { id: "035_leadflow_persistence_harmonization", name: "Persistence Harmonization", run: persistenceHarmonization },

    { id: "036_fine_permissions", name: "Fine Permissions", run: finePermissions },

    { id: "037_lead_activities", name: "Lead Activities", run: leadActivities },

    { id: "038_followup_queue_indexes", name: "Follow-up Queue Indexes", run: followupQueueIndexes },

    { id: "039_scheduled_activities", name: "Scheduled Activities", run: scheduledActivities },

    { id: "040_notification_reliability", name: "Notification Reliability", run: notificationReliability },

    { id: "041_scheduled_activity_open_index", name: "Scheduled Activity Open Index", run: scheduledActivityOpenIndex },

    { id: "042_roadshows", name: "Roadshows", run: roadshows },

];

/** Ids of every migration this build knows about (ledger ids, ordered). */
export const MIGRATION_IDS: string[] = migrations.map(m => m.id);

export interface MigrationRunResult {
    /** True when nothing had to be executed (the common, cheap case). */
    upToDate: boolean;
    /** Ids applied in THIS run (empty when up to date or adopted). */
    applied: string[];
    /** True when a legacy database was adopted instead of replayed. */
    adopted: boolean;
    /** True when another instance already held the migration lock. */
    skippedForAnotherWriter: boolean;
    /** Wall-clock duration of the whole call. */
    durationMs: number;
}

/**
 * Apply only the migrations this database has not recorded yet.
 * Idempotent, safe to call at every boot and from a deploy step.
 */
export async function runMigrations(): Promise<MigrationRunResult> {
    const startedAt = Date.now();
    const result: MigrationRunResult = {
        upToDate: false,
        applied: [],
        adopted: false,
        skippedForAnotherWriter: false,
        durationMs: 0,
    };

    // 2 round trips on a current schema: ledger probe + applied-ids read.
    const ledger = await loadLedger();

    if (ledger.createdNow && ledger.applied.size === 0) {
        // First boot with the ledger: adopt an already-current legacy
        // database instead of replaying 226 round trips of DDL.
        result.adopted = await tryAdoptLegacySchema(MIGRATION_IDS);
        if (result.adopted) {
            console.log(
                `✅ Schema ledger adopted ${MIGRATION_IDS.length} existing migrations (no DDL replayed)`
            );
            result.upToDate = true;
            result.durationMs = Date.now() - startedAt;
            return result;
        }
    }

    const pending = migrations.filter(m => !ledger.applied.has(m.id));
    if (pending.length === 0) {
        console.log(`✅ Schema up to date (${migrations.length} migrations recorded)`);
        result.upToDate = true;
        result.durationMs = Date.now() - startedAt;
        return result;
    }

    console.log(`➡️  Applying ${pending.length} pending migration(s)`);

    const locked = await withMigrationLock(async () => {
        // Re-read under the lock: another instance may have applied them
        // between our first read and acquiring the lock.
        const appliedNow = await readAppliedIds();
        const stillPending = pending.filter(m => !appliedNow.has(m.id));
        const appliedHere: string[] = [];

        for (const migration of stillPending) {
            const t0 = Date.now();
            console.log(`➡️ ${migration.name}`);
            await migration.run();
            // Recorded only after success: a failure leaves the migration
            // unrecorded so the next boot retries it.
            await recordApplied(migration.id, Date.now() - t0);
            appliedHere.push(migration.id);
            console.log(`✅ ${migration.name} completed`);
        }
        return appliedHere;
    });

    if (locked.outcome === "busy") {
        console.log("ℹ️  Another instance is migrating this database — skipping this boot's DDL");
        result.skippedForAnotherWriter = true;
    } else {
        result.applied = locked.result || [];
        result.upToDate = result.applied.length === 0;
    }

    result.durationMs = Date.now() - startedAt;
    if (result.applied.length) {
        console.log(`✅ All Database Migrations Completed (${result.applied.length} applied)`);
    }
    return result;
}
