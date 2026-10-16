import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, LEASE_MS } from '../src/server/store';
import { demoCheckout, demoDashboard, demoReply, demoViews, DEMO_LABEL } from '../src/shared/demo';
import { interactionPrompt, LIMITS, type ViewDetail, type ViewListing } from '../src/shared/contract';

const PUBLIC = 'https://canvas.example.ts.net';
const html = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
const page = (title = 'Checkout', body = '<p>Hello</p>') => ({ title, format: 'html' as const, source: html(body) });

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'), store = new Store(path);
  const register = (sessionId: string, projectRoot = '/project', owner = sessionId) =>
    store.register({ sessionId, directory: projectRoot, projectRoot, agent: 'research', owner, title: sessionId });
  return { store, path, register };
}
const status = (code: number, message?: RegExp) => (e: any) => e.status === code && (!message || message.test(e.message));

test('revisions number up and stale or missing expectedRevision conflicts', t => {
  const { store, register } = fixture(t), a = register('A');
  const first = store.show({ sessionKey: a.key, ...page('Draft') });
  assert.equal(first.revision, 1);
  assert.deepEqual(first.warnings, []);
  const second = store.show({ sessionKey: a.key, ...page('Draft 2'), viewId: first.id, expectedRevision: 1 });
  assert.deepEqual([second.id, second.revision], [first.id, 2]);
  assert.throws(() => store.show({ sessionKey: a.key, ...page(), viewId: first.id, expectedRevision: 1 }), status(409, /revision 2/));
  assert.throws(() => store.show({ sessionKey: a.key, ...page(), viewId: first.id }), status(409));
  assert.throws(() => store.show({ sessionKey: a.key, ...page(), expectedRevision: 1 }), status(400, /viewId/));
  assert.throws(() => store.show({ sessionKey: 'unknown', ...page() }), status(404));
  // A revision may switch format.
  assert.equal(store.show({ sessionKey: a.key, ...demoDashboard(), viewId: first.id, expectedRevision: 2 }).revision, 3);
  assert.equal(store.revision(a, first.id, 3).content.format, 'openui');
  assert.equal(store.revision(a, first.id, 1).title, 'Draft');
});

test('content is validated: errors reject with every message, warnings come back', t => {
  const { store, register } = fixture(t), a = register('A');
  assert.throws(() => store.show({ sessionKey: a.key, title: 'Bad', format: 'openui', source: 'this is not openui lang' }), status(400, /OpenUI source has/));
  assert.throws(() => store.show({ sessionKey: a.key, ...page('Bad', '<script src="canvas:lib/no-such-lib"></script>') }), status(400, /no-such-lib/));
  assert.throws(() => store.show({ sessionKey: a.key, title: 'Big', format: 'openui', source: 'x'.repeat(LIMITS.openuiSource + 1) }), status(400, /at most 200000/));
  assert.throws(() => store.show({ sessionKey: a.key, title: 'Empty', format: 'html', source: '' }));
  const warned = store.show({ sessionKey: a.key, ...page('Remote', '<script src="https://cdn.example.com/x.js"></script>') });
  assert.ok(warned.warnings.length > 0);
  assert.equal(Object.keys(store.db.views).length, 1, 'rejected content saves nothing');
});

