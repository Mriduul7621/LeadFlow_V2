#!/usr/bin/env node
/**
 * verify-serverless-build.mjs
 * ------------------------------------------------------------------
 * Reproduces Vercel's serverless-function build for `api/index.ts`
 * locally and smoke-tests the compiled output.
 *
 * Why this exists:
 *   Vercel's Node.js runtime (@vercel/node) does NOT bundle the
 *   entrypoint. It traces the import graph with @vercel/nft
 *   (TypeScript-style resolution) and transpiles EVERY traced .ts file
 *   individually to ESM JavaScript (`.ts` -> `.js`, preserving the
 *   directory layout), then runs the tree with Node ESM inside the
 *   Lambda (`/var/task/...`). Because package.json has "type":
 *   "module", those .js files are loaded as ESM — and Node ESM
 *   requires explicit file extensions on relative imports. An
 *   extensionless `import ... from '../database/connection'` therefore
 *   compiles fine, type-checks fine, and works under tsx/esbuild
 *   bundling, but throws at Lambda runtime:
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find module
 *     '/var/task/server/database/connection' imported from
 *     '/var/task/server/routes/production.routes.js'
 *
 * What this script does:
 *   1. Traces the runtime import graph from api/index.ts (static +
 *      dynamic relative imports, TS resolution incl. `.js` -> `.ts`).
 *   2. Transpiles each traced .ts file individually to ESM .js
 *      (esbuild transform, no bundling — same shape as @vercel/node).
 *   3. Writes the tree to `.serverless-test/` together with the repo
 *      package.json ("type": "module"), mimicking /var/task.
 *   4. Boots the compiled app with plain Node (production env) and
 *      exercises the API endpoints.
 *
 * Usage:
 *   node scripts/verify-serverless-build.mjs
 *     DATABASE_URL=postgres://... JWT_SECRET=... \
 *       node scripts/verify-serverless-build.mjs   # + full DB flow
 *
 * Exit code 0 = all checks passed.
 */
