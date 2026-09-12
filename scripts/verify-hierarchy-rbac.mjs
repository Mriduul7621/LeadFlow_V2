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
 *   2. Every employee reports to exactly ONE manager whose role sits one
 *      or two levels up (skip-level), same department unless Level-1 CEO.
 *   3. Same-department managers only (exception: the Level-1 CEO is the
 *      only cross-department link).
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
    // Manager three levels up (gap 3 > allowed 2)
    await createUser(`BAD2${stamp}`, 'Bad Three Levels', 'EXECUTIVE', retailDept, CEO, 400);
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

    // ---- PUT /users/:id enforces the SAME ladder rules as POST ----
    // A Level 2+ update without a manager must be rejected (mandatory
    // reporting); every other link rule applies on update as well.
    const putExpect = async (employeeId, body, expectStatus, label) => {
      const r = await req('PUT', `/api/users/${employeeId}`, { token: admin, body });
      check(`PUT /api/users ${label} -> ${expectStatus}`, r.status === expectStatus,
        `status=${r.status}${r.status !== expectStatus ? ` body=${JSON.stringify(r.json)}` : ''}`);
      return r;
    };
    const clearExec = await putExpect(EXEC_X, { managerId: '' }, 400, 'L4 Executive without manager (rejected)');
    check('Rejection message names the missing reporting manager', /reporting manager/i.test(clearExec.json?.message || ''),
      JSON.stringify(clearExec.json));
    const execAfterReject = await req('GET', `/api/users/${EXEC_X}`, { token: admin });
    check('Rejected update preserves the stored manager (no silent removal)',
      (execAfterReject.json?.managerId || execAfterReject.json?.reportingManagerId) === MGR_A,
      `managerId=${execAfterReject.json?.managerId}`);
    await putExpect(EXEC_X, { managerId: MGR_A, designation: 'Executive (verified)' }, 200, 'L4 Executive with valid manager (accepted)');
    await putExpect(EXEC_X, { designation: 'Executive (verified again)' }, 200, 'L4 field-only update keeps existing manager (accepted)');
    await putExpect(CEO, { managerId: RETAIL_HEAD }, 400, 'CEO with a manager (rejected)');
    await putExpect(MGR_A, { managerId: MGR_A }, 400, 'self-manager (rejected)');
    // Skip-level is allowed: L4 -> L2 (gap 2). Restore under MGR_A afterwards
    // so later organogram assertions still see the original tree.
    await putExpect(EXEC_X, { managerId: RETAIL_HEAD }, 200, 'skip-level manager L4 -> L2 (accepted)');
    await putExpect(EXEC_X, { managerId: MGR_A }, 200, 'restore Executive X under Manager A (accepted)');
    await putExpect(EXEC_X, { managerId: CEO }, 400, 'too-far-up manager L4 -> L1 (rejected)');
    await putExpect(EXEC_X, { managerId: CORP_MGR }, 400, 'cross-department manager (rejected)');
    // Inactive managers are not valid link targets.
    await putExpect(MGR_B, { status: 'Inactive' }, 200, 'deactivate Manager B (setup)');
    await putExpect(EXEC_X, { managerId: MGR_B }, 400, 'inactive manager (rejected)');
    await putExpect(MGR_B, { status: 'Active' }, 200, 'reactivate Manager B (restore)');

    /* ---------------- 3. Reporting-options endpoint ---------------- */
    log('\nD. Reporting-options dropdown source:');
    const optsMgr = await req('GET', `/api/users/reporting-options?role=MANAGER&departmentId=${retailDept}`, { token: admin });
    // MANAGER (L3) may report to DEPT_HEAD (L2, same dept) or CEO (L1, cross-dept).
    check('MANAGER in Retail sees Retail Head + CEO as candidates', optsMgr.status === 200 && optsMgr.json?.length === 2 && optsMgr.json.some(o => o.employeeId === RETAIL_HEAD) && optsMgr.json.some(o => o.employeeId === CEO), JSON.stringify(optsMgr.json?.map(o => o.employeeId)));
    const optsCeo = await req('GET', `/api/users/reporting-options?role=CEO`, { token: admin });
    check('CEO has no candidates (Level 1)', optsCeo.status === 200 && optsCeo.json?.length === 0);
    const optsExec = await req('GET', `/api/users/reporting-options?role=EXECUTIVE&departmentId=${corpDept}`, { token: admin });
    // EXECUTIVE (L4) may report to MANAGER (L3) or DEPT_HEAD (L2), both in Corporate.
    check('EXECUTIVE in Corporate sees Corporate Manager + Corporate Head', optsExec.status === 200 && optsExec.json?.length === 2 && optsExec.json.some(o => o.employeeId === CORP_MGR) && optsExec.json.some(o => o.employeeId === CORP_HEAD), JSON.stringify(optsExec.json?.map(o => o.employeeId)));

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

    /* ---------------- 8. Setup stats & post-change detection ---------------- */
    const cfg2 = await req('GET', '/api/hierarchy-config', { token: admin });
    const setup = cfg2.json?.setup || {};
    // In a fully-valid org the CEO (Level 1) MUST NOT be counted as "missing a
    // reporting manager"; only Level 2+ employees with no manager are counted.
    check('Setup: CEO (Level 1) NOT counted as missing a manager', setup.usersWithoutManager === 0, `withoutManager=${setup.usersWithoutManager} (must be 0 — CEO excluded)`);
    check('Setup: no false invalid links in a valid org', setup.invalidLinks?.length === 0, `invalidLinks=${JSON.stringify(setup.invalidLinks)}`);

    // (a) Mandatory reporting on update + missing-manager health coverage.
    // PUT must REJECT clearing a Level 2+ manager (the stored manager_id
    // is preserved by the rollback — never silently removed).
    const clearMgr = await req('PUT', `/api/users/${RETAIL_HEAD}`, { token: admin, body: { managerId: '' } });
    check('PUT rejects clearing a Level-2 manager (mandatory reporting)',
      clearMgr.status === 400 && /reporting manager/i.test(clearMgr.json?.message || ''),
      `status=${clearMgr.status} body=${JSON.stringify(clearMgr.json)}`);
    const headAfterReject = await req('GET', `/api/users/${RETAIL_HEAD}`, { token: admin });
    check('Rejected clear preserves the Retail Head manager (still the CEO)',
      (headAfterReject.json?.managerId || headAfterReject.json?.reportingManagerId) === CEO,
      `managerId=${headAfterReject.json?.managerId}`);
    const restoreMgr = await req('PUT', `/api/users/${RETAIL_HEAD}`, { token: admin, body: { managerId: CEO } });
    check('PUT with a valid Level-2 manager is accepted', restoreMgr.status === 200, `status=${restoreMgr.status}`);

    // Missing-manager health coverage WITHOUT violating PUT rules: create
    // an employee on an unassigned (non-ladder) role — the manager is
    // optional there — then place that role at Level 2. The employee is
    // now a Level 2+ employee without a manager, which the health stats
    // must flag (and which is fixed the supported way: PUT a valid
    // manager, which the mandatory-reporting rule accepts).
    const FLOATER_ROLE = `FLT${stamp}`;
    const FLOATER = `FLT1${stamp}`;
    await req('POST', '/api/roles', { token: admin, body: { roleId: FLOATER_ROLE, roleName: 'Floater (verify)' } });
    const mkFloater = await req('POST', '/api/users', {
      token: admin,
      body: {
        fullName: 'Floater One', employeeId: FLOATER, email: `${FLOATER.toLowerCase()}@leadflow.test`,
        role: FLOATER_ROLE, departmentId: retailDept, managerId: '', password: 'verify-pass-123',
      },
    });
    check('POST unassigned-role employee without manager -> 201', mkFloater.status === 201, `status=${mkFloater.status} body=${JSON.stringify(mkFloater.json)}`);
    await req('PUT', '/api/hierarchy-config', { token: admin, body: { assignments: [{ roleId: FLOATER_ROLE, level: 2 }] } });
    const setupOrphan = (await req('GET', '/api/hierarchy-config', { token: admin })).json?.setup || {};
    check('Setup: a Level 2 employee with no manager IS counted as missing', setupOrphan.usersWithoutManager === 1, `withoutManager=${setupOrphan.usersWithoutManager}`);
    check('Setup: orphan reported in invalidLinks ("no reporting manager")',
      setupOrphan.invalidLinks?.some(l => l.employeeId === FLOATER && /no reporting manager/i.test(l.reason)),
      JSON.stringify(setupOrphan.invalidLinks));
    const fixFloater = await req('PUT', `/api/users/${FLOATER}`, { token: admin, body: { managerId: CEO } });
    check('PUT assigns the missing Level-2 manager (accepted)', fixFloater.status === 200, `status=${fixFloater.status}`);
    const setupFixed = (await req('GET', '/api/hierarchy-config', { token: admin })).json?.setup || {};
    check('Setup: missing count back to 0 after the fix',
      setupFixed.usersWithoutManager === 0 && !(setupFixed.invalidLinks || []).some(l => l.employeeId === FLOATER),
      `withoutManager=${setupFixed.usersWithoutManager} invalidLinks=${JSON.stringify(setupFixed.invalidLinks)}`);
    // Restore the role to unassigned so later sections see the original ladder.
    await req('PUT', '/api/hierarchy-config', { token: admin, body: { assignments: [{ roleId: FLOATER_ROLE, level: 0 }] } });

    // (b) Invalid reporting relationships detected AFTER a role-level change.
    // Move MANAGER from Level 3 -> Level 4 so the existing MANAGER employees
    // now report to a Level-2 head (must be Level 3) => links become invalid.
    // Existing manager_id values are NOT auto-edited — they are surfaced.
    const levelChange = allRoleIds.map(id => ({
      roleId: id,
      level: assignmentMap.get(id) != null ? (id === 'MANAGER' ? 4 : assignmentMap.get(id)) : 0,
    }));
    const lcRes = await req('PUT', '/api/hierarchy-config', { token: admin, body: { assignments: levelChange } });
    check('PUT hierarchy-config level change -> 200', lcRes.status === 200 && lcRes.json?.success === true, `status=${lcRes.status}`);
    const setupChanged = lcRes.json?.data?.setup || {};
    const badManagerLinks = (setupChanged.invalidLinks || []).filter(l => /Manager must be Level/i.test(l.reason));
    check('Post level-change: MANAGER employees flagged as invalid (manager no longer one level up)',
      badManagerLinks.length >= 3, `invalidLinks=${JSON.stringify(setupChanged.invalidLinks)}`);
    // restore the correct ladder
    await req('PUT', '/api/hierarchy-config', { token: admin, body: { assignments: ladderBody } });
    const restored = (await req('GET', '/api/hierarchy-config', { token: admin })).json?.setup || {};
    check('Ladder restored: invalidLinks back to 0', restored.invalidLinks?.length === 0, `invalidLinks=${JSON.stringify(restored.invalidLinks)}`);

    /* ---------------- 9. POST /users atomicity ---------------- */
    // User creation and reporting-chain recomputation share ONE database
    // transaction: when the recompute cannot persist, the whole create
    // must fail (error response, no swallowed error) and NO
    // partially-created user may remain. The failure is simulated by
    // temporarily renaming the `hierarchies` table (scratch test database
    // only — always renamed back in the finally block).
    log('\nI. User creation rolls back when the recompute fails:');
    let pgClient = null;
    let hierarchiesRenamed = false;
    try {
      const pg = await import('pg');
      const Client = pg.Client ?? pg.default?.Client;
      if (!Client) throw new Error('pg Client unavailable');
      pgClient = new Client({ connectionString: process.env.DATABASE_URL });
      await pgClient.connect();
      await pgClient.query('ALTER TABLE hierarchies RENAME TO hierarchies_verify_bak');
      hierarchiesRenamed = true;

      const mkBody = (employeeId, fullName, role, managerId) => ({
        fullName, employeeId, email: `${employeeId.toLowerCase()}@leadflow.test`,
        role, departmentId: retailDept, managerId, password: 'verify-pass-123',
      });
      const doomedCEO = `DC${stamp}`;
      const failCEO = await req('POST', '/api/users', { token: admin, body: mkBody(doomedCEO, 'Doomed CEO', 'CEO', '') });
      check('POST /api/users fails (5xx, no false success) when the recompute cannot persist',
        failCEO.status >= 500 && failCEO.json?.success === false,
        `status=${failCEO.status} body=${JSON.stringify(failCEO.json)}`);
      const ghostCEO = await pgClient.query('SELECT id FROM users WHERE employee_id = $1', [doomedCEO]);
      check('Failed create left NO partially-created user row (manager-less path)', ghostCEO.rows.length === 0, `rows=${ghostCEO.rows.length}`);

      const doomedExec = `DE${stamp}`;
      const failExec = await req('POST', '/api/users', { token: admin, body: mkBody(doomedExec, 'Doomed Exec', 'EXECUTIVE', MGR_A) });
      check('POST /api/users fails (5xx) for a manager-linked user too',
        failExec.status >= 500 && failExec.json?.success === false,
        `status=${failExec.status} body=${JSON.stringify(failExec.json)}`);
      const ghostExec = await pgClient.query('SELECT id FROM users WHERE employee_id = $1', [doomedExec]);
      check('Failed create left NO partially-created user row (linked path)', ghostExec.rows.length === 0, `rows=${ghostExec.rows.length}`);
    } finally {
      if (pgClient) {
        if (hierarchiesRenamed) {
          try {
            await pgClient.query('ALTER TABLE hierarchies_verify_bak RENAME TO hierarchies');
            hierarchiesRenamed = false;
          } catch (err) {
            log(`  WARNING: could not restore the hierarchies table: ${err?.message || err}`);
          }
        }
        await pgClient.end().catch(() => {});
      }
    }
    check('hierarchies table restored after the failure simulation', hierarchiesRenamed === false);
    // Recovery proof: the rolled-back employee ID is free again, so the
    // same create now succeeds (a leftover row would 409 here).
    const retryExec = await req('POST', '/api/users', {
      token: admin,
      body: {
        fullName: 'Doomed Exec', employeeId: `DE${stamp}`, email: `de${stamp.toLowerCase()}@leadflow.test`,
        role: 'EXECUTIVE', departmentId: retailDept, managerId: MGR_A, password: 'verify-pass-123',
      },
    });
    check('POST /api/users succeeds again after restore (rollback freed the ID)', retryExec.status === 201, `status=${retryExec.status} body=${JSON.stringify(retryExec.json)}`);

    log('');
    if (failures) { log(`✗ ${failures} check(s) FAILED`); process.exitCode = 1; }
    else log('✓ All hierarchy RBAC checks passed.');
  } finally {
    h.child.kill('SIGTERM');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
