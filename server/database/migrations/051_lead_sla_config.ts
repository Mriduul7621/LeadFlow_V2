import { query } from "../connection.js";

/**
 * 051 — register the First-Contact SLA configuration (Phase 3 PR #3).
 * ------------------------------------------------------------------
 * Like every other admin feature switch in this app, the SLA config
 * lives in the Metadata Engine:
 *
 *   metadata_types: key 'LeadSla' (registry row, system)
 *   options: ('LeadSla', 'enabled')           is_active = the switch
 *            ('LeadSla', 'firstContactHours') meta.hours = the window
 *
 * The switch is seeded INACTIVE: SLA badges, breach alerts and the
 * push-summary breach line are all OFF until an administrator turns
 * the feature on (Settings → Overview → First-Contact SLA, or the
 * Metadata/options admin API). With the switch off — or the rows
 * missing entirely (e.g. a legacy database adopted by the migration
 * ledger) — every surface behaves exactly as before this feature;
 * `LeadSlaService` fails closed to OFF with the 24h default.
 *
 * The window row is seeded ACTIVE with meta {"hours": 24}: it is a
 * value row, not a switch, so its is_active carries no meaning for
 * the feature gate (only 'enabled' gates).
 *
 * Idempotent: both inserts are no-ops when the rows already exist, so
 * an admin's later toggle/window state is never reset by a re-run.
 */
export async function up(): Promise<void> {
  await query(
    `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
     SELECT 'LeadSla',
            'Lead First-Contact SLA',
            'Feature switch + window: a newly assigned lead with no recorded first contact inside the window is flagged, alerted and escalated.',
            TRUE,
            COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
      WHERE NOT EXISTS (
        SELECT 1 FROM metadata_types WHERE key = 'LeadSla'
      )`
  );

  await query(
    `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
     SELECT 'LeadSla',
            'enabled',
            'First-contact SLA tracking',
            1,
            FALSE,
            FALSE,
            '{"featureFlag":true}'::jsonb,
            NOW(),
            NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM options
         WHERE field_key = 'LeadSla' AND option_value = 'enabled'
      )`
  );

  await query(
    `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
     SELECT 'LeadSla',
            'firstContactHours',
            'First-contact window (hours)',
            2,
            FALSE,
            TRUE,
            '{"hours":24}'::jsonb,
            NOW(),
            NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM options
         WHERE field_key = 'LeadSla' AND option_value = 'firstContactHours'
      )`
  );

  console.log("✅ 051_lead_sla_config migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — the config rows (and the admin's chosen state) remain.
  console.log("ℹ️ 051 down() is a no-op to protect the admin's SLA configuration.");
}
