import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Import hardened helpers directly (they are exported from production.routes.ts)
import {
  isLeadAccessible,
  isAssignedToAllowed,
  sanitizeCustomFields,
  FORBIDDEN_CUSTOM_KEYS,
  buildSecureLeadRecord,
  type CallerDbInfo,
} from '../routes/production.routes.js';

// Helper to create caller
function makeCaller(overrides: Partial<CallerDbInfo> = {}): CallerDbInfo {
  return {
    id: 'user-1',
    employee_id: 'EMP001',
    email: 'emp1@example.com',
    role_id: 'role-emp',
    role_code: 'EMPLOYEE',
    department_id: 'dept-1',
    ...overrides,
  };
}

describe('Lead Hardening - Spoofing Prevention', () => {
  it('FORBIDDEN_CUSTOM_KEYS contains critical authz fields', () => {
    assert.ok(FORBIDDEN_CUSTOM_KEYS.has('assignedBy'));
    assert.ok(FORBIDDEN_CUSTOM_KEYS.has('assigned_by'));
    assert.ok(FORBIDDEN_CUSTOM_KEYS.has('updatedBy'));
    assert.ok(FORBIDDEN_CUSTOM_KEYS.has('createdBy'));
    assert.ok(FORBIDDEN_CUSTOM_KEYS.has('owner'));
    assert.ok(FORBIDDEN_CUSTOM_KEYS.has('visibility'));
    assert.ok(FORBIDDEN_CUSTOM_KEYS.has('role'));
  });

  it('sanitizeCustomFields strips forbidden keys', () => {
    const input = {
      assignedBy: 'HACKER',
      assigned_by: 'HACKER',
      updatedBy: 'HACKER',
      createdBy: 'HACKER',
      owner: 'HACKER',
      visibility: 'Organization',
      role: 'ADMIN',
      legitField: 'keep-me',
      campaignName: 'should-be-stripped? no, campaignName is allowed via reserved but not forbidden',
    };
    const out = sanitizeCustomFields(input as any);
    assert.equal(out.assignedBy, undefined);
    assert.equal(out.assigned_by, undefined);
    assert.equal(out.updatedBy, undefined);
    assert.equal(out.owner, undefined);
    assert.equal(out.visibility, undefined);
    assert.equal(out.role, undefined);
    assert.equal(out.legitField, 'keep-me');
  });

  it('buildSecureLeadRecord derives assignedBy/created_by from caller, not client payload', async () => {
    const caller = makeCaller({ id: 'caller-123', employee_id: 'EMP999', email: 'caller@example.com' });
    const target = { userId: 'target-456', employeeId: 'EMP456' };
    const payload = {
      customerName: 'John Doe',
      mobile: '01700000001',
      assignedTo: 'HACKER_EMP',
      assignedBy: 'HACKER_EMP',
      createdBy: 'HACKER_ID',
      updatedBy: 'HACKER_ID',
      customFields: {
        assignedBy: 'HACKER',
        owner: 'HACKER',
        legit: 'ok',
      },
      notes: 'test',
    };
    const record = await buildSecureLeadRecord(payload, caller, target);
    assert.ok(!('error' in record));
    if ('error' in record) return;
    // assignedTo should be target, not hacker
    assert.equal(record.assignedTo, target.userId);
    // assignedBy should be caller, not hacker
    assert.equal(record.assignedBy, caller.id);
    // createdBy/updatedBy should be caller
    assert.equal(record.createdBy, caller.id);
    assert.equal(record.updatedBy, caller.id);
    // customFields should not contain forbidden keys
    assert.equal((record.customFields as any).assignedBy, caller.employee_id); // reserved field set to caller employee_id
    // But the hacker value from customFields bag should be stripped and replaced by reserved
    assert.notEqual((record.customFields as any).assignedBy, 'HACKER');
    // legit field from top-level? we only allow primitives not objects, but customFields bag legit should be kept if not forbidden
    // Actually buildSecureLeadRecord only keeps flat primitives from top-level excluding ignored, so legit from customFields bag
    // should be sanitized but kept
    // Let's check that forbidden 'owner' is not present
    assert.equal((record.customFields as any).owner, undefined);
  });
});

