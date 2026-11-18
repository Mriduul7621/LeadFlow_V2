/**
 * dead-tree-hygiene.test.ts
 * ------------------------------------------------------------------
 * Guards the F14 cleanup (a duplicate component tree that shadowed the live
 * one) and the F15 authorization-ordering rule on the user bulk endpoints.
 *
 *   F14 — `src/pages/*` was a full 17-file duplicate of the module pages that
 *         nothing imported, kept alive only by `src/hooks/*` and `src/utils/*`
 *         copies of the shared helpers. A dead copy is worse than no copy: an
 *         edit lands in the file the app never renders. The whole tree (plus
 *         the unreachable `/leads/:id/edit` page) is gone; only
 *         `src/utils/chunkRecovery.ts` survives because the chunk boundary
 *         imports it for real.
 *         UPDATE (owner, 2026-11-18): the /leads/:id/edit ROUTE is back —
 *         as a real route rendering LeadGenerate in edit mode, because
 *         Lead360's Edit button navigated there and the missing route
 *         sent the user home. What stays gone is the separate
 *         LeadEdit.tsx page: there is ONE edit form (LeadGenerate),
 *         not two. The F14 test below pins that split.
 *   F15 — POST /users/bulk/validate and /users/bulk/commit validated the
 *         payload BEFORE checking the caller's permission, so an unprivileged
 *         caller got `400 No rows supplied` for an empty body and only got the
 *         documented `403 users.create required` once they sent rows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe('Dead code hygiene — F14', () => {
  it('F14. the duplicate src/pages and src/hooks trees are gone', () => {
    assert.equal(exists('src/pages'), false, 'src/pages must not come back — the module pages are the app');
    assert.equal(exists('src/hooks'), false, 'src/hooks was the dead tree\'s private helper copy');
  });

  it('F14. src/utils keeps only the helper the live chunk boundary imports', () => {
    const kept = fs.readdirSync(path.join(ROOT, 'src/utils')).sort();
    assert.deepEqual(kept, ['chunkRecovery.ts'], 'src/utils must hold exactly chunkRecovery.ts');
    // ...and it really is the live one.
    assert.ok(read('src/main.tsx').includes("from './utils/chunkRecovery'"), 'main.tsx installs the live recovery');
    assert.ok(read('src/modules/shared/components/ChunkErrorBoundary.tsx').includes('utils/chunkRecovery'),
      'the error boundary imports the live recovery helper');
  });

  it('F14. no source file imports a removed legacy path', () => {
    // Resolve every relative import against the FILE that writes it, so a
    // module-local helper (`../utils/activityEngine` inside a module page,
    // which resolves to the module's own live copy) is never confused with
    // the deleted root file of the same name.
    const removedFiles = new Set([
      'src/utils/activityEngine.ts', 'src/utils/bangladeshGeography.ts', 'src/utils/dataScope.ts',
      'src/utils/leadStatusMeta.ts', 'src/utils/permissions.ts', 'src/utils/translations.ts',
    ]);
    const removedDirs = ['src/pages', 'src/hooks'];
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });

    for (const file of walk(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file);
      const text = fs.readFileSync(file, 'utf-8');
      const specifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
      for (const spec of specifiers) {
        if (!spec.startsWith('.')) continue;
        const resolved = path.relative(ROOT, path.resolve(path.dirname(file), spec)).replace(/\\/g, '/');
        for (const dir of removedDirs) {
          assert.ok(!resolved.startsWith(dir + '/'), `${rel} imports the removed tree (${spec} -> ${resolved})`);
        }
        if (removedFiles.has(resolved) || removedFiles.has(resolved + '.ts')) {
          assert.fail(`${rel} imports the removed helper (${spec} -> ${resolved})`);
        }
      }
    }
  });

  it('F14. no separate LeadEdit page exists — the /leads/:id/edit route renders LeadGenerate in edit mode', () => {
    // F14 deleted the unreachable LeadEdit.tsx page. The ROUTE came
    // back in 2026-11-18 (owner: Lead360's Edit button navigated
    // there and the missing route sent the user home) — but as
    // LeadGenerate in edit mode, NOT as a second edit page. A
    // separate LeadEdit.tsx would be the same dead-copy bug F14
    // removed: an edit landing in the file the app never renders.
    assert.equal(exists('src/modules/leads/pages/LeadEdit.tsx'), false, 'LeadEdit.tsx must stay deleted — edit mode lives in LeadGenerate');
    for (const rel of ['src/App.tsx', 'src/layouts/featureRouteAccess.ts']) {
      assert.ok(!read(rel).includes('LeadEdit'), `${rel} must not reference LeadEdit`);
    }
    assert.ok(read('src/App.tsx').includes("path: '/leads/:id/edit'"), 'the edit route exists and is reachable');
    assert.ok(read('src/App.tsx').includes('<LazyPage page={<LeadGenerate />} />') || read('src/App.tsx').includes('page={<LeadGenerate />}'),
      'the edit route renders LeadGenerate');
    assert.ok(read('src/layouts/featureRouteAccess.ts').includes("'/leads/:id/edit'"), 'the edit route is access-registered');
    // The canonical entry point survives.
    assert.ok(read('src/App.tsx').includes("path: '/leads/:id/update'"), 'the update route must still exist');
  });
});

describe('Authorization ordering — F15', () => {
  for (const [endpoint, missingMsg] of [
    ['/users/bulk/commit', 'No rows supplied for commit'],
    ['/users/bulk/validate', 'No rows supplied for validation'],
  ] as const) {
    it(`F15. ${endpoint} answers the permission question before the payload question`, () => {
      // Phase 1 (users/access step): the bulk-user handlers live in
      // production/users.routes.ts (mounted by production.routes.ts).
      const src = read('server/routes/production/users.routes.ts');
      const start = src.indexOf(`router.post('${endpoint}'`);
      assert.ok(start > 0, `${endpoint} handler must exist`);
      const body = src.slice(start, src.indexOf('\nrouter.', start + 10));
      const permAt = body.indexOf('users.create required');
      const rowsAt = body.indexOf(missingMsg);
      assert.ok(permAt > 0 && rowsAt > 0, 'both checks must be present');
      assert.ok(permAt < rowsAt,
        'the 403 must be decided before the empty-body 400 — authorization cannot depend on the payload');
    });
  }
});
