import express from 'express';
import dotenv from 'dotenv';

import {
  applyProductionHttpSecurity,
  createApiErrorHandler,
  createApiNotFoundHandler,
  isProductionRuntime,
} from '../server/middleware.js';

dotenv.config();

const app = express();

/**
 * Security headers, trust proxy, rate limiting and JSON body limits —
 * mounted before every route so no response can bypass them. This is the
 * exact same call the standalone entrypoint (server.ts) makes, which keeps
 * the two production runtime paths at parity.
 *
 * Order: trust proxy -> headers -> /api limiter -> auth limiter ->
 *        bulk JSON parser -> global JSON parser -> routes.
 */
applyProductionHttpSecurity(app, { production: true });

let dbInitialized = false;
let dbInitializationAttempted = false;

async function ensureDb() {
  if (dbInitializationAttempted) return;
  dbInitializationAttempted = true;
  if (!process.env.DATABASE_URL) {
    // Honest startup log: without DATABASE_URL a serverless deployment does
    // NOT fall back to in-memory persistence. Database-backed requests are
    // refused with HTTP 503 by the production router (see
    // docs/PRODUCTION_SECURITY_HARDENING.md).
    console.log(
      isProductionRuntime()
        ? 'DATABASE_URL not configured - database-backed requests will be refused (503), no in-memory fallback'
        : 'DATABASE_URL not set - development demo mode (in-memory, not persistent)'
    );
    return;
  }

  try {
    const { initializeDatabase } = await import('../server/database/initialize.js');
    await initializeDatabase();
    dbInitialized = true;
    console.log('Database initialized');
  } catch (error: any) {
    console.error('DB init failed:', error?.message || error);
  }
}

const IS_PRODUCTION = isProductionRuntime();

app.get('/api/db-status', async (_req, res) => {
  if (!process.env.DATABASE_URL) {
    const demoMode = !IS_PRODUCTION;
    return res.status(demoMode ? 200 : 503).json({
      connected: false,
      message: demoMode
        ? 'DATABASE_URL is not set. Running in development demo mode (in-memory, not persistent).'
        : 'DATABASE_URL is not configured. The application cannot persist data in production.',
      mode: demoMode ? 'dev-demo' : 'db-unconfigured',
    });
  }
  try {
    const { checkDatabaseHealth } = await import('../server/database/connection.js');
    const connected = await checkDatabaseHealth();
    if (!connected) {
      return res.status(503).json({ connected: false, message: 'Database host is unreachable.', mode: 'database-unreachable' });
    }
    return res.json({ connected, message: 'Database connected.', mode: 'database' });
  } catch (error: any) {
    return res.status(503).json({ connected: false, message: error?.message || 'Database is unavailable.', mode: 'database-unreachable' });
  }
});

// Health endpoint. Registered on both '/health' and '/api/health': on Vercel,
// /api/* requests are routed to this function with the full original path
// (e.g. '/api/health'), while '/health' only matches when the app is served
// standalone (npm start / local dev). Without the '/api/health' alias the
// health check would fall through to the API 404 handler in production.
const healthHandler = async (_req, res) => {
  try {
    const { isDatabaseConfigured, checkDatabaseHealth } = await import('../server/database/connection.js');
    const configured = isDatabaseConfigured();
    const database = configured ? await checkDatabaseHealth().catch(() => false) : false;
    return res.json({
      ok: true,
      database,
      mode: configured ? 'database' : (IS_PRODUCTION ? 'unconfigured' : 'dev-demo'),
      status: configured ? (database ? 'ok' : 'degraded') : (IS_PRODUCTION ? 'misconfigured' : 'demo'),
    });
  } catch {
    return res.json({ ok: true, database: false, mode: 'unconfigured', status: IS_PRODUCTION ? 'misconfigured' : 'demo' });
  }
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// All API routes - load after DB init
let productionRouter: express.Router | null = null;
let routesLoading: Promise<express.Router> | null = null;

async function loadRoutes(): Promise<express.Router> {
  if (productionRouter) return productionRouter;
  if (!routesLoading) {
    routesLoading = (async () => {
      await ensureDb();
      const { default: productionRoutes } = await import('../server/routes/production.routes.js');
      productionRouter = productionRoutes;
      return productionRoutes;
    })().catch(error => {
      routesLoading = null;
      throw error;
    });
  }
  return routesLoading;
}

// Serverless cold start: kick off DB init + router load as soon as the
// module is evaluated, instead of on the first request. On Vercel the
// function container boots, evaluates this module, and only then starts
// dispatching requests — so the (several-seconds) migration check and the
// production-router import now overlap container warm-up and network time
// to the first request, instead of sitting on that request's critical
// path. `loadRoutes` is memoized: the first request still awaits the SAME
// promise (no second init, no changed dispatch order, no new 404s). The
// `.catch` keeps the kick-off from becoming an unhandled rejection — a
// cold-start failure is still surfaced on the first request, exactly as
// before.
void loadRoutes().catch(() => undefined);

// Dispatch /api/* into the lazily-loaded production router. Calling the router
// directly (instead of app.use inside the loader) keeps the 404 handler below
// as the true last resort.
app.use('/api', async (req, res, next) => {
  try {
    const router = await loadRoutes();
    router(req, res, next);
  } catch (error: any) {
    console.error('Route error:', error?.message);
    next(error);
  }
});

// 404 catch-all for unknown /api/* routes (must be registered after the loader
// middleware so lazily-mounted production routes still get a chance to match).
app.use('/api', createApiNotFoundHandler());

// Generic error handler so failures return JSON instead of an HTML stack trace.
// In production it sends a curated message (never the raw error text, which can
// carry SQL, connection details or query parameters) while logging the full
// error server-side.
app.use(createApiErrorHandler({ production: true }));

export default app;
