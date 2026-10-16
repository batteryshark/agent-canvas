import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store';
import { APP_CSP, createCanvasServer } from '../src/server/http';
import { FRAME_CSP, FRAME_SHELL_HTML } from '../src/server/frame-shell';
import { HTML_LIBRARIES } from '../src/shared/html-check';
import { LIMITS, type Session, type ViewDetail, type ViewListing } from '../src/shared/contract';
import type { Connection } from '../src/server/config';

const PUBLIC = 'https://canvas.example.ts.net';
const source = '<!doctype html><html><head><title>t</title></head><body><button data-canvas-action="Go">Go</button></body></html>';

async function fixture(t: any, storeReady = true) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-http-')), assets = join(dir, 'web');
  mkdirSync(join(assets, 'lib'), { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Agent Canvas</title><div id="root"></div>');
  writeFileSync(join(assets, 'app.js'), 'console.log("app")');
  writeFileSync(join(assets, 'app.css'), 'body{}');
  for (const name of Object.keys(HTML_LIBRARIES)) writeFileSync(join(assets, 'lib', `${name}.js`), `/* ${name} */`);
  writeFileSync(join(dir, 'state.json.copy'), 'secret');
  const store = new Store(join(dir, 'state.json'));
  const config: Connection = { endpoint: 'http://127.0.0.1:4999', publicUrl: PUBLIC, token: 'x'.repeat(40) };
  const server = createCanvasServer(storeReady ? store : () => undefined, config, assets);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (path: string, init: { body?: unknown; token?: string; headers?: Record<string, string>; method?: string; raw?: string } = {}) => fetch(base + path, {
    method: init.method ?? (init.body === undefined && init.raw === undefined ? 'GET' : 'POST'),
    headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined || init.raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const agent = (path: string, body: unknown) => call(path, { body, token: config.token });
  return { store, config, base, call, agent };
}

test('agent routes need the agent token and drive show, read, claim and ack', async t => {
  const { config, call, agent } = await fixture(t);
  assert.deepEqual(await (await call('/health')).json(), { name: 'agent-canvas', version: 2 });
  assert.equal((await call('/agent/register', { body: {} })).status, 401);
  assert.equal((await call('/agent/register', { body: {}, token: 'y'.repeat(40) })).status, 401);
  const session = await (await agent('/agent/register', { sessionId: 'A', directory: '/p', projectRoot: '/p', agent: 'build', owner: 'worker-A' })).json() as Session;
  assert.equal((await call('/agent/claim', { body: { owner: 'worker-A' }, token: session.viewerKey })).status, 401);
  assert.equal((await call('/agent/claim', { token: config.token })).status, 405);
  assert.equal((await agent('/agent/resolve', { directory: '/p', sessionId: 'A' })).status, 200);

  const shown = await agent('/agent/show', { sessionKey: session.key, title: 'Checkout', format: 'html', source });
  assert.equal(shown.status, 200);
  const result = await shown.json() as any;
  assert.deepEqual([result.revision, result.warnings], [1, []]);
  assert.equal(result.link, `${PUBLIC}/#key=${encodeURIComponent(session.viewerKey)}&view=${result.id}`);

  const invalid = await agent('/agent/show', { sessionKey: session.key, title: 'Bad', format: 'openui', source: 'not openui at all' });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json() as any).error, /OpenUI source has \d+ problem/);
  const conflict = await agent('/agent/show', { sessionKey: session.key, title: 'Again', format: 'html', source, viewId: result.id, expectedRevision: 2 });
  assert.equal(conflict.status, 409);
  const schema = await agent('/agent/show', { sessionKey: session.key, title: '', format: 'html', source });
  assert.equal(schema.status, 400);
  assert.match((await schema.json() as any).error, /^title: /);

  const listing = await (await agent('/agent/read', { sessionKey: session.key })).json() as ViewListing;
  assert.deepEqual(listing.map(v => [v.id, v.title, v.format, v.shownHere]), [[result.id, 'Checkout', 'html', 1]]);
  const detail = await (await agent('/agent/read', { sessionKey: session.key, viewId: result.id })).json() as ViewDetail;
  assert.equal(detail.latest.content.source, source);
  assert.equal(detail.link, result.link);
  assert.equal((await agent('/agent/read', { sessionKey: 'nope' })).status, 404);

  const id = randomUUID();
  assert.equal((await call('/api/submit', { token: session.viewerKey, body: { id, sessionKey: session.key, viewId: result.id, revision: 1, action: 'Go', data: { a: 1 } } })).status, 200);
  assert.equal(await (await agent('/agent/claim', { owner: 'someone-else' })).json(), null);
  const job = await (await agent('/agent/claim', { owner: 'worker-A' })).json() as any;
  assert.deepEqual([job.action.id, job.action.status, job.session.sessionId], [id, 'sending', 'A']);
  const acked = await (await agent('/agent/ack', { owner: 'worker-A', result: { id, status: 'delivered', detail: 'ok' } })).json() as any;
  assert.equal(acked.status, 'delivered');
  assert.equal((await agent('/agent/ack', { owner: 'worker-A', result: { id, status: 'delivered', detail: 'ok' } })).status, 409);
  assert.equal((await agent('/agent/nope', {})).status, 404);
});

test('viewer routes are scoped to the session key and enforce revisions and idempotency', async t => {
  const { store, call } = await fixture(t);
  const a = store.register({ sessionId: 'A', directory: '/p', projectRoot: '/p', agent: 'build', owner: 'A' });
  const b = store.register({ sessionId: 'B', directory: '/p', projectRoot: '/p', agent: 'build', owner: 'B' });
  const view = store.show({ sessionKey: a.key, title: 'Mine', format: 'html', source });
  assert.equal((await call('/api/snapshot')).status, 401);
  assert.equal((await call('/api/snapshot', { token: 'wrong' })).status, 401);
  const snapshot = await (await call('/api/snapshot', { token: a.viewerKey })).json() as any;
  assert.equal(snapshot.session.viewerKey, undefined);
  assert.equal(snapshot.session.owner, undefined);
  assert.equal(snapshot.browserUrl, `${PUBLIC}/#key=${encodeURIComponent(a.viewerKey)}`);
  assert.deepEqual(snapshot.views.map((v: any) => v.id), [view.id]);
  assert.equal((await (await call('/api/snapshot', { token: b.viewerKey })).json() as any).views.length, 0);
  assert.equal((await call(`/api/revision?id=${view.id}&revision=1`, { token: b.viewerKey })).status, 404);
  assert.equal((await (await call(`/api/revision?id=${view.id}&revision=1`, { token: a.viewerKey })).json() as any).title, 'Mine');
  assert.equal((await call(`/api/revision?id=${view.id}&revision=zero`, { token: a.viewerKey })).status, 400);

  const input = { id: randomUUID(), sessionKey: a.key, viewId: view.id, revision: 1, action: 'Go', data: { x: 1 } };
  assert.equal((await call('/api/submit', { token: b.viewerKey, body: input })).status, 409);
  const first = await (await call('/api/submit', { token: a.viewerKey, body: input })).json() as any;
  const again = await (await call('/api/submit', { token: a.viewerKey, body: input })).json() as any;
  assert.equal(again.id, first.id);
  assert.equal((await call('/api/submit', { token: a.viewerKey, body: { ...input, notes: 'changed' } })).status, 409);
  const tooBig = await call('/api/submit', { token: a.viewerKey, body: { ...input, id: randomUUID(), data: 'x'.repeat(LIMITS.dataBytes + 1) } });
  assert.equal(tooBig.status, 400);
  assert.match((await tooBig.json() as any).error, /at most 32000/);

  assert.equal((await call('/api/pin', { token: a.viewerKey, body: { viewId: view.id, name: 'Shared', expectedRevision: 1 } })).status, 200);
  assert.equal((await (await call('/api/snapshot', { token: b.viewerKey })).json() as any).views.length, 1);
  store.show({ sessionKey: b.key, title: 'Theirs', format: 'html', source, viewId: view.id, expectedRevision: 1 });
  const stale = await call('/api/submit', { token: a.viewerKey, body: { ...input, id: randomUUID() } });
  assert.equal(stale.status, 409);
  assert.match((await stale.json() as any).error, /newer revision/);

  assert.equal((await call('/api/report', { token: a.viewerKey, body: { viewId: view.id, revision: 2, errors: ['ReferenceError: chart is not defined'] } })).status, 200);
  assert.deepEqual(store.revision(a, view.id, 2).clientErrors, ['ReferenceError: chart is not defined']);
  assert.equal((await call('/api/retry', { token: a.viewerKey, body: { id: first.id } })).status, 409);
  assert.equal((await call('/api/pin', { token: a.viewerKey, raw: 'not json' })).status, 400);
  assert.equal((await call('/api/snapshot', { token: a.viewerKey, method: 'POST', raw: '{}' })).status, 404);
});

test('foreign origins are rejected; the endpoint and public origins are allowed', async t => {
  const { store, call } = await fixture(t);
  const s = store.register({ sessionId: 'A', directory: '/p', projectRoot: '/p', agent: 'build', owner: 'A' });
  const snapshot = (origin: string) => call('/api/snapshot', { token: s.viewerKey, headers: { Origin: origin } });
  assert.equal((await snapshot('https://untrusted.test')).status, 403);
  assert.equal((await snapshot('null')).status, 403);
  assert.equal((await snapshot('https://canvas.example.ts.net.evil.test')).status, 403);
  assert.equal((await snapshot(PUBLIC)).status, 200);
  assert.equal((await snapshot('http://127.0.0.1:4999')).status, 200);
  assert.equal((await snapshot('http://localhost:4999')).status, 200);
  assert.equal((await call('/', { headers: { Origin: 'https://untrusted.test' } })).status, 403);
});

test('static app, frame shell and libraries are served with their policies', async t => {
  const { call } = await fixture(t);
  for (const path of ['/', '/index.html']) {
    const page = await call(path);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), APP_CSP);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.match(await page.text(), /Agent Canvas/);
  }
  assert.match(APP_CSP, /frame-ancestors 'none'/);
  assert.match(APP_CSP, /frame-src 'self'/);
  const script = await call('/app.js');
  assert.match(script.headers.get('content-type')!, /text\/javascript/);
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('/app.js', { headers: { 'If-None-Match': script.headers.get('etag')! } })).status, 304);
  assert.match((await call('/app.css')).headers.get('content-type')!, /text\/css/);

  const frame = await call('/frame');
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-security-policy'), FRAME_CSP);
  assert.equal(await frame.text(), FRAME_SHELL_HTML);
  assert.match(FRAME_CSP, /connect-src 'none'/);

  const names = Object.keys(HTML_LIBRARIES);
  assert.ok(names.includes('chart.js'));
  for (const name of names) {
    const lib = await call(`/lib/${name}.js`);
    assert.equal(lib.status, 200, name);
    assert.match(lib.headers.get('content-type')!, /text\/javascript/);
    assert.equal(await lib.text(), `/* ${name} */`);
  }
  for (const path of ['/lib/constructor.js', '/lib/__proto__.js', '/lib/unknown.js', '/lib/..%2Fapp.js', '/lib/chart.js', '/state.json', '/state.json.copy', '/app.js.map'])
    assert.equal((await call(path)).status, 404, path);
  assert.equal((await call('/', { method: 'POST', raw: '{}' })).status, 405);
});