test('demo views and replies are valid content', t => {
  const { store, register } = fixture(t), a = register('A');
  for (const view of demoViews()) {
    assert.equal(view.summary, DEMO_LABEL);
    const shown = store.show({ sessionKey: a.key, ...view });
    assert.deepEqual(shown.warnings, [], `${view.title} shows without warnings`);
    const receipt = { action: 'Choose this layout', data: { layout: 'B', note: 'quotes " and <tags> & \n lines' }, notes: 'keep "it"', revision: 1 };
    const reply = demoReply(view.format, receipt);
    assert.equal(reply.title, view.title);
    assert.equal(store.show({ sessionKey: a.key, ...reply, viewId: shown.id, expectedRevision: 1 }).revision, 2);
    assert.match(reply.source, /Choose this layout/);
  }
  assert.match(demoCheckout().source, /data-canvas-action="Send feedback"/);
  assert.match(demoCheckout().source, /canvas\.send\('Choose this layout'/);
  assert.match(demoDashboard().source, /BarChart\(/);
  assert.match(demoDashboard().source, /Table\(/);
  assert.match(demoDashboard().source, /Form\("request"/);
});

test('pinning shares a view with the project; a cross-session revise preserves the original snapshot', t => {
  const { store, path, register } = fixture(t), a = register('A'), b = register('B');
  const first = store.show({ sessionKey: a.key, ...page('Map') });
  assert.equal(store.snapshot(b, PUBLIC).views.length, 0);
  assert.throws(() => store.pin(a, { viewId: first.id, name: 'System map', expectedRevision: 2 }), status(409));
  assert.deepEqual(store.pin(a, { viewId: first.id, name: 'System map', expectedRevision: 1 }), { id: first.id, pinnedName: 'System map', revision: 1 });
  const other = store.show({ sessionKey: a.key, ...page('Other') });
  assert.throws(() => store.pin(a, { viewId: other.id, name: 'system MAP', expectedRevision: 1 }), status(409, /already exists/));
  assert.equal(store.snapshot(b, PUBLIC).views[0].pinnedName, 'System map');
  store.show({ sessionKey: b.key, ...page('A deeper map'), viewId: first.id, expectedRevision: 1 });
  assert.throws(() => store.show({ sessionKey: a.key, ...page(), viewId: first.id, expectedRevision: 1 }), status(409));
  const reopened = new Store(path);
  const viewA = reopened.snapshot(reopened.session(a.key), PUBLIC).views.find(v => v.id === first.id)!;
  assert.deepEqual([viewA.revision.number, viewA.revision.title, viewA.latest], [1, 'Map', 2]);
  const viewB = reopened.snapshot(reopened.session(b.key), PUBLIC).views.find(v => v.id === first.id)!;
  assert.deepEqual([viewB.revision.number, viewB.revision.title, viewB.revision.agent], [2, 'A deeper map', 'research']);
  assert.equal(viewB.history.length, 2);
  assert.equal((viewB.history[0] as any).content, undefined);
  // Snapshots name the shown revision's format but never carry sources: those come from revision().
  assert.equal(viewB.revision.format, 'html');
  assert.equal((viewB.revision as any).content, undefined);
  assert.equal(reopened.revision(reopened.session(b.key), first.id, 2).content.source, page('A deeper map').source);
  // Renaming a pinned view is another pin.
  assert.equal(store.pin(b, { viewId: first.id, name: 'Architecture', expectedRevision: 2 }).pinnedName, 'Architecture');
});

test('projects are isolated even for pinned views', t => {
  const { store, register } = fixture(t), a = register('A'), b = register('B', '/other');
  const view = store.show({ sessionKey: a.key, ...page('Private') });
  store.pin(a, { viewId: view.id, name: 'Private map', expectedRevision: 1 });
  assert.notEqual(a.projectId, b.projectId);
  assert.equal(store.snapshot(b, PUBLIC).views.length, 0);
  assert.deepEqual(store.read(b, undefined, PUBLIC), []);
  assert.throws(() => store.read(b, view.id, PUBLIC), status(404));
  assert.throws(() => store.revision(b, view.id, 1), status(404));
  assert.throws(() => store.pin(b, { viewId: view.id, name: 'stolen', expectedRevision: 1 }), status(404));
  assert.throws(() => store.show({ sessionKey: b.key, ...page(), viewId: view.id, expectedRevision: 1 }), status(404));
  assert.throws(() => store.submit(b, { id: randomUUID(), sessionKey: b.key, viewId: view.id, revision: 1, action: 'Go' }), status(404));
  assert.throws(() => store.report(b, { viewId: view.id, revision: 1, errors: ['x'] }), status(404));
  // The same pinned name is fine in another project.
  const mine = store.show({ sessionKey: b.key, ...page('Mine') });
  assert.equal(store.pin(b, { viewId: mine.id, name: 'Private map', expectedRevision: 1 }).pinnedName, 'Private map');
});

test('viewer credentials are per session, stable across registration, and never in snapshots', t => {
  const { store, register } = fixture(t), a = register('A'), b = register('B');
  assert.notEqual(a.viewerKey, b.viewerKey);
  assert.equal(store.viewer(a.viewerKey).key, a.key);
  assert.throws(() => store.viewer('not-a-key'), status(401));
  assert.throws(() => store.viewer(''), status(401));
  const again = register('A', '/project', 'new-owner');
  assert.equal(again.viewerKey, a.viewerKey);
  assert.equal(again.owner, 'new-owner');
  assert.equal(store.resolve('/project', 'A').key, a.key);
  assert.throws(() => store.resolve('/elsewhere', 'A'), status(404));
  const snapshot = store.snapshot(a, PUBLIC) as any;
  assert.equal(snapshot.session.viewerKey, undefined);
  assert.equal(snapshot.session.owner, undefined);
  assert.equal(snapshot.browserUrl, `${PUBLIC}/#key=${encodeURIComponent(a.viewerKey)}`);
  assert.equal(snapshot.connected, true);
});

test('submissions are idempotent, bound to their session, and rejected for stale revisions', t => {
  const { store, register } = fixture(t), a = register('A'), b = register('B');
  const view = store.show({ sessionKey: a.key, ...page('Checkout redesign') });
  store.pin(a, { viewId: view.id, name: 'Checkout', expectedRevision: 1 });
  const input = { id: randomUUID(), sessionKey: b.key, viewId: view.id, revision: 1, action: 'Choose layout B', data: { layout: 'B' }, notes: 'keep the old header' };
  assert.throws(() => store.submit(a, input), status(409, /another conversation/));
  assert.equal(Object.keys(store.db.interactions).length, 0);
  const first = store.submit(b, input);
  assert.equal(first.messageId, `msg_canvas${input.id.replaceAll('-', '')}`);
  assert.equal(first.prompt, interactionPrompt({ id: view.id, title: 'Checkout redesign' }, { ...input }));
  assert.match(first.prompt, /^\[Agent Canvas\] Checkout redesign \(view .+, revision 1\)\nAction: Choose layout B\nData:\n```json/);
  assert.equal(first.status, 'queued');
  assert.equal(store.submit(b, input), first);
  assert.throws(() => store.submit(b, { ...input, notes: 'different' }), status(409, /different input/));
  assert.throws(() => store.submit(b, { ...input, data: { layout: 'A' } }), status(409, /different input/));
  assert.throws(() => store.submit(b, { ...input, id: randomUUID(), revision: 2 }), status(404));
  store.show({ sessionKey: b.key, ...page('Checkout v2'), viewId: view.id, expectedRevision: 1 });
  assert.throws(() => store.submit(b, { ...input, id: randomUUID() }), status(409, /newer revision/));
  // A repeat of an already accepted submission still answers with the original.
  assert.equal(store.submit(b, input).id, first.id);
  const bare = store.submit(b, { id: randomUUID(), sessionKey: b.key, viewId: view.id, revision: 2, action: 'Continue' });
  assert.deepEqual([bare.data, bare.notes], [null, '']);
  assert.equal(bare.prompt, `[Agent Canvas] Checkout v2 (view ${view.id}, revision 2)\nAction: Continue`);
});

test('submission data and notes are size limited', t => {
  const { store, register } = fixture(t), a = register('A'), view = store.show({ sessionKey: a.key, ...page() });
  const base = { sessionKey: a.key, viewId: view.id, revision: 1, action: 'Send' };
  assert.throws(() => store.submit(a, { ...base, id: randomUUID(), data: { text: 'x'.repeat(LIMITS.dataBytes) } }), /at most 32000/);
  assert.throws(() => store.submit(a, { ...base, id: randomUUID(), notes: 'x'.repeat(LIMITS.notes + 1) }));
  assert.throws(() => store.submit(a, { ...base, id: randomUUID(), action: 'x'.repeat(LIMITS.action + 1) }));
  assert.throws(() => store.submit(a, { ...base, id: randomUUID(), extra: true }));
  assert.equal(store.submit(a, { ...base, id: randomUUID(), data: { text: 'x'.repeat(LIMITS.dataBytes - 20) } }).status, 'queued');
});

test('delivery: only the owner claims, acks settle, unsent retries, and a lost lease becomes uncertain', t => {
  const { store, register } = fixture(t), s = register('A'), other = register('B');
  const view = store.show({ sessionKey: s.key, ...page() });
  const submit = () => store.submit(s, { id: randomUUID(), sessionKey: s.key, viewId: view.id, revision: 1, action: 'Go' });
  const first = submit();
  assert.equal(store.claim('B'), null);
  const job = store.claim('A')!;
  assert.deepEqual([job.action.id, job.action.status, job.session.sessionId], [first.id, 'sending', 'A']);
  assert.equal(store.claim('A'), null);
  assert.throws(() => store.acknowledge('B', { id: first.id, status: 'delivered', detail: 'x' }), status(404));
  store.acknowledge('A', { id: first.id, status: 'unsent', detail: 'Busy' });
  assert.throws(() => store.acknowledge('A', { id: first.id, status: 'delivered', detail: 'late' }), status(409));
  assert.throws(() => store.retry(other, first.id), status(404));
  assert.equal(store.retry(s, first.id).status, 'queued');
  assert.equal(store.claim('A')!.action.id, first.id);
  store.acknowledge('A', { id: first.id, status: 'delivered', detail: 'Accepted' });
  assert.throws(() => store.retry(s, first.id), status(409, /unsent/));
  const second = submit();
  store.claim('A');
  store.db.interactions[second.id].updatedAt = new Date(Date.now() - LEASE_MS - 1000).toISOString();
  assert.equal(store.snapshot(s, PUBLIC).interactions.find(i => i.id === second.id)!.status, 'uncertain');
  assert.equal(store.claim('A'), null);
  assert.throws(() => store.retry(s, second.id), status(409));
  // An unsent input for a view that has moved on cannot be retried.
  const third = submit();
  store.claim('A'); store.acknowledge('A', { id: third.id, status: 'unsent', detail: 'Busy' });
  store.show({ sessionKey: s.key, ...page(), viewId: view.id, expectedRevision: 1 });
  assert.throws(() => store.retry(s, third.id), status(409, /newer revision/));
});

test('a restarted plugin instance takes over its project\'s conversations once the old one goes quiet', t => {
  const { store, register } = fixture(t), s = register('A', '/project', 'old'), elsewhere = register('E', '/elsewhere', 'old');
  const view = store.show({ sessionKey: s.key, ...page() });
  const input = store.submit(s, { id: randomUUID(), sessionKey: s.key, viewId: view.id, revision: 1, action: 'Go' });
  assert.equal(store.claim('new', '/project'), null, 'a live instance keeps its conversations');
  store.heartbeats.set('old', Date.now() - 60_000);
  assert.equal(store.snapshot(s, PUBLIC).connected, false);
  assert.equal(store.claim('new', '/project')!.action.id, input.id);
  assert.equal(store.snapshot(s, PUBLIC).connected, true);
  assert.equal(store.db.sessions[elsewhere.key].owner, 'old', 'another project\'s conversations stay with their instance');
});

test('a restart turns an in-flight delivery uncertain instead of resending it', t => {
  const { store, path, register } = fixture(t), s = register('A'), view = store.show({ sessionKey: s.key, ...page() });
  const action = store.submit(s, { id: randomUUID(), sessionKey: s.key, viewId: view.id, revision: 1, action: 'Go' });
  const queued = store.submit(s, { id: randomUUID(), sessionKey: s.key, viewId: view.id, revision: 1, action: 'Later' });
  store.claim('A');
  const reopened = new Store(path);
  assert.equal(reopened.db.interactions[action.id].status, 'uncertain');
  assert.equal(reopened.claim('A')!.action.id, queued.id);
  assert.equal(reopened.claim('A'), null);
});

test('state of another format version is refused with a move-aside message', t => {
  const { path } = fixture(t);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(state.version, 2);
  writeFileSync(path, JSON.stringify({ ...state, version: 1 }));
  assert.throws(() => new Store(path), /version 1.*Move it aside/s);
  writeFileSync(path, '{not json');
  assert.throws(() => new Store(path), /Move it aside/);
});

test('report replaces the client errors of one revision', t => {
  const { store, register } = fixture(t), a = register('A'), view = store.show({ sessionKey: a.key, ...page() });
  store.show({ sessionKey: a.key, ...page(), viewId: view.id, expectedRevision: 1 });
  assert.deepEqual(store.report(a, { viewId: view.id, revision: 1, errors: ['TypeError: x is undefined'] }), { ok: true });
  store.report(a, { viewId: view.id, revision: 2, errors: ['first', 'second'] });
  store.report(a, { viewId: view.id, revision: 2, errors: ['only'] });
  const detail = store.read(a, view.id, PUBLIC) as ViewDetail;
  assert.deepEqual(detail.latest.clientErrors, ['only']);
  assert.deepEqual(detail.history[0].clientErrors, ['TypeError: x is undefined']);
  store.report(a, { viewId: view.id, revision: 2, errors: [] });
  assert.equal(store.revision(a, view.id, 2).clientErrors, undefined);
  assert.throws(() => store.report(a, { viewId: view.id, revision: 3, errors: [] }), status(404));
  assert.throws(() => store.report(a, { viewId: view.id, revision: 1, errors: Array(21).fill('e') }));
});

test('read lists the conversation and project views, and details one with its input and link', t => {
  const { store, register } = fixture(t), a = register('A'), b = register('B');
  const mine = store.show({ sessionKey: a.key, ...page('Mine') });
  // Listings sort newest first; keep the order independent of clock resolution.
  store.db.views[mine.id].revisions[0].createdAt = '2020-01-01T00:00:00.000Z';
  const shared = store.show({ sessionKey: b.key, title: 'Shared', format: 'openui', source: demoDashboard().source });
  store.show({ sessionKey: b.key, ...page('Hidden') });
  store.pin(b, { viewId: shared.id, name: 'Dashboard', expectedRevision: 1 });
  store.show({ sessionKey: b.key, ...demoDashboard(), viewId: shared.id, expectedRevision: 1 });
  const listing = store.read(a, undefined, PUBLIC) as ViewListing;
  assert.deepEqual(listing.map(v => v.id), [shared.id, mine.id]);
  assert.deepEqual({ ...listing[0], updatedAt: '' }, { id: shared.id, title: demoDashboard().title, format: 'openui', pinnedName: 'Dashboard', latest: 2, shownHere: undefined, updatedAt: '', agent: 'research' });
  assert.equal(listing[1].shownHere, 1);
  store.submit(a, { id: randomUUID(), sessionKey: a.key, viewId: mine.id, revision: 1, action: 'Mine', data: { n: 1 } });
  const elsewhere = store.show({ sessionKey: b.key, ...page('B view') });
  store.submit(b, { id: randomUUID(), sessionKey: b.key, viewId: elsewhere.id, revision: 1, action: 'Theirs' });
  const detail = store.read(a, mine.id, PUBLIC) as ViewDetail;
  assert.equal(detail.latest.content.source, page('Mine').source);
  assert.deepEqual(detail.interactions.map(i => i.action), ['Mine']);
  assert.equal(detail.link, `${PUBLIC}/#key=${encodeURIComponent(a.viewerKey)}&view=${mine.id}`);
  assert.equal((detail.history[0] as any).content, undefined);
  assert.throws(() => store.read(a, randomUUID(), PUBLIC), status(404));
});

test('each view keeps a bounded interaction history without dropping pending input', t => {
  const { store, register } = fixture(t), s = register('A'), view = store.show({ sessionKey: s.key, ...page() });
  const pending = store.submit(s, { id: randomUUID(), sessionKey: s.key, viewId: view.id, revision: 1, action: 'Pending' });
  for (let i = 0; i < LIMITS.interactionsPerView + 5; i++) {
    const a = store.submit(s, { id: randomUUID(), sessionKey: s.key, viewId: view.id, revision: 1, action: `Send ${i}` });
    store.db.interactions[a.id].status = 'delivered';
  }
  const kept = Object.values(store.db.interactions).filter(a => a.viewId === view.id);
  assert.ok(kept.length <= LIMITS.interactionsPerView + 1);
  assert.ok(kept.some(a => a.id === pending.id));
  assert.equal(kept.at(-1)!.action, `Send ${LIMITS.interactionsPerView + 4}`);
});
