/**
 * jsonbody-method-quick-add.test.ts
 * ------------------------------------------------------------------
 * Regression guard for the production bug Mahadi hit twice on
 * 2026-11-09: the Add Lead form's "+" (quick-add) ALWAYS failed with
 * "Unable to reach the server. Please check your connection and try
 * again." - yet the server was healthy and other saves worked.
 *
 * Root cause: `jsonBody(data)` returns { headers, body } with NO HTTP
 * method. Callers passing it bare - `apiRequest(url, jsonBody(data))` -
 * therefore called `fetch(url, { headers, body })`, which defaults to
 * GET, and a GET with a body makes fetch throw a TypeError BEFORE any
 * network I/O. http.ts maps that rejection to ApiError status 0 (the
 * "Unable to reach the server" toast), and because the request never
 * left the browser, the production server logs showed the POSTs never
 * arriving while GETs and correctly-built POSTs landed fine.
 *
 * The fix lives in ONE place (shared/api/http.ts fetchAndHandle): a
 * request carrying a body but no explicit method goes out as POST, and
 * an explicit method is never overridden. That revives every bare
 * jsonBody() call site at once (metadata types/values/quick-add/
 * reorder, form-builder save/reorder, workflow-rule save). This test
 * pins the behaviour with a fetch stub that enforces the REAL fetch
 * spec rule (GET/HEAD with a body throws), so the pre-fix code fails
 * here exactly the way it failed in the browser.
 *
 * It also pins the quick-add resilience added alongside: quickAddOption
 * retries NETWORK failures only (status 0), never HTTP responses -
 * safe because the endpoint dedupes case-insensitively.
 *
 * Harness mirrors auth-flow-integration.test.ts: browser-ish globals
 * first, then the REAL client modules are imported dynamically.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Small synchronous localStorage stand-in (the client store persists through it). */
function createStorageShim() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('jsonBody method default + quick-add retry (production "Unable to reach the server" bug)', () => {
  let httpModule: typeof import('../../src/modules/shared/api/http');
  let metadataService: typeof import('../../src/modules/metadata/services/metadataService').metadataService;

  const realFetch = globalThis.fetch;

  interface CapturedCall {
    url: string;
    method: string;
    body: unknown;
  }
  let calls: CapturedCall[] = [];
  /** Per-call behaviours; the last one repeats when the queue runs out. */
  let behaviours: Array<() => Promise<Response>> = [];

  /**
   * A fetch stub faithful to the spec point this bug turns on: a
   * request whose effective method is GET/HEAD and that carries a body
   * throws a TypeError, exactly like the browser. Records every call's
   * effective method before responding via the behaviour queue.
   */
  function installFetchStub() {
    calls = [];
    (globalThis as any).fetch = async (input: any, init: any = {}) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body });
      if ((method === 'GET' || method === 'HEAD') && init?.body != null) {
        throw new TypeError('Request with GET/HEAD method cannot have body.');
      }
      const behaviour = behaviours.length > 1 ? behaviours.shift()! : behaviours[0];
      if (!behaviour) throw new Error('fetch stub: no behaviour queued');
      return behaviour();
    };
  }

  const jsonResponse = (status: number, payload: unknown) => async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const networkFailure = () => async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };

  before(async () => {
    const g = globalThis as any;
    g.localStorage = createStorageShim();
    g.window = globalThis;
    httpModule = await import('../../src/modules/shared/api/http');
    ({ metadataService } = await import('../../src/modules/metadata/services/metadataService'));
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    behaviours = [];
    installFetchStub();
  });

  it('apiRequest(url, jsonBody(data)) goes out as POST and resolves', async () => {
    behaviours = [jsonResponse(201, { id: 'opt-1', value: 'Child Education', existing: false })];
    const saved = await httpModule.apiRequest<any>(
      '/api/options/quick-add',
      httpModule.jsonBody({ type: 'Product', value: 'Child Education' })
    );
    assert.equal(saved.value, 'Child Education');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST', 'a body-carrying request with no explicit method must default to POST');
    assert.equal(calls[0].body, JSON.stringify({ type: 'Product', value: 'Child Education' }));
  });

  it('an explicit method is never overridden (PUT / DELETE keep theirs, bodyless stays GET)', async () => {
    behaviours = [jsonResponse(200, { ok: true })];
    await httpModule.apiRequest('/api/options', { method: 'PUT', ...httpModule.jsonBody({ a: 1 }) });
    assert.equal(calls[0].method, 'PUT');

    calls = [];
    await httpModule.apiRequest('/api/options', { method: 'DELETE', body: JSON.stringify({ a: 1 }) });
    assert.equal(calls[0].method, 'DELETE');

    calls = [];
    await httpModule.apiRequest('/api/options');
    assert.equal(calls[0].method, 'GET', 'a bodyless call with no method stays a plain GET');
    assert.equal(calls[0].body, undefined);
  });

  it('quickAddOption succeeds first try, via POST', async () => {
    behaviours = [
      jsonResponse(201, { id: 'opt-2', type: 'Product', value: 'Child Education', label: 'Child Education', status: 'Active', existing: false }),
    ];
    const saved = await metadataService.quickAddOption('Product', 'Child Education');
    assert.equal(saved.value, 'Child Education');
    assert.equal((saved as any).existing, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/options/quick-add');
    assert.equal(calls[0].method, 'POST');
  });

  it('quickAddOption retries a network failure (status 0) and then succeeds', async () => {
    behaviours = [
      networkFailure(),
      jsonResponse(200, { id: 'opt-3', type: 'Source', value: 'Walk-in', label: 'Walk-in', status: 'Active', existing: true }),
    ];
    const saved = await metadataService.quickAddOption('Source', 'Walk-in');
    assert.equal(saved.value, 'Walk-in');
    assert.equal((saved as any).existing, true, 'a retry after a landed write resolves with the stored option');
    assert.equal(calls.length, 2, 'exactly one retry was needed');
    assert.ok(calls.every(c => c.method === 'POST'));
  });

  it('quickAddOption does NOT retry an HTTP response (400 is a real answer)', async () => {
    behaviours = [jsonResponse(400, { error: 'This list cannot be extended from the lead form' })];
    await assert.rejects(
      () => metadataService.quickAddOption('FollowUpStatus', 'Whatever'),
      (err: any) => err instanceof httpModule.ApiError && err.status === 400
    );
    assert.equal(calls.length, 1, 'an HTTP refusal must not be retried');
  });

  it('quickAddOption gives up after 2 retries when the network stays down', async () => {
    behaviours = [networkFailure()];
    await assert.rejects(
      () => metadataService.quickAddOption('Product', 'Never Lands'),
      (err: any) => err instanceof httpModule.ApiError && err.status === 0
    );
    assert.equal(calls.length, 3, '1 initial attempt + 2 retries, then the error surfaces');
  });
});