test('request bodies over the limit are refused with 413', async t => {
  const { store, base, call, agent } = await fixture(t);
  const s = store.register({ sessionId: 'A', directory: '/p', projectRoot: '/p', agent: 'build', owner: 'A' });
  const huge = JSON.stringify({ padding: 'x'.repeat(LIMITS.requestBytes) });
  const declared = await call('/api/report', { token: s.viewerKey, raw: huge });
  assert.equal(declared.status, 413);
  assert.match((await declared.json() as any).error, /larger than/);
  assert.equal((await agent('/agent/show', { sessionKey: s.key, title: 'Huge', format: 'html', source: 'x'.repeat(LIMITS.requestBytes) })).status, 413);
  // Without a Content-Length the limit is enforced while streaming.
  const chunk = new TextEncoder().encode('x'.repeat(100_000));
  const body = new ReadableStream({ start(c) { for (let i = 0; i < 12; i++) c.enqueue(chunk); c.close(); } });
  const chunked = await fetch(`${base}/api/report`, { method: 'POST', headers: { Authorization: `Bearer ${s.viewerKey}` }, body, duplex: 'half' } as RequestInit);
  assert.equal(chunked.status, 413);
  // The connection stays usable afterwards.
  assert.equal((await call('/api/snapshot', { token: s.viewerKey })).status, 200);
});

test('the service answers 503 while its store is still opening', async t => {
  const { call, config } = await fixture(t, false);
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/agent/claim', { body: { owner: 'x' }, token: config.token })).status, 503);
  assert.equal((await call('/api/snapshot', { token: 'x' })).status, 503);
});
