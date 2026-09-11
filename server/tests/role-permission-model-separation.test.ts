/**
 * role-permission-model-separation.test.ts
 * ------------------------------------------------------------------
 * Source guards for the three-layer permission model introduced to
 * complete the canonical role action permissions (follow-up to PR #28):
 *
 *   Layer A  Data Visibility      — Own / DownTeam / FullTeam / Organization
 *   Layer B  Feature Access       — module/page visibility ONLY
 *   Layer C  Action Permissions   — canonical, server-enforced actions
 *
 * Guards:
 *  1. Feature Access and Action Permissions are separate concepts in the
 *     editor (distinct constants; APP_FEATURES carries no child toggles).
 *  2. Feature Access UI contains module visibility only.
 *  3. Legacy action-like duplicate sub-options are no longer exposed.
 *  4. Every canonical code exposed in the UI exists in the migration-025
 *     permission catalog (no invented codes).
 *  5. Every canonical code exposed is enforced server-side on the mounted
 *     router (hasPermissionCode / requirePermissionCode), and every
 *     protected mutation exposed maps to an enforcement point.
 *  6. Admin-only capabilities stay requireAdmin (role matrix GET/PUT,
 *     fine-permissions, campaign delete / clear-all).
 *  7. Self-service password change is NOT modeled as users.edit.
 *  8. Dependency rule: hidden module => action group marked inactive
 *     (grants preserved), with the documented helper text.
 *  9. usePermissions: self-service settings keys bypass the canonical
 *     fail-closed lookup; configure_* resolves settings.manage.
 * 10. adminService defaults are sub-option free; workbench stays
 *     fail-closed; all_leads has a legacy backfill.
 * 11. docs/ROLE_PERMISSION_MODEL.md documents the model.
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

function userMgmt(): string {
  return read('src/modules/users/pages/UserManagement.tsx');
}
function appFeaturesBlock(): string {
  const src = userMgmt();
  const start = src.indexOf('const APP_FEATURES');
  const end = src.indexOf('const ACTION_PERMISSION_GROUPS');
  assert.ok(start >= 0 && end > start, 'APP_FEATURES must precede ACTION_PERMISSION_GROUPS');
  return src.slice(start, end);
}
function actionGroupsBlock(): string {
  const src = userMgmt();
  const start = src.indexOf('const ACTION_PERMISSION_GROUPS');
  const end = src.indexOf('const ACTION_MODULE_FEATURE_KEYS');
  assert.ok(start >= 0 && end > start, 'ACTION_PERMISSION_GROUPS must exist');
  return src.slice(start, end);
}

/** Canonical codes seeded by migration 025 (parsed from the migration file). */
function migration025Codes(): string[] {
  const src = read('server/database/migrations/025_permissions.ts');
  const codes: string[] = [];
  const re = /\[\s*"([a-z_.]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) codes.push(m[1]);
  assert.ok(codes.length >= 20, 'migration 025 must seed the canonical catalog');
  return codes;
}

/** Codes the editor exposes (parsed from ACTION_PERMISSION_GROUPS). */
function editorCodes(): string[] {
  const block = actionGroupsBlock();
  const codes: string[] = [];
  const re = /code:\s*'([a-z_.]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) codes.push(m[1]);
  assert.ok(codes.length >= 15, 'the editor must expose the full canonical matrix');
  return codes;
}

describe('Role Permission Model — three-layer separation (source guards)', () => {
  const prod = () => stripComments(read('server/routes/production.routes.ts'));

  it('1. Feature Access and Action Permissions are separate constants', () => {
    const src = userMgmt();
    assert.ok(src.includes('const APP_FEATURES'), 'APP_FEATURES (Feature Access) must exist');
    assert.ok(src.includes('const ACTION_PERMISSION_GROUPS'), 'ACTION_PERMISSION_GROUPS must exist');
    assert.ok(
      src.indexOf('const ACTION_PERMISSION_GROUPS') > src.indexOf('const APP_FEATURES'),
      'Action Permissions must be declared as a distinct layer'
    );
  });

  it('2. Feature Access UI contains module visibility only (no child toggles)', () => {
    const src = userMgmt();
    const block = appFeaturesBlock();
    assert.ok(!block.includes('suboptions'), 'APP_FEATURES must not declare suboptions');
    // The module-visibility-only contract is documented at the APP_FEATURES declaration.
    assert.ok(src.includes('MODULE / PAGE VISIBILITY ONLY'), 'the module-visibility-only contract must be documented');
    // Editor renders a plain enable/disable toggle per feature, no checkbox children.
    const renderBlock = src.slice(src.indexOf('3. Feature Access'), src.indexOf('4. Action Permissions'));
    assert.ok(renderBlock.includes('✓ Enabled'), 'feature toggles must render the enable/disable control');
    assert.ok(!renderBlock.includes("type=\"checkbox\""), 'Feature Access panel must not render checkbox children');
  });

  it('3. Legacy action-like duplicate sub-options are no longer exposed', () => {
    const block = appFeaturesBlock();
    for (const legacy of [
      'status_update',
      'view_all_leads_tab',
      "'Create Leads'",
      'Upload Excel File',
      'Delete Campaign Leads',
      'Update Lead Status',
      'dept_view', 'dept_create', 'dept_edit', 'dept_delete',
      'role_view', 'role_create', 'role_edit', 'role_delete',
      'user_view', 'user_create', 'user_edit', 'user_delete',
      'hier_view', 'hier_create', 'hier_edit', 'hier_delete',
      'view_profile', 'view_security', 'view_notifications', 'view_system', 'view_sync',
      'configure_parameters',
    ]) {
      assert.ok(!block.includes(legacy), `legacy sub-option ${legacy} must not be exposed in Feature Access`);
    }
  });

  it('4. Every exposed canonical code exists in the migration-025 catalog (no invented codes)', () => {
    const known = new Set(migration025Codes());
    for (const code of editorCodes()) {
      assert.ok(known.has(code), `editor code ${code} must exist in migration 025 permissions`);
    }
  });

  it('5a. the editor matrix covers the required module groups', () => {
    const block = actionGroupsBlock();
    for (const group of ['Dashboard', 'Leads', 'Users', 'Roles', 'Departments', 'Hierarchy & Teams', 'Settings']) {
      assert.ok(block.includes(`module: '${group}'`), `action group ${group} must exist`);
    }
    for (const code of [
      'dashboard.view',
      'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
      'leads.assign', 'leads.transfer', 'leads.import', 'leads.export',
      'users.create', 'users.edit', 'users.delete',
      'roles.manage', 'permissions.manage',
      'departments.manage',
      'teams.manage', 'hierarchy.manage',
      'settings.manage', 'workflow.manage',
    ]) {
      assert.ok(block.includes(`'${code}'`), `canonical action ${code} must be exposed`);
    }
  });

  it('5b. every exposed code is enforced server-side on the mounted router', () => {
    const prodSrc = prod();
    const enforcedViaHasPermissionCode = [
      'dashboard.view',
      'leads.view', 'leads.create', 'leads.edit', 'leads.delete',
      'leads.assign', 'leads.transfer', 'leads.import',
    ];
    for (const code of enforcedViaHasPermissionCode) {
      assert.ok(prodSrc.includes(`hasPermissionCode(caller, '${code}')`), `${code} must be enforced via hasPermissionCode`);
    }
    // leads.export gates the UI export action; export itself is a
    // client-side download over visibility-filtered data (no dedicated
    // server export endpoint exists — documented in the model docs).
    const docs = read('docs/ROLE_PERMISSION_MODEL.md');
    assert.ok(/[Ee]xport[^\n]*client-side/.test(docs), 'leads.export client-side nature must be documented');
    const enforcedViaRequirePermissionCode: Array<[string, string]> = [
      ["users.create", "router.post('/users', requireAuth, requirePermissionCode('users.create')"],
      ["users.edit", "requirePermissionCode('users.edit')"],
      ["users.delete", "requirePermissionCode('users.delete')"],
      ["roles.manage", "requirePermissionCode('roles.manage')"],
      ["permissions.manage", "requirePermissionCode('permissions.manage')"],
      ["departments.manage", "requirePermissionCode('departments.manage')"],
      ["teams.manage", "requirePermissionCode('teams.manage')"],
      ["hierarchy.manage", "requirePermissionCode('hierarchy.manage')"],
      ["settings.manage", "requirePermissionCode('settings.manage')"],
      ["workflow.manage", "requirePermissionCode('workflow.manage')"],
    ];
    for (const [code, needle] of enforcedViaRequirePermissionCode) {
      assert.ok(prodSrc.includes(needle), `${code} must be enforced via requirePermissionCode`);
    }
  });

  it('5c. requirePermissionCode is fail-closed and preserves the ADMIN/SUPERADMIN bypass', () => {
    const src = read('server/routes/production.routes.ts');
    const start = src.indexOf('function requirePermissionCode(');
    assert.ok(start >= 0, 'requirePermissionCode helper must exist');
    const block = src.slice(start, src.indexOf('/* ====================================================================', start));
    assert.ok(block.includes('hasPermissionCode(caller, permissionCode)'), 'the gate must resolve grants through hasPermissionCode');
    assert.ok(block.includes('401'), 'unauthenticated requests must be rejected');
    assert.ok(!callerBypassInGate(block), 'the bypass must live in hasPermissionCode, not be re-implemented per-gate');
    // hasPermissionCode keeps the fail-closed + admin bypass semantics.
    const hpc = src.slice(src.indexOf('export async function hasPermissionCode'), src.indexOf('export async function resolveCallerVisibility'));
    assert.ok(hpc.includes("role === 'ADMIN' || role === 'SUPERADMIN'"), 'ADMIN/SUPERADMIN bypass preserved');
    assert.ok(/Fail closed|fail closed/i.test(hpc), 'fail-closed semantics documented in hasPermissionCode');
    assert.ok(hpc.includes('return false;'), 'hasPermissionCode must deny by default');
  });

  function callerBypassInGate(block: string): boolean {
    return /SUPERADMIN/.test(block);
  }

  it('6. Admin-only capabilities remain requireAdmin (not canonical toggles)', () => {
    const src = read('server/routes/production.routes.ts');
    for (const route of [
      "router.get('/roles/:roleId/permissions', requireAuth, requireAdmin,",
      "router.put('/roles/:roleId/permissions', requireAuth, requireAdmin,",
      "router.post('/permissions', requireAuth, requireAdmin,",
      "router.delete('/permissions/:roleId', requireAuth, requireAdmin,",
      "router.delete('/leads/campaign/:campaign', requireAuth, requireAdmin,",
      "router.post('/leads/clear-all', requireAuth, requireAdmin,",
    ]) {
      assert.ok(src.includes(route), `${route} must stay admin-gated`);
    }
  });

  it('7. Self-service password change is NOT modeled as users.edit', () => {
    const src = read('server/routes/production.routes.ts');
    const idx = src.indexOf("router.post('/auth/change-password'");
    assert.ok(idx >= 0, 'self-service change-password endpoint must exist');
    const line = src.slice(idx, idx + 160);
    assert.ok(line.includes('requireAuth'), 'change-password must require authentication');
    assert.ok(!line.includes('users.edit') && !line.includes('requirePermissionCode'), 'self-service password change must never require users.edit');
    // The dedicated admin reset endpoint IS canonical-gated (users.edit).
    const resetIdx = src.indexOf("router.post('/users/:id/reset-password'");
    assert.ok(src.slice(resetIdx, resetIdx + 160).includes("requirePermissionCode('users.edit')"), 'admin reset must be canonical-gated');
  });

  it('8. Dependency rule: hidden modules mark action groups inactive (grants preserved)', () => {
    const src = userMgmt();
    assert.ok(src.includes('const ACTION_MODULE_FEATURE_KEYS'), 'module→group activity mapping must exist');
    assert.ok(src.includes('disabled={!groupActive}'), 'inactive groups must disable the checkboxes visually');
    assert.ok(src.includes('grants stay saved but have no effect'), 'the UI must state that saved grants are preserved');
    // Toggling one action never mutates its siblings.
    assert.ok(src.includes('setRoleFormActions({ ...roleFormActions, [item.code]: !isOn })'), 'each action must toggle independently');
  });

  it('9. the editor shows the Feature Access vs Action Permissions helper text', () => {
    const src = userMgmt();
    assert.ok(
      /Feature Access controls whether the module is available\.\s*Action Permissions\s*control what the role can do inside it\./.test(src),
      'helper text must be present'
    );
  });

  it('10. usePermissions: self-service settings bypass canonical lookup; configure_* -> settings.manage', () => {
    const hook = read('src/modules/shared/hooks/usePermissions.ts');
    assert.ok(hook.includes('SELF_SERVICE_SETTINGS_KEYS'), 'self-service settings key list must exist');
    assert.ok(
      hook.includes("['view_profile', 'view_security', 'view_notifications', 'view_system', 'view_sync']"),
      'the self-service key list must cover the five settings sections'
    );
    assert.ok(hook.includes("configure_global_metadata: 'manage'"), 'configure_global_metadata must resolve settings.manage');
    assert.ok(hook.includes("configure_parameters: 'manage'"), 'configure_parameters must resolve settings.manage');
  });

  it('11. adminService defaults are sub-option free with all_leads legacy backfill', () => {
    const svc = read('src/modules/admin/services/adminService.ts');
    for (const legacy of ['dept_view', 'user_create', 'role_edit', 'hier_create', 'configure_parameters', 'status_update', 'view_all_leads_tab']) {
      assert.ok(!svc.includes(`'${legacy}'`) && !svc.includes(`${legacy}:`), `adminService must not seed ${legacy} as a default`);
    }
    assert.ok(svc.includes('view_all_leads_tab'), 'adminService must keep the legacy view_all_leads_tab backfill reference');
    assert.ok(svc.includes("all_leads: { view: false }"), 'all_leads must default fail-closed');
    assert.ok(svc.includes("feat === 'all_leads') route = '/leads/all'"), 'all_leads must map to /leads/all');
    assert.ok(svc.includes('workbench: { view: false }'), 'workbench fail-closed default must remain');
  });

  it('12. docs/ROLE_PERMISSION_MODEL.md documents the complete model', () => {
    const doc = read('docs/ROLE_PERMISSION_MODEL.md');
    assert.ok(doc.includes('Data Visibility'), 'doc must describe Data Visibility');
    assert.ok(doc.includes('Feature Access'), 'doc must describe Feature Access');
    assert.ok(doc.includes('Action Permissions'), 'doc must describe Action Permissions');
    assert.ok(/canonical permission matrix/i.test(doc), 'doc must include the canonical permission matrix');
    assert.ok(/[Ll]egacy compatibility mapping/i.test(doc), 'doc must include the legacy compatibility mapping');
    assert.ok(/[Ss]erver enforcement mapping/i.test(doc), 'doc must include the server enforcement mapping');
    assert.ok(/[Mm]igration behavior/i.test(doc), 'doc must document migration behavior');
    assert.ok(doc.includes('ADMIN') && doc.includes('Manager'), 'doc must include example roles');
    assert.ok(/[Ss]ecurity notes/i.test(doc), 'doc must include security notes');
    assert.ok(/[Ff]ollow-up work/i.test(doc), 'doc must list known follow-up work');
    assert.ok(doc.includes('Forced-password'), 'doc must reference the forced-password follow-up PR');
  });

  it('13. Data Visibility scopes remain untouched and server-side', () => {
    const src = userMgmt();
    for (const scope of ['Own', 'DownTeam', 'FullTeam', 'Organization']) {
      assert.ok(src.includes(`'${scope}'`), `scope ${scope} must remain in the editor`);
    }
    const authz = read('server/authz.ts');
    assert.ok(authz.includes("'Own' | 'DownTeam' | 'FullTeam' | 'Organization'"), 'server visibility scopes unchanged');
  });
});
