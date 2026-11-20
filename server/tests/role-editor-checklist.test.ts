/**
 * role-editor-checklist.test.ts — Roles & Access editor checklist redesign
 * ------------------------------------------------------------------
 * Source guards for the single-checklist role editor (Mahadi, 2026-11-20):
 * Role details first, then ONE feature-wise list where enabling a feature
 * reveals that feature's specific actions inline as checkboxes.
 *
 * Guards:
 *  1. Every editor label matches the app's current names (enterprise
 *     workspace sidebar labels / page titles) — the full old→new mapping.
 *  2. FEATURE_ACTION_CODES covers every canonical action code exactly
 *     once, except reports.view, which is shared by the four report
 *     pages and appears under each of them.
 *  3. Every code in the checklist map exists in ACTION_PERMISSION_GROUPS
 *     (no invented codes).
 *  4. Presentation only: handleSaveRole builds the same payload as
 *     before (same menuAccess keys, same grants write, same derived
 *     legacy fields) — the redesign changes no saved shape.
 *  5. reports.view stays in sync: all four appearances read/write the
 *     one shared roleFormActions['reports.view'] grant.
 *  6. ADMIN/SUPERADMIN bypass preserved (actions forced on + locked,
 *     visibility forced to Organization).
 *  7. Editor structure: 1. Role Details (with Data Visibility inside),
 *     then 2. Access Checklist; the old separate panels are gone.
 *  8. Mobile: checklist rows flex without fixed widths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function userMgmt(): string {
  return read('src/modules/users/pages/UserManagement.tsx');
}

/** Parse the APP_FEATURES entries: key → { label, group, path }. */
function appFeatures(): Map<string, { label: string; group: string; path: string }> {
  const src = userMgmt();
  const start = src.indexOf('const APP_FEATURES');
  const end = src.indexOf('const APP_FEATURE_GROUPS');
  assert.ok(start >= 0 && end > start, 'APP_FEATURES block must exist');
  const block = src.slice(start, end);
  const out = new Map<string, { label: string; group: string; path: string }>();
  const re = /\{\s*key: '([^']+)',\s*label: '([^']+)',[\s\S]*?group: '([^']+)',\s*path: '([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.set(m[1], { label: m[2], group: m[3], path: m[4] });
  }
  assert.equal(out.size, 20, 'the editor must catalog exactly 20 features');
  return out;
}

/** Parse ACTION_PERMISSION_GROUPS: the canonical code catalog. */
function actionGroupsBlock(): string {
  const src = userMgmt();
  const start = src.indexOf('const ACTION_PERMISSION_GROUPS');
  const end = src.indexOf('const FEATURE_ACTION_CODES');
  assert.ok(start >= 0 && end > start, 'ACTION_PERMISSION_GROUPS must exist');
  return src.slice(start, end);
}
function canonicalCodes(): string[] {
  const codes: string[] = [];
  const re = /code:\s*'([a-z_.]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(actionGroupsBlock())) !== null) codes.push(m[1]);
  return codes;
}

/** Parse FEATURE_ACTION_CODES: feature key → action codes shown under it. */
function featureActionCodes(): Map<string, string[]> {
  const src = userMgmt();
  const start = src.indexOf('const FEATURE_ACTION_CODES');
  assert.ok(start >= 0, 'FEATURE_ACTION_CODES must exist');
  const block = src.slice(start, src.indexOf('};', start));
  const out = new Map<string, string[]>();
  const re = /(\w+): \[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const codes: string[] = [];
    const codeRe = /'([^']+)'/g;
    let c: RegExpExecArray | null;
    while ((c = codeRe.exec(m[2])) !== null) codes.push(c[1]);
    out.set(m[1], codes);
  }
  return out;
}

