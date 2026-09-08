import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));

let dbInitialized = false;
let dbInitializationAttempted = false;

async function ensureDb() {
  if (dbInitializationAttempted) return;
  dbInitializationAttempted = true;
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set - running in fallback mode');
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

app.get('/api/db-status', async (_req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.json({ connected: false, message: 'DATABASE_URL is not set.' });
  }
  try {
    const { checkDatabaseHealth } = await import('../server/database/connection.js');
    const connected = await checkDatabaseHealth();
    return res.json({ connected, message: connected ? 'Database connected.' : 'Unreachable.' });
  } catch (error: any) {
    return res.json({ connected: false, message: error?.message });
  }
});

app.get('/health', async (_req, res) => {
  try {
    const { isDatabaseConfigured, checkDatabaseHealth } = await import('../server/database/connection.js');
    const connected = isDatabaseConfigured() ? await checkDatabaseHealth().catch(() => false) : false;
    return res.json({ ok: true, database: connected, mode: isDatabaseConfigured() ? 'database' : 'fallback' });
  } catch {
    return res.json({ ok: true, database: false, mode: 'fallback' });
  }
});

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
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `API route not found: ${req.method} ${req.originalUrl}` });
});

// Generic error handler so failures return JSON instead of an HTML stack trace
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled API error:', error?.message || error);
  res.status(error?.status || 500).json({ success: false, message: error?.message || 'Internal server error' });
});

export default app;
