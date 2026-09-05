import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

import routes from './routes';
import { initializeDatabase } from './database/initialize';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '50mb' }));

// -------------------------------
// Lazy Database Initialization
// -------------------------------

let dbInitialized = false;

app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await initializeDatabase();
      dbInitialized = true;
      console.log('✅ Database initialized');
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
    }
  }

  next();
});

// -------------------------------
// API Routes
// -------------------------------

app.use('/api', routes);

// -------------------------------
// Development (Vite)
// -------------------------------

async function startDevelopmentServer() {
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
    },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Development Server Running : http://0.0.0.0:${PORT}`);
  });
}

// -------------------------------
// Production
// -------------------------------

function startProductionServer() {
  const distPath = path.join(process.cwd(), 'dist');

  app.use(express.static(distPath));

  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Production Server Running : http://0.0.0.0:${PORT}`);
  });
}

// -------------------------------
// Bootstrap
// -------------------------------

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  startDevelopmentServer().catch(console.error);
} else if (!process.env.VERCEL) {
  startProductionServer();
}

export default app;