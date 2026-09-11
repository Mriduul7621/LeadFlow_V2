/**
 * perf-baseline.ts
 * ------------------------------------------------------------------
 * Development-only performance baseline for the warm, production-like
 * API paths. Boots the REAL production router (api/index.ts) against a
 * real (PGlite) PostgreSQL and measures, over actual HTTP:
 *
 *   A. login request duration (warm)
 *   B. cold session validation duration (GET /api/auth/session)
 *   C. dashboard startup fan-out: every endpoint the browser fires after
 *      a cold authenticated load, individually and as the parallel batch
 *      the browser performs (wall time of the batch)
 *   D. navigation-relevant shared endpoints (roles / permissions /
 *      notifications)
 *
 * It prints a compact summary table + a JSON blob (for docs). It never
 * ships to production: nothing in src/ or server/ imports it, and the
 * Server-Timing / [perf] console output it relies on is the existing
 * production-safe instrumentation (header always, console line only
 * outside production or with PERF_LOGS=1).
 *
 * Usage:  npx tsx scripts/perf-baseline.ts
 *         PERF_ITER=25 npx tsx scripts/perf-baseline.ts
 */
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'pglite://memory';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'leadflow_perf_baseline_secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test'; // enables [perf] logs + Server-Timing
delete process.env.VERCEL;

const ITER = Number(process.env.PERF_ITER || 15);

