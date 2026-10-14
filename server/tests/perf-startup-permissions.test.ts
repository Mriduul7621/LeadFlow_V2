import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

describe('Performance startup — defer optional permission metadata', () => {
  it('waits for shell readiness before fetching the current user permission sheet', () => {
    const source = read('src/modules/shared/hooks/usePermissions.ts');
    const start = source.indexOf('async function loadServerPermissions');
    const end = source.indexOf('\n    loadServerPermissions();', start);
    assert.ok(start >= 0 && end > start, 'permission loader must exist');
    const body = source.slice(start, end);
    const gate = body.indexOf('await waitForShellStartup()');
    const cancelGuard = body.indexOf('if (cancelled) return;', gate);
    const fetch = body.indexOf('coalesceGet(permPath, () => fetch(permPath))');
    assert.ok(gate >= 0, 'optional permission metadata must wait for shell readiness');
    assert.ok(cancelGuard > gate, 'cancelled/unmounted components must not start a deferred request');
    assert.ok(fetch > cancelGuard, 'permission request must start only after the gate and cancellation guard');
  });

  it('keeps the startup gate releasable for both Dashboard and non-Dashboard routes', () => {
    const startup = read('src/modules/shared/api/startupPriority.ts');
    const layout = read('src/layouts/AppLayout.tsx');
    const dashboard = read('src/modules/dashboard/pages/Dashboard.tsx');
    assert.ok(startup.includes('export function waitForShellStartup()'));
    assert.ok(layout.includes("location.pathname !== '/'"));
    assert.ok(layout.includes('markShellStartupSettled()'));
    assert.ok(dashboard.includes('markCriticalStartupSettled()'));
  });
});
