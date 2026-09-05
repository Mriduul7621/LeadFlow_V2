import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

import { initializeDatabase } from './server/database/initialize';
import { checkDatabaseHealth, isDatabaseConfigured, getPool } from './server/database/connection';
import productionRoutes from './server/routes/production.routes';

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

app.get('/api/db-status', async (_req, res) => {
  if (!isDatabaseConfigured()) {
    return res.json({ connected: false, message: 'DATABASE_URL is not set. Using local fallback mode.' });
  }

  try {
    const connected = await checkDatabaseHealth();
    return res.json({ connected, message: connected ? 'Connected to PostgreSQL database.' : 'Database host is unreachable.' });
  } catch (error: any) {
    return res.status(503).json({ connected: false, message: error.message || 'Database is unavailable.' });
  }
});

app.get('/health', async (_req, res) => {
  const pool = isDatabaseConfigured() ? getPool() : null;
  const health = pool ? await checkDatabaseHealth().catch(() => false) : false;
  return res.json({ ok: true, database: health, mode: isDatabaseConfigured() ? 'database' : 'fallback' });
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
