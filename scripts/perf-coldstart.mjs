/**
 * perf-coldstart.mjs
 * ------------------------------------------------------------------
 * Measures the serverless-function cold start the way Vercel experiences
 * it: process spawn (container warm-up + module evaluation) -> first
 * /api/* response. Uses the Vercel-style compiled ESM tree that
 * `npm run verify:serverless` writes to .serverless-test/ (production
 * mode, no DATABASE_URL — the router import + dispatch path is what we
 * are measuring here; the remote-DB migration cost is infrastructure and
 * is documented separately).
 *
 * Usage:  node scripts/perf-coldstart.mjs [label]
 * (run `npm run verify:serverless` first, or it will say so.)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.serverless-test');
const PORT = 4299 + Math.floor(Math.random() * 100);
const label = process.argv[2] || 'run';

const t0 = process.hrtime.bigint();
const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;

let out = '';
const child = spawn(process.execPath, ['harness.mjs'], {
  cwd: outDir,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    VERCEL: '1',
    PORT: String(PORT),
    JWT_SECRET: 'perf-coldstart-secret',
    DATABASE_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => (out += d.toString()));
child.stderr.on('data', d => (out += d.toString()));

let readyAt = -1;
let loginCold = -1;
let loginWarm = -1;
let finished = false;

child.stdout.on('data', () => {
  if (readyAt === -1 && out.includes('HARNESS_READY')) {
    readyAt = ms();
    void firstRequest();
  }
});

async function firstRequest() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await res.text();
    loginCold = ms();
    // second request = warm (router already loaded)
    const res2 = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await res2.text();
    loginWarm = ms();
    console.log(
      JSON.stringify({ label, readyMs: Math.round(readyAt), firstApiMs: Math.round(loginCold), warmApiMs: Math.round(loginWarm) })
    );
    finished = true;
  } catch (err) {
    console.error('coldstart request failed:', err.message, '\n', out.slice(-2000));
    finished = true;
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => process.exit(finished ? 0 : 1), 200);
  }
}

setTimeout(() => {
  if (!finished) {
    console.error('coldstart timed out\n', out.slice(-2000));
    child.kill('SIGTERM');
    process.exit(1);
  }
}, 30_000);
