import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

import { initializeDatabase } from './server/database/initialize.js';
import { checkDatabaseHealth, isDatabaseConfigured, getPool } from './server/database/connection.js';
import productionRoutes from './server/routes/production.routes.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '50mb' }));

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

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

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

app.get('/health', async (_req, res) => {
  const pool = isDatabaseConfigured() ? getPool() : null;
  const database = pool ? await checkDatabaseHealth().catch(() => false) : false;
  return res.json({
    ok: true,
    database,
    mode: pool ? 'database' : (IS_PRODUCTION ? 'unconfigured' : 'dev-demo'),
    status: pool ? (database ? 'ok' : 'degraded') : (IS_PRODUCTION ? 'misconfigured' : 'demo'),
  });
});

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

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  startDevelopmentServer().catch(console.error);
} else if (!process.env.VERCEL) {
  startProductionServer();
}

export default app;
