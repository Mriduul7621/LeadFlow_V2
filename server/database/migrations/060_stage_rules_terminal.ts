import { query } from "../connection.js";

/**
 * 060 — DZ-6: stage rules & terminal unification (Admin Control
 * programme, audit §2.4 D2/D3, §4, §5 Finding 5).
 * ------------------------------------------------------------------
 * Two sources of truth are retired by this slice:
 *
 *   D2 — the per-status required-field rules (`LEAD_STAGE_RULES`)
 *        lived only in code, keyed by status NAME. Renaming a status
 *        in Settings → Metadata silently detached its rule. The rules
 *        now live in a table keyed by the FollowUpStatus dictionary
 *        ENTRY (options.id), so a rename keeps its rule.
 *   D3 — the terminal set lived twice: the dictionary's
 *        `meta.isTerminal` flag AND the hardcoded
 *        `TERMINAL_LEAD_STATUSES` code constant. The constant is
 *        deleted by DZ-6 and the dictionary flag becomes the single
 *        source for every "open lead" definition (follow-up queue,
 *        dashboard counts, SLA, auto-assignment, calendar sync, push
 *        reminders, deactivation transfers, Lead Quality).
 *
 * This migration:
 *   1. Creates `lead_stage_rules` (one row per dictionary entry that
 *      carries required fields; absence = no extra requirement).
 *   2. Backfills the dictionary flags: any FollowUpStatus row named
 *      'Converted' / 'Not Interested' whose meta carries no
 *      isTerminal flag gets isTerminal = true (preserving every
 *      other meta key). Rows already carrying an explicit flag —
 *      true OR false — are never touched: an admin's deliberate
 *      choice is data, and the runtime honours an explicit false.
 *   3. Seeds the five code rules by dictionary-entry id, looked up
 *      by value at seed time. The seed runs ONLY while the table is
 *      empty: once any rule row exists, the Danger Zone owns the
 *      table, and a re-run must never resurrect a rule an admin
 *      deliberately deleted (a bare ON CONFLICT DO NOTHING cannot
 *      see a deletion — the deleted row leaves no conflict behind,
 *      so it would re-seed it; the empty-table check is what keeps
 *      the "an admin's later edits are never reset" promise). On a
 *      database whose FollowUpStatus rows do not exist yet, no rule
 *      rows are written and the runtime falls back to the code
 *      defaults until the Danger Zone saves a set.
 *
 * Ordering note: the seed lookup runs at migration time. On a
 * database whose FollowUpStatus rows do not exist yet (fresh install
 * — the rows are seeded at server boot), no rule rows are written;
 * the runtime then falls back to the code-default rule table until
 * the Danger Zone saves a set, exactly like DZ-3's config fallback.
 * down() drops the table only; the flag backfill is data repair and
 * is deliberately not reverted (migration 058 pattern).
 */
const CODE_RULES: Array<{ status: string; requiredFields: string }> = [
  {
    status: "Follow-up Set",
    requiredFields: JSON.stringify([
      { field: "nextFollowUpDate", label: "Next Follow-Up date & time" },
    ]),
  },
  {
    status: "Meeting Fixed",
    requiredFields: JSON.stringify([
      { field: "meetingDate", label: "Meeting date & time" },
    ]),
  },
  {
    status: "Proposal Sent",
    requiredFields: JSON.stringify([
      { field: "productName", label: "Product" },
      { field: "sumAssured", label: "Sum Assured", numeric: true, positive: true },
      { field: "projectedNCP", label: "Projected FYCP", numeric: true, positive: true },
    ]),
  },
  {
    status: "Converted",
    requiredFields: JSON.stringify([
      { field: "productName", label: "Product" },
      { field: "sumAssured", label: "Sum Assured", numeric: true, positive: true },
      { field: "collectedNCP", label: "Collected FYCP", numeric: true, positive: true },
    ]),
  },
  {
    status: "Not Interested",
    requiredFields: JSON.stringify([
      { field: "lossReason", label: "Loss reason" },
    ]),
  },
];

export async function up(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS lead_stage_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status_option_id UUID NOT NULL REFERENCES options(id) ON DELETE CASCADE,
      required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_lead_stage_rules_status UNIQUE (status_option_id)
    );
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS idx_lead_stage_rules_status
      ON lead_stage_rules(status_option_id);
  `);

  // Backfill the terminal flags where the dictionary row carries no
  // explicit isTerminal key (jsonb '?' tests key presence; an
  // explicit false is a deliberate admin choice and is kept).
  await query(`
    UPDATE options
       SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{isTerminal}', 'true'::jsonb, true)
     WHERE field_key = 'FollowUpStatus'
       AND option_value IN ('Converted', 'Not Interested')
       AND NOT (COALESCE(meta, '{}'::jsonb) ? 'isTerminal');
  `);

  // Seed only while the table is empty (checked ONCE, before the
  // loop — a per-row NOT EXISTS would see the first inserted rule
  // and skip the rest). Once any rule row exists, the Danger Zone
  // owns the table.
  const existing: any = await query(`SELECT COUNT(*)::int AS n FROM lead_stage_rules`);
  if (Number(existing.rows?.[0]?.n || 0) === 0) {
    for (const rule of CODE_RULES) {
      await query(
        `INSERT INTO lead_stage_rules (status_option_id, required_fields)
           SELECT o.id, $2::jsonb
             FROM options o
            WHERE o.field_key = 'FollowUpStatus'
              AND o.option_value = $1
         ON CONFLICT (status_option_id) DO NOTHING`,
        [rule.status, rule.requiredFields]
      );
    }
  }

  console.log("✅ 060_stage_rules_terminal migrated");
}

export async function down(): Promise<void> {
  await query(`DROP TABLE IF EXISTS lead_stage_rules;`);
  // Deliberate no-op for the flag backfill (see header): the flags
  // are data repair, and re-clearing them would silently re-open
  // the D3 divergence this slice removes.
  console.log("ℹ️ 060 down() drops lead_stage_rules only; the isTerminal backfill is kept.");
}
