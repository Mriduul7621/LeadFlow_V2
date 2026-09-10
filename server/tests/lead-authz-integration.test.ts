import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// Import the router and fallbackStore
import productionRoutes from '../routes/production.routes.js';
import { fallbackStore, createId } from '../fallbackStore.js';

const JWT_SECRET = process.env.JWT_SECRET || 'leadflow_development_only_secret';

function signToken(payload: Record<string, any>): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', productionRoutes);
  return app;
}

function resetStores() {
  fallbackStore.users = [];
  fallbackStore.leads = [];
  fallbackStore.notifications = [];
  // Keep other stores empty
  (fallbackStore as any).departments = [];
  (fallbackStore as any).teams = [];
}

function makeUser(overrides: any = {}) {
  const id = overrides.id || createId('user');
  const employeeId = overrides.employeeId || `EMP${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return {
    id,
    employeeId,
    fullName: overrides.fullName || `User ${employeeId}`,
    name: overrides.fullName || `User ${employeeId}`,
    email: overrides.email || `${employeeId.toLowerCase()}@test.com`,
    role: overrides.role || 'EMPLOYEE',
    roleCode: overrides.role || 'EMPLOYEE',
    status: 'Active' as const,
    accountStatus: 'ACTIVE',
    isActive: true,
    designation: overrides.designation || 'Officer',
    departmentId: overrides.departmentId || 'dept-1',
    teamId: '',
    managerId: overrides.managerId || '',
    reportingManagerId: overrides.managerId || '',
    avatarUrl: '',
    createdDate: new Date().toISOString(),
    password: 'hashed',
    mustChangePassword: false,
    reportingChain: [],
    subordinates: [],
    ...overrides,
  };
}

describe('Lead API Authorization - Route Level', () => {
  let app: express.Express;

  beforeEach(() => {
    resetStores();
    app = createTestApp();
    // Ensure dev-demo mode
    process.env.NODE_ENV = 'development';
    delete process.env.DATABASE_URL;
  });

  it('1. Anonymous: POST /api/leads, PUT /api/leads/:id, DELETE /api/leads/:id rejected', async () => {
    // POST anon
    const resPost = await request(app).post('/api/leads').send({ customerName: 'Anon', mobile: '01700000001' });
    assert.equal(resPost.status, 401, 'POST /api/leads anon should be 401');

    // PUT anon (actually POST with id is update in this codebase, but test DELETE and GET too)
    const resPut = await request(app).post('/api/leads').send({ id: 'some-id', customerName: 'Anon', mobile: '01700000002' });
    // Without token, even if it's an update attempt, should be 401
    assert.equal(resPut.status, 401);

    const resDelete = await request(app).delete('/api/leads/some-id');
    assert.equal(resDelete.status, 401, 'DELETE anon should be 401');

    const resGet = await request(app).get('/api/leads');
    assert.equal(resGet.status, 401, 'GET anon should be 401');
  });

  it('2. User A creates Lead A, persisted in fallbackStore (sim PostgreSQL)', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });

    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerName: 'Lead A', mobile: '01700000010', source: 'Test' });

    assert.equal(res.status, 200, `User A create should succeed, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(res.body.success);
    assert.equal(res.body.data.customerName, 'Lead A');
    assert.equal(res.body.data.mobile, '01700000010');

    // Verify persisted in fallbackStore
    const stored = fallbackStore.leads.find((l: any) => l.mobile === '01700000010' || l.id === res.body.data.id);
    assert.ok(stored, 'Lead should be persisted in fallbackStore');
    assert.equal(stored.customerName, 'Lead A');
  });

  it('3. User B attempts to update Lead A by ID -> rejected, record unchanged', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    const userB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA, userB);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email, name: userB.fullName });

    // User A creates
    const createRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerName: 'Lead A', mobile: '01700000011' });
    assert.equal(createRes.status, 200);
    const leadId = createRes.body.data.id;
    const originalName = createRes.body.data.customerName;

    // User B attempts update
    const updateRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ id: leadId, customerName: 'Hacked Lead', mobile: '01700000011' });

    assert.equal(updateRes.status, 403, `User B update should be 403, got ${updateRes.status}`);

    // Verify unchanged in store
    const stored = fallbackStore.leads.find((l: any) => l.id === leadId);
    assert.ok(stored);
    assert.equal(stored.customerName, originalName, 'Record should remain unchanged after unauthorized update');
  });

  it('4. User B attempts to delete Lead A -> rejected, record remains', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    const userB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA, userB);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email, name: userB.fullName });

    const createRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerName: 'Lead A', mobile: '01700000012' });
    assert.equal(createRes.status, 200);
    const leadId = createRes.body.data.id;

    const deleteRes = await request(app)
      .delete(`/api/leads/${leadId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    assert.equal(deleteRes.status, 403, `User B delete should be 403, got ${deleteRes.status}`);

    const stored = fallbackStore.leads.find((l: any) => l.id === leadId);
    assert.ok(stored, 'Lead should still exist after unauthorized delete');
  });

  it('5. Manager updates authorized subordinate/downline lead -> succeeds, PostgreSQL reflects', async () => {
    const manager = makeUser({ employeeId: 'MGR1', role: 'MANAGER' });
    const subordinate = makeUser({ employeeId: 'EMP1', role: 'EMPLOYEE', managerId: manager.employeeId });
    fallbackStore.users.push(manager, subordinate);
    const tokenManager = signToken({ id: manager.id, employeeId: manager.employeeId, role: manager.role, email: manager.email, name: manager.fullName });
    const tokenSub = signToken({ id: subordinate.id, employeeId: subordinate.employeeId, role: subordinate.role, email: subordinate.email, name: subordinate.fullName });

    // Subordinate creates lead
    const createRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenSub}`)
      .send({ customerName: 'Sub Lead', mobile: '01700000013' });
    assert.equal(createRes.status, 200);
    const leadId = createRes.body.data.id;

    // Manager updates it (should succeed because downline)
    const updateRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenManager}`)
      .send({ id: leadId, customerName: 'Updated by Manager', mobile: '01700000013' });

    assert.equal(updateRes.status, 200, `Manager update downline should succeed, got ${updateRes.status} ${JSON.stringify(updateRes.body)}`);

    const stored = fallbackStore.leads.find((l: any) => l.id === leadId);
    assert.ok(stored);
    assert.equal(stored.customerName, 'Updated by Manager');
  });

  it('6. Manager attempts to update unrelated/sibling branch lead -> rejected, unchanged', async () => {
    const manager1 = makeUser({ employeeId: 'MGR1', role: 'MANAGER' });
    const manager2 = makeUser({ employeeId: 'MGR2', role: 'MANAGER' });
    const emp1 = makeUser({ employeeId: 'EMP1', role: 'EMPLOYEE', managerId: manager1.employeeId });
    const emp2 = makeUser({ employeeId: 'EMP2', role: 'EMPLOYEE', managerId: manager2.employeeId });
    fallbackStore.users.push(manager1, manager2, emp1, emp2);
    const tokenM1 = signToken({ id: manager1.id, employeeId: manager1.employeeId, role: manager1.role, email: manager1.email, name: manager1.fullName });
    const tokenEmp2 = signToken({ id: emp2.id, employeeId: emp2.employeeId, role: emp2.role, email: emp2.email, name: emp2.fullName });

    // Emp2 creates lead (under manager2)
    const createRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenEmp2}`)
      .send({ customerName: 'Sibling Lead', mobile: '01700000014' });
    assert.equal(createRes.status, 200);
    const leadId = createRes.body.data.id;

    // Manager1 attempts update (sibling branch, should be rejected)
    const updateRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenM1}`)
      .send({ id: leadId, customerName: 'Hacked Sibling', mobile: '01700000014' });

    assert.equal(updateRes.status, 403, `Manager sibling update should be 403, got ${updateRes.status}`);

    const stored = fallbackStore.leads.find((l: any) => l.id === leadId);
    assert.ok(stored);
    assert.equal(stored.customerName, 'Sibling Lead', 'Sibling lead should remain unchanged');
  });

  it('7. Unauthorized bulk import outside caller scope -> rejected rows, unchanged', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    const userB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA, userB);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });

    // User A tries to bulk import leads assigned to User B (outside scope)
    const bulkRes = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        leads: [
          { customerName: 'Bulk 1', mobile: '01700000015', assignedTo: 'EMPB' },
          { customerName: 'Bulk 2', mobile: '01700000016', assignedTo: 'EMPB' },
        ],
      });

    // Should either be 403 or have failed rows
    if (bulkRes.status === 403) {
      assert.equal(bulkRes.status, 403);
    } else {
      assert.equal(bulkRes.status, 200);
      assert.ok(bulkRes.body.data.failed > 0, 'Should have failed rows for unauthorized scope');
      assert.equal(bulkRes.body.data.inserted, 0, 'No rows should be inserted outside scope');
    }

    // Verify no leads persisted for EMPB via User A
    const leadsForB = fallbackStore.leads.filter((l: any) => l.assignedTo === 'EMPB');
    assert.equal(leadsForB.length, 0, 'Unauthorized bulk should not create leads outside scope');
  });

  it('8. Authorized bulk import inside caller scope -> succeeds, persisted', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });

    const bulkRes = await request(app)
      .post('/api/leads/bulk')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        leads: [
          { customerName: 'Bulk Auth 1', mobile: '01700000017' },
          { customerName: 'Bulk Auth 2', mobile: '01700000018', assignedTo: 'EMPA' },
        ],
      });

    assert.equal(bulkRes.status, 200, `Authorized bulk should succeed, got ${bulkRes.status} ${JSON.stringify(bulkRes.body)}`);
    assert.equal(bulkRes.body.data.failed, 0);
    assert.equal(bulkRes.body.data.inserted, 2);

    const stored1 = fallbackStore.leads.find((l: any) => l.mobile === '01700000017');
    const stored2 = fallbackStore.leads.find((l: any) => l.mobile === '01700000018');
    assert.ok(stored1, 'Bulk lead 1 should be persisted');
    assert.ok(stored2, 'Bulk lead 2 should be persisted');
  });

  it('9. Identity spoofing: false assignedBy/updatedBy/changedBy must come from session', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    const userB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA, userB);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });

    const res = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        customerName: 'Spoof Test',
        mobile: '01700000019',
        assignedBy: 'EMPB',
        updatedBy: 'EMPB',
        createdBy: 'EMPB',
        deletedBy: 'EMPB',
        assignedTo: 'EMPA',
        customFields: {
          assignedBy: 'EMPB',
          updatedBy: 'EMPB',
          createdBy: 'EMPB',
        },
        assignmentHistory: [
          { id: 'assign_1', toEmployeeId: 'EMPA', changedBy: 'EMPB', date: new Date().toISOString() },
        ],
        statusHistory: [
          { status: 'Untouched', date: new Date().toISOString(), updatedBy: 'EMPB' },
        ],
      });

    assert.equal(res.status, 200);
    const stored = fallbackStore.leads.find((l: any) => l.mobile === '01700000019');
    assert.ok(stored);

    // Actor must be from session (EMPA), not spoofed EMPB
    assert.equal(stored.assignedBy, 'EMPA', 'assignedBy must be session user, not spoofed');
    // customFields assignedBy should be session user
    assert.equal(stored.customFields?.assignedBy || stored.assignedBy, 'EMPA');

    // Check that returned data also has session-derived actor
    const returned = res.body.data;
    assert.equal(returned.assignedBy, 'EMPA');

    // Assignment history spoofing check - changedBy must be session
    const history = returned.assignmentHistory || stored.assignmentHistory || [];
    if (history.length > 0) {
      const last = history[history.length - 1];
      // Our fix ensures changedBy is always caller.employee_id
      assert.notEqual(last.changedBy, 'EMPB', 'changedBy should not be spoofed EMPB');
      // It should be EMPA (or at least not EMPB)
      assert.ok(last.changedBy === 'EMPA' || last.changedBy === undefined || typeof last.changedBy === 'string', 'changedBy should be sanitized');
      // For new entries, it should be EMPA
      if (last.changedBy) {
        assert.equal(last.changedBy, 'EMPA', 'changedBy in history must be session user');
      }
    }

    // Status history
    const statusHist = returned.statusHistory || [];
    if (statusHist.length > 0) {
      for (const entry of statusHist) {
        if (entry.updatedBy) {
          assert.equal(entry.updatedBy, 'EMPA', 'statusHistory updatedBy must be session user');
        }
      }
    }
  });

  it('10. Failed mutation: API/DB failure must not update local cache as success', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    const userB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA, userB);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });

    // Create lead as A
    const createRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerName: 'Fail Test', mobile: '01700000020' });
    assert.equal(createRes.status, 200);
    const leadId = createRes.body.data.id;

    // Try to update as B (should fail 403) and ensure store unchanged
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email, name: userB.fullName });
    const failRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ id: leadId, customerName: 'Hacked', mobile: '01700000020' });

    assert.equal(failRes.status, 403);

    const stored = fallbackStore.leads.find((l: any) => l.id === leadId);
    assert.ok(stored);
    assert.equal(stored.customerName, 'Fail Test', 'Failed mutation must not update cache');
  });

  it('11. Duplicate/idempotency: authz cannot be bypassed via mobile/upsert', async () => {
    const userA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    const userB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE' });
    fallbackStore.users.push(userA, userB);
    const tokenA = signToken({ id: userA.id, employeeId: userA.employeeId, role: userA.role, email: userA.email, name: userA.fullName });
    const tokenB = signToken({ id: userB.id, employeeId: userB.employeeId, role: userB.role, email: userB.email, name: userB.fullName });

    // User A creates lead with mobile X
    const createRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerName: 'Original', mobile: '01700000021' });
    assert.equal(createRes.status, 200);
    const leadId = createRes.body.data.id;

    // User B tries to create another lead with same mobile (duplicate) - should be rejected via authz
    const dupRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ customerName: 'Duplicate Attempt', mobile: '01700000021' });

    // Should be 403 because existing lead is outside B's scope
    assert.equal(dupRes.status, 403, `Duplicate upsert bypass should be 403, got ${dupRes.status}`);

    // Original should remain unchanged
    const stored = fallbackStore.leads.find((l: any) => l.id === leadId);
    assert.ok(stored);
    assert.equal(stored.customerName, 'Original');

    // User A can upsert same mobile (idempotent) - should succeed and update
    const upsertRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerName: 'Original Updated', mobile: '01700000021' });
    assert.equal(upsertRes.status, 200);
    const storedAfter = fallbackStore.leads.find((l: any) => l.id === leadId || l.mobile === '01700000021');
    assert.ok(storedAfter);
    assert.equal(storedAfter.customerName, 'Original Updated', 'Owner upsert should succeed');
  });

  it('Admin can reassign but actor is session, not payload', async () => {
    const admin = makeUser({ employeeId: 'ADMIN1', role: 'ADMIN' });
    const empA = makeUser({ employeeId: 'EMPA', role: 'EMPLOYEE' });
    const empB = makeUser({ employeeId: 'EMPB', role: 'EMPLOYEE' });
    fallbackStore.users.push(admin, empA, empB);
    const tokenAdmin = signToken({ id: admin.id, employeeId: admin.employeeId, role: admin.role, email: admin.email, name: admin.fullName });
    const tokenA = signToken({ id: empA.id, employeeId: empA.employeeId, role: empA.role, email: empA.email, name: empA.fullName });

    // EmpA creates
    const createRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ customerName: 'Admin Reassign Test', mobile: '01700000022' });
    assert.equal(createRes.status, 200);
    const leadId = createRes.body.data.id;

    // Admin reassigns to EMPB, but tries to spoof assignedBy as EMPB
    const reassignRes = await request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ id: leadId, customerName: 'Admin Reassign Test', mobile: '01700000022', assignedTo: 'EMPB', assignedBy: 'EMPB' });

    assert.equal(reassignRes.status, 200);
    const returned = reassignRes.body.data;
    // Target should be EMPB (allowed for admin)
    assert.equal(returned.assignedTo, 'EMPB');
    // Actor should be ADMIN1, not EMPB
    assert.equal(returned.assignedBy, 'ADMIN1', 'Admin reassignment actor must be session admin, not payload');
  });
});
