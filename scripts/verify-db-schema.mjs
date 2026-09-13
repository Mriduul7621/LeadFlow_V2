#!/usr/bin/env node
/**
 * verify-db-schema.mjs — read-only migration / schema readiness check
 * ------------------------------------------------------------------
 * Answers: "Is the PostgreSQL schema complete enough for LeadFlow to operate?"
 *
 * LeadFlow's migrations run automatically at startup and are idempotent
 * (CREATE TABLE IF NOT EXISTS / ALTER TABLE ... IF NOT EXISTS), but a failed
 * or partially-applied startup migration is only surfaced per-request (HTTP
 * 503), not as a single readiness signal. This script gives operators a
 * repeatable, NON-DESTRUCTIVE way to verify schema readiness before/after a
 * release without changing any production data.
 *
 * What it does (read-only):
 *   1. requires DATABASE_URL (no fallback — same honesty as the runtime);
 *   2. opens a connection and runs SELECT 1;
 *   3. reads information_schema for the set of tables the production router
 *      and migrations create/query;
 *   4. prints a per-table PASS/MISS list (never any row data);
 *   5. exits 0 when every expected table exists, 1 otherwise.
 *
 * What it NEVER does: CREATE / ALTER / DROP / INSERT / UPDATE / DELETE,
 * run migrations, run seeds, or read business rows.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/verify-db-schema.mjs
 *   npm run verify:db-schema
 *
 * This script is deliberately NOT part of LeadFlow CI (CI must not require a
 * real production database). It is an operator / release-runbook tool.
 */

import pg from 'pg';

/**
 * The tables the production router and migration suite are known to create
 * or query. Curated from server/database/migrations/* and the SQL in
 * server/routes/production.routes.ts. Missing entries here do not fail the
 * check; this is a floor, not an exhaustive schema diff.
 */
const EXPECTED_TABLES = [
  // Identity / RBAC
  'users',
  'roles',
  'departments',
  'teams',
  'hierarchies',
  'employee_departments',
  'employee_reporting',
  'user_visibility',
  'team_members',
  'territories',
  'user_territories',
  'employees',
  'permissions',
  'role_permissions',
  'user_permissions',
  'fine_permissions',
  'sessions',
  'audit_logs',
  // Leads
  'leads',
  'lead_status',
  'lead_activities',
  'scheduled_activities',
  // Configuration / reference
  'options',
  'metadata',
  'metadata_types',
  'form_fields',
  'forms',
  'workflows',
  'workflow_rules',
  'products',
  'campaigns',
  'notifications',
  'department_hierarchies',
];

const log = (...a) => console.log(...a);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail('DATABASE_URL is not set. Refusing to run a schema check against an unknown target.');
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: /[?&]sslmode=disable\b/i.test(url) ? false : { rejectUnauthorized: false },
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (err) {
    fail(`Could not connect to the database: ${err?.message || err}`);
  }

  try {
    await client.query('SELECT 1');

    const res = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    const existing = new Set(res.rows.map((r) => String(r.table_name)));

    const missing = EXPECTED_TABLES.filter((t) => !existing.has(t));
    const present = EXPECTED_TABLES.filter((t) => existing.has(t));

    log(`Schema readiness — ${present.length}/${EXPECTED_TABLES.length} expected tables present.`);
    for (const t of EXPECTED_TABLES) {
      log(`  [${existing.has(t) ? 'PASS' : 'MISS'}] ${t}`);
    }

    if (missing.length > 0) {
      console.error('');
      console.error(`✗ Missing tables (${missing.length}): ${missing.join(', ')}`);
      console.error(
        'The schema is incomplete. Apply pending migrations (deploy, or run the documented migration procedure in docs/PRODUCTION_RELEASE_RUNBOOK.md) before serving traffic.'
      );
      process.exit(1);
    }

    log('');
    log('✓ Schema is complete for the expected LeadFlow tables.');
    process.exit(0);
  } catch (err) {
    fail(`Schema check failed: ${err?.message || err}`);
  } finally {
    if (connected) await client.end().catch(() => undefined);
  }
}

main();
