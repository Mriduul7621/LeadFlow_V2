/**
 * migrationLedger.ts — schema_migrations ledger + advisory lock
 * ------------------------------------------------------------------
 * WHY THIS EXISTS (measured, not guessed)
 * ------------------------------------------------------------------
 * Before this module, `runMigrations()` re-ran EVERY migration function on
 * every process boot: on an already-current schema it still issued **226
 * PostgreSQL round trips** (`node scripts/_probe-startup-roundtrips.ts`
 * output: 226 statements, 326 on a virgin database). Vercel evaluates
 * `api/index.ts` per function instance, and that module awaited
 * `initializeDatabase()` before it would dispatch the first `/api/*`
 * request — so EVERY cold function instance (login, dashboard, follow-up
 * queue, ...) paid that serial cost against a remote Supabase database:
 *
 *     round trips × Vercel→Supabase RTT
 *     226 × 10 ms  ≈ 2.3 s
 *     226 × 30 ms  ≈ 6.8 s
 *     226 × 60 ms  ≈ 13.6 s      (transatlantic / cross-region)
 *
 * That is the delay users see as "data takes forever to load": the first
 * request on each new instance waits for a full DDL replay of 36
 * migrations + 5 seed routines, and concurrent instances could even block
 * each other on DDL locks, which is why a few startup requests showed
 * tens of seconds while their own Server-Timing was ~1.6 s.
 *
 * WHAT THIS MODULE DOES
 * ------------------------------------------------------------------
 * 1. Creates a tiny `schema_migrations` ledger table (idempotent, one
 *    statement, no data change).
 * 2. Reads the applied migration ids in ONE query, so an up-to-date
 *    database costs exactly **2 round trips** instead of 226.
 * 3. Records each migration the moment it succeeds, so an interrupted
 *    boot does not redo finished work.
 * 4. Takes a PostgreSQL **advisory lock** while actually applying pending
 *    migrations, so two function instances booting at the same time can
 *    never run DDL concurrently (the second one skips and logs).
 * 5. Adopts a pre-existing legacy database (created before the ledger
 *    existed) only when the LAST migration's objects are already present —
 *    proof the schema is current. Otherwise the migrations run normally.
 *
 * SAFETY
 * ------------------------------------------------------------------
 * - Migrations themselves are unchanged and remain idempotent.
 * - No business table is written, altered or dropped here.
 * - A failure inside a migration is NOT recorded, so the next boot retries
 *   it exactly like the old behavior.
 * - Advisory locks are session-scoped; the dedicated client is always
 *   released, and `pg_try_advisory_lock` never blocks a request thread.
 */

import { getPool, isDatabaseConfigured } from "./connection.js";

/** Ledger table name (single source of truth for both DDL and queries). */
export const MIGRATION_LEDGER_TABLE = "schema_migrations";

/** Stable, project-specific advisory lock key (int4 range). */
export const MIGRATION_ADVISORY_LOCK_KEY = 70865023;

/** Marker row id for the one-time baseline seed run. */
export const SEED_LEDGER_MARKER = "seed:baseline-v1";

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms INTEGER
  )
`;

export interface LedgerState {
  /** True when the ledger table did not exist before this call. */
  createdNow: boolean;
  /** Migration/seed ids already recorded. */
  applied: Set<string>;
}

async function tableExists(): Promise<boolean> {
  const res = await getPool().query(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${MIGRATION_LEDGER_TABLE}`]
  );
  return res.rows[0]?.present === true;
}

/**
 * Ensure the ledger exists and return the ids already applied.
 * Cost on a warm schema: 1 existence probe + 1 SELECT (2 round trips).
 */
export async function loadLedger(): Promise<LedgerState> {
  const existed = await tableExists();
  if (!existed) {
    await getPool().query(LEDGER_DDL);
  }
  const rows = await getPool().query(`SELECT name FROM ${MIGRATION_LEDGER_TABLE}`);
  const applied = new Set<string>();
  for (const row of rows.rows as Array<{ name: string }>) {
    applied.add(String(row.name));
  }
  return { createdNow: !existed, applied };
}

/**
 * Read the applied ids only (used by readiness/deploy checks).
 */
export async function readAppliedIds(): Promise<Set<string>> {
  const res = await getPool().query(`SELECT name FROM ${MIGRATION_LEDGER_TABLE}`);
  const applied = new Set<string>();
  for (const row of res.rows as Array<{ name: string }>) applied.add(String(row.name));
  return applied;
}

/** Record one migration/seed marker. Never throws on duplicate. */
export async function recordApplied(name: string, durationMs?: number): Promise<void> {
  await getPool().query(
    `INSERT INTO ${MIGRATION_LEDGER_TABLE} (name, duration_ms)
     VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING`,
    [name, Number.isFinite(durationMs as number) ? Math.max(0, Math.round(durationMs as number)) : null]
  );
}

export type LockOutcome = "acquired" | "busy" | "unsupported";

/**
 * Run `fn` while holding the migration advisory lock.
 *
 * - "busy" means another instance is already migrating: the caller must
 *   NOT run DDL; it logs and continues (the other instance finishes).
 * - "unsupported" (a runtime that rejects advisory locks, e.g. an exotic
 *   proxy) falls back to running `fn` unguarded — same as the old
 *   single-writer assumption, never worse.
 */
export async function withMigrationLock<T>(
  fn: () => Promise<T>
): Promise<{ outcome: LockOutcome; result?: T }> {
  if (!isDatabaseConfigured()) return { outcome: "unsupported", result: await fn() };

  let client: any = null;
  try {
    client = await getPool().connect();
  } catch {
    return { outcome: "unsupported", result: await fn() };
  }

  let locked = false;
  try {
    const res = await client.query(`SELECT pg_try_advisory_lock($1) AS locked`, [
      MIGRATION_ADVISORY_LOCK_KEY,
    ]);
    locked = res.rows?.[0]?.locked === true;
  } catch {
    // Runtime without advisory locks: degrade to the previous behavior.
    try {
      client.release?.();
    } catch {
      /* ignore */
    }
    return { outcome: "unsupported", result: await fn() };
  }

  if (!locked) {
    try {
      client.release?.();
    } catch {
      /* ignore */
    }
    return { outcome: "busy" };
  }

  try {
    const result = await fn();
    return { outcome: "acquired", result };
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch {
      /* ignore — session end releases it anyway */
    }
    try {
      client.release?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Legacy adoption: a database created before this ledger existed already
 * has every migration's effect. Detect that with the LAST migration's
 * objects (042 roadshows + 041 partial index + the core leads table) and,
 * only then, mark all ids as applied without replaying DDL.
 *
 * If any sentinel is missing, the caller runs the migrations normally —
 * we never guess a half-migrated schema is current.
 */
export async function tryAdoptLegacySchema(ids: string[]): Promise<boolean> {
  const sentinels = await getPool().query(`
    SELECT
      to_regclass('public.leads')       IS NOT NULL AS has_leads,
      to_regclass('public.roadshows')   IS NOT NULL AS has_roadshows,
      to_regclass('public.users')       IS NOT NULL AS has_users,
      EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'idx_scheduled_activities_open_lead'
      ) AS has_last_index
  `);
  const row: any = sentinels.rows[0] || {};
  if (!(row.has_leads && row.has_users && row.has_roadshows && row.has_last_index)) {
    return false;
  }
  for (const id of ids) {
    await recordApplied(id, 0);
  }
  return true;
}