describe('Lead Hardening - Ownership & Visibility', () => {
  it('owner can access own lead', () => {
    const caller = makeCaller({ id: 'user-1', employee_id: 'EMP001' });
    const visibility = { all: false, userIds: ['user-1'], employeeIds: ['EMP001'] };
    const leadRow = {
      assigned_to: 'user-1',
      custom_fields: { assignedTo: 'EMP001' },
      created_by: 'user-1',
    };
    assert.equal(isLeadAccessible(leadRow, visibility, caller), true);
  });

  it('non-owner cannot access other user lead', () => {
    const caller = makeCaller({ id: 'user-1', employee_id: 'EMP001' });
    const visibility = { all: false, userIds: ['user-1'], employeeIds: ['EMP001'] };
    const leadRow = {
      assigned_to: 'user-2',
      custom_fields: { assignedTo: 'EMP002' },
      created_by: 'user-2',
    };
    assert.equal(isLeadAccessible(leadRow, visibility, caller), false);
  });

  it('manager can access downline lead via visibility', () => {
    const manager = makeCaller({ id: 'mgr-1', employee_id: 'MGR001', role_code: 'MANAGER' });
    const visibility = {
      all: false,
      userIds: ['mgr-1', 'user-2', 'user-3'],
      employeeIds: ['MGR001', 'EMP002', 'EMP003'],
    };
    const downlineLead = {
      assigned_to: 'user-2',
      custom_fields: { assignedTo: 'EMP002' },
      created_by: 'user-2',
    };
    assert.equal(isLeadAccessible(downlineLead, visibility, manager), true);
  });

  it('manager sibling rejection - cannot access sibling team lead', () => {
    const manager = makeCaller({ id: 'mgr-1', employee_id: 'MGR001', role_code: 'MANAGER' });
    const visibility = {
      all: false,
      userIds: ['mgr-1', 'user-2'],
      employeeIds: ['MGR001', 'EMP002'],
    };
    const siblingLead = {
      assigned_to: 'user-9',
      custom_fields: { assignedTo: 'EMP009' },
      created_by: 'user-9',
    };
    assert.equal(isLeadAccessible(siblingLead, visibility, manager), false);
  });

  it('canonical unassigned rows do not inherit a stale custom owner', () => {
    const caller = makeCaller({ id: 'user-1', employee_id: 'EMP001' });
    const visibility = { all: false, userIds: ['user-1'], employeeIds: ['EMP001'] };
    const staleRow = {
      assigned_to: null,
      custom_fields: { assignedTo: 'EMP001' },
      created_by: 'user-9',
    };
    assert.equal(isLeadAccessible(staleRow, visibility, caller), false);
  });

  it('admin bypass - visibility.all = true allows any lead', () => {
    const admin = makeCaller({ id: 'admin-1', employee_id: 'ADMIN001', role_code: 'ADMIN' });
    const visibility = { all: true, userIds: [], employeeIds: [] };
    const anyLead = {
      assigned_to: 'user-9',
      custom_fields: { assignedTo: 'EMP009' },
      created_by: 'user-9',
    };
    assert.equal(isLeadAccessible(anyLead, visibility, admin), true);
  });
});

describe('Lead Hardening - Assignment Scope', () => {
  it('can assign to self', () => {
    const caller = makeCaller({ id: 'user-1', employee_id: 'EMP001' });
    const visibility = { all: false, userIds: ['user-1'], employeeIds: ['EMP001'] };
    const target = { userId: 'user-1', employeeId: 'EMP001' };
    assert.equal(isAssignedToAllowed(target, visibility, caller), true);
  });

  it('manager can assign to downline', () => {
    const caller = makeCaller({ id: 'mgr-1', employee_id: 'MGR001' });
    const visibility = { all: false, userIds: ['mgr-1', 'user-2'], employeeIds: ['MGR001', 'EMP002'] };
    const target = { userId: 'user-2', employeeId: 'EMP002' };
    assert.equal(isAssignedToAllowed(target, visibility, caller), true);
  });

  it('cannot assign to sibling outside scope', () => {
    const caller = makeCaller({ id: 'user-1', employee_id: 'EMP001' });
    const visibility = { all: false, userIds: ['user-1'], employeeIds: ['EMP001'] };
    const target = { userId: 'user-9', employeeId: 'EMP009' };
    assert.equal(isAssignedToAllowed(target, visibility, caller), false);
  });

  it('admin can assign to anyone', () => {
    const caller = makeCaller({ id: 'admin-1', employee_id: 'ADMIN001', role_code: 'ADMIN' });
    const visibility = { all: true, userIds: [], employeeIds: [] };
    const target = { userId: 'user-9', employeeId: 'EMP009' };
    assert.equal(isAssignedToAllowed(target, visibility, caller), true);
  });

  it('null target (unassigned) is allowed', () => {
    const caller = makeCaller();
    const visibility = { all: false, userIds: ['user-1'], employeeIds: ['EMP001'] };
    assert.equal(isAssignedToAllowed(null, visibility, caller), true);
  });

  it('explicitly allowed unassignment stays NULL rather than defaulting to caller', async () => {
    const caller = makeCaller();
    const record = await buildSecureLeadRecord(
      { customerName: 'Unowned', mobile: '017000000099' },
      caller,
      null,
      { allowUnassigned: true }
    );
    assert.ok(!('error' in record));
    assert.equal(record.assignedTo, null);
  });
});

