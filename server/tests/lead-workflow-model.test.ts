/**
 * Lead Workspace / Lead Pool workflow guards.
 *
 * These tests intentionally combine pure tab classification with source
 * guards for the compatibility boundary: route and database keys stay
 * stable while visible labels and responsibilities change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { filterLeadsByPoolTab, getLeadPoolCounts } from '../../src/modules/leads/utils/leadPool';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function lead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    assignedTo: '',
    currentStatus: 'Untouched',
    ...overrides,
  } as any;
}

describe('Lead workflow model', () => {
  it('classifies pool tabs from canonical assignedTo only', () => {
    const records = [
      lead({ id: 'blank', assignedTo: '' }),
      lead({ id: 'null', assignedTo: null }),
      lead({ id: 'spaces', assignedTo: '  ' }),
      lead({ id: 'owned', assignedTo: 'EMP-2' }),
      lead({ id: 'converted', assignedTo: 'EMP-3', currentStatus: 'Converted' }),
    ];

    assert.deepEqual(filterLeadsByPoolTab(records, 'unassigned').map(x => x.id), ['blank', 'null', 'spaces']);
    assert.deepEqual(filterLeadsByPoolTab(records, 'assigned').map(x => x.id), ['owned', 'converted']);
    assert.equal(filterLeadsByPoolTab(records, 'all').length, records.length);
    assert.deepEqual(getLeadPoolCounts(records), {
      total: 5,
      unassigned: 3,
      assigned: 2,
      converted: 1,
    });
  });

  it('keeps routes and internal feature keys while renaming visible labels', () => {
    const layout = read('src/layouts/AppLayout.tsx');
    const translations = read('src/modules/shared/utils/translations.ts');
    const roleEditor = read('src/modules/users/pages/UserManagement.tsx');
    const app = read('src/App.tsx');

    assert.match(layout, /label: 'Lead Workspace'.*path: '\/leads'/s);
    assert.match(layout, /label: 'Lead Pool'.*path: '\/leads\/all'/s);
    assert.ok(translations.includes('navLeadTracking: "Lead Workspace"'));
    assert.ok(translations.includes('navAllLeads: "Lead Pool"'));
    assert.match(roleEditor, /key: 'lead_tracking',[\s\S]*label: 'Lead Workspace'/);
    assert.match(roleEditor, /key: 'all_leads',[\s\S]*label: 'Lead Pool'/);
    assert.ok(app.includes("path: '/leads'"));
    assert.ok(app.includes("path: '/leads/all'"));
    const leadSection = layout.slice(layout.indexOf("key: 'leads'"), layout.indexOf("key: 'insights'"));
    const order = ['Lead Workspace', 'Add New Lead', 'Bulk Upload', 'Lead Pool'].map(label => leadSection.indexOf(`label: '${label}'`));
    assert.ok(order.every(index => index >= 0));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'sidebar lead order must stay Workspace → Add → Bulk → Pool');
  });

  it('separates feature visibility from canonical action controls', () => {
    const pool = read('src/modules/leads/pages/AllLeads.tsx');
    const workspace = read('src/modules/leads/pages/LeadList.tsx');
    const server = read('server/routes/production.routes.ts');

    assert.ok(pool.includes("canAccess('all_leads', 'view')"));
    assert.ok(pool.includes("canAccess('all_leads', 'assign')"));
    assert.ok(pool.includes("canAccess('all_leads', 'delete')"));
    assert.ok(pool.includes("canAccess('all_leads', 'export')"));
    assert.ok(workspace.includes("canAccess('lead_tracking', 'edit')"));
    assert.ok(workspace.includes("canAccess('lead_tracking', 'export')"));
    assert.ok(server.includes("hasPermissionCode(caller, 'leads.assign')"));
    assert.ok(server.includes("hasPermissionCode(caller, 'leads.delete')"));
    assert.ok(server.includes("hasPermissionCode(caller, 'leads.edit')"));
  });

  it('keeps server visibility authoritative and prevents stale owner shadowing', () => {
    const workspace = read('src/modules/leads/pages/LeadList.tsx');
    const pool = read('src/modules/leads/pages/AllLeads.tsx');
    const server = read('server/routes/production.routes.ts');

    assert.ok(workspace.includes('const visibleLeads = await leadService.getLeads();'));
    assert.ok(pool.includes('const visibleLeads = await leadService.getLeads();'));
    assert.ok(!workspace.includes('getLeads({ \n        role: user.role'));
    assert.ok(!pool.includes('getLeads({ role: UserRole.ADMIN })'));
    assert.ok(server.includes('const hasCanonicalAssignment'));
    assert.ok(server.includes('stale custom_fields.assignedTo'));
    assert.ok(server.includes('const preserveExistingAssignment'));
    assert.ok(server.includes('allowUnassigned: Boolean(existingLead && !targetAssigned)'));
  });

  it('preserves a single record path into workspace and follow-up history', () => {
    const leadService = read('src/modules/leads/services/leadService.ts');
    const server = read('server/routes/production.routes.ts');
    const workspace = read('src/modules/leads/pages/LeadList.tsx');

    assert.ok(leadService.includes("'/api/leads'"));
    assert.ok(leadService.includes('/api/leads/${encodeURIComponent(leadId)}/follow-up'));
    assert.ok(server.includes("router.post('/leads/:id/follow-up'"));
    assert.ok(server.includes('INSERT INTO lead_activities'));
    assert.ok(server.includes('assignmentHistory'));
    assert.ok(workspace.includes('handleUpdateStatus'));
  });

  it('aligns campaign purge UI policy with the admin-only server policy', () => {
    const pool = read('src/modules/leads/pages/AllLeads.tsx');
    const server = read('server/routes/production.routes.ts');
    const workflowDocs = read('docs/LEAD_WORKFLOW_MODEL.md');
    const permissionDocs = read('docs/ROLE_PERMISSION_MODEL.md');

    assert.match(pool, /const canPurgeCampaign = isAdminRole/);
    assert.doesNotMatch(pool, /canDelete\s*&&\s*isAdminRole/);
    assert.match(pool, /Campaign purge is restricted to ADMIN\/SUPERADMIN/);

    const purgeStart = server.indexOf("router.delete('/leads/campaign/:campaign'");
    const purgeEnd = server.indexOf("router.post('/leads/clear-all'", purgeStart);
    assert.ok(purgeStart >= 0 && purgeEnd > purgeStart);
    const purgeRoute = server.slice(purgeStart, purgeEnd).replace(/\/\/.*$/gm, '');
    assert.match(purgeRoute, /requireAuth, requireAdmin/);
    assert.doesNotMatch(purgeRoute, /hasPermissionCode\(caller,\s*'leads\.delete'\)/);
    assert.match(workflowDocs, /Campaign purge \| `requireAdmin` \(`ADMIN`\/`SUPERADMIN`\) only/);
    assert.match(permissionDocs, /Campaign purge is intentionally separate/i);
    assert.match(permissionDocs, /`DELETE \/leads\/campaign\/:campaign` remains `requireAdmin`/);
  });

  it('keeps transfer authorization distinct while preserving assignment and visibility boundaries', () => {
    const server = read('server/routes/production.routes.ts');
    const workflowDocs = read('docs/LEAD_WORKFLOW_MODEL.md');
    const featureDocs = read('docs/ROLE_FEATURE_ACCESS_ALIGNMENT.md');

    assert.match(server, /Normal assignment and unassignment require leads\.assign/);
    assert.match(server, /const isExistingOwnerTransfer/);
    assert.match(server, /isExistingOwnerTransfer \? \(canAssign \|\| canTransfer\)/);
    assert.match(server, /Data Visibility\/assignment-scope check above succeeds/);

    const bulkStart = server.indexOf("router.post('/leads/bulk'");
    const bulkEnd = server.indexOf("router.get('/leads", bulkStart);
    const bulk = server.slice(bulkStart, bulkEnd > bulkStart ? bulkEnd : undefined);
    assert.match(bulk, /Reassigning an existing lead requires leads\.assign or leads\.transfer/);
    assert.match(bulk, /Assigning or unassigning an existing lead requires the leads\.assign permission/);
    assert.match(workflowDocs, /`leads\.assign OR leads\.transfer`/);
    assert.match(workflowDocs, /`leads\.transfer` as the alternative gate/);
    assert.match(featureDocs, /Existing-owner transfer alternative/);
  });
});
