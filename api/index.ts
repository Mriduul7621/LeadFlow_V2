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
let routesLoaded = false;
async function loadRoutes() {
  if (routesLoaded) return;
  routesLoaded = true;
  await ensureDb();
  const { default: productionRoutes } = await import('../server/routes/production.routes.js');
  app.use('/api', productionRoutes);
}

app.use('/api', async (req, res, next) => {
  try {
    await loadRoutes();
    next();
  } catch (error: any) {
    console.error('Route error:', error?.message);
    next(error);
  }
});

export default app;
