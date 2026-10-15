/**
 * lead-generate-hooks-order.test.ts
 * ------------------------------------------------------------------
 * Regression guard for the React #310 crash (P0).
 *
 * `canAccess()` is not synchronous for non-admin roles: the role matrix
 * arrives one tick after mount. `LeadGenerate` used to return the
 * AccessDenied tree BEFORE its hook list, so the first render (no hooks
 * past the gate) and the second render (all hooks) disagreed and React
 * aborted the whole route with error #310 — "Rendered more hooks than
 * during the previous render". Because the route error boundary kept the
 * caught error, EVERY later page in that session showed "Something went
 * wrong" until a manual reload.
 *
 * Two halves, mirroring the repo's test style:
 *   1. Source guards — the capability gate in LeadGenerate sits after
 *      every hook call, the metadata effect is capability-guarded, and
 *      the AccessDenied contract (strings + strictness) is unchanged.
 *   2. A tree-wide scan — no LIVE page component may place a top-level
 *      conditional return before its last hook call. The scanner is
 *      deliberately conservative (component-body indentation only, and
 *      `if (...) { ... return ... }` blocks that actually return).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Every hook call shape used in this codebase's page components. */
const HOOK_CALL =
  /\buse(State|Memo|Effect|Form|Ref|Callback|Context|Reducer|AuthStore|Translation|Permissions|Navigate|Location|Params|SearchParams|Idle|SessionTimeout)\s*\(/;

/**
 * Component-body lines are indented by exactly two spaces inside
 * `export default function Page()`. Nested callbacks/effects indent
 * further, so requiring exactly two spaces keeps the scan free of the
 * false positives a plain regex sweep produces.
 */
const BODY_LINE = /^ {2}\S/;
const TOP_LEVEL_IF = /^ {2}if \(/;

interface Offender {
  file: string;
  lines: number[];
}

/** A top-level `if` that returns, sitting between the first and last hook. */
function scanPageComponent(rel: string): Offender | null {
  const lines = read(rel).split(/\r?\n/);
  const start = lines.findIndex((l) => /export default function \w+/.test(l));
  if (start === -1) return null;
  // Stop at the component's closing brace (column 0): helper functions
  // defined after it are other components/hooks, not this render body.
  const endRel = lines.slice(start + 1).findIndex((l) => l === '}');
  const end = endRel === -1 ? lines.length : start + 1 + endRel;

  const hooks: number[] = [];
  const ifs: number[] = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (!BODY_LINE.test(line)) continue;
    if (HOOK_CALL.test(line)) hooks.push(i);
    if (TOP_LEVEL_IF.test(line)) ifs.push(i);
  }
  if (hooks.length === 0 || ifs.length === 0) return null;

  const first = hooks[0];
  const last = hooks[hooks.length - 1];
  const offenders = ifs.filter((i) => {
    if (i <= first || i >= last) return false;
    // The block must actually return something to be dangerous.
    const block = lines.slice(i, Math.min(i + 40, lines.length)).join('\n');
    const body = block.slice(0, block.indexOf('\n  }') === -1 ? block.length : block.indexOf('\n  }'));
    return /\breturn\b/.test(body);
  });
  return offenders.length ? { file: rel, lines: offenders.map((i) => i + 1) } : null;
}

/** Live page components (the dead `src/pages` duplicate tree is excluded). */
function livePageFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.tsx')) out.push(rel);
    }
  };
  walk('src/modules');
  walk('src/layouts');
  return out.sort();
}

describe('LeadGenerate — capability gate must not change the hook order (#310)', () => {
  const PAGE = () => read('src/modules/leads/pages/LeadGenerate.tsx');

  it('A. the gate is evaluated into a constant and returned AFTER every hook', () => {
    const page = PAGE();
    const lines = page.split(/\r?\n/);
    const gateConst = lines.findIndex((l) => /const mayCreateLead = canAccess\('lead_generate', 'create'\)/.test(l));
    const gateReturn = lines.findIndex((l) => /if \(!mayCreateLead\) \{/.test(l));
    assert.ok(gateConst !== -1, 'LeadGenerate must resolve the capability into mayCreateLead');
    assert.ok(gateReturn !== -1, 'LeadGenerate must keep the capability gate');

    const hookLines = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^ {2}\S/.test(l) && HOOK_CALL.test(l))
      .map(({ i }) => i);
    assert.ok(hookLines.length >= 6, 'LeadGenerate is expected to use several hooks');

    assert.ok(
      gateConst < gateReturn,
      'the capability constant is resolved once, above the gate it drives',
    );
    assert.ok(
      gateReturn > hookLines[hookLines.length - 1],
      'the AccessDenied return must sit below EVERY hook call, or React #310 returns',
    );
    // No hook may live below the gate either: that is the same bug from
    // the other side.
    assert.equal(
      hookLines.filter((i) => i > gateReturn).length,
      0,
      'no hook call may appear after the conditional return',
    );
  });

  it('B. the gate comment explains the rule so it is not "simplified" back', () => {
    const page = PAGE();
    assert.match(page, /React #310|error #310/, 'the hooks-order rule must be documented in place');
    assert.match(page, /never early-returned, before the hooks/i, 'the mayCreateLead note must state the rule');
  });

  it('C. the metadata load is skipped for a user without the capability (and re-runs when it arrives)', () => {
    const page = PAGE();
    const effect = page.slice(page.indexOf('const loadOptions'), page.indexOf('loadOptions();'));
    assert.ok(effect.length > 0, 'the metadata effect must still exist');
    assert.ok(
      /if \(!mayCreateLead\) return;/.test(page),
      'the effect must bail out for users who cannot create leads',
    );
    assert.ok(
      /\}, \[mayCreateLead\]\)/.test(page),
      'the effect must depend on mayCreateLead so the options load once access is known',
    );
  });

  it('D. the strictness contract is unchanged: AccessDenied copy + capability code', () => {
    const page = PAGE();
    assert.ok(page.includes('Access Denied'), 'the same denial screen renders');
    assert.ok(
      page.includes('Strict Security Level: Feature lead_generate.create Required'),
      'the denial screen still names the required capability',
    );
    assert.ok(page.includes("t('accessDeniedMsg')"), 'the bilingual denial message stays');
    // The capability is still consulted with the SAME code pair.
    assert.ok(
      page.includes("canAccess('lead_generate', 'create')"),
      'the gate must keep checking lead_generate.create',
    );
  });

  it('E. no live page component returns conditionally before its last hook', () => {
    const offenders: Offender[] = [];
    for (const file of livePageFiles()) {
      const hit = scanPageComponent(file);
      if (hit) offenders.push(hit);
    }
    assert.deepEqual(
      offenders,
      [],
      'a top-level conditional return before the last hook flips the hook count between renders ' +
        '(React #310). Move the gate below the hooks.\nOffenders: ' + JSON.stringify(offenders),
    );
  });
});
