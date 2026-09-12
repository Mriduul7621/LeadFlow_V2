/**
 * test-hierarchy-health.ts
 * ------------------------------------------------------------------
 * Database-free unit tests for the "missing reporting manager" calculation
 * and invalid-link detection (server/utils/hierarchyHealth.ts).
 *
 * These run WITHOUT a live Postgres so the core counting rule can be
 * verified in CI / pre-merge even when no DATABASE_URL is available.
 * The DB-backed end-to-end checks live in verify-hierarchy-rbac.mjs.
 *
 * Run:  npx tsx scripts/test-hierarchy-health.ts
 * Exit code 0 = all checks passed.
 */
import { computeHierarchyHealth } from '../server/utils/hierarchyHealth.js';
import type { HierarchyUserRow } from '../server/utils/hierarchyHealth.js';

// Actual ladder defined by the repository (server/database/seeds/roles.seed.ts
// + DEFAULT_ROLES in production.routes.ts). ADMIN/SUPERADMIN are system roles
// and are intentionally NOT placed in this ladder map.
const LEVELS: Record<string, number> = {
  CEO: 1,
  MANAGER: 2,
  SM: 2,
  TEAM_LEAD: 3,
  BDM: 3,
  EMPLOYEE: 4,
  SBE: 4,
  BE: 5,
};