import { transformSync } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.serverless-test');
const PORT = Number(process.env.VERIFY_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;

const log = (...a) => console.log(...a);
let failures = 0;
function check(name, cond, detail = '') {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ */
/* 1. Trace the import graph from api/index.ts (nft-style, TS rules)   */
/* ------------------------------------------------------------------ */
function extractRelativeSpecifiers(source) {
  const specs = new Set();
  for (const m of source.matchAll(/\bfrom\s*(['"])(\.\.?\/[^'"]*)\1/g)) specs.add(m[2]);
  for (const m of source.matchAll(/\bimport\s*\(\s*(['"])(\.\.?\/[^'"]*)\1/g)) specs.add(m[2]);
  for (const m of source.matchAll(/(^|\n)\s*import\s+(['"])(\.\.?\/[^'"]*)\2/g)) specs.add(m[3]);
  return [...specs];
}

function resolveTsSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
  ];
  for (const c of candidates) {
    if (existsSync(c) && !c.endsWith('.d.ts')) return c;
  }
  return null;
}

function traceGraph(entryRel) {
  const entry = path.join(root, entryRel);
  const seen = new Set();
  const queue = [entry];
  const tsFiles = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.ts') && !file.endsWith('.d.ts')) tsFiles.push(file);
    const source = readFileSync(file, 'utf8');
    for (const spec of extractRelativeSpecifiers(source)) {
      const resolved = resolveTsSpecifier(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return tsFiles;
}

/* ------------------------------------------------------------------ */
/* 2. Per-file TS -> ESM transpile (like @vercel/node's Babel step)    */
/* ------------------------------------------------------------------ */
function buildServerlessTree() {
  rmSync(outDir, { recursive: true, force: true });
  const tsFiles = traceGraph('api/index.ts');
  const written = [];
  for (const file of tsFiles) {
    const rel = path.relative(root, file);
    const source = readFileSync(file, 'utf8');
    const { code } = transformSync(source, {
      loader: 'ts',
      format: 'esm',
      platform: 'node',
      target: 'node20',
      tsconfigRaw: {
        compilerOptions: {
          experimentalDecorators: true,
          useDefineForClassFields: false,
        },
      },
    });
    const outRel = rel.replace(/\.tsx?$/, '.js');
    const outFile = path.join(outDir, outRel);
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, code);
    written.push(outRel);
  }
  // Root package.json makes the compiled .js files load as ESM,
  // exactly like /var/task/package.json does inside the Lambda.
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  writeFileSync(
    path.join(outDir, 'package.json'),
    JSON.stringify({ name: pkg.name, type: pkg.type }, null, 2)
  );
  // Tiny request-handler wrapper: Vercel wraps the exported Express app the
  // same way and forwards the original request path (/api/...).
  writeFileSync(
    path.join(outDir, 'harness.mjs'),
    `import app from './api/index.js';\n` +
      `const port = Number(process.env.PORT || 4199);\n` +
      `app.listen(port, '0.0.0.0', () => console.log('HARNESS_READY'));\n`
  );
  return written;
}

/* ------------------------------------------------------------------ */
/* 3. Boot the compiled tree with plain Node (production mode)         */
/* ------------------------------------------------------------------ */
function startHarness() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['harness.mjs'], {
      cwd: outDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        VERCEL: '1',
        PORT: String(PORT),
        // Local test-only default; production configures real secrets.
        JWT_SECRET: process.env.JWT_SECRET || 'verify-serverless-build-test-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('HARNESS_READY')) resolve({ child, output: () => out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`harness exited early (code ${code}):\n${out}`)));
    setTimeout(() => reject(new Error(`harness start timed out:\n${out}`)), 30_000);
  });
}

const stopHarness = (h) => h.child.kill('SIGTERM');

/* ------------------------------------------------------------------ */
/* 4. Smoke tests                                                      */
/* ------------------------------------------------------------------ */
async function req(method, p, { body, token } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function main() {
  log('Building Vercel-style per-file ESM output in .serverless-test/ ...');
  const files = buildServerlessTree();
  log(`Compiled ${files.length} TypeScript modules -> ESM .js (no bundling):`);
  for (const f of files) log(`   ${f}`);
  log('');

  const dbConfigured = !!process.env.DATABASE_URL;
  log(`DATABASE_URL ${dbConfigured ? 'set — full DB flow will be tested' : 'NOT set — testing production honesty mode (no silent fallback)'}`);
  log('');

  const h = await startHarness();
  try {
    log('Booted compiled app with Node ESM (NODE_ENV=production, VERCEL=1).');
    log('');

    /* --- Module-resolution / boot checks (DB-agnostic) --- */
    log('A. Module resolution & API boot (must not 500 with ERR_MODULE_NOT_FOUND):');
    const health = await req('GET', '/api/health');
    check('GET /api/health responds 200', health.status === 200, `status=${health.status} body=${JSON.stringify(health.json)}`);

    const dbStatus = await req('GET', '/api/db-status');
    check(
      'GET /api/db-status responds 200 (DB up) or 503 (unconfigured/unreachable)',
      dbStatus.status === 200 || dbStatus.status === 503,
      `status=${dbStatus.status}`
    );

    const loginEmpty = await req('POST', '/api/auth/login', { body: {} });
    check(
      'POST /api/auth/login (empty body) -> 400 validation (production router module loaded)',
      loginEmpty.status === 400,
      `status=${loginEmpty.status} body=${JSON.stringify(loginEmpty.json)}`
    );

    const checkAdminAnon = await req('GET', '/api/users/check-admin');
    check(
      'GET /api/users/check-admin without token -> 401 (auth protection intact)',
      checkAdminAnon.status === 401,
      `status=${checkAdminAnon.status}`
    );

    const notFound = await req('GET', '/api/__does_not_exist__');
    check('GET /api/__does_not_exist__ -> 404 JSON', notFound.status === 404, `status=${notFound.status}`);

    const output = h.output();
    check(
      'server log contains no "Cannot find module"',
      !/Cannot find module/i.test(output)
    );

    /* --- DB-backed flow --- */
    if (dbConfigured) {
      log('');
      log('B. Database-backed flow (Supabase/PostgreSQL via DATABASE_URL):');
      check('GET /api/health reports database connected', health.json?.database === true && health.json?.mode === 'database', JSON.stringify(health.json));
      check('GET /api/db-status connected', dbStatus.json?.connected === true, JSON.stringify(dbStatus.json));

      const stamp = Date.now().toString(36);
      const adminId = `ADM${stamp}`;
      const adminEmail = `admin-${stamp}@leadflow.test`;
      const userId = `BDM${stamp}`;

      const bootstrapStatus = await req('GET', '/api/auth/bootstrap-status');
      check('GET /api/auth/bootstrap-status -> 200', bootstrapStatus.status === 200, JSON.stringify(bootstrapStatus.json));

      const bootstrap = await req('POST', '/api/auth/bootstrap-admin', {
        body: { fullName: 'Verify Admin', employeeId: adminId, email: adminEmail, password: 'verify-pass-123' },
      });
      check(
        'POST /api/auth/bootstrap-admin (first admin) -> 201 Created',
        bootstrap.status === 201 && bootstrap.json?.success === true,
        `status=${bootstrap.status}`
      );

      const badLogin = await req('POST', '/api/auth/login', { body: { employeeId: adminId, password: 'wrong-password' } });
      check('POST /api/auth/login wrong password -> 401', badLogin.status === 401, `status=${badLogin.status}`);

      const login = await req('POST', '/api/auth/login', { body: { employeeId: adminId, password: 'verify-pass-123' } });
      check('POST /api/auth/login (bootstrapped admin) -> 200 + token', login.status === 200 && !!login.json?.token, `status=${login.status}`);

      const checkAdmin = await req('GET', '/api/users/check-admin', { token: login.json?.token });
      check('GET /api/users/check-admin (authenticated) -> {exists:true}', checkAdmin.status === 200 && checkAdmin.json?.exists === true, JSON.stringify(checkAdmin.json));

      const createUser = await req('POST', '/api/users', {
        token: login.json?.token,
        body: { fullName: 'Verify BDM', employeeId: userId, email: `bdm-${stamp}@leadflow.test`, role: 'BDM', password: 'bdm-pass-123' },
      });
      check('POST /api/users (admin creates user) -> 201 persisted', createUser.status === 201, `status=${createUser.status} body=${JSON.stringify(createUser.json)}`);

      // Direct SQL verification that rows were persisted through DATABASE_URL.
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const { rows } = await client.query(
        `SELECT u.employee_id, r.role_code FROM users u JOIN roles r ON r.id = u.role_id
         WHERE UPPER(u.employee_id) IN (UPPER($1), UPPER($2))`,
        [adminId, userId]
      );
      await client.end();
      const byId = Object.fromEntries(rows.map((r) => [String(r.employee_id).toUpperCase(), r.role_code]));
      check(
        'DATABASE_URL persistence verified (admin + user rows in PostgreSQL)',
        byId[adminId.toUpperCase()] === 'ADMIN' && byId[userId.toUpperCase()] === 'BDM',
        JSON.stringify(byId)
      );
    } else {
      log('');
      log('B. Production honesty (no DATABASE_URL):');
      const login = await req('POST', '/api/auth/login', { body: { employeeId: 'someone', password: 'x' } });
      check(
        'POST /api/auth/login -> 503 (no silent in-memory fallback in production)',
        login.status === 503 && /not configured/i.test(String(login.json?.message)),
        `status=${login.status} body=${JSON.stringify(login.json)}`
      );
      check('GET /api/db-status -> 503 db-unconfigured', dbStatus.status === 503 && dbStatus.json?.mode === 'db-unconfigured', `status=${dbStatus.status}`);
    }

    log('');
    const finalOutput = h.output();
    if (/Cannot find module/i.test(finalOutput)) {
      log('--- server log tail ---');
      log(finalOutput.split('\n').slice(-25).join('\n'));
    }
  } finally {
    stopHarness(h);
  }

  log('');
  if (failures) {
    log(`✗ ${failures} check(s) FAILED`);
    process.exit(1);
  }
  log('✓ All checks passed — Vercel-style compiled ESM output verified.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
