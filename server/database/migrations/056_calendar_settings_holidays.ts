import { query } from "../connection.js";

/**
 * 056 — Calendar Settings: configurable weekend + BD government
 * holidays (LeadFlow calendar upgrade, PR C).
 * ------------------------------------------------------------------
 * Mahadi's requirement: the weekend is Friday + Saturday by default
 * but must be changeable from Calendar Settings, and the Bangladesh
 * government holidays must arrive PRE-SEEDED — editable by an admin
 * whenever the government changes them.
 *
 * Two stores, both following patterns this codebase already uses:
 *
 *   1. Weekend config — the Metadata Engine, exactly like the
 *      LeadSla (051) and LeadAutoAssignment (049) feature config:
 *        metadata_types: key 'Calendar' (registry row, system)
 *        options: ('Calendar', 'weekendDays') — a VALUE row (not a
 *        switch; is_active carries no gating meaning), meta.days is
 *        the array of JS weekday numbers (Sun=0 … Sat=6). Seeded
 *        [5, 6] (Fri, Sat) ONLY when the row is absent — an admin's
 *        later change is never reset by a re-run.
 *
 *   2. Holidays — a dedicated table `calendar_holidays`, one row per
 *      holiday DAY (multi-day festivals are expanded per day):
 *        UNIQUE (holiday_date, name) — the dedupe key is (date,
 *        name), NEVER date alone: 2026-03-20 legitimately carries
 *        both Jumatul Wida and the Eid-ul-Fitr day-before entry, as
 *        do 2026-05-01 and 2027-05-20. The seed insert is
 *        ON CONFLICT (holiday_date, name) DO NOTHING, so re-running
 *        this migration (or a boot that replays it) can never
 *        duplicate a row.
 *
 * SEED PROVENANCE: Ministry of Public Administration (MoPA) gazette
 * holiday notifications — 2026 issued 9 Nov 2025 (28 days: 14
 * General + 14 Executive Order) and 2027 issued 5 Nov 2026, memo
 * 05.00.0000.175.08.0008.25-105 (29 days: 15 General + 14 Executive
 * Order) — as verified in
 * goals/leadflow-v2-production-review/files/calendar/bd-govt-holidays-seed.md
 * (every row cross-checked across ≥3 national reports reproducing
 * the notification; optional religious holidays and bank-only
 * holidays deliberately excluded). `moon_dependent` rows follow the
 * gazette's `*` convention (dates may shift on moon sighting — the
 * admin can edit them in Calendar Settings). `regional` marks the
 * Chaitra Sankranti rows that apply only to Rangamati,
 * Khagrachhari & Bandarban.
 *
 * Idempotent throughout. down() is a deliberate non-destructive
 * no-op: the holidays and the admin's weekend choice are real
 * configuration data the moment this ships.
 */
