/**
 * enterprise-preview.test.ts
 * ------------------------------------------------------------------
 * Fix round 1 (2026-11-19): Mahadi's ask — "Super admin side bar
 * theke drop down theke role select kore onnano role er preview
 * dekhte parbe." The sample's sidebar rolebox ("Preview role")
 * returns, visible ONLY to super admins, and ONLY as a display
 * preview.
 *
 * Super-admin determination is the SAME as the Danger Zone gate:
 * server SUPER_ADMIN_ROLE_CODES = ["ADMIN", "SUPERADMIN"],
 * DB-resolved per request; the client equivalent is isAdminRole
 * (AdminRoute). Mahadi's own account (employee 2025019, role
 * ADMIN) qualifies. No new super-admin concept, no widened gate.
 *
 * Preview only, never access: the preview changes DISPLAY (nav +
 * overview composition) and nothing else — data stays scoped to
 * the real user, page access still enforces real permissions
 * server-side. The validation is re-applied on every render, never
 * trusted from client state alone.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnterpriseRole } from '../../src/layouts/enterpriseRole';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Strip block + line comments so documented rules don't trip the guards. */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// enterprisePreview imports AdminRoute (a .tsx React module), so it
// is loaded the same way the perf-diagnostics guards load the gate:
// a dynamic import with the .js extension tsx resolves to .ts.
type PreviewModule = typeof import('../../src/layouts/enterprisePreview');
let preview: PreviewModule;
before(async () => {
  preview = await import('../../src/layouts/enterprisePreview.js');
});

describe('canPreviewRoles — the Danger Zone determination, reused', () => {
  it('ADMIN and SUPERADMIN may preview (Mahadi, 2025019, is ADMIN)', () => {
    assert.equal(preview.canPreviewRoles('ADMIN'), true);
    assert.equal(preview.canPreviewRoles('SUPERADMIN'), true);
  });

  it('every other role — including manager role codes — may not', () => {
    for (const role of ['MANAGER', 'TEAM_LEAD', 'RO', 'RM', 'ASM', 'BE', 'BH', 'EMPLOYEE', 'GHOSTROLE']) {
      assert.equal(preview.canPreviewRoles(role), false, `${role} must not preview roles`);
    }
  });

  it('a missing role never previews', () => {
    assert.equal(preview.canPreviewRoles(null), false);
    assert.equal(preview.canPreviewRoles(undefined), false);
    assert.equal(preview.canPreviewRoles(''), false);
  });

  it('the check is the shared isAdminRole, not a retyped list', () => {
    const mod = stripComments(read('src/layouts/enterprisePreview.ts'));
    assert.ok(mod.includes("import { isAdminRole } from '../modules/auth/components/AdminRoute'"));
    assert.ok(mod.includes('return isAdminRole(userRole);'));
    assert.ok(!mod.includes('SUPER_ADMIN_ROLE_CODES'), 'no second copy of the code list');
  });
});

describe('resolveDisplayRole / isPreviewingRole — validated every render', () => {
  it('a super admin with a chosen role previews that role', () => {
    assert.equal(
      preview.resolveDisplayRole({ realRole: 'admin', previewRole: 'agent', canPreview: true }),
      'agent',
    );
    assert.equal(
      preview.isPreviewingRole({ realRole: 'admin', previewRole: 'agent', canPreview: true }),
      true,
    );
  });

  it('a non-super-admin choice is discarded — even a hand-crafted one', () => {
    // The dropdown never renders for them, but even tampered state
    // (devtools, forged previewRole) cannot change the display role.
    for (const role of ['manager', 'teamLead', 'agent'] as EnterpriseRole[]) {
      assert.equal(
        preview.resolveDisplayRole({ realRole: 'agent', previewRole: role, canPreview: false }),
        'agent',
        `a non-super-admin previewing as ${role} still renders as agent`,
      );
      assert.equal(
        preview.isPreviewingRole({ realRole: 'agent', previewRole: role, canPreview: false }),
        false,
      );
    }
  });

  it('no choice means the own derived role, for super admins too', () => {
    assert.equal(
      preview.resolveDisplayRole({ realRole: 'manager', previewRole: null, canPreview: true }),
      'manager',
    );
    assert.equal(
      preview.isPreviewingRole({ realRole: 'manager', previewRole: null, canPreview: true }),
      false,
    );
  });

  it('choosing the own role is not a preview', () => {
    assert.equal(
      preview.isPreviewingRole({ realRole: 'admin', previewRole: 'admin', canPreview: true }),
      false,
    );
  });

  it('the dropdown offers all four roles, in the sample order', () => {
    assert.deepEqual(preview.ENTERPRISE_PREVIEW_ROLE_OPTIONS, ['admin', 'manager', 'teamLead', 'agent']);
  });
});

