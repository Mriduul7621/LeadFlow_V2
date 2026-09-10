#!/usr/bin/env node
/**
 * verify-hierarchy-rbac.mjs
 * ------------------------------------------------------------------
 * End-to-end verification of the company-wide reporting ladder and
 * server-side data-visibility scoping, run against the same
 * Vercel-equivalent per-file ESM build used by
 * scripts/verify-serverless-build.mjs.
 *
 * Scenario (exact model requested by the product owner):
 *
 *   CEO (Level 1, no manager, cross-department root)
 *     ├── Retail Head (Level 2, reports to CEO)
 *     │     ├── Retail Manager A (Level 3)
 *     │     │     └── Executive X (Level 4)
 *     │     └── Retail Manager B (Level 3)
 *     │           └── Executive Y (Level 4)
 *     ├── Corporate Head (Level 2, reports to CEO)
 *     │     └── Corporate Manager (Level 3)
 *     └── Back Office Head (Level 2, reports to CEO)
 *
 * Rules verified:
 *   1. One company-wide ladder (Level 1..N) configured by the admin.
 *   2. Every employee reports to exactly ONE manager one level up.
 *   3. Same-department managers only (exception: everyone at Level 2
 *      reports to the Level-1 CEO).
 *   4. Same-role employees in different branches cannot see each
 *      other's data (DownTeam = own subtree only).
 *   5. No reporting connection -> no data visibility.
 *   6. ADMIN sees everything; Own sees only their own rows.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/verify-hierarchy-rbac.mjs
 * Exit code 0 = all checks passed.
 */
import { transformSync } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.serverless-test');
const PORT = Number(process.env.VERIFY_PORT || 4211);
const BASE = `http://127.0.0.1:${PORT}`;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set for the hierarchy RBAC verification.');
  process.exit(1);
}

