import { query } from "../connection.js";

/**
 * 059 — Schema-drift repair: timestamp columns the settings writers
 * already use, missing on databases whose tables predate migration 035.
 * ------------------------------------------------------------------
 * Migration 035 defined `form_fields`, `metadata_types` and
 * `workflow_rules` WITH their timestamp columns — but only through
 * `CREATE TABLE IF NOT EXISTS`. A production database whose tables
 * were first created by the legacy bootstrap (server/db.ts, which has
 * `created_date VARCHAR` instead of `created_at`/`updated_at` — and
 * no timestamp column at all on metadata_types) therefore kept the
 * old shape forever: no later migration ever ALTERed these tables.
 *
 * The writers, however, speak the 035 shape:
 *   - POST /form-fields upsert + reorder (metadata.routes.ts) write
 *     form_fields.created_at / updated_at — the owner hit this live
 *     on 2026-11-11: saving any form field failed with
 *     `column "created_at" of relation "form_fields" does not exist`.
 *   - POST /workflow-rules upsert writes workflow_rules.created_at /
 *     updated_at (same legacy shape, same failure waiting to happen).
 *   - POST /metadata-types and the metadata seed write
 *     metadata_types.created_at (035's shape for this table has no
 *     updated_at and no writer uses one, so none is added).
 *
 * `options` was audited and deliberately left out: its creation
 * migration (007) defines created_at/updated_at from birth, and its
 * only later change is 035's `meta` column — no drift pattern.
 *
 * Every statement is ADD COLUMN IF NOT EXISTS, so on an already-035-
 * shaped database this migration is a pure no-op, and re-running it
 * changes nothing (idempotent, like every migration in this chain).
 *
 * down() drops the five columns with plain DROP COLUMN IF EXISTS.
 * Whether a given column pre-existed 059 is not tracked anywhere, so
 * on a database that was born with the 035 shape a down() would drop
 * columns it originally had — acceptable for a rollback of a drift
 * repair, and noted here so nobody is surprised by it.
 */
export async function up(): Promise<void> {
    await query(`ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`);
    await query(`ALTER TABLE form_fields ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);
    await query(`ALTER TABLE metadata_types ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`);
    await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`);
    await query(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);
    console.log("✅ 059_form_fields_timestamps migrated");
}

export async function down(): Promise<void> {
    await query(`ALTER TABLE form_fields DROP COLUMN IF EXISTS created_at`);
    await query(`ALTER TABLE form_fields DROP COLUMN IF EXISTS updated_at`);
    await query(`ALTER TABLE metadata_types DROP COLUMN IF EXISTS created_at`);
    await query(`ALTER TABLE workflow_rules DROP COLUMN IF EXISTS created_at`);
    await query(`ALTER TABLE workflow_rules DROP COLUMN IF EXISTS updated_at`);
    console.log("ℹ️ 059 down(): timestamp columns dropped (see header note).");
}
