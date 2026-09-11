/**
 * role-feature-access-alignment.test.ts — Role Feature Access alignment
 * ------------------------------------------------------------------
 * Source guards for the Role Feature Access administration UI
 * (`src/modules/users/pages/UserManagement.tsx` "Roles & Access" tab +
 * `src/modules/admin/services/adminService.ts` defaults) staying aligned
 * with the actual live sidebar / routes / Dashboard / Daily Workbench.
 *
 * Guards:
 *  - No unenforced fine-grained dashboard child toggles (dead controls)
 *  - Daily Workbench added to the feature taxonomy (route /workbench)
 *  - Legacy labels renamed to current sidebar names; internal keys kept
 *  - leads.edit preserved for Daily Workbench mutations
 *  - dataVisibility scopes preserved
 *  - server remains the final authorization boundary
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The APP_FEATURES metadata block only (excludes page title/tab literals). */
function appFeaturesBlock(): string {
  const src = read('src/modules/users/pages/UserManagement.tsx');
  const start = src.indexOf('const APP_FEATURES');
  const end = src.indexOf('MAIN COMPONENT');
  assert.ok(start >= 0, 'APP_FEATURES must exist');
  assert.ok(end > start, 'APP_FEATURES must precede MAIN COMPONENT');
  return src.slice(start, end);
}

