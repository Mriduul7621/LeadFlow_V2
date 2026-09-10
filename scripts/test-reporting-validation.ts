/**
 * test-reporting-validation.ts
 * ------------------------------------------------------------------
 * Database-free regression tests for the two pre-merge hierarchy fixes:
 *
 *   1. PUT /users/:id enforces a MANDATORY reporting manager for Level 2+
 *      employees (validateReportingLink with managerIsRequired: true —
 *      the same flag POST /users already used). CEO (Level 1) must have
 *      NO manager; unassigned-ladder roles (level 99, including the
 *      ADMIN/SUPERADMIN system roles) keep the existing optional-manager
 *      behavior.
 *
 *   2. recomputeReportingChains() never swallows database errors, so a
 *      reporting-chain persistence failure propagates to the caller and
 *      the caller's transaction rolls back instead of committing a
 *      partially-created user.
 *
 * These run WITHOUT a live Postgres (stub executors stand in for the
 * database driver) so the fixed behaviors can be verified in CI /
 * pre-merge even when no DATABASE_URL is available. The DB-backed
 * end-to-end proof lives in scripts/verify-hierarchy-rbac.mjs.
 *
 * Run:  npx tsx scripts/test-reporting-validation.ts
 * Exit code 0 = all checks passed.
 */
import {
  validateReportingLink,
  recomputeReportingChains,
} from '../server/routes/production.routes.js';

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) passes++;
  else failures++;
  // eslint-disable-next-line no-console
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------
   Stub executor for validateReportingLink
------------------------------------------------------------------ */

interface StubManagerRow {
  id: string;
  employee_id: string;
  department_id: string | null;
  is_active: boolean;
  role_code: string;
  hierarchy_level: number;
}

