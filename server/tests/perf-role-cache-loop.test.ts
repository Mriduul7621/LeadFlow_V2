import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

describe('Performance regression — role cache refresh must not trigger another role fetch', () => {
  it('does not emit the same-tab role-change event after a successful GET /api/roles', () => {
    const source = read('src/modules/admin/services/adminService.ts');
    assert.ok(source.includes('function writeCache<T>(key: string, value: T, notifyRoleChange = true)'));
    const getRolesStart = source.indexOf('async getRoles(): Promise<RolePermission[]>');
    const saveRoleStart = source.indexOf('async saveRole(', getRolesStart);
    assert.ok(getRolesStart >= 0 && saveRoleStart > getRolesStart);
    const getRolesBody = source.slice(getRolesStart, saveRoleStart);
    assert.ok(getRolesBody.includes('writeCache(KEYS.ROLES, finalized, false)'));
    assert.ok(!getRolesBody.includes('emitRolesCacheChanged()'));
  });

  it('still announces successful role mutations so mounted gates refresh', () => {
    const source = read('src/modules/admin/services/adminService.ts');
    const saveStart = source.indexOf('async saveRole(');
    const deleteStart = source.indexOf('async deleteRole(', saveStart);
    const teamsStart = source.indexOf('// --- CANONICAL ROLE ACTION PERMISSIONS', deleteStart);
    assert.ok(saveStart >= 0 && deleteStart > saveStart && teamsStart > deleteStart);
    const mutations = source.slice(saveStart, teamsStart);
    assert.ok(mutations.includes('writeCache(KEYS.ROLES, roles)'));
    assert.ok(mutations.includes('writeCache(KEYS.ROLES, cachedRoles().filter'));
    assert.ok(source.includes('if (key === KEYS.ROLES && notifyRoleChange) emitRolesCacheChanged()'));
  });
});