describe('role preview — the shell wiring (source guards)', () => {
  const layout = stripComments(read('src/layouts/AppLayout.tsx'));

  it('the dropdown renders only when the fresh canPreview verdict is true', () => {
    assert.ok(layout.includes('const canPreview = canPreviewRoles(user?.role);'));
    assert.ok(layout.includes('{canPreview && !roleLoading && ('), 'the rolebox is gated on canPreview');
    assert.ok(layout.includes('className="ep-rolebox"'), 'the sample rolebox styling is used');
  });

  it('the display role comes from resolveDisplayRole, never raw state', () => {
    assert.ok(
      layout.includes('resolveDisplayRole({ realRole: enterpriseRole, previewRole, canPreview })'),
      'the render-time derivation re-validates the preview choice',
    );
    assert.ok(layout.includes('role: displayRole'), 'the sidebar nav is built for the display role');
    // The select's own value defaults to the own role for display
    // (value={previewRole ?? enterpriseRole}) — that is the control's
    // label, not a render path: the value is read in exactly four
    // places (state declaration, the two derivations, the select).
    const previewUses = (layout.match(/previewRole/g) || []).length;
    assert.equal(previewUses, 4, `previewRole is read only in the derivation + the control (${previewUses} uses)`);
  });

  it('a preview shows an unmistakable banner with a one-click way back', () => {
    assert.ok(layout.includes('className="ep-preview-banner"'));
    assert.ok(layout.includes('Previewing as '), 'the banner names the previewed role');
    assert.ok(layout.includes('Back to my view'), 'one click returns to the own view');
    assert.ok(layout.includes('{isPreviewing && ('), 'the banner shows only while previewing');
  });

  it('the display-role context wraps the page content, not the shell', () => {
    assert.ok(layout.includes('<EnterpriseDisplayRoleProvider'));
    assert.ok(layout.includes('realRole: enterpriseRole'), 'the real role travels with the context');
  });

  it('EnterpriseHome renders the DISPLAY role, and the data hook takes no role', () => {
    const home = stripComments(read('src/modules/workspace/pages/EnterpriseHome.tsx'));
    assert.ok(home.includes('useEnterpriseDisplayRole()'));
    const hook = stripComments(read('src/modules/workspace/hooks/useEnterpriseHomeData.ts'));
    assert.ok(
      hook.includes('export function useEnterpriseHomeData(options?: { withUsers?: boolean })'),
      'the data hook has no role parameter — data stays scoped to the real user',
    );
    assert.ok(!hook.includes('displayRole') && !hook.includes('previewRole'), 'the hook never sees the preview');
  });

  it('the display-role context falls back to the derived role without a provider', () => {
    const ctx = stripComments(read('src/layouts/enterpriseDisplayRole.tsx'));
    assert.ok(ctx.includes('useEnterpriseRole()'), 'no provider: the derived role is the display role');
    assert.ok(ctx.includes('isPreviewing: false'), 'no provider: never previewing');
  });
});