function levelMapFromLevels(): Map<string, number> {
  const m = new Map<string, number>();
  for (const [code, lv] of Object.entries(LEVELS)) m.set(code, lv);
  return m;
}

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  // eslint-disable-next-line no-console
  console.log(`  [${status}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function user(
  employeeId: string,
  fullName: string,
  roleCode: string,
  departmentId: string,
  managerId: string | null
): HierarchyUserRow {
  // In the real schema `manager_id` references a user's `id` (UUID). For the
  // fixture we let `id` equal `employee_id` so manager references read cleanly.
  return {
    id: employeeId,
    employee_id: employeeId,
    full_name: fullName,
    role_code: roleCode,
    department_id: departmentId,
    manager_id: managerId,
    is_active: true,
  };
}

const LM = levelMapFromLevels();

console.log('\nA. CEO / Level-1 rules');
{
  // Only the CEO exists, with no manager.
  const ceoOnly = [user('CEO1', 'Alice CEO', 'CEO', 'D1', null)];
  const h = computeHierarchyHealth(ceoOnly, LM);
  check('CEO without manager is NOT counted as missing', h.usersWithoutManager === 0, `without=${h.usersWithoutManager}`);
  check('CEO without manager produces no invalid links', h.invalidLinks.length === 0, JSON.stringify(h.invalidLinks));
  check('CEO is reflected in total ladder users', h.totalUsers === 1, `total=${h.totalUsers}`);
}
{
  // A CEO that incorrectly has a manager must be flagged, but NOT counted as "missing".
  const ceoWithMgr = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('M1', 'Bob Mgr', 'MANAGER', 'D1', 'CEO1'),
    user('CEO2', 'Carol CEO', 'CEO', 'D2', 'M1'), // invalid: CEO with a manager
  ];
  const h = computeHierarchyHealth(ceoWithMgr, LM);
  check('CEO with a manager is reported as an invalid link (not "missing")',
    h.invalidLinks.some(l => l.employeeId === 'CEO2' && /must not have a reporting manager/i.test(l.reason)),
    JSON.stringify(h.invalidLinks));
  check('Invalid CEO link does NOT inflate usersWithoutManager', h.usersWithoutManager === 0, `without=${h.usersWithoutManager}`);
}

console.log('\nB. Level 2+ missing manager is counted');
{
  const ceoPlusL2 = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('M1', 'Bob Mgr', 'MANAGER', 'D1', null), // L2, no manager -> missing
  ];
  const h = computeHierarchyHealth(ceoPlusL2, LM);
  check('Level 2 employee without manager IS counted as missing', h.usersWithoutManager === 1, `without=${h.usersWithoutManager}`);
  check('Level 2 missing link explains "no reporting manager"',
    h.invalidLinks.some(l => l.employeeId === 'M1' && /no reporting manager/i.test(l.reason)),
    JSON.stringify(h.invalidLinks));
}
{
  // Level 3 (Team Lead) without manager.
  const l3Missing = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('M1', 'Bob Mgr', 'MANAGER', 'D1', 'CEO1'),
    user('T1', 'Tara Lead', 'TEAM_LEAD', 'D1', null), // L3, no manager -> missing
  ];
  const h = computeHierarchyHealth(l3Missing, LM);
  check('Level 3 employee without manager IS counted as missing', h.usersWithoutManager === 1, `without=${h.usersWithoutManager}`);
  check('Level 3 missing link explains "no reporting manager"',
    h.invalidLinks.some(l => l.employeeId === 'T1' && /no reporting manager/i.test(l.reason)),
    JSON.stringify(h.invalidLinks));
}

console.log('\nC. Fully valid org -> nothing missing');
{
  const ok = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('M1', 'Bob Mgr', 'MANAGER', 'D1', 'CEO1'),
    user('T1', 'Tara Lead', 'TEAM_LEAD', 'D1', 'M1'),
    user('E1', 'Eve Emp', 'EMPLOYEE', 'D1', 'T1'),
  ];
  const h = computeHierarchyHealth(ok, LM);
  check('Valid org: usersWithoutManager === 0', h.usersWithoutManager === 0, `without=${h.usersWithoutManager}`);
  check('Valid org: no invalid links', h.invalidLinks.length === 0, JSON.stringify(h.invalidLinks));
  check('Valid org: all ladder users counted', h.totalUsers === 4 && h.usersWithManager === 3, `total=${h.totalUsers} withMgr=${h.usersWithManager}`);
}

console.log('\nD. Invalid manager relationship detection (after a level change)');
{
  // L2 employee now points at an L3 manager (lower level -> invalid). The
  // L3 -> L1 link is a valid skip-level gap (2) under the flexible rule.
  const wrongLevel = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('T1', 'Tara Lead', 'TEAM_LEAD', 'D1', 'CEO1'), // L3 -> L1 = gap 2 (valid)
    user('M1', 'Bob Mgr', 'MANAGER', 'D1', 'T1'), // L2 reporting to L3 -> invalid
  ];
  const h = computeHierarchyHealth(wrongLevel, LM);
  check('Wrong-level manager flagged as invalid',
    h.invalidLinks.some(l => l.employeeId === 'M1' && /must hold a Level 1 role/i.test(l.reason)),
    JSON.stringify(h.invalidLinks));
  // A user who HAS a (wrong) manager is "mis-assigned", not "managerless"; the
  // invalid link is surfaced separately and the user is NOT counted as missing.
  check('Wrong-level manager is NOT counted as "missing" (surfaced via invalidLinks)',
    h.usersWithoutManager === 0 && h.invalidLinks.length === 1,
    `without=${h.usersWithoutManager} invalid=${h.invalidLinks.length}`);
}
{
  // Skip-level (gap 2) is valid: L4 EMPLOYEE reports straight to L2 MANAGER.
  const skipLevel = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('M1', 'Bob Manager', 'MANAGER', 'D1', 'CEO1'),
    user('E1', 'Eve Employee', 'EMPLOYEE', 'D1', 'M1'), // L4 -> L2 = gap 2 (valid)
  ];
  const h = computeHierarchyHealth(skipLevel, LM);
  check('Skip-level link (L4 -> L2) produces no invalid links',
    h.invalidLinks.length === 0 && h.usersWithoutManager === 0,
    JSON.stringify(h.invalidLinks));
}
{
  // Same-department rule: a correctly-levelled manager must be in the SAME
  // department (the Level-1 CEO is the only cross-department link). Here E1
  // (L4) reports to T2 (L3 = correct level) but T2 is in a different dept.
  const crossDept = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('T1', 'Tara Lead', 'TEAM_LEAD', 'D1', 'CEO1'),
    user('T2', 'Tyler Lead', 'TEAM_LEAD', 'D2', 'CEO1'), // L3 in D2
    user('E1', 'Eve Emp', 'EMPLOYEE', 'D1', 'T2'), // L4 in D1 -> L3 manager in D2 = cross-dept invalid
  ];
  const h = computeHierarchyHealth(crossDept, LM);
  check('Cross-department manager flagged as invalid',
    h.invalidLinks.some(l => l.employeeId === 'E1' && /same department/i.test(l.reason)),
    JSON.stringify(h.invalidLinks));
  check('Cross-department manager is NOT counted as "missing" (surfaced via invalidLinks)',
    h.usersWithoutManager === 0,
    `without=${h.usersWithoutManager}`);
}

console.log('\nE. Realistic hierarchy using the repo\'s actual roles');
{
  // CEO -> MANAGER(L2) -> TEAM_LEAD(L3) -> EMPLOYEE(L4) -> BE(L5), all same dept.
  const realistic = [
    user('CEO1', 'Alice CEO', 'CEO', 'D1', null),
    user('M1', 'Bob Manager', 'MANAGER', 'D1', 'CEO1'),
    user('T1', 'Tara TeamLead', 'TEAM_LEAD', 'D1', 'M1'),
    user('E1', 'Eve Employee', 'EMPLOYEE', 'D1', 'T1'),
    user('B1', 'Ben BE', 'BE', 'D1', 'E1'),
  ];
  const h = computeHierarchyHealth(realistic, LM);
  check('Realistic ladder (CEO->MANAGER->TEAM_LEAD->EMPLOYEE->BE): nothing missing',
    h.usersWithoutManager === 0 && h.invalidLinks.length === 0,
    `without=${h.usersWithoutManager} invalid=${JSON.stringify(h.invalidLinks)}`);
}

console.log('');
if (failures) {
  console.error(`✗ ${failures} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('✓ All hierarchy-health checks passed.');
}