function linkStub(opts: {
  roleLevels: Record<string, number>;
  managers: Record<string, StubManagerRow | null>;
  chainLinks: Record<string, string | null>;
}): { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> } {
  return {
    async query(sql: string, params: any[]) {
      // Manager lookup: SELECT u.id, ... FROM users u LEFT JOIN roles ...
      if (sql.includes('FROM users u LEFT JOIN roles')) {
        const row = opts.managers[params[0]];
        return { rows: row ? [row] : [] };
      }
      // roleLevelOf: SELECT hierarchy_level FROM roles WHERE id = $1
      if (sql.includes('FROM roles WHERE id')) {
        const level = opts.roleLevels[params[0]];
        return { rows: level == null ? [] : [{ hierarchy_level: level }] };
      }
      // Cycle walk: SELECT manager_id FROM users WHERE id = $1
      if (sql.includes('SELECT manager_id FROM users')) {
        const next = opts.chainLinks[params[0]];
        if (params[0] in opts.chainLinks) return { rows: [{ manager_id: next }] };
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in stub: ${sql.slice(0, 90)}`);
    },
  };
}

const CEO_ROLE = 'role-ceo'; // level 1
const HEAD_ROLE = 'role-head'; // level 2
const MGR_ROLE = 'role-mgr'; // level 3
const EXEC_ROLE = 'role-exec'; // level 4
const ADMIN_ROLE = 'role-admin'; // level 1 (system role, seeded at level 1)
const FLOAT_ROLE = 'role-float'; // level 99 (not in the ladder)

const D_RETAIL = 'dept-retail';
const D_CORP = 'dept-corp';

const baseLevels: Record<string, number> = {
  [CEO_ROLE]: 1,
  [HEAD_ROLE]: 2,
  [MGR_ROLE]: 3,
  [EXEC_ROLE]: 4,
  [ADMIN_ROLE]: 1,
  [FLOAT_ROLE]: 99,
};

function managerRow(
  id: string,
  employeeId: string,
  roleCode: string,
  level: number,
  departmentId: string | null,
  isActive = true
): StubManagerRow {
  return { id, employee_id: employeeId, department_id: departmentId, is_active: isActive, role_code: roleCode, hierarchy_level: level };
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('A. PUT semantics: managerIsRequired = true (Level 2+ mandatory):');

  // 1. Level 2+ update WITHOUT a manager is REJECTED.
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: {}, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-head', roleId: HEAD_ROLE, departmentId: D_RETAIL, managerId: null, managerIsRequired: true,
    });
    check('L2 update without manager → rejected', !!err && /reporting manager is required/i.test(err), err || '(accepted!)');
  }
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: {}, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-exec', roleId: EXEC_ROLE, departmentId: D_RETAIL, managerId: null, managerIsRequired: true,
    });
    check('L4 update without manager → rejected', !!err && /reporting manager is required/i.test(err), err || '(accepted!)');
  }

  // 2. Level 2+ update WITH a valid manager is ACCEPTED.
  {
    const exec = linkStub({
      roleLevels: baseLevels,
      managers: { 'mgr-ceo': managerRow('mgr-ceo', 'CEO1', 'CEO', 1, D_CORP) },
      chainLinks: { 'mgr-ceo': null },
    });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-head', roleId: HEAD_ROLE, departmentId: D_RETAIL, managerId: 'mgr-ceo', managerIsRequired: true,
    });
    check('L2 update with L1 CEO manager (cross-dept exception) → accepted', err === null, err || '');
  }
  {
    const exec = linkStub({
      roleLevels: baseLevels,
      managers: { 'mgr-m': managerRow('mgr-m', 'MGR1', 'MANAGER', 3, D_RETAIL) },
      chainLinks: { 'mgr-m': 'mgr-head', 'mgr-head': 'mgr-ceo', 'mgr-ceo': null },
    });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-exec', roleId: EXEC_ROLE, departmentId: D_RETAIL, managerId: 'mgr-m', managerIsRequired: true,
    });
    check('L4 update with valid L3 same-dept manager → accepted', err === null, err || '');
  }

  // eslint-disable-next-line no-console
  console.log('\nB. CEO / self / level / department / cycle rules on update:');

  // 3. CEO with a manager is REJECTED; CEO without one is ACCEPTED.
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: {}, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-ceo', roleId: CEO_ROLE, departmentId: D_RETAIL, managerId: 'mgr-head', managerIsRequired: true,
    });
    check('CEO update WITH a manager → rejected', !!err && /cannot report to anyone/i.test(err), err || '(accepted!)');
  }
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: {}, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-ceo', roleId: CEO_ROLE, departmentId: D_RETAIL, managerId: null, managerIsRequired: true,
    });
    check('CEO update WITHOUT a manager → accepted (org root)', err === null, err || '');
  }

  // 4. Self-manager is REJECTED.
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: {}, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-m', roleId: MGR_ROLE, departmentId: D_RETAIL, managerId: 'emp-m', managerIsRequired: true,
    });
    check('Self-manager → rejected', !!err && /themselves/i.test(err), err || '(accepted!)');
  }

  // 5. Wrong hierarchy-level manager is REJECTED.
  {
    const exec = linkStub({
      roleLevels: baseLevels,
      managers: { 'mgr-head': managerRow('mgr-head', 'HEAD1', 'DEPT_HEAD', 2, D_RETAIL) },
      chainLinks: {},
    });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-exec', roleId: EXEC_ROLE, departmentId: D_RETAIL, managerId: 'mgr-head', managerIsRequired: true,
    });
    check('Wrong-level manager (L4 emp → L2 mgr, needs L3) → rejected',
      !!err && /Level 3/.test(err), err || '(accepted!)');
  }

  // 6. Cross-department manager is REJECTED (non-CEO manager).
  {
    const exec = linkStub({
      roleLevels: baseLevels,
      managers: { 'mgr-corp': managerRow('mgr-corp', 'CMGR1', 'MANAGER', 3, D_CORP) },
      chainLinks: {},
    });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-exec', roleId: EXEC_ROLE, departmentId: D_RETAIL, managerId: 'mgr-corp', managerIsRequired: true,
    });
    check('Cross-department manager → rejected', !!err && /same department/i.test(err), err || '(accepted!)');
  }

  // 7. Cycle is REJECTED (manager chain loops back to the employee).
  {
    const exec = linkStub({
      roleLevels: baseLevels,
      managers: { 'mgr-m': managerRow('mgr-m', 'MGR1', 'MANAGER', 3, D_RETAIL) },
      // Proposed manager's chain leads back to the employee itself.
      chainLinks: { 'mgr-m': 'emp-exec', 'emp-exec': 'mgr-m' },
    });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-exec', roleId: EXEC_ROLE, departmentId: D_RETAIL, managerId: 'mgr-m', managerIsRequired: true,
    });
    check('Circular reporting chain → rejected', !!err && /circular/i.test(err), err || '(accepted!)');
  }

  // 8. Manager must exist and be active.
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: { 'mgr-ghost': null }, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-exec', roleId: EXEC_ROLE, departmentId: D_RETAIL, managerId: 'mgr-ghost', managerIsRequired: true,
    });
    check('Unknown manager → rejected', !!err && /not found/i.test(err), err || '(accepted!)');
  }
  {
    const exec = linkStub({
      roleLevels: baseLevels,
      managers: { 'mgr-off': managerRow('mgr-off', 'MGR9', 'MANAGER', 3, D_RETAIL, false) },
      chainLinks: {},
    });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-exec', roleId: EXEC_ROLE, departmentId: D_RETAIL, managerId: 'mgr-off', managerIsRequired: true,
    });
    check('Inactive manager → rejected', !!err && /active/i.test(err), err || '(accepted!)');
  }

  // eslint-disable-next-line no-console
  console.log('\nC. System roles / unassigned roles keep existing behavior:');
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: {}, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-float', roleId: FLOAT_ROLE, departmentId: D_RETAIL, managerId: null, managerIsRequired: true,
    });
    check('Level-99 (unassigned) update without manager → accepted', err === null, err || '');
  }
  {
    const exec = linkStub({ roleLevels: baseLevels, managers: {}, chainLinks: {} });
    const err = await validateReportingLink(exec, {
      selfId: 'emp-admin', roleId: ADMIN_ROLE, departmentId: null, managerId: null, managerIsRequired: true,
    });
    check('ADMIN (system role) without manager → accepted', err === null, err || '');
  }

  /* ------------------------------------------------------------------
     recomputeReportingChains: success path + error propagation
  ------------------------------------------------------------------ */
  // eslint-disable-next-line no-console
  console.log('\nD. recomputeReportingChains: derived data + no swallowed errors:');

  interface FixtureUser { id: string; employee_id: string; manager_id: string | null }
  const fixture: FixtureUser[] = [
    { id: 'u-ceo', employee_id: 'CEO1', manager_id: null },
    { id: 'u-head', employee_id: 'HEAD1', manager_id: 'u-ceo' },
    { id: 'u-exec', employee_id: 'EXEC1', manager_id: 'u-head' },
  ];

  function recomputeStub(failOn: 'insert' | 'delete' | null = null) {
    const calls: Array<{ kind: string; params: any[] }> = [];
    return {
      calls,
      async query(sql: string, params: any[]) {
        if (sql.includes('SELECT id, employee_id, manager_id FROM users')) {
          return { rows: fixture };
        }
        if (sql.includes('UPDATE users SET reporting_chain')) {
          calls.push({ kind: 'update', params });
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO hierarchies')) {
          if (failOn === 'insert') throw new Error('boom-insert: relation "hierarchies" does not exist');
          calls.push({ kind: 'insert', params });
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM hierarchies')) {
          if (failOn === 'delete') throw new Error('boom-delete: relation "hierarchies" does not exist');
          calls.push({ kind: 'delete', params });
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in stub: ${sql.slice(0, 90)}`);
      },
    };
  }

  // Success path: chains + subordinates derived for every user.
  {
    const stub = recomputeStub(null);
    let threw: unknown = null;
    try {
      await recomputeReportingChains(stub);
    } catch (err) {
      threw = err;
    }
    check('recompute success path resolves', threw === null, threw ? String(threw) : '');
    const updates = stub.calls.filter(c => c.kind === 'update');
    check('recompute updates every user row (3)', updates.length === 3, `updates=${updates.length}`);
    const byId = new Map(updates.map(u => [u.params[0], { chain: JSON.parse(u.params[1]), subs: JSON.parse(u.params[2]) }]));
    check('EXEC chain = [HEAD1, CEO1]',
      JSON.stringify(byId.get('u-exec')?.chain) === JSON.stringify(['HEAD1', 'CEO1']),
      JSON.stringify(byId.get('u-exec')?.chain));
    check('HEAD chain = [CEO1]',
      JSON.stringify(byId.get('u-head')?.chain) === JSON.stringify(['CEO1']),
      JSON.stringify(byId.get('u-head')?.chain));
    check('CEO chain = []', JSON.stringify(byId.get('u-ceo')?.chain) === JSON.stringify([]),
      JSON.stringify(byId.get('u-ceo')?.chain));
    check('CEO subordinates = [HEAD1, EXEC1]',
      JSON.stringify(byId.get('u-ceo')?.subs) === JSON.stringify(['HEAD1', 'EXEC1']),
      JSON.stringify(byId.get('u-ceo')?.subs));
    const inserts = stub.calls.filter(c => c.kind === 'insert');
    const deletes = stub.calls.filter(c => c.kind === 'delete');
    check('hierarchies upserted for the 2 linked users', inserts.length === 2, `inserts=${inserts.length}`);
    check('hierarchies row removed for the manager-less CEO', deletes.length === 1 && deletes[0].params[0] === 'u-ceo',
      JSON.stringify(deletes.map(d => d.params[0])));
  }

  // Failure propagation: NOTHING may be swallowed.
  {
    const stub = recomputeStub('insert');
    let message = '';
    try {
      await recomputeReportingChains(stub);
    } catch (err: any) {
      message = String(err?.message || err);
    }
    check('hierarchies INSERT failure PROPAGATES (no swallow)', /boom-insert/.test(message), message || '(swallowed!)');
  }
  {
    const stub = recomputeStub('delete');
    let message = '';
    try {
      await recomputeReportingChains(stub);
    } catch (err: any) {
      message = String(err?.message || err);
    }
    check('hierarchies DELETE failure PROPAGATES (no swallow)', /boom-delete/.test(message), message || '(swallowed!)');
  }

  // eslint-disable-next-line no-console
  console.log('');
  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`✗ ${failures} check(s) FAILED (${passes} passed)`);
    process.exit(1);
  } else {
    // eslint-disable-next-line no-console
    console.log(`✓ All reporting-validation checks passed (${passes}/${passes}).`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
