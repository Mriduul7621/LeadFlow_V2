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
import { up as dataIntegrityGuards } from "./migrations/042_data_integrity_guards.js";

interface Migration {

    name: string;

    run: () => Promise<void>;

}

const migrations: Migration[] = [

    {
        name: "Departments",
        run: departments,
    },

    {
        name: "Roles",
        run: roles,
    },

    {
        name: "Teams",
        run: teams,
    },

    {
        name: "Users",
        run: users,
    },

    {
        name: "Hierarchies",
        run: hierarchies,
    },

    {
        name: "Metadata",
        run: metadata,
    },

    {
        name: "Options",
        run: options,
    },

    {
        name: "Forms",
        run: forms,
    },

    {
        name: "Workflows",
        run: workflows,
    },

    {
        name: "Notifications",
        run: notifications,
    },

    {
        name: "Products",
        run: products,
    },

    {
        name: "Campaigns",
        run: campaigns,
    },

    {
        name: "Lead Status",
        run: leadStatus,
    },

    {
        name: "Leads",
        run: leads,
    },

    {
        name: "Identity Compatibility",
        run: identityCompatibility,
    },

    {
        name: "Employees",
        run: employees,
    },

    {
        name: "Employee Departments",
        run: employeeDepartments,
    },

    {
        name: "Permissions",
        run: permissions,
    },

    {
        name: "Role Permissions",
        run: rolePermissions,
    },

    {
        name: "User Permissions",
        run: userPermissions,
    },

    {
        name: "User Visibility",
        run: userVisibility,
    },

    {
        name: "Team Members",
        run: teamMembers,
    },

    {
        name: "Employee Reporting",
        run: employeeReporting,
    },

    {
        name: "Sessions",
        run: sessions,
    },

    {
        name: "Audit Logs",
        run: auditLogs,
    },

    {
        name: "Territories",
        run: territories,
    },

    {
        name: "User Territories",
        run: userTerritories,
    },

    {
        name: "LeadFlow Persistence Harmonization",
        run: persistenceHarmonization,
    },

    {
        name: "Fine Permissions",
        run: finePermissions,
    },

    {
        name: "Lead Activities",
        run: leadActivities,
    },

    {
        name: "Follow-up Queue Indexes",
        run: followupQueueIndexes,
    },

    {
        name: "Scheduled Activities",
        run: scheduledActivities,
    },

    {
        name: "Notification Reliability",
        run: notificationReliability,
    },

    {
        name: "Scheduled Activity Open Index",
        run: scheduledActivityOpenIndex,
    },

    {
        name: "Data Integrity Guards",
        run: dataIntegrityGuards,
    },

];

/**
 * Migration run summary — the cheap, safe visibility improvement from the
 * reliability audit (docs/DATA_INTEGRITY_AND_RECOVERY.md §9).
 *
 * The runner is intentionally NOT a versioned ledger: every migration is
 * idempotent DDL (IF NOT EXISTS / ON CONFLICT DO NOTHING) and the whole
 * list re-runs on every cold start. That design is preserved. What was
 * missing was a process-local record of WHAT happened on the last run, so
 * a partial failure could be told apart from "never ran" without grepping
 * logs. The summary lives in memory only (never written to the database,
 * never exposed as a public endpoint) and is safe to log: it contains
 * migration names, counts and a sanitized error message — no SQL text,
 * no connection details, no row data.
 */
export interface MigrationRunSummary {
    /** 'never' before the first attempt in this process. */
    status: "never" | "running" | "completed" | "failed";
    /** Total migrations in the fixed list. */
    total: number;
    /** Migrations that completed in the most recent run (in order). */
    completed: string[];
    /** Migration that threw in the most recent run, if any. */
    failedAt: string | null;
    /** Sanitized error message (first line only, capped) or null. */
    error: string | null;
    /** ISO timestamps of the most recent run boundaries. */
    startedAt: string | null;
    finishedAt: string | null;
}

let lastRun: MigrationRunSummary = {
    status: "never",
    total: migrations.length,
    completed: [],
    failedAt: null,
    error: null,
    startedAt: null,
    finishedAt: null,
};

/** Read-only snapshot of the most recent migration run in this process. */
export function getLastMigrationRunSummary(): MigrationRunSummary {
    return { ...lastRun, completed: [...lastRun.completed] };
}

/** Names of the fixed migration list (for tooling/tests; no side effects). */
export function listMigrationNames(): string[] {
    return migrations.map((m) => m.name);
}

/** One-line, secret-free description for startup logs. */
export function describeMigrationRun(summary: MigrationRunSummary = lastRun): string {
    const base = `migrations=${summary.status} completed=${summary.completed.length}/${summary.total}`;
    if (summary.status === "failed") {
        return `${base} failedAt=${summary.failedAt || "unknown"} error=${summary.error || "unknown"}`;
    }
    return base;
}

function sanitizeMigrationError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? "unknown error");
    // First line only, no connection strings, capped length.
    return raw
        .split(/\r?\n/)[0]
        .replace(/postgres(ql)?:\/\/\S+/gi, "postgres://[redacted]")
        .slice(0, 300);
}

export async function runMigrations(): Promise<void> {

    console.log("========================================");
    console.log("🚀 Running Database Migrations");
    console.log("========================================");

    lastRun = {
        status: "running",
        total: migrations.length,
        completed: [],
        failedAt: null,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
    };

    for (const migration of migrations) {

        console.log(`➡️ ${migration.name}`);

        try {
            await migration.run();
        } catch (error) {
            // Failure marker: record WHICH migration failed and how far the
            // run got, then rethrow unchanged so startup behaviour is exactly
            // as before (initializeDatabase() rejects; requests get 503).
            lastRun = {
                ...lastRun,
                status: "failed",
                failedAt: migration.name,
                error: sanitizeMigrationError(error),
                finishedAt: new Date().toISOString(),
            };
            console.error(`❌ Migration failed: ${describeMigrationRun(lastRun)}`);
            throw error;
        }

        lastRun.completed.push(migration.name);
        console.log(`✅ ${migration.name} completed`);

    }

    lastRun = { ...lastRun, status: "completed", finishedAt: new Date().toISOString() };

    console.log("========================================");
    console.log(`✅ All Database Migrations Completed (${describeMigrationRun(lastRun)})`);
    console.log("========================================");

}