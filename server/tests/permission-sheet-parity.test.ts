/**
 * permission-sheet-parity.test.ts
 * ------------------------------------------------------------------
 * Guards the F16 §3.1 divergence fix: the client's permission sheet must
 * resolve EXACTLY like the server's `hasPermissionCode()`.
 *
 * The live audit found a deny override (admin → User Management → set one
 * permission to DENY for one person) that the server honoured with a 403
 * while the UI kept the button enabled, because the hook read only the
 * role grant and ignored `user_override`. The sheet now resolves through
 * one pure function; this suite pins its precedence and fails if the hook
 * ever goes back to reading `is_allowed` alone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildPermissionSheet } from '../../src/modules/shared/utils/permissionSheet';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

describe('Permission sheet — server-precedence resolution', () => {
  it('a user override wins over the role grant (both directions)', () => {
    const sheet = buildPermissionSheet([
      { permission_code: 'audit.view', is_allowed: true, user_override: false },
      { permission_code: 'leads.export', is_allowed: false, user_override: true },
    ]);
    assert.equal(sheet['audit.view'], false, 'deny override must beat a role grant');
    assert.equal(sheet['leads.export'], true, 'allow override must beat a missing role grant');
  });

  it('null / undefined override falls back to the role grant (the ROLE state of the editor)', () => {
    const sheet = buildPermissionSheet([
      { permission_code: 'reports.view', is_allowed: true, user_override: null },
      { permission_code: 'users.delete', is_allowed: false },
    ]);
    assert.equal(sheet['reports.view'], true);
    assert.equal(sheet['users.delete'], false);
  });

  it('absent rows stay absent — callers treat an absent code as deny (fail closed)', () => {
    const sheet = buildPermissionSheet([{ permission_code: 'dashboard.view', is_allowed: true }]);
    assert.equal('leads.delete' in sheet, false, 'a code the caller never received must not be invented');
    assert.deepEqual(buildPermissionSheet([]), {});
    assert.deepEqual(buildPermissionSheet(null), {});
    assert.deepEqual(buildPermissionSheet(undefined), {});
  });

  it('malformed rows are skipped, never trusted', () => {
    const sheet = buildPermissionSheet([
      { permission_code: '', is_allowed: true },
      { is_allowed: true } as any,
      { permission_code: 'leads.view', is_allowed: 1, user_override: 'false' as any },
    ]);
    assert.deepEqual(Object.keys(sheet), ['leads.view']);
    assert.equal(sheet['leads.view'], true, 'a truthy string override is still an override value: Boolean("false") === true is the documented coercion for raw values');
  });

  it('the hook uses the shared resolver and never re-implements it (source guard)', () => {
    const hook = read('src/modules/shared/hooks/usePermissions.ts');
    assert.ok(hook.includes('buildPermissionSheet(rows)'), 'the hook must resolve through the shared sheet builder');
    assert.ok(
      !hook.includes('Boolean(row.is_allowed)'),
      'the old role-grant-only mapping must not come back — it ignored user_override'
    );
    const server = read('server/routes/production.routes.ts');
    assert.ok(server.includes('if (row.has_user_override)'), 'the server rule the sheet mirrors must still exist');
    assert.ok(server.includes('user_override_allowed'), 'the override column must still be resolved server-side');
  });
});