export async function up(): Promise<void> {
  // ---- 1. Weekend config (Metadata Engine, seeded only if absent)
  await query(
    `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
     SELECT 'Calendar',
            'Calendar Settings',
            'Workspace calendar configuration: weekend days (options row weekendDays, meta.days) and government holidays (calendar_holidays table).',
            TRUE,
            COALESCE((SELECT MAX(sort_order) FROM metadata_types), 0) + 1
      WHERE NOT EXISTS (
        SELECT 1 FROM metadata_types WHERE key = 'Calendar'
      )`
  );

  await query(
    `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
     SELECT 'Calendar',
            'weekendDays',
            'Weekend days',
            1,
            FALSE,
            TRUE,
            '{"days":[5,6]}'::jsonb,
            NOW(),
            NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM options
         WHERE field_key = 'Calendar' AND option_value = 'weekendDays'
      )`
  );

  // ---- 2. Holidays table
  await query(`
    CREATE TABLE IF NOT EXISTS calendar_holidays (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      holiday_date DATE NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(20) NOT NULL DEFAULT 'general'
        CHECK (category IN ('general', 'executive')),
      moon_dependent BOOLEAN NOT NULL DEFAULT FALSE,
      regional BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (holiday_date, name)
    )
  `);

  // For a table adopted from an earlier shape, make sure the unique
  // index the seed's ON CONFLICT relies on exists.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_holidays_date_name
    ON calendar_holidays (holiday_date, name)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_calendar_holidays_date
    ON calendar_holidays (holiday_date)
  `);

  // ---- 3. Seed: MoPA gazette 2026 (28) + 2027 (29) = 57 rows.
  await query(`
    INSERT INTO calendar_holidays (holiday_date, name, category, moon_dependent, regional, note)
    VALUES
    ('2026-02-04', 'Shab-e-Barat', 'executive', TRUE, FALSE, NULL),
    ('2026-02-21', 'Shaheed Day and International Mother Language Day', 'general', FALSE, FALSE, NULL),
    ('2026-03-17', 'Shab-e-Qadr', 'executive', TRUE, FALSE, NULL),
    ('2026-03-19', 'Eid-ul-Fitr holiday (2 days before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-03-20', 'Jumatul Wida', 'general', TRUE, FALSE, NULL),
    ('2026-03-20', 'Eid-ul-Fitr holiday (day before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-03-21', 'Eid-ul-Fitr', 'general', TRUE, FALSE, NULL),
    ('2026-03-22', 'Eid-ul-Fitr holiday (day after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-03-23', 'Eid-ul-Fitr holiday (2 days after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-03-26', 'Independence and National Day', 'general', FALSE, FALSE, NULL),
    ('2026-04-13', 'Chaitra Sankranti (hill districts only)', 'general', FALSE, TRUE, 'Hill districts only: Rangamati, Khagrachhari & Bandarban'),
    ('2026-04-14', 'Bengali New Year', 'executive', FALSE, FALSE, NULL),
    ('2026-05-01', 'May Day', 'general', FALSE, FALSE, NULL),
    ('2026-05-01', 'Buddha Purnima (Baishakhi Purnima)', 'general', TRUE, FALSE, NULL),
    ('2026-05-26', 'Eid-ul-Azha holiday (2 days before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-05-27', 'Eid-ul-Azha holiday (day before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-05-28', 'Eid-ul-Azha', 'general', TRUE, FALSE, NULL),
    ('2026-05-29', 'Eid-ul-Azha holiday (day after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-05-30', 'Eid-ul-Azha holiday (2 days after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-05-31', 'Eid-ul-Azha holiday (3 days after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2026-06-26', 'Ashura', 'executive', TRUE, FALSE, NULL),
    ('2026-08-05', 'July Mass Uprising Day', 'general', FALSE, FALSE, NULL),
    ('2026-08-26', 'Eid-e-Milad-un-Nabi (SAW)', 'general', TRUE, FALSE, NULL),
    ('2026-09-04', 'Janmashtami', 'general', FALSE, FALSE, NULL),
    ('2026-10-20', 'Durga Puja (Mahanabami)', 'executive', FALSE, FALSE, NULL),
    ('2026-10-21', 'Durga Puja (Vijaya Dashami)', 'general', FALSE, FALSE, NULL),
    ('2026-12-16', 'Victory Day', 'general', FALSE, FALSE, NULL),
    ('2026-12-25', 'Christmas Day', 'general', FALSE, FALSE, NULL),
    ('2027-01-24', 'Shab-e-Barat', 'executive', TRUE, FALSE, NULL),
    ('2027-02-21', 'Shaheed Day and International Mother Language Day', 'general', FALSE, FALSE, NULL),
    ('2027-03-05', 'Jumatul Wida', 'general', TRUE, FALSE, NULL),
    ('2027-03-07', 'Shab-e-Qadr', 'executive', TRUE, FALSE, NULL),
    ('2027-03-08', 'Eid-ul-Fitr holiday (2 days before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-03-09', 'Eid-ul-Fitr holiday (day before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-03-10', 'Eid-ul-Fitr', 'general', TRUE, FALSE, NULL),
    ('2027-03-11', 'Eid-ul-Fitr holiday (day after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-03-12', 'Eid-ul-Fitr holiday (2 days after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-03-26', 'Independence and National Day', 'general', FALSE, FALSE, NULL),
    ('2027-04-13', 'Chaitra Sankranti (hill districts only)', 'general', FALSE, TRUE, 'Hill districts only: Rangamati, Khagrachhari & Bandarban'),
    ('2027-04-14', 'Bengali New Year (Pahela Baishakh)', 'executive', FALSE, FALSE, NULL),
    ('2027-05-01', 'May Day', 'general', FALSE, FALSE, NULL),
    ('2027-05-15', 'Eid-ul-Azha holiday (2 days before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-05-16', 'Eid-ul-Azha holiday (day before Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-05-17', 'Eid-ul-Azha', 'general', TRUE, FALSE, NULL),
    ('2027-05-18', 'Eid-ul-Azha holiday (day after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-05-19', 'Eid-ul-Azha holiday (2 days after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-05-20', 'Eid-ul-Azha holiday (3 days after Eid)', 'executive', TRUE, FALSE, NULL),
    ('2027-05-20', 'Buddha Purnima (Baishakhi Purnima)', 'general', TRUE, FALSE, NULL),
    ('2027-06-16', 'Ashura', 'executive', TRUE, FALSE, NULL),
    ('2027-08-05', 'July Mass Uprising Day', 'general', FALSE, FALSE, NULL),
    ('2027-08-15', 'Eid-e-Milad-un-Nabi (SAW)', 'general', TRUE, FALSE, NULL),
    ('2027-08-25', 'Janmashtami', 'general', FALSE, FALSE, NULL),
    ('2027-10-09', 'Durga Puja (Mahanabami)', 'executive', FALSE, FALSE, NULL),
    ('2027-10-10', 'Durga Puja (Vijaya Dashami)', 'general', FALSE, FALSE, NULL),
    ('2027-11-07', 'National Revolution and Solidarity Day', 'general', FALSE, FALSE, NULL),
    ('2027-12-16', 'Victory Day', 'general', FALSE, FALSE, NULL),
    ('2027-12-25', 'Christmas Day', 'general', FALSE, FALSE, NULL)
    ON CONFLICT (holiday_date, name) DO NOTHING
  `);

  console.log("✅ 056_calendar_settings_holidays migrated");
}

export async function down(): Promise<void> {
  // Non-destructive — see header. Holidays and the admin's weekend
  // choice are live configuration, not schema scaffolding.
  console.log("ℹ️ 056 down() is a no-op to protect calendar configuration data.");
}