async function main() {
  const { getPGliteInstanceAsync, createPGlitePoolAsync } = await import('../server/database/pglitePool.js');
  const { _setTestPoolForTest } = await import('../server/database/connection.js');
  const { initializeDatabase } = await import('../server/database/initialize.js');

  await getPGliteInstanceAsync();
  const pool = await createPGlitePoolAsync();
  _setTestPoolForTest(pool);
  await initializeDatabase();

  // ---- seed: one RM (manager) + one RO (reporting to the RM) + leads ---
  const hash = await bcrypt.hash('Base-line1!', 10);
  const roles = (await pool.query(`SELECT id, role_code FROM roles`)).rows;
  const adminRole = roles.find(r => r.role_code === 'ADMIN');
  const rmRole = roles.find(r => r.role_code === 'RM') || roles[roles.length - 1];
  const roRole = roles.find(r => r.role_code === 'RO') || roles[roles.length - 1];

  const mkUser = (empId: string, name: string, role: any) =>
    pool.query(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE, FALSE) RETURNING id`,
      [empId, name, `${empId.toLowerCase()}@leadflow.local`, hash, role.id]
    );
  const adminId = (await mkUser('ADM9100', 'Perf Admin', adminRole)).rows[0].id;
  const rmId = (await mkUser('RM9101', 'Perf RM', rmRole)).rows[0].id;
  const roId = (await mkUser('RO9102', 'Perf RO', roRole)).rows[0].id;
  await pool.query(
    `UPDATE users SET manager_id = (SELECT id FROM users WHERE employee_id = 'RM9101') WHERE employee_id = 'RO9102'`
  );

  // leads assigned to the RO, some with follow-ups due today/tomorrow/overdue
  const now = new Date();
  const todayAt = (h: number) => { const d = new Date(now); d.setHours(h, 30, 0, 0); return d.toISOString(); };
  const inDays = (days: number, h = 10) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  for (let i = 0; i < 40; i++) {
    const next = i % 4 === 0 ? inDays(-2) : i % 4 === 1 ? todayAt(9 + (i % 8)) : i % 4 === 2 ? inDays(1) : null;
    const status = i % 5 === 0 ? 'Untouched' : i % 5 === 1 ? 'Contacted' : i % 5 === 2 ? 'Interested' : i % 5 === 3 ? 'Meeting Fixed' : 'Converted';
    await pool.query(
      `INSERT INTO leads (lead_code, customer_name, mobile, assigned_to, created_by, updated_by, current_status, custom_fields, follow_up_count, next_follow_up_at, is_deleted)
       VALUES ($1, $2, $3, $4, $4, $4, $5, $6::jsonb, 0, $7, FALSE)`,
      [`L${String(i).padStart(4, '0')}`, `Perf Lead ${i}`, `017110000${i}`, roId, status, JSON.stringify({ assignedTo: 'RO9102' }), next]
    );
  }
  // scheduled activities around today (so both the 2-day dashboard window
  // and the 90-day embedded calendar window return rows)
  const leadIds = (await pool.query(`SELECT id FROM leads ORDER BY lead_code`)).rows.map(r => r.id);
  for (let i = 0; i < 25; i++) {
    await pool.query(
      `INSERT INTO scheduled_activities (lead_id, activity_type, scheduled_at, title, status, created_by, created_at, updated_at)
       VALUES ($5, $1, $2, $3, 'scheduled', $4, NOW(), NOW())`,
      [i % 4 === 0 ? 'call' : i % 4 === 1 ? 'meeting' : i % 4 === 2 ? 'follow_up' : 'task',
       inDays(-Math.floor(i / 4), 9 + (i % 8)), `Perf Activity ${i}`, roId, leadIds[i % leadIds.length]]
    );
  }

  // ---- boot the real production app -------------------------------------
  const app: express.Express = (await import('../api/index.js')).default;
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const timed = async (method: string, path: string, { body, token }: { body?: any; token?: string } = {}) => {
    const t0 = process.hrtime.bigint();
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    return { status: res.status, json, ms, serverTiming: res.headers.get('server-timing') || '' };
  };

  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { min: Math.round(s[0]), median: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(s[s.length - 1]) };
  };

  const results: Record<string, any> = {};
  const bench = async (name: string, fn: () => Promise<any>) => {
    const times: number[] = [];
    let last: any = null;
    for (let i = 0; i < ITER; i++) {
      const r = await fn();
      if (r.status >= 500) throw new Error(`${name} -> ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
      times.push(r.ms);
      last = r;
    }
    results[name] = { ...stats(times), serverTiming: last.serverTiming };
  };

  // A. login (warm — pool + process already hot from the bench warm-up below)
  const warmLogin = await timed('POST', '/api/auth/login', { body: { employeeId: 'RO9102', password: 'Base-line1!' } });
  if (warmLogin.status !== 200) throw new Error(`login failed: ${warmLogin.status}`);
  const ro = warmLogin.json.user;
  const roToken = warmLogin.json.token;
  const rmToken = (await timed('POST', '/api/auth/login', { body: { employeeId: 'RM9101', password: 'Base-line1!' } })).json.token;
  void rmToken;

  // generic warm-up so the first measured call is a WARM call
  for (let i = 0; i < 3; i++) {
    await timed('GET', '/api/auth/session', { token: roToken });
    await timed('GET', '/api/dashboard', { token: roToken });
  }

  // A. login duration (warm)
  await bench('A1 POST /api/auth/login (warm)', async () =>
    timed('POST', '/api/auth/login', { body: { employeeId: 'RO9102', password: 'Base-line1!' } }));

  // B. cold session validation
  await bench('B1 GET /api/auth/session', async () => timed('GET', '/api/auth/session', { token: roToken }));

  // C. dashboard startup fan-out (what the browser fires after login/reload)
  await bench('C1 GET /api/dashboard', async () => timed('GET', '/api/dashboard', { token: roToken }));
  await bench('C2 GET /api/leads/follow-ups?bucket=today', async () =>
    timed('GET', '/api/leads/follow-ups?bucket=today&limit=50', { token: roToken }));
  await bench('C3 GET /api/leads/follow-ups?bucket=upcoming', async () =>
    timed('GET', '/api/leads/follow-ups?bucket=upcoming&limit=50', { token: roToken }));
  const dhakaYmd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const calStart = new Date(today); calStart.setDate(calStart.getDate() - 30);
  const calEnd = new Date(today); calEnd.setDate(calEnd.getDate() + 60);
  await bench('C4 GET /api/scheduled-activities (today..tomorrow, dash daily panel)', async () =>
    timed('GET', `/api/scheduled-activities?from=${dhakaYmd(today)}&to=${dhakaYmd(tomorrow)}&limit=100`, { token: roToken }));
  await bench('C5 GET /api/scheduled-activities (90-day window, embedded calendar)', async () =>
    timed('GET', `/api/scheduled-activities?from=${dhakaYmd(calStart)}&to=${dhakaYmd(calEnd)}&limit=200`, { token: roToken }));

  // D. shared session data (AppLayout + usePermissions)
  await bench('D1 GET /api/roles', async () => timed('GET', '/api/roles', { token: roToken }));
  await bench('D2 GET /api/notifications/users/:emp', async () =>
    timed('GET', `/api/notifications/users/${encodeURIComponent(ro.employeeId)}`, { token: roToken }));
  await bench('D3 GET /api/users/:id/permissions', async () =>
    timed('GET', `/api/users/${encodeURIComponent(ro.id)}/permissions`, { token: roToken }));

  // C6. the actual post-login/reload fan-out: everything in PARALLEL, as the
  //     browser fires it. Wall time of the batch == "first dashboard data".
  {
    const batchTimes: number[] = [];
    for (let i = 0; i < ITER; i++) {
      const t0 = process.hrtime.bigint();
      await Promise.all([
        timed('GET', '/api/dashboard', { token: roToken }),
        timed('GET', '/api/leads/follow-ups?bucket=today&limit=50', { token: roToken }),
        timed('GET', '/api/leads/follow-ups?bucket=upcoming&limit=50', { token: roToken }),
        timed('GET', `/api/scheduled-activities?from=${dhakaYmd(today)}&to=${dhakaYmd(tomorrow)}&limit=100`, { token: roToken }),
        timed('GET', `/api/scheduled-activities?from=${dhakaYmd(calStart)}&to=${dhakaYmd(calEnd)}&limit=200`, { token: roToken }),
        timed('GET', '/api/roles', { token: roToken }),
        timed('GET', `/api/notifications/users/${encodeURIComponent(ro.employeeId)}`, { token: roToken }),
        timed('GET', `/api/users/${encodeURIComponent(ro.id)}/permissions`, { token: roToken }),
      ]);
      batchTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    results['C6 dashboard fan-out (8 requests in parallel, wall)'] = stats(batchTimes);
  }

  // E. navigation: a second page (workbench) re-issues follow-ups + scheduled
  //    (the shared roles/notifs/permissions are session-cached: 0 requests)
  await bench('E1 workbench fan-out (follow-ups + scheduled, parallel wall)', async () => {
    const t0 = process.hrtime.bigint();
    await Promise.all([
      timed('GET', '/api/leads/follow-ups?bucket=overdue&limit=50', { token: roToken }),
      timed('GET', '/api/leads/follow-ups?bucket=today&limit=50', { token: roToken }),
      timed('GET', `/api/scheduled-activities?from=${dhakaYmd(today)}&to=${dhakaYmd(tomorrow)}&limit=100`, { token: roToken }),
    ]);
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: 200, serverTiming: '' };
  });

  console.log('\n=== PERF BASELINE (warm, PGlite, localhost; ITER=%d) ===', ITER);
  for (const [name, r] of Object.entries(results)) {
    const rt = r.serverTiming ? `  [server-timing: ${r.serverTiming}]` : '';
    console.log(`${name}\n    min ${r.min}ms | median ${r.median}ms | p95 ${r.p95}ms | max ${r.max}ms${rt}`);
  }
  console.log('\n=== JSON ===');
  console.log(JSON.stringify(results, null, 2));

  server.close();
  process.exit(0);
}

main().catch(err => {
  console.error('perf-baseline failed:', err);
  process.exit(1);
});
