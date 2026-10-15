/**
 * perf-roundtrip-audit.ts — reproducible latency audit (development only)
 * ------------------------------------------------------------------
 * What it answers: "the server says 1.6 s, the user waits 45 s — which
 * layer is actually burning the time?" It boots the REAL production app
 * (api/index.ts → production.routes.ts) on an in-process PostgreSQL
 * (PGlite), seeds a production-shaped dataset, then measures every request
 * the browser fires during a first dashboard load:
 *
 *   - DB round trips per request  (the number that multiplies by RTT)
 *   - wall time with a SIMULATED DB round-trip latency (DB_RTT_MS)
 *   - response bytes and gzip bytes (what actually crosses the mobile link)
 *
 * Why simulate latency: PGlite runs in-process, so an unmodified run
 * reports ~0 ms per round trip and hides the one thing that matters on
 * Vercel → Supabase (10-100 ms per round trip). Adding a fixed delay per
 * query turns every result into an honest "round trips × RTT" model.
 *
 * Usage
 *   DB_RTT_MS=30 npx tsx scripts/perf-roundtrip-audit.ts
 *   DB_RTT_MS=60 DB_LEADS=2000 npx tsx scripts/perf-roundtrip-audit.ts
 *   npx tsx scripts/perf-roundtrip-audit.ts --out docs/perf-numbers.md
 *
 * Never touches a production database: DATABASE_URL is forced to
 * pglite://memory before any server module is imported.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import bcrypt from 'bcryptjs';

process.env.DATABASE_URL = 'pglite://memory';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'leadflow_perf_audit_secret';
process.env.NODE_ENV = 'test';
// Keep stdout readable: one line per measurement is enough.
process.env.OBSERVABILITY_LOG_LEVEL = process.env.OBSERVABILITY_LOG_LEVEL || 'error';
delete process.env.VERCEL;

const RTT_MS = Number(process.env.DB_RTT_MS || 30);
const LEAD_COUNT = Number(process.env.DB_LEADS || 1500);
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > -1 ? process.argv[i + 1] : null;
})();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Measurement {
  name: string;
  path: string;
  ms: number;
  roundTrips: number;
  bytes: number;
  gzipBytes: number;
  status: number;
}

async function main() {
  const { getPGliteInstanceAsync, createPGlitePoolAsync } = await import('../server/database/pglitePool.js');
  await getPGliteInstanceAsync();
  const pool: any = await createPGlitePoolAsync();

  // ---- instrument the pool: count round trips + simulate remote RTT ----
  const originalQuery = pool.query.bind(pool);
  let roundTrips = 0;
  pool.query = async (sql: string, params?: any[]) => {
    roundTrips += 1;
    if (RTT_MS > 0) await sleep(RTT_MS);
    return originalQuery(sql, params);
  };

  const { _setTestPoolForTest } = await import('../server/database/connection.js');
  _setTestPoolForTest(pool);

  // ---- schema (ledger-backed migrations) -------------------------------
  const { initializeDatabase } = await import('../server/database/initialize.js');
  const coldStart = { first: { roundTrips: 0, ms: 0 }, warm: { roundTrips: 0, ms: 0 } };
  {
    roundTrips = 0;
    const t0 = Date.now();
    await initializeDatabase();
    coldStart.first = { roundTrips, ms: Date.now() - t0 };

    roundTrips = 0;
    const t1 = Date.now();
    await initializeDatabase();
    coldStart.warm = { roundTrips, ms: Date.now() - t1 };
  }

  // ---- seed a production-shaped dataset --------------------------------
  const hash = await bcrypt.hash('Perf-audit1!', 10);
  const roles = (await originalQuery(`SELECT id, role_code FROM roles`)).rows;
  const rmRole = roles.find((r: any) => r.role_code === 'RM') || roles[roles.length - 1];
  const roRole = roles.find((r: any) => r.role_code === 'RO') || roles[roles.length - 1];

  const mkUser = (empId: string, name: string, role: any) =>
    originalQuery(
      `INSERT INTO users (employee_id, full_name, email, password, role_id, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE, FALSE) RETURNING id`,
      [empId, name, `${empId.toLowerCase()}@leadflow.local`, hash, role.id]
    );
  await mkUser('ADM9100', 'Audit Admin', roles.find((r: any) => r.role_code === 'ADMIN'));
  await mkUser('RM9101', 'Audit RM', rmRole);
  const roId = (await mkUser('RO9102', 'Audit RO', roRole)).rows[0].id;
  await originalQuery(
    `UPDATE users SET manager_id = (SELECT id FROM users WHERE employee_id = 'RM9101') WHERE employee_id = 'RO9102'`
  );

  // Grant every seeded permission to the RM/RO roles so the audited reads
  // exercise the real query path instead of failing closed on 403.
  for (const role of [rmRole, roRole]) {
    await originalQuery(
      `INSERT INTO role_permissions (role_id, permission_id, is_allowed)
       SELECT $1, p.id, TRUE FROM permissions p
       ON CONFLICT DO NOTHING`,
      [role.id]
    );
  }

  const now = new Date();
  const at = (days: number, hour = 10) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 30, 0, 0);
    return d.toISOString();
  };
  const statuses = ['New', 'Contacted', 'Interested', 'Meeting Fixed', 'Follow-up Set', 'Converted', 'No Response', 'Busy'];
  const insertLead = (i: number) =>
    originalQuery(
      `INSERT INTO leads (lead_code, customer_name, mobile, email, area, occupation, priority, assigned_to, created_by, updated_by,
                          current_status, custom_fields, follow_up_count, next_follow_up_at, last_contacted_at, expected_premium, expected_value,
                          is_deleted, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,FALSE,$16)`,
      [
        `AUD${String(i).padStart(5, '0')}`,
        `Audit Prospect ${i}`,
        `0171${String(1000000 + i)}`,
        `prospect${i}@example.com`,
        ['Dhaka', 'Chattogram', 'Sylhet', 'Khulna'][i % 4],
        ['Service', 'Business', 'Engineer', 'Teacher'][i % 4],
        ['High', 'Medium', 'Low'][i % 3],
        roId,
        statuses[i % statuses.length],
        JSON.stringify({
          campaignName: `Campaign ${i % 5}`,
          productName: `Product ${i % 4}`,
          projectedNCP: String(50000 + (i % 20) * 5000),
          collectedNCP: i % 6 === 0 ? String(25000 + (i % 10) * 1000) : '0',
          sumAssured: String(1000000 + (i % 30) * 50000),
        }),
        i % 5,
        i % 4 === 0 ? at(-2) : i % 4 === 1 ? at(0, 9 + (i % 8)) : i % 4 === 2 ? at(1) : null,
        i % 3 === 0 ? at(-3) : null,
        String(50000 + (i % 20) * 5000),
        String(1000000 + (i % 30) * 50000),
        at(-((i % 60) + 1)),
      ]
    );

  for (let i = 0; i < LEAD_COUNT; i++) await insertLead(i);

  const leadIds = (await originalQuery(`SELECT id FROM leads ORDER BY lead_code`)).rows.map((r: any) => r.id);
  // Activity + scheduled history: the lead-quality signals read these.
  for (let i = 0; i < Math.min(leadIds.length, 1200); i++) {
    await originalQuery(
      `INSERT INTO lead_activities (lead_id, activity_type, status, remarks, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [leadIds[i], i % 3 === 0 ? 'call' : i % 3 === 1 ? 'meeting' : 'note',
       i % 6 === 0 ? 'No Response' : 'Completed', `Audit log ${i}`, roId, at(-(i % 30))]
    );
  }
  for (let i = 0; i < 400; i++) {
    await originalQuery(
      `INSERT INTO scheduled_activities (lead_id, activity_type, scheduled_at, title, status, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [leadIds[i % leadIds.length], i % 2 === 0 ? 'call' : 'meeting', at(-(i % 10), 9 + (i % 8)),
       `Audit activity ${i}`, i % 5 === 0 ? 'completed' : 'scheduled', roId]
    );
  }

  // ---- boot the real app ----------------------------------------------
  const app: any = (await import('../api/index.js')).default;
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ employeeId: 'RO9102', password: 'Perf-audit1!' }),
  });
  const loginBody: any = await login.json();
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(loginBody).slice(0, 200)}`);
  const token = loginBody.token;

  const call = async (path: string, method = 'GET'): Promise<Measurement> => {
    roundTrips = 0;
    const t0 = Date.now();
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    const ms = Date.now() - t0;
    const bytes = Buffer.byteLength(text);
    let gzipBytes = 0;
    try { gzipBytes = zlib.gzipSync(Buffer.from(text), { level: 6 }).length; } catch { gzipBytes = 0; }
    return { name: '', path, ms, roundTrips, bytes, gzipBytes, status: res.status };
  };

  const measure = async (name: string, path: string, method = 'GET'): Promise<Measurement> => {
    const first = await call(path, method); // warm-up (connection + plan)
    const runs = [first];
    for (let i = 0; i < 3; i++) runs.push(await call(path, method));
    const best = runs.reduce((a, b) => (b.ms < a.ms ? b : a));
    const result = { ...best, name };
    if (best.status >= 400) {
      console.warn(`  ! ${path} -> HTTP ${best.status}`);
    }
    return result;
  };

  const dhakaYmd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const calStart = new Date(today); calStart.setDate(calStart.getDate() - 30);
  const calEnd = new Date(today); calEnd.setDate(calEnd.getDate() + 60);

  console.log(`\nAuditing with simulated DB round-trip latency = ${RTT_MS} ms, ${LEAD_COUNT} leads\n`);

  const results: Measurement[] = [];
  results.push(await measure('Dashboard KPI', '/api/dashboard'));
  results.push(await measure('Follow-ups: today', '/api/leads/follow-ups?bucket=today&limit=50'));
  results.push(await measure('Follow-ups: upcoming', '/api/leads/follow-ups?bucket=upcoming&limit=50'));
  results.push(await measure('Follow-ups: overdue', '/api/leads/follow-ups?bucket=overdue&limit=50'));
  results.push(await measure('Follow-ups: all (workbench)', '/api/leads/follow-ups?bucket=all&limit=200'));
  results.push(await measure('Scheduled activities (2-day)', `/api/scheduled-activities?from=${dhakaYmd(today)}&to=${dhakaYmd(tomorrow)}&limit=100`));
  results.push(await measure('Scheduled activities (90-day)', `/api/scheduled-activities?from=${dhakaYmd(calStart)}&to=${dhakaYmd(calEnd)}&limit=200`));
  results.push(await measure('Lead list (max page)', '/api/leads'));
  results.push(await measure('Roles', '/api/roles'));
  results.push(await measure('Own permission sheet', `/api/users/${encodeURIComponent(loginBody.user.id)}/permissions`));
  results.push(await measure('Notifications', `/api/notifications/users/${encodeURIComponent(loginBody.user.employeeId)}`));
  results.push(await measure('Options', '/api/options'));

  // ---- first-load burst: everything the Dashboard fires, in parallel ---
  const burstPaths = [
    '/api/dashboard',
    '/api/leads/follow-ups?bucket=today&limit=50',
    '/api/leads/follow-ups?bucket=upcoming&limit=50',
    `/api/scheduled-activities?from=${dhakaYmd(today)}&to=${dhakaYmd(tomorrow)}&limit=100`,
    '/api/roles',
    `/api/users/${encodeURIComponent(loginBody.user.id)}/permissions`,
    `/api/options`,
  ];
  const burstTimes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await Promise.all(burstPaths.map(p => call(p)));
    burstTimes.push(Date.now() - t0);
  }
  const burstMs = Math.min(...burstTimes);

  // ---- report ----------------------------------------------------------
  const lines: string[] = [];
  const push = (s = '') => { lines.push(s); console.log(s); };

  push(`| Endpoint | DB round trips | Wall (ms @ ${RTT_MS} ms RTT) | Payload | gzip |`);
  push('| --- | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    push(`| \`${r.path}\` | ${r.roundTrips} | ${r.ms} | ${(r.bytes / 1024).toFixed(1)} KiB | ${(r.gzipBytes / 1024).toFixed(1)} KiB |`);
  }
  push();
  push(`First-load burst (${burstPaths.length} parallel requests): ${burstMs} ms`);
  push();
  push(`Cold start (migrations + seeds on an already-current schema): ${coldStart.warm.roundTrips} round trips, ${coldStart.warm.ms} ms simulated`);
  push(`Cold start (virgin database, one time only): ${coldStart.first.roundTrips} round trips, ${coldStart.first.ms} ms simulated`);

  const payload = {
    dbRttMs: RTT_MS,
    leads: LEAD_COUNT,
    coldStart,
    burstMs,
    endpoints: results,
  };

  if (OUT) {
    const fs = await import('node:fs');
    const markdown = `<!-- generated by scripts/perf-roundtrip-audit.ts — DB_RTT_MS=${RTT_MS}, leads=${LEAD_COUNT} -->\n\n` +
      lines.join('\n') + '\n\n```json\n' + JSON.stringify(payload, null, 2) + '\n```\n';
    fs.writeFileSync(OUT, markdown);
    console.log(`\nWrote ${OUT}`);
  }

  server.close();
  process.exit(0);
}

main().catch(error => {
  console.error('perf-roundtrip-audit failed:', error);
  process.exit(1);
});
