/**
 * role-feature-access-alignment.test.ts — Role Feature Access alignment
 * ------------------------------------------------------------------
 * Source guards for the Role Feature Access administration UI
 * (`src/modules/users/pages/UserManagement.tsx` "Roles & Access" tab +
 * `src/modules/admin/services/adminService.ts` defaults) staying aligned
 * with the primary navigation / More directories / routes / Dashboard /
 * Daily Workbench.
 *
 * Guards:
 *  - No unenforced fine-grained dashboard child toggles (dead controls)
 *  - Daily Workbench added to the feature taxonomy (route /workbench)
 *  - Legacy labels renamed to current navigation names; internal keys kept
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
    assert.ok(slice.includes("'/workbench': featureOn('workbench')"), '/workbench must be driven by the workbench module toggle');
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

  it('labels match the current enterprise workspace names (internal keys preserved)', () => {
    const block = appFeaturesBlock();
    // Enterprise checklist redesign (2026-11-20, Mahadi): the editor's
    // visible labels mirror the app's sidebar labels
    // (src/layouts/enterpriseNav.ts) and page titles (FALLBACK_LABELS).
    // A page whose sidebar label differs per role carries the combined
    // label (My Work / Team Overview, My / Team Performance).
    for (const label of [
      'My Work / Team Overview',
      'My Leads / Team Leads / All Leads',
      'Add Lead',
      'Lead Intake',
      'Lead Pool',
      'Follow-up Queue',
      'Team Members',
      'My Performance / Team Performance',
      'NCP Progress',
      'Trends & Reports',
      'Campaigns',
      'Users & Roles',
      'Profile & Settings',
      'Roadshow',
      'Daily Workbench',
      'Task Calendar',
      'Activities',
      'Notifications',
      'Help',
      'About',
    ]) {
      assert.ok(block.includes(`label: '${label}'`), `must use current label '${label}'`);
    }
    // Legacy visible labels removed. NOTE: 'Dashboard', 'Users' and
    // 'Settings' are NOT in this list — those words survive as
    // ACTION_PERMISSION_GROUPS module names ('Dashboard', 'Users',
    // 'Settings'), which the block span also covers; only the
    // FEATURE labels were renamed.
    for (const legacy of ["'Lead Workspace'", "'Add New Lead'", "'Bulk Upload'", "'Performance'", "'Trends'", "'Team'", "'Roadshow Follow-up'", "'Help & Support'", "'About LeadFlow'", "'Execution Intelligence'", "'Trend Charts'", "'Campaign Breakdown'", "'Follow-up Strategy'", "'Team Progress'", "'Lead Generation'", "'Sync Settings'"]) {
      assert.ok(!block.includes(legacy), `legacy label ${legacy} must be renamed`);
    }
    // Internal keys preserved (not blindly renamed). NOTE: `view_sync` was a
    // settings_control SUB-OPTION key and is intentionally gone — the editor
    // no longer exposes action-like child toggles (the self-service key now
    // lives only in usePermissions' SELF_SERVICE_SETTINGS_KEYS mapping).
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
    ]) {
      assert.ok(block.includes(key), `internal key ${key} must be preserved`);
    }
  });

  it('feature groups mirror the enterprise workspace structure', () => {
    const block = appFeaturesBlock();
    // Strip sub-option blocks so only top-level feature keys remain.
    const topLevel = block.replace(/suboptions:\s*\[[\s\S]*?\],/g, '');
    const keys: string[] = [];
    const re = /key:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(topLevel)) !== null) keys.push(m[1]);
    // Checklist order (2026-11-20): the sidebar WORKSPACE order first,
    // then Reports, Administration, More pages.
    const expected = [
      'dashboard',
      'lead_tracking',
      'lead_generate',
      'lead_upload',
      'all_leads',
      'follow_up_strategy',
      'team_progress',
      'execution_intelligence',
      'task_calendar',
      'roadshow_follow_up',
      'activities',
      'workbench',
      'ncp_progress',
      'trend_charts',
      'campaign_breakdown',
      'user_management',
      'settings_control',
      'notifications',
      'help_support',
      'about_leadflow',
    ];
    assert.deepEqual(keys, expected, 'feature taxonomy must include every navigation destination in checklist order');
    // Groups mirror where the page lives in the app — no stale
    // 'Primary navigation' / 'More → Reports' / 'More' groups (there is
    // no More menu anymore; the sidebar has WORKSPACE, CONFIGURATION
    // and ADMINISTRATION groups).
    for (const group of ['Workspace', 'Reports', 'Administration', 'More pages']) {
      assert.ok(block.includes(`group: '${group}'`), `group '${group}' must exist`);
    }
    for (const stale of ["group: 'Primary navigation'", "group: 'More → Reports'", "group: 'More'"]) {
      assert.ok(!block.includes(stale), `stale group ${stale} must be gone`);
    }
    // Spot-check the key → group mapping (parsed per feature entry).
    const groupOf = new Map<string, string>();
    const entryRe = /key: '([^']+)'[\s\S]*?group: '([^']+)'/g;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(topLevel)) !== null) groupOf.set(e[1], e[2]);
    const expectedGroups: Record<string, string> = {
      dashboard: 'Workspace',
      lead_tracking: 'Workspace',
      lead_upload: 'Workspace',
      all_leads: 'Workspace',
      execution_intelligence: 'Workspace',
      workbench: 'Workspace',
      ncp_progress: 'Reports',
      trend_charts: 'Reports',
      campaign_breakdown: 'Reports',
      user_management: 'Administration',
      settings_control: 'Administration',
      notifications: 'More pages',
      help_support: 'More pages',
      about_leadflow: 'More pages',
    };
    for (const [key, group] of Object.entries(expectedGroups)) {
      assert.equal(groupOf.get(key), group, `feature ${key} must sit in group '${group}'`);
    }
  });

  it('Lead Pool stays a view control and does not claim data-scope authority', () => {
    const block = appFeaturesBlock();
    // Lead Pool is a standalone top-level module toggle (the internal key
    // remains all_leads for route/API compatibility).
    assert.ok(block.includes("key: 'all_leads'"), 'all_leads must be a top-level feature key');
    assert.ok(block.includes('Lead Pool'), 'visible label Lead Pool must exist');
    // Menu/route access must never be conflated with server data visibility.
    assert.ok(block.includes('server Data Visibility'), 'Lead Pool description must defer data scope to server visibility');
    const src = userMgmt();
    const saveIdx = src.indexOf('menuAccess: {');
    const slice = src.slice(saveIdx, saveIdx + 800);
    assert.ok(slice.includes("'/leads/all': featureOn('all_leads')"), '/leads/all must be driven by the all_leads module toggle');
  });

  it('dataVisibility scopes are preserved in the editor', () => {
    const src = userMgmt();
    for (const scope of ["'Own'", "'DownTeam'", "'FullTeam'", "'Organization'"]) {
      assert.ok(src.includes(scope), `dataVisibility scope ${scope} must remain`);
    }
    // The legacy leads.edit proxy is now derived from the canonical grant.
    assert.ok(src.includes("edit: granted('leads.edit')"), 'legacy actions.edit must be derived from the canonical leads.edit grant');
  });

  it('Daily Workbench mutations still gate on lead_tracking edit (leads.edit), not workbench view', () => {
    const wb = stripComments(workbench());
    assert.ok(wb.includes("canAccess('lead_tracking', 'edit')"), 'Workbench mutations must gate on lead_tracking edit');
    assert.ok(!wb.includes("canAccess('workbench', 'edit')"), 'Workbench view feature must not gate mutations');
  });

  it('server remains the final authorization boundary for leads.edit', () => {
    // Phase 1 PR #6: the lead handlers live in production/leads.routes.ts
    // (mounted by production.routes.ts; same router). The Phase 1 finale
    // moved the dashboard handler (whose fail-closed gate this test also
    // reads) to production/dashboard.routes.ts.
    const prod =
      read('server/routes/production.routes.ts') +
      read('server/routes/production/leads.routes.ts') +
      read('server/routes/production/dashboard.routes.ts');
    assert.ok(prod.includes("hasPermissionCode(caller, 'leads.edit')"), 'server must enforce leads.edit');
    assert.ok(prod.includes('fail closed') || prod.includes('Fail closed'), 'fail-closed semantics preserved');
  });

  it('usePermissions maps the workbench feature to /workbench', () => {
    const p = permsHook();
    assert.ok(p.includes('workbench'), 'usePermissions must know workbench');
    assert.ok(p.includes("'/workbench'"), 'workbench must map to /workbench');
  });

  it('the sidebar dropped Daily Workbench, and the Agent nav keeps the My Work label', () => {
    // Team Lead / Manager / Admin workspace (2026-11-20): NO role's
    // sidebar carries /workbench anymore — the Agent home (My Work)
    // is the day's workspace, and /workbench stays live by URL + on
    // the Agent bottom bar as "Workbench". Agent workspace rebuild
    // (2026-11-20): "My Work" survives as the Agent sidebar label
    // and breadcrumb — the home's H1 is the time-based greeting now.
    // The routes are unchanged.
    const nav = read('src/layouts/enterpriseNav.ts');
    assert.doesNotMatch(nav, /label: 'Daily Workbench'[^}]*path: '\/workbench'/,
      'no sidebar item may offer Daily Workbench anymore');
    assert.match(nav, /label: 'Workbench'[^}]*path: '\/workbench'/,
      'the Agent bottom bar still reaches /workbench as Workbench');
    assert.match(nav, /label: 'Follow-up Queue'[^}]*path: '\/follow-up'/,
      'the sidebar must keep the Follow-up Queue reachable as Follow-up Queue');
    assert.match(nav, /label: 'My Work'[^}]*path: '\/'/,
      'the Agent nav must keep My Work as the home label');
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
    // Phase 1 (users/access step): the roles endpoints live in
    // production/users.routes.ts (mounted by production.routes.ts).
    const prod = read('server/routes/production/users.routes.ts');
    assert.ok(prod.includes("router.get('/roles/:roleId/permissions'"), 'GET role permissions endpoint must exist');
    assert.ok(prod.includes("router.put('/roles/:roleId/permissions'"), 'PUT role permissions endpoint must exist');
    assert.ok(prod.includes('requireAdmin'), 'role permission writes must be admin-gated');
  });

  it('role permission matrix read is admin-gated (not just authenticated)', () => {
    // Phase 1 (users/access step): see the endpoints test above.
    const prod = read('server/routes/production/users.routes.ts');
    const getIdx = prod.indexOf("router.get('/roles/:roleId/permissions'");
    assert.ok(getIdx >= 0, 'GET role permissions endpoint must exist');
    const line = prod.slice(getIdx, getIdx + 120);
    assert.ok(line.includes('requireAdmin'), 'GET role permissions must require admin (ordinary users must not enumerate role matrices)');
  });

  it('role save reports partial permission failure honestly and keeps editor open', () => {
    const src = userMgmt();
    assert.ok(
      src.includes('Role settings were saved, but action permissions could not be saved. Please retry.'),
      'partial permission failure must use the honest error message'
    );
    // The permission save is wrapped so its failure does not fall through to
    // the generic "could not save" handler, and it does NOT close the editor
    // or claim full success.
    const saveIdx = src.indexOf('adminService.saveRole(payload)');
    assert.ok(saveIdx >= 0, 'role save must call saveRole');
    const slice = src.slice(saveIdx, saveIdx + 1400);
    assert.ok(slice.includes('catch (permErr)'), 'permission save failure must be caught separately');
    assert.ok(slice.indexOf('toast.error') < slice.indexOf("'Role saved successfully.'"), 'partial-failure error must precede the success toast');
    // On partial failure the handler returns before closing the editor or
    // announcing success, so the admin can retry.
    const errIdx = slice.indexOf('toast.error(');
    const successIdx = slice.indexOf('toast.success(');
    const closeIdx = slice.indexOf('setShowRoleForm(false)');
    assert.ok(errIdx >= 0 && errIdx < closeIdx, 'partial-failure branch must run before any editor close');
    assert.ok(successIdx < 0 || errIdx < successIdx, 'error must be raised before any success toast');
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
