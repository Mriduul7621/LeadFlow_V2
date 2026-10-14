# Performance Fix — Phase 1: Remove migrations from the request path

## Finding

The Vercel API entrypoint called `ensureDb()` before importing the production
router. `ensureDb()` called `initializeDatabase()`, which ran the full ordered
migration list (currently through migration 042) and then all seed routines.
This happens once per serverless function instance, so multiple cold instances
can replay schema checks/DDL and seeds while the first requests are waiting.

The frontend is not the only relevant layer: this creates avoidable work in
the backend cold-start path. Database initialization and migration execution
are different responsibilities and should not be coupled to serving API calls.

## Change

- Vercel production builds run `npm run migrate:production` before the app
  build. The script only runs when `VERCEL_ENV=production`.
- Production builds fail closed if `DATABASE_URL` is missing, so an app
  cannot deploy silently without its schema migration step.
- Preview and local builds skip production migrations to avoid accidentally
  mutating production data.
- `api/index.ts` only lazily imports and memoizes the API router; it no longer
  waits for database migrations/seeds on cold start.
- The standalone development server keeps its convenient request-time
  initialization only outside production. Production runtime requests do not
  run migrations.

## Safety and rollout notes

1. Vercel Production must have `DATABASE_URL` available at build time. If it
   is configured only for runtime, this change intentionally fails the build
   and the Vercel environment must be corrected before rollout.
2. Migration functions and seeds are still the existing functions; this phase
   changes when they run, not their SQL or business logic.
3. Migrations now run once per production deployment rather than once per
   cold serverless instance. Future schema changes must continue to be
   backward-compatible with the currently serving release while a deployment
   is building.
4. Do not merge/deploy until the production build and existing test suite pass.
5. After deployment, compare cold and warm timings for `/api/dashboard`,
   `/api/options`, `/api/leads`, and `/api/leads/follow-ups`. If total time
   remains much higher than `dbDurationMs`, Phase 2 should trace non-DB time
   and optimize the dashboard startup request graph.

## Rollback

Revert the commits on this branch. That restores runtime initialization in
`api/index.ts` and the original Vercel build command. No schema/data rollback
is required because this phase does not alter the schema or seed contents.