describe('Role editor checklist — source guards', () => {
  it('1. every editor label matches the current app names', () => {
    const features = appFeatures();
    const expected: Record<string, { label: string; group: string; path: string }> = {
      dashboard: { label: 'My Work / Team Overview', group: 'Workspace', path: '/' },
      lead_tracking: { label: 'My Leads / Team Leads / All Leads', group: 'Workspace', path: '/leads' },
      lead_generate: { label: 'Add Lead', group: 'Workspace', path: '/leads/new' },
      lead_upload: { label: 'Lead Intake', group: 'Workspace', path: '/leads/upload' },
      all_leads: { label: 'Lead Pool', group: 'Workspace', path: '/leads/all' },
      follow_up_strategy: { label: 'Follow-up Queue', group: 'Workspace', path: '/follow-up' },
      team_progress: { label: 'Team Members', group: 'Workspace', path: '/team' },
      execution_intelligence: { label: 'My Performance / Team Performance', group: 'Workspace', path: '/execution-intelligence' },
      task_calendar: { label: 'Task Calendar', group: 'Workspace', path: '/task-calendar' },
      roadshow_follow_up: { label: 'Roadshow', group: 'Workspace', path: '/roadshows' },
      activities: { label: 'Activities', group: 'Workspace', path: '/activities' },
      workbench: { label: 'Daily Workbench', group: 'Workspace', path: '/workbench' },
      ncp_progress: { label: 'NCP Progress', group: 'Reports', path: '/ncp-progress' },
      trend_charts: { label: 'Trends & Reports', group: 'Reports', path: '/trend-charts' },
      campaign_breakdown: { label: 'Campaigns', group: 'Reports', path: '/campaign-breakdown' },
      user_management: { label: 'Users & Roles', group: 'Administration', path: '/users' },
      settings_control: { label: 'Profile & Settings', group: 'Administration', path: '/settings' },
      notifications: { label: 'Notifications', group: 'More pages', path: '/notifications' },
      help_support: { label: 'Help', group: 'More pages', path: '/help' },
      about_leadflow: { label: 'About', group: 'More pages', path: '/about' },
    };
    for (const [key, want] of Object.entries(expected)) {
      const got = features.get(key);
      assert.ok(got, `feature ${key} must exist`);
      assert.equal(got.label, want.label, `feature ${key} must be labelled '${want.label}'`);
      assert.equal(got.group, want.group, `feature ${key} must sit in group '${want.group}'`);
      assert.equal(got.path, want.path, `feature ${key} must map to route '${want.path}'`);
    }
  });

  it('1b. the editor labels are the app\'s own labels (enterpriseNav cross-check)', () => {
    const nav = read('src/layouts/enterpriseNav.ts');
    // Each part of every editor label must appear verbatim as a sidebar
    // label or a FALLBACK_LABELS page title in the app's nav.
    for (const part of [
      'My Work', 'Team Overview',
      'My Leads', 'Team Leads', 'All Leads',
      'Add Lead', 'Lead Intake', 'Lead Pool',
      'Follow-up Queue', 'Follow-up Monitor',
      'Team Members', 'My Performance', 'Team Performance',
      'Task Calendar', 'Roadshow', 'Activities', 'Daily Workbench',
      'NCP Progress', 'Trends & Reports', 'Campaigns',
      'Users & Roles', 'Profile & Settings', 'Notifications', 'Help', 'About',
    ]) {
      assert.ok(nav.includes(`'${part}'`), `app nav must carry the label '${part}'`);
    }
  });

  it('2. every canonical action appears under exactly one feature (reports.view shared by four)', () => {
    const map = featureActionCodes();
    const counts = new Map<string, string[]>();
    for (const [feature, codes] of map) {
      for (const code of codes) {
        const list = counts.get(code) || [];
        list.push(feature);
        counts.set(code, list);
      }
    }
    for (const code of canonicalCodes()) {
      const homes = counts.get(code) || [];
      if (code === 'reports.view') {
        assert.deepEqual(
          [...homes].sort(),
          ['campaign_breakdown', 'execution_intelligence', 'ncp_progress', 'trend_charts'],
          'reports.view must appear under exactly the four report pages'
        );
      } else {
        assert.equal(homes.length, 1, `action ${code} must appear under exactly one feature (found under: ${homes.join(', ') || 'none'})`);
      }
    }
    // Spot-check the primary homes (each action under the feature where
    // the admin would look for it).
    const homeOf = (code: string) => [...map.entries()].find(([, codes]) => codes.includes(code))?.[0];
    assert.equal(homeOf('leads.create'), 'lead_generate', 'leads.create belongs to Add Lead');
    assert.equal(homeOf('leads.import'), 'lead_upload', 'leads.import belongs to Lead Intake');
    assert.equal(homeOf('leads.delete'), 'all_leads', 'leads.delete belongs to Lead Pool');
    assert.equal(homeOf('leads.view'), 'lead_tracking', 'leads.view belongs to the leads list');
    assert.equal(homeOf('users.add_employee'), 'user_management', 'users.add_employee belongs to Users & Roles');
    assert.equal(homeOf('teams.manage'), 'team_progress', 'teams.manage belongs to Team Members');
    assert.equal(homeOf('settings.manage'), 'settings_control', 'settings.manage belongs to Profile & Settings');
    assert.equal(homeOf('roadshows.create'), 'roadshow_follow_up', 'roadshows.create belongs to Roadshow');
  });

  it('3. every code in the checklist map exists in the canonical catalog', () => {
    const known = new Set(canonicalCodes());
    for (const [feature, codes] of featureActionCodes()) {
      for (const code of codes) {
        assert.ok(known.has(code), `checklist code ${code} (under ${feature}) must exist in ACTION_PERMISSION_GROUPS`);
      }
    }
  });

  it('4. presentation only: handleSaveRole builds the same payload as before', () => {
    const src = userMgmt();
    const start = src.indexOf('const handleSaveRole');
    const end = src.indexOf('const handleDeleteRole');
    assert.ok(start >= 0 && end > start, 'handleSaveRole must exist');
    const save = src.slice(start, end);
    // Same menuAccess keys, driven by the same feature toggles.
    for (const line of [
      "'/': featureOn('dashboard')",
      "'/workbench': featureOn('workbench')",
      "'/leads/new': featureOn('lead_generate')",
      "'/leads/upload': featureOn('lead_upload')",
      "'/leads/all': featureOn('all_leads')",
      "'/leads': featureOn('lead_tracking')",
      "'/execution-intelligence': featureOn('execution_intelligence')",
      "'/ncp-progress': featureOn('ncp_progress')",
      "'/trend-charts': featureOn('trend_charts')",
      "'/campaign-breakdown': featureOn('campaign_breakdown')",
      "'/follow-up': featureOn('follow_up_strategy')",
      "'/task-calendar': featureOn('task_calendar')",
      "'/activities': featureOn('activities')",
      "'/team': featureOn('team_progress')",
      "'/roadshows': featureOn('roadshow_follow_up')",
    ]) {
      assert.ok(save.includes(line), `save payload must still build ${line}`);
    }
    // Same grants write path and same derived legacy fields.
    assert.ok(save.includes('adminService.saveRole(payload)'), 'role save must persist the role');
    assert.ok(save.includes('adminService.saveRolePermissions(slug, grants)'), 'role save must persist the canonical grants');
    assert.ok(save.includes("dataVisibility: isAdm ? 'Organization' : roleFormVisibility"), 'data visibility must save the same way');
    assert.ok(save.includes("edit: granted('leads.edit')"), 'legacy actions.edit must still derive from leads.edit');
    // The grants list is still built from the canonical catalog, not
    // from the checklist map — the map is presentation only.
    assert.ok(
      save.includes('ACTION_PERMISSION_GROUPS.flatMap'),
      'grants must still be built from ACTION_PERMISSION_GROUPS, never from FEATURE_ACTION_CODES'
    );
    assert.ok(!save.includes('FEATURE_ACTION_CODES'), 'handleSaveRole must not read the presentation-only map');
  });

  it('5. reports.view stays in sync across its four appearances', () => {
    const src = userMgmt();
    // All four checkboxes read the ONE shared lookup — there is no
    // per-feature copy of the grant to drift.
    assert.ok(
      src.includes("const isOn = editingBypassRole ? true : !!roleFormActions[item.code];"),
      'every action checkbox must read the shared roleFormActions map by code'
    );
    // And the shared-grant note tells the admin the four toggles are one grant.
    assert.ok(
      src.includes("item.code === 'reports.view'") && src.includes('Shared — one grant covering every report page.'),
      'reports.view must carry the shared-grant note'
    );
  });

  it('6. ADMIN/SUPERADMIN bypass is preserved', () => {
    const src = userMgmt();
    assert.ok(src.includes('disabled={editingBypassRole}'), 'bypass roles must lock the action checkboxes');
    assert.ok(src.includes("editingBypassRole ? true : !!roleFormActions[item.code]"), 'bypass roles must show every action as allowed');
    assert.ok(src.includes("editingBypassRole ? scope === 'Organization'"), 'bypass roles must keep Organization visibility');
    assert.ok(src.includes('bypasses the permission matrix'), 'the bypass explanation must stay in the editor');
  });

  it('7. editor structure: Role Details first, then one Access Checklist', () => {
    const src = userMgmt();
    const details = src.indexOf('1. Role Details');
    const visibility = src.indexOf('Data Visibility', details);
    const checklist = src.indexOf('2. Access Checklist');
    const save = src.indexOf('Save Role', details);
    assert.ok(details >= 0, '1. Role Details must exist');
    assert.ok(visibility > details, 'Data Visibility must live inside Role Details');
    assert.ok(checklist > visibility, '2. Access Checklist must follow Role Details');
    assert.ok(save > details && save < checklist, 'Save Role must sit in the Role Details card');
    assert.ok(!src.includes('3. Feature Access'), 'the old separate Feature Access panel must be gone');
    assert.ok(!src.includes('4. Action Permissions'), 'the old separate Action Permissions panel must be gone');
    assert.ok(src.includes('Back to Roles'), 'Back to Roles must stay');
  });

  it('8. mobile: checklist rows flex without fixed widths', () => {
    const src = userMgmt();
    const start = src.indexOf('2. Access Checklist');
    const end = src.indexOf('TAB 4: HIERARCHY');
    assert.ok(start >= 0 && end > start, 'checklist block must exist');
    const block = src.slice(start, end);
    assert.ok(block.includes('min-w-0'), 'checklist text must shrink instead of overflowing');
    assert.ok(block.includes('shrink-0'), 'the enable toggle must keep its width without squeezing the text');
    assert.ok(!block.includes('w-['), 'the checklist must not use fixed widths');
    assert.ok(!block.includes('min-w-['), 'the checklist must not use fixed min-widths');
  });
});
