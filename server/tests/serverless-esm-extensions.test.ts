/**
 * serverless-esm-extensions.test.ts
 * ------------------------------------------------------------------
 * Guards the class of bug that broke CI on `main` after the F6 work: a
 * relative import WITHOUT a file extension inside the server runtime graph.
 *
 * Vercel does not bundle `api/index.ts`. It traces the import graph with
 * @vercel/nft and transpiles every traced `.ts` file individually to ESM,
 * then runs the tree with plain Node inside the Lambda. Node ESM requires
 * explicit extensions on relative specifiers, so
 *
 *     import { x } from '../utils/leadStatusRules'
 *
 * type-checks, builds, runs under tsx — and then throws
 * `ERR_MODULE_NOT_FOUND` on the very first request in production.
 * The runtime symptom is a 500 on every route except /api/health.
 *
 * scripts/verify-serverless-build.mjs boots the compiled tree and catches
 * this end-to-end, but only after a ~30 s build+boot; this test walks the
 * same graph statically in milliseconds, so the mistake surfaces in the
 * ordinary unit run (and in CI gate 2) instead of in gate 5.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SPEC = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
const HAS_EXT = /\.(js|ts|tsx|json|css|mjs)$/;

/** Resolve a relative specifier the way TypeScript/tsx would. */
function resolve(fromFile: string, spec: string): string | null {
  const target = path.resolve(path.dirname(fromFile), spec);
  const candidates = spec.endsWith('.js')
    ? [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx')]
    : [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, path.join(target, 'index.ts')];
  return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

/** Every file reachable from the Lambda entry point. */
function serverGraph(): string[] {
  const seen = new Set<string>();
  const stack = [path.join(ROOT, 'api/index.ts')];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf-8');
    for (const m of text.matchAll(SPEC)) {
      const next = resolve(file, m[1]);
      if (next) stack.push(next);
    }
  }
  return [...seen];
}

describe('Serverless ESM — relative imports must carry an extension', () => {
  it('the Lambda import graph has no extensionless relative import', () => {
    const graph = serverGraph();
    // A smoke assertion that the walk found the app (not an empty graph
    // because someone moved the entry point).
    assert.ok(graph.length > 50, `expected a real graph, walked ${graph.length} files`);

    const offenders: string[] = [];
    for (const file of graph) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const m of text.matchAll(SPEC)) {
        if (!HAS_EXT.test(m[1])) {
          offenders.push(`${path.relative(ROOT, file)}  →  ${m[1]}`);
        }
      }
    }
    assert.deepEqual(offenders, [],
      'Node ESM cannot resolve these at Lambda runtime (add the .js extension):\n' + offenders.join('\n'));
  });

  it('the entry graph still includes the pieces the rules depend on', () => {
    const graph = serverGraph().map(f => path.relative(ROOT, f));
    for (const rel of [
      'server/routes/production.routes.ts',
      'server/utils/leadStatusRules.ts',
      'src/modules/leads/utils/leadStatusRules.ts',
      'src/modules/shared/utils/statusFieldRules.ts',
    ]) {
      assert.ok(graph.includes(rel), `${rel} must be part of the traced server graph`);
    }
  });
});
