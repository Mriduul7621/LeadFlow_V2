import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

import { initializeDatabase } from './server/database/initialize.js';
import { checkDatabaseHealth, isDatabaseConfigured, getPool } from './server/database/connection.js';
import productionRoutes from './server/routes/production.routes.js';
import {
  applyProductionHttpSecurity,
  createApiErrorHandler,
  createApiNotFoundHandler,
} from './server/middleware.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

/**
 * Security headers, trust proxy, rate limiting and JSON body limits.
 * Mounted BEFORE every route (and before the Vite/SPA fallbacks) so no
 * response can bypass them. The exact same call is made by the Vercel
 * entrypoint (api/index.ts) — see server/middleware.ts and
 * docs/PRODUCTION_SECURITY_HARDENING.md.
 *
 * Order: trust proxy -> headers -> /api limiter -> auth limiter ->
 *        bulk JSON parser -> global JSON parser -> routes.
 */
applyProductionHttpSecurity(app, { production: IS_PRODUCTION });

let dbInitialized = false;
let dbInitializationAttempted = false;

app.use(async (req, res, next) => {
  if (!isDatabaseConfigured() || dbInitializationAttempted) {
    next();
    return;
  }

  dbInitializationAttempted = true;

  if (!dbInitialized) {
    try {
      await initializeDatabase();
      dbInitialized = true;
      console.log('✅ Database initialized');
    } catch (error) {
      console.error('⚠️ Database initialization failed:', error);
    }
  }

  next();
});

app.use('/api', productionRoutes);

app.get('/api/db-status', async (_req, res) => {
  if (!isDatabaseConfigured()) {
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
    const connected = await checkDatabaseHealth();
    if (!connected) {
      return res.status(503).json({ connected: false, message: 'Database host is unreachable.', mode: 'database-unreachable' });
    }
    return res.json({ connected, message: 'Connected to PostgreSQL database.', mode: 'database' });
  } catch (error: any) {
    return res.status(503).json({ connected: false, message: error.message || 'Database is unavailable.', mode: 'database-unreachable' });
  }
});

// Health check, served on '/health' (standalone convention) and on
// '/api/health' so the standalone runtime answers exactly the same path the
// Vercel function exposes to uptime monitors.
const healthHandler = async (_req: express.Request, res: express.Response) => {
  const pool = isDatabaseConfigured() ? getPool() : null;
  const database = pool ? await checkDatabaseHealth().catch(() => false) : false;
  return res.json({
    ok: true,
    database,
    mode: pool ? 'database' : (IS_PRODUCTION ? 'unconfigured' : 'dev-demo'),
    status: pool ? (database ? 'ok' : 'degraded') : (IS_PRODUCTION ? 'misconfigured' : 'demo'),
  });
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

/**
 * Unknown /api/* routes return the same JSON 404 as the Vercel function
 * instead of falling through to the SPA HTML shell. Registered after the
 * real routes and before the static/SPA fallbacks.
 */
app.use('/api', createApiNotFoundHandler());

/**
 * Generic API error handler — registered after every API route so both
 * runtime paths answer failures as JSON without stack traces, SQL or
 * credentials. Non-API failures (Vite dev middleware, SPA fallback) are
 * passed on to Express/Vite unchanged.
 */
app.use(createApiErrorHandler({ production: IS_PRODUCTION }));

async function startDevelopmentServer() {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Full-Stack application running on http://0.0.0.0:${PORT}`);
  });
}

function startProductionServer() {
  const distPath = path.join(process.cwd(), 'dist');

  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Production Server Running : http://0.0.0.0:${PORT}`);
  });
}

/**
 * Test seam: importing this module must never bind a port or boot Vite.
 * Production/development startup is unchanged when these are unset.
 */
const SKIP_LISTEN = process.env.LEADFLOW_SKIP_LISTEN === '1' || process.env.NODE_ENV === 'test';

if (SKIP_LISTEN) {
  // Imported by the test suite — the exported app is driven directly.
} else if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  startDevelopmentServer().catch(console.error);
} else if (!process.env.VERCEL) {
  startProductionServer();
}

export default app;
