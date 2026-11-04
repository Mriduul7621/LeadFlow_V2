import { query } from "../connection.js";

/**
 * 049 — register the Lead Auto-Assignment feature switch (Phase 3 PR #1).
 * ------------------------------------------------------------------
 * The switch is a Metadata Engine option, like every other admin
 * toggle in this app:
 *
 *   metadata_types: key 'LeadAutoAssignment' (registry row, system)
 *   options: ('LeadAutoAssignment', 'enabled') with is_active = switch
 *
 * It is seeded INACTIVE: auto-assignment is OFF until an administrator
 * deliberately turns it on (Settings → Overview → Lead Auto-Assignment,
 * or the Metadata/options admin API). With the switch off — or the row
 * missing entirely (e.g. a legacy database adopted by the migration
 * ledger) — the lead write paths behave exactly as they did before
 * this feature existed; `AutoAssignmentService` fails closed to OFF.
 *
 * Effect when ON: a lead that arrives with no assignee (single create
 * with no `assignedTo`, or a bulk-import row with a blank "Assigned
 * To") is routed at arrival to the least-loaded ACTIVE member of the
 * creator's assignment scope (the caller's Data Visibility set — the
 * same people a manual assignment by that caller could target).
 * Explicitly assigned leads are never touched.
 *
 * Idempotent: both inserts are no-ops when the rows already exist, so
 * an admin's later toggle state is never reset by a re-run.
 */
export async function up(): Promise<void> {
  await query(
    `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
     SELECT 'LeadAutoAssignment',
            'Lead Auto-Assignment',
            'Feature switch: route leads that arrive with no assignee to the least-loaded active member of the creator''s team.',
            TRUE,
            COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
      WHERE NOT EXISTS (
        SELECT 1 FROM metadata_types WHERE key = 'LeadAutoAssignment'
      )`
  );

  await query(
    `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
     SELECT 'LeadAutoAssignment',
            'enabled',
            'Auto-assign unassigned leads',
            1,
            FALSE,
            FALSE,
            '{"featureFlag":true,"rule":"least_loaded"}'::jsonb,
            NOW(),
            NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM options
         WHERE field_key = 'LeadAutoAssignment' AND option_value = 'enabled'
      )`
  );

  console.log("✅ 049_lead_auto_assignment_flag migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — the switch row (and the admin's chosen state) remains.
  console.log("ℹ️ 049 down() is a no-op to protect the admin's switch state.");
}
