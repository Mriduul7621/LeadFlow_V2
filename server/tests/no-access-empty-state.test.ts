/**
 * no-access-empty-state.test.ts
 * ------------------------------------------------------------------
 * F3 — "You don't have access yet" instead of a look of a broken app.
 *
 * Context: `hasPermissionCode()` fails closed. Migration 045 hands the
 * standard roles a default grant so a fresh database works out of the box,
 * but a CUSTOM role (or a role an admin emptied on purpose) still reaches a
 * page through menu access and then gets 403 from every read. Before this
 * change those pages printed the generic red "could not be loaded" card, so
 * the only honest reading was "the product is broken".
 *
 * Contract:
 *   1. Behaviour — `isForbiddenError` says YES for a 403 (any of the shapes
 *      the app's services re-throw) and NO for anything else, so a genuine
 *      failure keeps its original message + Retry.
 *   2. Copy — the empty state names the cause and the fix (Roles & Access),
 *      and is announced to assistive tech (role="status").
 *   3. Wiring — every page that renders a load-error card for a
 *      permission-gated read also speaks this language, and none of them
 *      turns a server outage into "no access".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isForbiddenError } from '../../src/modules/shared/api/forbidden';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PAGES = [
  'src/modules/workbench/pages/DailyWorkbench.tsx',
  'src/modules/leads/pages/AllLeads.tsx',
  'src/modules/roadshows/pages/RoadshowPage.tsx',
  'src/modules/dashboard/pages/SalesPipelinePage.tsx',
];

// Enterprise Preview (2026-11-19): Dashboard.tsx is deleted and the
// "no access" wiring split in two — the shared home hook carries the
// classifier + the forbidden flag, and the four role homes render the
// empty state from the hook's flag.
const HOME_HOOK = 'src/modules/workspace/hooks/useEnterpriseHomeData.ts';
const ROLE_HOMES = [
  'src/modules/workspace/pages/AdminHome.tsx',
  'src/modules/workspace/pages/ManagerHome.tsx',
  'src/modules/workspace/pages/TeamLeadHome.tsx',
  'src/modules/workspace/pages/AgentHome.tsx',
];

describe('F3 — "no access yet" empty state', () => {
  it('A. isForbiddenError recognises every shape a 403 arrives in, and only 403', () => {
    // The ApiError the HTTP client throws.
    assert.equal(isForbiddenError({ status: 403, message: 'You do not have permission to view leads.' }), true);
    // A plain object re-thrown by a service layer.
    assert.equal(isForbiddenError({ statusCode: 403 }), true);
    // axios/fetch-style wrapper.
    assert.equal(isForbiddenError({ response: { status: 403 } }), true);
    // The status was lost but the server's own copy survived.
    assert.equal(isForbiddenError(new Error('You do not have permission to view Roadshows.')), true);

    // NOT a permission problem — these must keep the retry UI.
    assert.equal(isForbiddenError({ status: 401, message: 'Unauthorized' }), false);
    assert.equal(isForbiddenError({ status: 500 }), false);
    assert.equal(isForbiddenError(new Error('Network request failed')), false);
    assert.equal(isForbiddenError(null), false);
    assert.equal(isForbiddenError(undefined), false);
    assert.equal(isForbiddenError(''), false);
  });

  it('B. the component states the cause and the fix, and is announced', () => {
    const src = read('src/modules/shared/components/NoAccessYet.tsx');
    assert.ok(src.includes('data-testid="no-access-yet"'), 'the empty state must be addressable');
    assert.ok(src.includes('role="status"') && src.includes('aria-live="polite"'), 'screen readers must hear it');
    assert.ok(src.includes("You don't have access yet"), 'the title must say exactly what happened');
    assert.ok(src.includes('Roles &amp; Access'), 'the user must learn WHERE an admin fixes it');
    assert.ok(src.includes('Nothing is broken'), 'it must not read like a crash');
    assert.ok(!/dangerouslySetInnerHTML/.test(src), 'no raw HTML injection');

    // `module` is optional and must not leak the word "undefined" into copy.
    const scoped = src.includes('const scope = module ? ` ${module}` : \'\';');
    assert.ok(scoped, 'the module name must be optional');
  });

  it('C. every permission-gated page routes its load failure through the classifier', () => {
    for (const page of PAGES) {
      const src = read(page);
      assert.ok(
        src.includes("from '../../shared/api/forbidden'"),
        `${page} must import the shared classifier`
      );
      assert.ok(src.includes('isForbiddenError('), `${page} must classify the failure`);
      assert.ok(src.includes('<NoAccessYet'), `${page} must render the empty state`);
      assert.ok(src.includes('setForbidden(false)'), `${page} must clear the flag on retry/refresh`);
      assert.ok(/setForbidden\(true\)/.test(src), `${page} must set the flag on a 403`);
    }

    // The role homes split the wiring: the shared hook carries the
    // classifier + the flag, and each home renders the empty state.
    const hook = read(HOME_HOOK);
    assert.ok(hook.includes("from '../../shared/api/forbidden'"), `${HOME_HOOK} must import the shared classifier`);
    assert.ok(hook.includes('isForbiddenError('), `${HOME_HOOK} must classify the failure`);
    assert.ok(hook.includes('setForbidden(false)'), `${HOME_HOOK} must clear the flag on retry/refresh`);
    assert.ok(/setForbidden\(true\)/.test(hook), `${HOME_HOOK} must set the flag on a 403`);
    for (const home of ROLE_HOMES) {
      assert.ok(read(home).includes('<NoAccessYet'), `${home} must render the empty state`);
    }
  });

  it('D. a real failure still shows the retry message (never "no access")', () => {
    const expectations: Record<string, string> = {
      // Enterprise Preview: the dashboard failure message moved from
      // Dashboard.tsx's setError into the home hook's setMetricsError.
      [HOME_HOOK]: "setMetricsError('Dashboard data could not be loaded.')",
      'src/modules/workbench/pages/DailyWorkbench.tsx': "setError('Daily work could not be loaded.')",
      'src/modules/leads/pages/AllLeads.tsx': "toast.error('Initialization matrix sync failure')",
      'src/modules/roadshows/pages/RoadshowPage.tsx': "setLoadError(error instanceof Error ? error.message : 'Roadshows could not be loaded.')",
      'src/modules/dashboard/pages/SalesPipelinePage.tsx': "setError(err instanceof Error ? err.message : 'Could not load the sales pipeline.')",
    };
    for (const [page, fallback] of Object.entries(expectations)) {
      assert.ok(read(page).includes(fallback), `${page} must keep its original failure path`);
    }

    // The Workbench decides on TWO rejected reads: "no access" only when both
    // were denied, otherwise the ordinary "try again" message survives.
    const wb = read('src/modules/workbench/pages/DailyWorkbench.tsx');
    assert.ok(
      wb.includes('isForbiddenError(followUpAllRes.reason) && isForbiddenError(scheduledRangeRes.reason)'),
      'the workbench must require BOTH reads to be denied before claiming "no access"'
    );
  });

  it('E. the empty state never hides a page the server DID answer', () => {
    // Guard against the tempting shortcut: `forbidden` may gate content only
    // in branches that already existed for errors/loading, not the whole page.
    // Enterprise Preview: the role homes early-return the empty state
    // (the hook's flag is only ever set when the metrics read was
    // denied, never when the server answered), and the pipeline still
    // swaps the error card.
    for (const home of ROLE_HOMES) {
      assert.ok(read(home).includes('if (forbidden) return <NoAccessYet'), `${home} must early-return the empty state on forbidden`);
    }
    const pipeline = read('src/modules/dashboard/pages/SalesPipelinePage.tsx');
    assert.ok(pipeline.includes('{forbidden ? (\n        <NoAccessYet'), 'the pipeline swaps the error card');
  });

  it('F. source guard: the classifier stays dependency-free and importable', () => {
    const src = read('src/modules/shared/api/forbidden.ts');
    assert.ok(!/from '\.\/http'/.test(src), 'must not import the HTTP client (keeps it Node-test friendly)');
    assert.ok(/export function isForbiddenError/.test(src), 'the classifier is exported');
  });
});