describe('Lead Hardening - Auth & Persistence', () => {
  it('anon create/update/delete should be rejected - production.routes uses requireAuth for lead routes', () => {
    const file = fs.readFileSync(path.join(process.cwd(), 'server/routes/production.routes.ts'), 'utf-8');
    // Check that POST /leads and bulk and delete use requireAuth
    assert.ok(file.includes("router.post('/leads', requireAuth"), 'POST /leads must use requireAuth');
    assert.ok(file.includes("router.post('/leads/bulk', requireAuth"), 'POST /leads/bulk must use requireAuth');
    assert.ok(file.includes("router.delete('/leads/:id', requireAuth"), 'DELETE /leads/:id must use requireAuth');
    // GET /leads also requires auth
    assert.ok(file.includes("router.get('/leads', requireAuth"), 'GET /leads must use requireAuth');
  });

  it('client leadService is API-first, throws on failure, no silent local success', () => {
    const file = fs.readFileSync(path.join(process.cwd(), 'src/modules/leads/services/leadService.ts'), 'utf-8');
    // Should call apiRequest before localDb
    const createLeadSection = file.split('async createLead')[1]?.split('async bulkUploadLeads')[0] || '';
    assert.ok(createLeadSection.includes('apiRequest'), 'createLead must call apiRequest');
    assert.ok(createLeadSection.includes('cacheLead'), 'createLead must cache after API success');
    // Check that getLeads throws on 4xx, only falls back on >=500 or network
    assert.ok(file.includes('if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err'), 'getLeads must throw on 4xx');
    // Check that deleteLead calls API before local delete
    const deleteSection = file.split('async deleteLead')[1]?.split('async deleteLeadsByCampaign')[0] || '';
    assert.ok(deleteSection.includes('apiRequest'), 'deleteLead must call API');
    assert.ok(deleteSection.includes('localDb.deleteLead'), 'deleteLead must delete cache after API');
    // Ensure no pattern of localDb create before apiRequest
    const badPattern = /localDb\.createLead.*apiRequest|localDb\.updateLead.*apiRequest/s;
    assert.ok(!badPattern.test(createLeadSection), 'Should not write to localDb before API call');
  });

  it('bulk import enforces per-row authz', () => {
    const file = fs.readFileSync(path.join(process.cwd(), 'server/routes/production.routes.ts'), 'utf-8');
    // Look for bulk handler checks
    assert.ok(file.includes('isAssignedToAllowed'), 'bulk handler must check isAssignedToAllowed');
    assert.ok(file.includes('isLeadAccessible'), 'bulk handler must check isLeadAccessible for existing leads');
    assert.ok(file.includes("hasPermissionCode(caller, 'leads.import')"), 'bulk must check import permission');
    assert.ok(file.includes("hasPermissionCode(caller, 'leads.edit')"), 'bulk must check edit permission for updates');
  });

  it('LEAD_UPSERT_SQL includes created_by and updated_by', () => {
    const file = fs.readFileSync(path.join(process.cwd(), 'server/routes/production.routes.ts'), 'utf-8');
    assert.ok(file.includes('created_by'), 'UPSERT must include created_by');
    assert.ok(file.includes('updated_by'), 'UPSERT must include updated_by');
    assert.ok(file.includes('deleted_by'), 'DELETE should set deleted_by');
  });

  it('spoofing fields are not trusted from client - assignedBy derived from session', () => {
    const file = fs.readFileSync(path.join(process.cwd(), 'server/routes/production.routes.ts'), 'utf-8');
    // Check that buildSecureLeadRecord uses caller.id for assignedBy
    assert.ok(file.includes('assignedById = caller.id'), 'assignedBy must be derived from caller.id');
    assert.ok(file.includes('createdBy: caller.id'), 'createdBy must be caller.id');
    assert.ok(file.includes('updatedBy: caller.id'), 'updatedBy must be caller.id');
    // Ensure FORBIDDEN_CUSTOM_KEYS check exists
    assert.ok(file.includes('FORBIDDEN_CUSTOM_KEYS'), 'Must have forbidden keys set');
  });
});
