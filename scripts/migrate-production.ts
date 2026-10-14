/**
 * Run schema migrations/seeds once during a Vercel production build.
 *
 * Vercel preview builds and local builds deliberately skip this step so they
 * cannot accidentally mutate the production database. A production build
 * fails closed if DATABASE_URL is missing instead of deploying an app whose
 * expected schema may not exist.
 */
if (process.env.VERCEL_ENV !== 'production') {
  console.log('[db-migrate] Skipping: this is not a Vercel production build.');
} else {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      '[db-migrate] DATABASE_URL must be available to the Vercel production build. ' +
      'Configure it for the Production environment before deploying.'
    );
  }

  const startedAt = Date.now();
  console.log('[db-migrate] Starting production database migrations and seeds.');

  const { initializeDatabase } = await import('../server/database/initialize.js');
  await initializeDatabase();

  console.log(JSON.stringify({
    event: 'production_database_migration_complete',
    durationMs: Date.now() - startedAt,
    environment: 'production',
  }));
}
