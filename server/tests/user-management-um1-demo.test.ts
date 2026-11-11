import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fallbackStore } from '../fallbackStore.js';
import { resolveCallerVisibility, isLeadAccessible } from '../routes/production/shared.js';

/**
 * UM-1 demo-mode parity — the tree-derived visibility floor must
 * behave IDENTICALLY when the app runs on the in-memory
 * fallbackStore (no DATABASE_URL in this file, by design):
 *   - an EMPLOYEE-role user WITH a report gets their subtree;
 *   - an EMPLOYEE-role user WITHOUT reports stays self-only;
 *   - MANAGER-like roles keep their subtree (unchanged).
 */

const CEO = { id: 'd-ceo', employeeId: 'DCEO1', fullName: 'Demo Ceo', role: 'CEO', status: 'Active', managerId: '' };
const TL = { id: 'd-tl', employeeId: 'DTL1', fullName: 'Demo Team Lead', role: 'EMPLOYEE', status: 'Active', managerId: 'DCEO1' };
const SUB = { id: 'd-sub', employeeId: 'DSUB1', fullName: 'Demo Sub', role: 'EMPLOYEE', status: 'Active', managerId: 'DTL1' };
const SOLO = { id: 'd-solo', employeeId: 'DSOLO1', fullName: 'Demo Solo', role: 'EMPLOYEE', status: 'Active', managerId: 'DCEO1' };
const MGR = { id: 'd-mgr', employeeId: 'DMGR1', fullName: 'Demo Manager', role: 'MANAGER', status: 'Active', managerId: 'DCEO1' };
const MSUB = { id: 'd-msub', employeeId: 'DMSUB1', fullName: 'Demo Manager Sub', role: 'EMPLOYEE', status: 'Active', managerId: 'DMGR1' };

const callerOf = (u: any) => ({
  id: u.id,
  employee_id: u.employeeId,
  email: `${u.employeeId.toLowerCase()}@demo.test`,
  role_id: null,
  role_code: u.role,
  department_id: null,
});

describe('UM-1 — visibility floor in demo mode (fallbackStore)', () => {
  beforeEach(() => {
    (fallbackStore as any).users = [CEO, TL, SUB, SOLO, MGR, MSUB];
    delete process.env.DATABASE_URL;
  });

  it('an EMPLOYEE with a report gets the subtree (team-lead floor)', async () => {
    const vis = await resolveCallerVisibility(callerOf(TL) as any);
    assert.equal(vis.all, false);
    assert.ok(vis.userIds.includes(TL.id));
    assert.ok(vis.userIds.includes(SUB.id), 'direct report visible in demo mode too');
    assert.ok(!vis.userIds.includes(SOLO.id), 'peer stays out');
  });

  it('an EMPLOYEE without reports stays self-only', async () => {
    const vis = await resolveCallerVisibility(callerOf(SOLO) as any);
    assert.deepEqual(vis.userIds, [SOLO.id]);
  });

  it('a MANAGER keeps the subtree (unchanged)', async () => {
    const vis = await resolveCallerVisibility(callerOf(MGR) as any);
    assert.ok(vis.userIds.includes(MSUB.id));
    assert.ok(!vis.userIds.includes(SUB.id), 'other teams stay out');
  });

  it('row-level access agrees: the floored team lead opens a report\'s demo lead, not a peer\'s', async () => {
    const vis = await resolveCallerVisibility(callerOf(TL) as any);
    const subLead = { id: 'dl-1', assignedTo: SUB.employeeId, createdBy: SUB.employeeId };
    const peerLead = { id: 'dl-2', assignedTo: SOLO.employeeId, createdBy: SOLO.employeeId };
    assert.equal(isLeadAccessible(subLead, vis, callerOf(TL) as any), true);
    assert.equal(isLeadAccessible(peerLead, vis, callerOf(TL) as any), false);
  });
});