describe('Role Feature Access — source guards', () => {
  const userMgmt = () => read('src/modules/users/pages/UserManagement.tsx');
  const adminSvc = () => read('src/modules/admin/services/adminService.ts');
  const layout = () => read('src/layouts/AppLayout.tsx');
  const workbench = () => read('src/modules/workbench/pages/DailyWorkbench.tsx');
  const permsHook = () => read('src/modules/shared/hooks/usePermissions.ts');

  it('no unenforced fine-grained dashboard child toggles remain in the editor', () => {
    const block = appFeaturesBlock();
    for (const dead of [
      'view_calls_stats',
      'view_pipeline_ncp',
      'view_division_table',
      'view_ncp_chart',
      'view_trend_chart',
      'view_campaign_pie',
      'view_critical_alerts',
      'view_agent_table',
      'view_task_calendar',
    ]) {
      assert.ok(!block.includes(dead), `dashboard child toggle ${dead} must be removed from the editor (unenforced on live Dashboard)`);
    }
  });

  it('adminService defaults no longer seed unenforced dashboard child toggles', () => {
    const svc = adminSvc();
    for (const dead of [
      'view_calls_stats',
      'view_pipeline_ncp',
      'view_division_table',
      'view_ncp_chart',
      'view_trend_chart',
      'view_campaign_pie',
      'view_critical_alerts',
      'view_agent_table',
      'view_task_calendar',
    ]) {
      assert.ok(!svc.includes(dead), `adminService must not seed ${dead}`);
    }
    assert.ok(svc.includes("dashboard: { view: true }"), 'dashboard default must reduce to a single view flag');
  });

  it('Daily Workbench is added to the feature taxonomy', () => {
    const block = appFeaturesBlock();
    assert.ok(block.includes("key: 'workbench'"), 'workbench feature key must exist');
    assert.ok(block.includes('Daily Workbench'), 'Daily Workbench visible label must exist');
    assert.ok(block.includes("'workbench'") && block.includes('Daily Workbench'), 'workbench key and label must be paired');
  });

  it('Daily Workbench maps to the /workbench route in the role save payload', () => {
    const src = userMgmt();
    const saveIdx = src.indexOf('menuAccess: {');
    assert.ok(saveIdx >= 0, 'menuAccess must be constructed on save');
    const slice = src.slice(saveIdx, saveIdx + 800);
    assert.ok(slice.includes("'/workbench': roleFormFeatures?.workbench?.view"), '/workbench must be driven by workbench.view');
  });

  it('adminService maps workbench to /workbench and defaults it fail-closed', () => {
    const svc = adminSvc();
    // Newly introduced feature must NOT silently enable for existing
    // custom/restricted roles (fail-closed default; Admin grants explicitly).
    assert.ok(svc.includes('workbench: { view: false }'), 'workbench default must fail closed for non-admin roles');
    assert.ok(svc.includes("feat === 'workbench') route = '/workbench'"), 'workbench must map to /workbench route');
  });

  it('workbench fail-closed default is documented in adminService', () => {
    const svc = adminSvc();
    assert.ok(/FAIL-CLOSED|fail.closed|fail closed/i.test(svc), 'adminService must document the fail-closed workbench default');
  });

  it('legacy labels are renamed to current sidebar names (internal keys preserved)', () => {
    const block = appFeaturesBlock();
    // New current names present
    for (const label of ['Performance', 'Trends', 'Campaigns', 'Follow-up Queue', 'Team', 'Users', 'Add New Lead', 'System Connection']) {
      assert.ok(block.includes(`label: '${label}'`), `must use current label '${label}'`);
    }
    // Legacy visible labels removed
    for (const legacy of ["'Execution Intelligence'", "'Trend Charts'", "'Campaign Breakdown'", "'Follow-up Strategy'", "'Team Progress'", "'Lead Generation'", "'Sync Settings'"]) {
      assert.ok(!block.includes(legacy), `legacy label ${legacy} must be renamed`);
    }
    // Internal keys preserved (not blindly renamed)
    for (const key of [
      "'execution_intelligence'",
      "'trend_charts'",
      "'campaign_breakdown'",
      "'follow_up_strategy'",
      "'team_progress'",
      "'user_management'",
      "'lead_generate'",
      "'lead_tracking'",
      "'settings_control'",
      "'view_sync'",
    ]) {
      assert.ok(block.includes(key), `internal key ${key} must be preserved`);
    }
  });

  it('feature list is presented in the same order as the sidebar', () => {
    const block = appFeaturesBlock();
    // Strip sub-option blocks so only top-level feature keys remain.
    const topLevel = block.replace(/suboptions:\s*\[[\s\S]*?\],/g, '');
    const keys: string[] = [];
    const re = /key:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(topLevel)) !== null) keys.push(m[1]);
    const expected = [
      'dashboard',
      'workbench',
      'activities',
      'task_calendar',
      'follow_up_strategy',
      'lead_tracking',
      'lead_generate',
      'lead_upload',
      'execution_intelligence',
      'ncp_progress',
      'trend_charts',
      'campaign_breakdown',
      'team_progress',
      'user_management',
      'settings_control',
    ];
    assert.deepEqual(keys, expected, 'feature list order must match the sidebar (Overview → My Work → Leads → Insights → Management → System)');
  });

  it('All Leads stays a view control and does not claim data-scope authority', () => {
    const block = appFeaturesBlock();
    assert.ok(block.includes("'view_all_leads_tab'"), 'internal key view_all_leads_tab must be preserved');
    assert.ok(block.includes('All Leads'), 'visible label All Leads must exist');
    // Menu/route access must never be conflated with server data visibility.
    assert.ok(block.includes('data scope still follows role visibility'), 'All Leads description must defer data scope to role visibility');
  });

  it('dataVisibility scopes are preserved in the editor', () => {
    const src = userMgmt();
    for (const scope of ["'Own'", "'DownTeam'", "'FullTeam'", "'Organization'"]) {
      assert.ok(src.includes(scope), `dataVisibility scope ${scope} must remain`);
    }
    assert.ok(src.includes("roleFormFeatures?.lead_tracking?.status_update"), 'lead status update (leads.edit proxy) must remain mapped in save payload');
  });

  it('Daily Workbench mutations still gate on lead_tracking edit (leads.edit), not workbench view', () => {
    const wb = stripComments(workbench());
    assert.ok(wb.includes("canAccess('lead_tracking', 'edit')"), 'Workbench mutations must gate on lead_tracking edit');
    assert.ok(!wb.includes("canAccess('workbench', 'edit')"), 'Workbench view feature must not gate mutations');
  });

  it('server remains the final authorization boundary for leads.edit', () => {
    const prod = read('server/routes/production.routes.ts');
    assert.ok(prod.includes("hasPermissionCode(caller, 'leads.edit')"), 'server must enforce leads.edit');
    assert.ok(prod.includes('fail closed') || prod.includes('Fail closed'), 'fail-closed semantics preserved');
  });

  it('usePermissions maps the workbench feature to /workbench', () => {
    const p = permsHook();
    assert.ok(p.includes('workbench'), 'usePermissions must know workbench');
    assert.ok(p.includes("'/workbench'"), 'workbench must map to /workbench');
  });

  it('sidebar still lists Daily Workbench under MY WORK', () => {
    const l = layout();
    assert.ok(l.includes('Daily Workbench'), 'sidebar must keep Daily Workbench label');
    assert.ok(l.includes("path: '/workbench'"), 'sidebar must keep /workbench path');
  });

  /* ---------- Granular canonical action control ---------- */

  it('editor exposes the canonical leads action matrix', () => {
    const src = userMgmt();
    for (const code of [
      'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
      'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
      'dashboard.view',
    ]) {
      assert.ok(src.includes(code), `canonical action ${code} must be exposed in the editor`);
    }
  });

  it('action permissions are independent (no grouping/derivation coupling)', () => {
    const src = userMgmt();
    // Each action is a standalone checkbox keyed by its canonical code.
    assert.ok(src.includes('roleFormActions[item.code]'), 'each action must toggle independently by code');
    assert.ok(src.includes('setRoleFormActions({ ...roleFormActions, [item.code]: !isOn })'), 'toggling one action must not touch others');
  });

  it('canonical action grants are saved via a dedicated role_permissions write path', () => {
    const src = userMgmt();
    assert.ok(src.includes('adminService.saveRolePermissions(slug, grants)'), 'role save must persist canonical action grants');
    const svc = adminSvc();
    assert.ok(svc.includes('/permissions'), 'adminService must call the role permissions endpoint');
    assert.ok(svc.includes('saveRolePermissions'), 'adminService must expose saveRolePermissions');
    assert.ok(svc.includes('getRolePermissions'), 'adminService must expose getRolePermissions');
  });

  it('canonical action grants come from the server, not localStorage', () => {
    const src = userMgmt();
    assert.ok(src.includes('getRolePermissions(role.roleId)'), 'role edit must load grants from the server');
    const svc = adminSvc();
    // The canonical action layer is fetched from the API; it is never
    // reconstructed from the localStorage role cache.
    const getBlock = svc.slice(svc.indexOf('getRolePermissions'), svc.indexOf('saveRolePermissions'));
    assert.ok(!getBlock.includes('localStorage.getItem'), 'getRolePermissions must not reconstruct grants from localStorage');
  });

  it('server exposes role permission read/write endpoints', () => {
    const prod = read('server/routes/production.routes.ts');
    assert.ok(prod.includes("router.get('/roles/:roleId/permissions'"), 'GET role permissions endpoint must exist');
    assert.ok(prod.includes("router.put('/roles/:roleId/permissions'"), 'PUT role permissions endpoint must exist');
    assert.ok(prod.includes('requireAdmin'), 'role permission writes must be admin-gated');
  });

  it('usePermissions resolves canonical lead actions from server permissions', () => {
    const p = permsHook();
    assert.ok(p.includes("'lead_upl_gen'"), 'lead_upl_gen must map to the leads module');
    assert.ok(p.includes("upload_raw_csv_xlsx: 'import'"), 'bulk upload action must map to leads.import');
    assert.ok(p.includes("delete_destroy_leads: 'delete'"), 'delete action must map to leads.delete');
    assert.ok(p.includes("reassign_global_leads: 'assign'"), 'reassign must map to leads.assign');
    assert.ok(p.includes("export_raw_xlsx: 'export'"), 'export action must map to leads.export');
  });

  it('docs/ROLE_FEATURE_ACCESS_ALIGNMENT.md exists and documents the alignment', () => {
    const doc = read('docs/ROLE_FEATURE_ACCESS_ALIGNMENT.md');
    assert.ok(doc.includes('Role Feature Access'), 'doc must have title');
    assert.ok(doc.includes('Daily Workbench'), 'doc must document Daily Workbench');
    assert.ok(doc.includes('/workbench'), 'doc must document /workbench route');
    assert.ok(doc.includes('leads.edit'), 'doc must document leads.edit workbench mutation boundary');
    assert.ok(doc.includes('dataVisibility') || doc.includes('Data Visibility'), 'doc must document data visibility scopes');
    assert.ok(doc.includes('mapping') || doc.includes('Mapping'), 'doc must include the label/key mapping table');
  });
});