const log = (...a) => console.log(...a);
let failures = 0;
function check(name, cond, detail = '') {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ---------------- Vercel-equivalent build (shared approach) --------- */
function extractRelativeSpecifiers(source) {
  const specs = new Set();
  for (const m of source.matchAll(/\bfrom\s*(['"])(\.\.?\/[^'"]*)\1/g)) specs.add(m[2]);
  for (const m of source.matchAll(/\bimport\s*\(\s*(['"])(\.\.?\/[^'"]*)\1/g)) specs.add(m[2]);
  for (const m of source.matchAll(/(^|\n)\s*import\s+(['"])(\.\.?\/[^'"]*)\2/g)) specs.add(m[3]);
  return [...specs];
}
function resolveTsSpecifier(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`];
  for (const c of candidates) if (existsSync(c) && !c.endsWith('.d.ts')) return c;
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
function buildServerlessTree() {
  rmSync(outDir, { recursive: true, force: true });
  const tsFiles = traceGraph('api/index.ts');
  for (const file of tsFiles) {
    const rel = path.relative(root, file);
    const { code } = transformSync(readFileSync(file, 'utf8'), {
      loader: 'ts', format: 'esm', platform: 'node', target: 'node20',
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    const outFile = path.join(outDir, rel.replace(/\.tsx?$/, '.js'));
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, code);
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ name: pkg.name, type: pkg.type }));
  writeFileSync(path.join(outDir, 'harness.mjs'),
    `import app from './api/index.js';\napp.listen(${PORT}, '0.0.0.0', () => console.log('HARNESS_READY'));\n`);
}
function startHarness() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['harness.mjs'], {
      cwd: outDir,
      env: { ...process.env, NODE_ENV: 'production', VERCEL: '1', PORT: String(PORT), JWT_SECRET: process.env.JWT_SECRET || 'hierarchy-rbac-test-secret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => { out += d.toString(); if (out.includes('HARNESS_READY')) resolve({ child, output: () => out }); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`harness exited early (code ${code}):\n${out}`)));
    setTimeout(() => reject(new Error(`harness start timed out:\n${out}`)), 60_000);
  });
}

/* ---------------- HTTP helpers ------------------------------------- */
async function req(method, p, { body, token } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const stamp = Date.now().toString(36).toUpperCase();

async function main() {
  log('Building Vercel-equivalent per-file ESM output...');
  buildServerlessTree();
  const h = await startHarness();
  log('Harness booted (production mode).\n');

  const tokens = {};
  const login = async (employeeId) => {
    const r = await req('POST', '/api/auth/login', { body: { employeeId, password: 'verify-pass-123' } });
    if (r.status !== 200) throw new Error(`login failed for ${employeeId}: ${JSON.stringify(r.json)}`);
    tokens[employeeId] = r.json.token;
    return r.json.token;
  };

  try {
    /* ---------------- 0. Bootstrap admin ---------------- */
    log('A. Bootstrap & ladder configuration:');
    const adminId = `ADM${stamp}`;
    await req('POST', '/api/auth/bootstrap-admin', { body: { fullName: 'Verify Admin', employeeId: adminId, email: `admin-${stamp}@leadflow.test`, password: 'verify-pass-123' } });
    await login(adminId);
    const admin = tokens[adminId];

    // Departments
    const mkDept = async (name) => {
      const r = await req('POST', '/api/departments', { token: admin, body: { name: `${name} ${stamp}` } });
      if (r.status !== 200 && r.status !== 201) throw new Error(`department create failed: ${JSON.stringify(r.json)}`);
      return r.json.id;
    };
    const retailDept = await mkDept('Retail');
    const corpDept = await mkDept('Corporate');
    const backDept = await mkDept('Back Office');

    // Roles via POST /roles (upsert), then ladder via PUT /hierarchy-config
    const roleDefs = [
      { roleId: 'CEO', roleName: 'Chief Executive Officer', hierarchyLevel: 1, dataVisibility: 'Organization' },
      { roleId: 'DEPT_HEAD', roleName: 'Department Head', hierarchyLevel: 2, dataVisibility: 'DownTeam' },
      { roleId: 'MANAGER', roleName: 'Manager', hierarchyLevel: 3, dataVisibility: 'DownTeam' },
      { roleId: 'EXECUTIVE', roleName: 'Executive', hierarchyLevel: 4, dataVisibility: 'Own' },
      { roleId: 'BACK_OFFICE', roleName: 'Back Office Staff', hierarchyLevel: 2, dataVisibility: 'Organization' },
    ];
    for (const role of roleDefs) {
      const r = await req('POST', '/api/roles', { token: admin, body: role });
      check(`POST /api/roles ${role.roleId} -> saved`, r.status === 200, `status=${r.status}`);
    }
    // Assign the full ladder: our roles at levels 1..4 and every other
    // (auto-seeded) business role switched OFF (level 0 = unassigned).
    const rolesList = await req('GET', '/api/roles', { token: admin });
    const allRoleIds = (rolesList.json || [])
      .map(r => String(r.roleId).toUpperCase())
      .filter(id => !['ADMIN', 'SUPERADMIN'].includes(id));
    const assignmentMap = new Map(roleDefs.map(r => [r.roleId.toUpperCase(), r.hierarchyLevel]));
    const ladderBody = allRoleIds.map(id => ({ roleId: id, level: assignmentMap.get(id) ?? 0 }));
    const ladder = await req('PUT', '/api/hierarchy-config', {
      token: admin,
      body: { assignments: ladderBody },
    });
    check('PUT /api/hierarchy-config -> 200', ladder.status === 200 && ladder.json?.success === true, `status=${ladder.status}`);
    const cfg = ladder.json?.data;
    check('Ladder has 4 levels (1..4)', Array.isArray(cfg?.levels) && cfg.levels.length === 4, JSON.stringify(cfg?.levels?.map(l => l.level)));
    check('Level 1 = CEO role', cfg?.levels?.[0]?.roles?.some(r => r.roleId === 'CEO') === true);
    check('ADMIN excluded from the business ladder', !JSON.stringify(cfg).includes('"roleId":"ADMIN"'));

    /* ---------------- 1. Create the org ---------------- */
    log('\nB. Employee creation with reporting links:');
    const createUser = async (employeeId, fullName, role, departmentId, managerEmployeeId, expectStatus = 201) => {
      const r = await req('POST', '/api/users', {
        token: admin,
        body: { fullName, employeeId, email: `${employeeId.toLowerCase()}@leadflow.test`, role, departmentId, managerId: managerEmployeeId || '', password: 'verify-pass-123' },
      });
      check(`POST /api/users ${employeeId} (${role}${managerEmployeeId ? ` → ${managerEmployeeId}` : ''}) -> ${expectStatus}`, r.status === expectStatus,
        `status=${r.status}${r.status !== expectStatus ? ` body=${JSON.stringify(r.json)}` : ''}`);
      return r;
    };

    const CEO = `CEO${stamp}`;
    const RETAIL_HEAD = `RHD${stamp}`;
    const CORP_HEAD = `CHD${stamp}`;
    const BACK_HEAD = `BKH${stamp}`;
    const MGR_A = `MGA${stamp}`;
    const MGR_B = `MGB${stamp}`;
    const CORP_MGR = `CMG${stamp}`;
    const EXEC_X = `EXX${stamp}`;
    const EXEC_Y = `EXY${stamp}`;

    await createUser(CEO, 'Verify CEO', 'CEO', retailDept, null); // Level 1: no manager
    await createUser(RETAIL_HEAD, 'Retail Head', 'DEPT_HEAD', retailDept, CEO); // Level 2 -> CEO (cross-dept link OK at L1)
    await createUser(CORP_HEAD, 'Corporate Head', 'DEPT_HEAD', corpDept, CEO);
    await createUser(BACK_HEAD, 'Back Office Head', 'BACK_OFFICE', backDept, CEO);
    await createUser(MGR_A, 'Retail Manager A', 'MANAGER', retailDept, RETAIL_HEAD);
    await createUser(MGR_B, 'Retail Manager B', 'MANAGER', retailDept, RETAIL_HEAD);
    await createUser(CORP_MGR, 'Corporate Manager', 'MANAGER', corpDept, CORP_HEAD);
    await createUser(EXEC_X, 'Executive X', 'EXECUTIVE', retailDept, MGR_A);
    await createUser(EXEC_Y, 'Executive Y', 'EXECUTIVE', retailDept, MGR_B);

    /* ---------------- 2. Negative validation cases ---------------- */
    log('\nC. Reporting-link validation (must reject):');
    // Same-level manager
    await createUser(`BAD1${stamp}`, 'Bad Same Level', 'EXECUTIVE', retailDept, EXEC_X, 400);
    // Manager two levels up
    await createUser(`BAD2${stamp}`, 'Bad Two Levels', 'EXECUTIVE', retailDept, RETAIL_HEAD, 400);
    // Cross-department manager (Corporate manager for a Retail executive)
    await createUser(`BAD3${stamp}`, 'Bad Cross Dept', 'EXECUTIVE', retailDept, CORP_MGR, 400);
    // CEO with a manager
    await createUser(`BAD4${stamp}`, 'Bad CEO Manager', 'CEO', corpDept, CORP_HEAD, 400);
    // Missing manager for a ladder role
    await createUser(`BAD5${stamp}`, 'Bad No Manager', 'EXECUTIVE', retailDept, null, 400);
    // Cycle: Manager A re-assigned to report to Executive X (their subordinate)
    const cycle = await req('PUT', `/api/users/${MGR_A}`, {
      token: admin,
      body: { managerId: EXEC_X },
    });
    check(`PUT /api/users cycle (Manager A -> Executive X) -> 400`, cycle.status === 400, `status=${cycle.status} body=${JSON.stringify(cycle.json)}`);
    // Self-reporting
    const selfReport = await req('PUT', `/api/users/${MGR_A}`, {
      token: admin,
      body: { managerId: MGR_A },
    });
    check('PUT /api/users self-reporting -> 400', selfReport.status === 400, `status=${selfReport.status} body=${JSON.stringify(selfReport.json)}`);

    /* ---------------- 3. Reporting-options endpoint ---------------- */
    log('\nD. Reporting-options dropdown source:');
    const optsMgr = await req('GET', `/api/users/reporting-options?role=MANAGER&departmentId=${retailDept}`, { token: admin });
    check('MANAGER in Retail sees only DEPT_HEAD (Retail Head) as candidate', optsMgr.status === 200 && optsMgr.json?.length === 1 && optsMgr.json[0].employeeId === RETAIL_HEAD, JSON.stringify(optsMgr.json?.map(o => o.employeeId)));
    const optsCeo = await req('GET', `/api/users/reporting-options?role=CEO`, { token: admin });
    check('CEO has no candidates (Level 1)', optsCeo.status === 200 && optsCeo.json?.length === 0);
    const optsExec = await req('GET', `/api/users/reporting-options?role=EXECUTIVE&departmentId=${corpDept}`, { token: admin });
    check('EXECUTIVE in Corporate sees only Corporate Manager', optsExec.status === 200 && optsExec.json?.length === 1 && optsExec.json[0].employeeId === CORP_MGR);

    /* ---------------- 4. Organogram ---------------- */
    log('\nE. Auto-generated organogram:');
    const org = await req('GET', '/api/organogram', { token: admin });
    check('GET /api/organogram -> 200', org.status === 200);
    const nodes = org.json?.nodes || [];
    const byId = Object.fromEntries(nodes.map(n => [n.employeeId, n]));
    check('CEO is a root', (org.json?.roots || []).includes(CEO));
    check('Retail Head reports to CEO', byId[RETAIL_HEAD]?.managerEmployeeId === CEO);
    check('Executive X reports to Manager A', byId[EXEC_X]?.managerEmployeeId === MGR_A);
    check('CEO directReports = 3 heads', byId[CEO]?.directReports === 3, `directReports=${byId[CEO]?.directReports}`);
    check('Single root: the CEO (system ADMIN excluded from the business tree)', (org.json?.roots || []).length === 1 && org.json.roots[0] === CEO, JSON.stringify(org.json?.roots));
    check('System ADMIN account not part of the organogram', !nodes.some(n => String(n.roleId).toUpperCase() === 'ADMIN'));

    /* ---------------- 5. Server-side data scoping ---------------- */
    log('\nF. Leads + server-side visibility scoping:');
    const mkLead = async (employeeId, code) => req('POST', '/api/leads', {
      token: admin,
      body: { leadCode: code, customerName: `Customer ${code}`, mobile: '01700000000', assignedTo: employeeId, currentStatus: 'Untouched' },
    });
    await mkLead(EXEC_X, `LX${stamp}`);
    await mkLead(EXEC_Y, `LY${stamp}`);
    await mkLead(MGR_A, `LA${stamp}`);
    await mkLead(CORP_MGR, `LC${stamp}`);

    const leadsOf = async (employeeId) => {
      const r = await req('GET', '/api/leads', { token: tokens[employeeId] });
      if (r.status !== 200) throw new Error(`leads fetch failed for ${employeeId}: ${r.status}`);
      return r.json.map(l => l.leadCode || l.id);
    };

    await login(MGR_A); await login(MGR_B); await login(EXEC_X); await login(CORP_HEAD); await login(RETAIL_HEAD);

    const mgrALeads = await leadsOf(MGR_A);
    check('Manager A (DownTeam) sees own + Executive X leads only', mgrALeads.includes(`LA${stamp}`) && mgrALeads.includes(`LX${stamp}`) && !mgrALeads.includes(`LY${stamp}`) && !mgrALeads.includes(`LC${stamp}`), JSON.stringify(mgrALeads));

    const mgrBLeads = await leadsOf(MGR_B);
    check('Manager B (DownTeam) sees own + Executive Y leads only', mgrBLeads.includes(`LY${stamp}`) && !mgrBLeads.includes(`LX${stamp}`) && !mgrBLeads.includes(`LA${stamp}`), JSON.stringify(mgrBLeads));

    const execXLeads = await leadsOf(EXEC_X);
    check('Executive X (Own) sees only own lead — not same-role Executive Y', execXLeads.includes(`LX${stamp}`) && !execXLeads.includes(`LY${stamp}`) && !execXLeads.includes(`LA${stamp}`), JSON.stringify(execXLeads));

    const corpHeadLeads = await leadsOf(CORP_HEAD);
    check('Corporate Head cannot see Retail leads (no reporting connection)', !corpHeadLeads.includes(`LX${stamp}`) && !corpHeadLeads.includes(`LY${stamp}`) && !corpHeadLeads.includes(`LA${stamp}`), JSON.stringify(corpHeadLeads));

    const retailHeadLeads = await leadsOf(RETAIL_HEAD);
    check('Retail Head (DownTeam) sees the whole Retail subtree', retailHeadLeads.includes(`LX${stamp}`) && retailHeadLeads.includes(`LY${stamp}`) && retailHeadLeads.includes(`LA${stamp}`) && !retailHeadLeads.includes(`LC${stamp}`), JSON.stringify(retailHeadLeads));

    const adminLeads = await leadsOf(adminId);
    check('ADMIN sees all leads', [`LX${stamp}`, `LY${stamp}`, `LA${stamp}`, `LC${stamp}`].every(c => adminLeads.includes(c)), JSON.stringify(adminLeads));

    /* ---------------- 6. Dashboard scoping ---------------- */
    const dashA = await req('GET', '/api/dashboard', { token: tokens[MGR_A] });
    const dashB = await req('GET', '/api/dashboard', { token: tokens[MGR_B] });
    check('Dashboard: Manager A userCount = 2 (self + Exec X)', dashA.json?.data?.userCount === 2, JSON.stringify(dashA.json?.data));
    check('Dashboard: Manager B userCount = 2 (self + Exec Y)', dashB.json?.data?.userCount === 2, JSON.stringify(dashB.json?.data));

    /* ---------------- 7. Reporting chains on users ---------------- */
    log('\nG. Server-computed reporting chains:');
    const usersR = await req('GET', '/api/users', { token: admin });
    const allUsers = usersR.json || [];
    const execXUser = allUsers.find(u => u.employeeId === EXEC_X);
    check('Executive X reportingChain = [MGR_A, RETAIL_HEAD, CEO]',
      JSON.stringify(execXUser?.reportingChain) === JSON.stringify([MGR_A, RETAIL_HEAD, CEO]), JSON.stringify(execXUser?.reportingChain));
    check('Retail Head subordinates include both managers and both executives',
      [MGR_A, MGR_B, EXEC_X, EXEC_Y].every(id => (allUsers.find(u => u.employeeId === RETAIL_HEAD)?.subordinates || []).includes(id)),
      JSON.stringify(allUsers.find(u => u.employeeId === RETAIL_HEAD)?.subordinates));
    check('Users response exposes hierarchyLevel', typeof execXUser?.hierarchyLevel === 'number' && execXUser?.hierarchyLevel === 4, `level=${execXUser?.hierarchyLevel}`);

    /* ---------------- 8. Setup stats (missing-manager business rule) ---------------- */
    const cfg2 = await req('GET', '/api/hierarchy-config', { token: admin });
    const setup2 = cfg2.json?.setup || {};
    check('CEO (Level 1) without a manager is NOT counted as missing', setup2.usersWithoutManager === 0, `withoutManager=${setup2.usersWithoutManager}`);
    check('managerRequired counts only Level 2+ employees (8 of 9 ladder users)', setup2.managerRequired === 8 && setup2.totalUsers === 9, `total=${setup2.totalUsers} required=${setup2.managerRequired}`);
    check('All Level-2+ employees have their reporting manager', setup2.usersWithManager === 8, `with=${setup2.usersWithManager}`);
    check('No invalid links in the clean scenario (a manager-less CEO is a valid root)', (setup2.invalidLinks || []).length === 0, JSON.stringify(setup2.invalidLinks));

    /* ---------------- 9. Missing-manager calculation ---------------- */
    log('\nH. Missing-manager calculation (Level 1 CEO exempt, Level 2+ counted):');
    // POST /users enforces the manager requirement for ladder roles; an admin
    // PUT (edit) may clear a manager — e.g. while re-linking an employee —
    // and the config must then count exactly the Level 2+ employees.
    const clearHead = await req('PUT', `/api/users/${RETAIL_HEAD}`, { token: admin, body: { managerId: '' } });
    check('PUT /api/users can clear a manager (re-linking use case)', clearHead.status === 200, `status=${clearHead.status} body=${JSON.stringify(clearHead.json)}`);
    const cfgH1 = await req('GET', '/api/hierarchy-config', { token: admin });
    const h1 = cfgH1.json?.setup || {};
    check('Level-2 employee (Retail Head) without a manager IS counted as missing',
      h1.usersWithoutManager === 1 && (h1.invalidLinks || []).some(l => l.employeeId === RETAIL_HEAD && /no reporting manager/i.test(l.reason || '')),
      `withoutManager=${h1.usersWithoutManager} links=${JSON.stringify(h1.invalidLinks)}`);

    const clearExec = await req('PUT', `/api/users/${EXEC_X}`, { token: admin, body: { managerId: '' } });
    check('PUT /api/users clears Executive X manager (Level 4)', clearExec.status === 200, `status=${clearExec.status}`);
    const cfgH2 = await req('GET', '/api/hierarchy-config', { token: admin });
    const h2 = cfgH2.json?.setup || {};
    check('Level-4 employee without a manager is also counted (missing = 2)',
      h2.usersWithoutManager === 2 && (h2.invalidLinks || []).some(l => l.employeeId === EXEC_X),
      `withoutManager=${h2.usersWithoutManager} links=${JSON.stringify(h2.invalidLinks)}`);
    check('CEO (Level 1, no manager) still NOT counted while others are missing',
      h2.totalUsers === 9 && h2.managerRequired === 8 && h2.usersWithManager === 6,
      `total=${h2.totalUsers} required=${h2.managerRequired} with=${h2.usersWithManager}`);

    const restoreHead = await req('PUT', `/api/users/${RETAIL_HEAD}`, { token: admin, body: { managerId: CEO } });
    const restoreExec = await req('PUT', `/api/users/${EXEC_X}`, { token: admin, body: { managerId: MGR_A } });
    check('Correction accepted (Retail Head -> CEO, Executive X -> Manager A)', restoreHead.status === 200 && restoreExec.status === 200, `${restoreHead.status}/${restoreExec.status}`);
    const cfgH3 = await req('GET', '/api/hierarchy-config', { token: admin });
    check('Missing count returns to 0 after correction',
      cfgH3.json?.setup?.usersWithoutManager === 0 && (cfgH3.json?.setup?.invalidLinks || []).length === 0,
      `withoutManager=${cfgH3.json?.setup?.usersWithoutManager} links=${JSON.stringify(cfgH3.json?.setup?.invalidLinks)}`);

    /* ---------------- 10. Hierarchy-change detection ---------------- */
    log('\nI. Hierarchy-change detection (existing links flagged, never overwritten):');
    // Move MANAGER from Level 3 to Level 4: every MANAGER employee now sits
    // two levels under a Department Head, and every EXECUTIVE reports to a
    // same-level manager. Both kinds of link must be flagged — and no
    // manager_id may be silently modified by the server.
    const changedLadder = ladderBody.map(a => (a.roleId === 'MANAGER' ? { roleId: a.roleId, level: 4 } : a));
    const putChanged = await req('PUT', '/api/hierarchy-config', { token: admin, body: { assignments: changedLadder } });
    check('PUT /api/hierarchy-config (MANAGER moved to Level 4) -> 200', putChanged.status === 200, `status=${putChanged.status} body=${JSON.stringify(putChanged.json)}`);
    const invalidAfter = putChanged.json?.data?.setup?.invalidLinks || [];
    const mgrALink = invalidAfter.find(l => l.employeeId === MGR_A);
    const execXLink = invalidAfter.find(l => l.employeeId === EXEC_X);
    check('Flags Manager A (manager is now two levels up)', !!mgrALink, JSON.stringify(invalidAfter));
    check('Flags Executive X (manager is now at the same level)', !!execXLink, JSON.stringify(invalidAfter));
    check('Affected employees listed with name + reason', !!(mgrALink?.employeeName && mgrALink?.reason && execXLink?.reason), JSON.stringify(invalidAfter));
    const usersI = (await req('GET', '/api/users', { token: admin })).json || [];
    check('Manager A manager_id preserved (never silently overwritten)', usersI.find(u => u.employeeId === MGR_A)?.managerId === RETAIL_HEAD, String(usersI.find(u => u.employeeId === MGR_A)?.managerId));
    check('Executive X manager_id preserved (never silently overwritten)', usersI.find(u => u.employeeId === EXEC_X)?.managerId === MGR_A, String(usersI.find(u => u.employeeId === EXEC_X)?.managerId));
    check('An invalid link is not a missing manager (they still have one)', putChanged.json?.data?.setup?.usersWithoutManager === 0, `withoutManager=${putChanged.json?.data?.setup?.usersWithoutManager}`);

    const putRestored = await req('PUT', '/api/hierarchy-config', { token: admin, body: { assignments: ladderBody } });
    check('Restoring the ladder clears the warnings', putRestored.status === 200 && (putRestored.json?.data?.setup?.invalidLinks || []).length === 0,
      `status=${putRestored.status} links=${JSON.stringify(putRestored.json?.data?.setup?.invalidLinks)}`);

    /* ---------------- 11. Realistic project ladder ---------------- */
    log('\nJ. Realistic project ladder (CEO -> BH -> BE -> BDM -> ASM -> RM -> RO):');
    // Role codes, names and the chain itself come from the project's own
    // definitions (UserRole enum, Login.tsx designations and the enterprise
    // hierarchy documented in src/modules/users/utils/dataScope.ts).
    const ladderRolesJ = [
      { roleId: 'CEO', level: 1, name: 'Chief Executive Officer', visibility: 'Organization' },
      { roleId: 'BH', level: 2, name: 'Business Head', visibility: 'DownTeam' },
      { roleId: 'BE', level: 3, name: 'Business Executive', visibility: 'DownTeam' },
      { roleId: 'BDM', level: 4, name: 'Business Development Manager', visibility: 'DownTeam' },
      { roleId: 'ASM', level: 5, name: 'Area Sales Manager', visibility: 'DownTeam' },
      { roleId: 'RM', level: 6, name: 'Relationship Manager', visibility: 'DownTeam' },
      { roleId: 'RO', level: 7, name: 'Relationship Officer', visibility: 'Own' },
    ];
    for (const role of ladderRolesJ) {
      const r = await req('POST', '/api/roles', { token: admin, body: { roleId: role.roleId, roleName: role.name, hierarchyLevel: role.level, dataVisibility: role.visibility } });
      check(`POST /api/roles ${role.roleId} (Level ${role.level}) -> saved`, r.status === 200, `status=${r.status}`);
    }
    // Every other business role leaves the ladder; existing manager_id links
    // must be preserved untouched, not rewritten.
    const rolesNowJ = await req('GET', '/api/roles', { token: admin });
    const levelsJ = new Map(ladderRolesJ.map(r => [r.roleId, r.level]));
    const assignmentsJ = (rolesNowJ.json || [])
      .map(r => String(r.roleId).toUpperCase())
      .filter(id => !['ADMIN', 'SUPERADMIN'].includes(id))
      .map(id => ({ roleId: id, level: levelsJ.get(id) ?? 0 }));
    const putJ = await req('PUT', '/api/hierarchy-config', { token: admin, body: { assignments: assignmentsJ } });
    check('PUT /api/hierarchy-config (project ladder) -> 200', putJ.status === 200, `status=${putJ.status} body=${JSON.stringify(putJ.json)}`);

    const BH = `BHH${stamp}`; const BE = `BEE${stamp}`; const BDM = `BDM${stamp}`;
    const ASM = `ASM${stamp}`; const RM = `RMM${stamp}`; const RO = `ROO${stamp}`;
    await createUser(BH, 'Business Head', 'BH', retailDept, CEO);
    await createUser(BE, 'Business Executive', 'BE', retailDept, BH);
    await createUser(BDM, 'Business Development Manager', 'BDM', retailDept, BE);
    await createUser(ASM, 'Area Sales Manager', 'ASM', retailDept, BDM);
    await createUser(RM, 'Relationship Manager', 'RM', retailDept, ASM);
    await createUser(RO, 'Relationship Officer', 'RO', retailDept, RM);

    const optsRO = await req('GET', `/api/users/reporting-options?role=RO&departmentId=${retailDept}`, { token: admin });
    check('RO in Retail sees only its Relationship Manager as a candidate', optsRO.status === 200 && optsRO.json?.length === 1 && optsRO.json[0].employeeId === RM, JSON.stringify(optsRO.json?.map(o => o.employeeId)));

    const usersJ = (await req('GET', '/api/users', { token: admin })).json || [];
    const roUser = usersJ.find(u => u.employeeId === RO);
    check('RO reportingChain = [RM, ASM, BDM, BE, BH, CEO]',
      JSON.stringify(roUser?.reportingChain) === JSON.stringify([RM, ASM, BDM, BE, BH, CEO]), JSON.stringify(roUser?.reportingChain));

    const cfgJ = await req('GET', '/api/hierarchy-config', { token: admin });
    const setupJ = cfgJ.json?.setup || {};
    check('Ladder stats: 7 ladder users, 6 manager-required, 0 missing, 0 invalid',
      setupJ.totalUsers === 7 && setupJ.managerRequired === 6 && setupJ.usersWithManager === 6 && setupJ.usersWithoutManager === 0 && (setupJ.invalidLinks || []).length === 0,
      JSON.stringify(setupJ));
    check('Off-ladder scenario employees keep their manager_id (no rewrite)',
      usersJ.find(u => u.employeeId === MGR_A)?.managerId === RETAIL_HEAD && usersJ.find(u => u.employeeId === EXEC_X)?.managerId === MGR_A,
      `${usersJ.find(u => u.employeeId === MGR_A)?.managerId} / ${usersJ.find(u => u.employeeId === EXEC_X)?.managerId}`);

    // DownTeam visibility across the realistic chain: the Business Head sees
    // the deep-subtree RO lead, none of the other branches' leads.
    await mkLead(RO, `LR${stamp}`);
    await login(BH);
    const bhLeads = await leadsOf(BH);
    check('Business Head (DownTeam) sees only the RO lead from its subtree',
      bhLeads.includes(`LR${stamp}`) && !bhLeads.includes(`LA${stamp}`) && !bhLeads.includes(`LX${stamp}`) && !bhLeads.includes(`LC${stamp}`),
      JSON.stringify(bhLeads));

    log('');
    if (failures) { log(`✗ ${failures} check(s) FAILED`); process.exitCode = 1; }
    else log('✓ All hierarchy RBAC checks passed.');
  } finally {
    h.child.kill('SIGTERM');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
