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

];

export async function runMigrations(): Promise<void> {

    console.log("========================================");
    console.log("🚀 Running Database Migrations");
    console.log("========================================");

    for (const migration of migrations) {

        console.log(`➡️ ${migration.name}`);

        await migration.run();

        console.log(`✅ ${migration.name} completed`);

    }

    console.log("========================================");
    console.log("✅ All Database Migrations Completed");
    console.log("========================================");

}