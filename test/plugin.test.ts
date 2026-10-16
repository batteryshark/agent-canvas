// Drives the real OpenCode 2 plugin against the real service, in process, through a fake plugin context.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import type { DeliveryJob, Interaction, Session, Snapshot, Submission } from '../src/shared/contract';
import { connection } from '../src/server/config';
import { request } from '../src/server/client';
import { Store } from '../src/server/store';
import { createCanvasServer } from '../src/server/http';
import { HTML_GUIDE } from '../src/shared/html-guide';
import plugin from '../src/opencode/plugin';
import { deliverToSession } from '../src/opencode/worker';
import { ensureService } from '../src/opencode/service';

const freePort = async () => {
  const s = createNetServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise(r => s.close(r));
  return port;
};
const home = mkdtempSync(join(tmpdir(), 'canvas-plugin-'));
process.env.AGENT_CANVAS_HOME = home;
process.env.AGENT_CANVAS_PORT = String(await freePort());
delete process.env.AGENT_CANVAS_NODE;

const config = connection(), store = new Store(join(home, 'state.json'));
const server = createCanvasServer(store, config, join(home, 'web'));
await new Promise<void>(r => server.listen(Number(new URL(config.endpoint).port), '127.0.0.1', r));
let serverOpen = true;

const project = join(home, 'project');
const sessions: Record<string, { directory: string; title: string; agent: string }> = {
  ses_a: { directory: project, title: 'Conversation A', agent: 'build' },
  ses_b: { directory: project, title: 'Conversation B', agent: 'plan' },
};
const prompts: any[] = [];
const tools = new Map<string, any>();
const hooks = new Map<string, (event: any) => unknown>();
const ctx = {
  location: { directory: project, project: { id: 'prj_test', directory: project, canonical: project } },
  session: {
    async get({ sessionID }: { sessionID: string }) {
      const s = sessions[sessionID];
      if (!s) throw new Error(`Session ${sessionID} not found`);
      return { id: sessionID, projectID: 'prj_test', title: s.title, agent: s.agent, location: { directory: s.directory } };
    },
    async wait() {},
    async prompt(input: unknown) { prompts.push(input); return {}; },
    async hook(name: string, callback: (event: any) => unknown) { hooks.set(name, callback); return { dispose: async () => {} }; },
  },
  tool: { async transform(callback: (editor: any) => void) { callback({ add: (t: any) => tools.set(t.name, t) }); return { dispose: async () => {} }; } },
} as unknown as Plugin.Context;
const cleanup = await plugin.setup(ctx);
let restarted: unknown;

after(async () => {
  if (typeof cleanup === 'function') await cleanup();
  if (typeof restarted === 'function') await restarted();
  if (serverOpen) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  rmSync(home, { recursive: true, force: true });
});

type Result = { content: string; metadata?: Record<string, any> };
const call = (name: string, input: unknown, sessionID = 'ses_a'): Promise<Result> => tools.get(name).execute(input, {
  sessionID, agent: sessions[sessionID]?.agent ?? 'build', messageID: 'msg_test', id: `call_${randomUUID()}`,
  signal: new AbortController().signal, progress: async () => {},
});
async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const resolve = (sessionId: string) => { try { return store.resolve(project, sessionId); } catch { return undefined; } };
const viewIdOf = (r: Result) => /- View: ([0-9a-f-]{36})/.exec(r.content)?.[1] ?? assert.fail(`No view id in:\n${r.content}`);

const OPENUI = [
  'root = Stack([header, chart, table, form])',
  'header = CardHeader("Release plan", "Pick the next milestone")',
  'chart = BarChart(["Q1", "Q2", "Q3"], [Series("Shipped", [4, 7, 9])])',
  'table = Table([Col("Milestone", ["Alpha", "Beta", "GA"]), Col("Status", ["done", "active", "planned"])])',
  'form = Form("next", Buttons([submit]), [choice])',
  'choice = FormControl("Next milestone", Select("milestone", [SelectItem("beta", "Beta"), SelectItem("ga", "GA")]))',
  'submit = Button("Choose milestone", @ToAssistant("Choose milestone"), "primary")',
].join('\n');
const HTML = '<!doctype html><html><head><title>Layouts</title><script src="https://cdn.example.com/widget.js"></script></head><body><form data-canvas-action="Choose layout"><label><input type="radio" name="layout" value="A" checked> A</label><label><input type="radio" name="layout" value="B"> B</label><button type="submit">Send</button></form></body></html>';
let openuiId = '', htmlId = '';

test('registers four direct tools whose descriptions sell a generic visual surface', () => {
  assert.deepEqual([...tools.keys()].sort(), ['canvas_guide', 'canvas_pin', 'canvas_read', 'canvas_show']);
  for (const tool of tools.values()) assert.equal(tool.options?.codemode, false, tool.name);
  const show = tools.get('canvas_show').description;
  for (const word of [/mockup/, /chart/, /table/, /form/, /diagram/, /interactive page/, /canvas_guide/, /\[Agent Canvas\]/]) assert.match(show, word);
  assert.match(tools.get('canvas_read').description, /source/);
  assert.ok(hooks.has('prompt') && hooks.has('context'));
});

test('the context hook adds a short system note and registers the conversation in the background', async () => {
  const event = { sessionID: 'ses_a', agent: 'build', system: [] as Array<{ type: string; text: string }> };
  await hooks.get('context')!(event);
  assert.equal(event.system.length, 1);
  const note = event.system[0].text;
  for (const word of [/canvas_guide/, /canvas_read/, /mockup/, /chart/, /form/, /link/, /\[Agent Canvas\]/]) assert.match(note, word);
  assert.ok(note.length < 900, `system note is ${note.length} characters`);
  const session = await waitFor(() => resolve('ses_a'), 'registration from the context hook');
  assert.equal(session.title, 'Conversation A');
  assert.equal(session.agent, 'build');
});

test('canvas_guide serves the overview, the generated OpenUI reference and the HTML guide', async () => {
  const overview = await call('canvas_guide', {});
  for (const word of [/openui/, /html/, /\[Agent Canvas\]/, /canvas_read/, /canvas_pin/, /expectedRevision/]) assert.match(overview.content, word);
  const openui = await call('canvas_guide', { topic: 'openui' });
  assert.equal(openui.content, readFileSync(new URL('../src/generated/openui-guide.md', import.meta.url), 'utf8'));
  assert.equal((await call('canvas_guide', { topic: 'html' })).content, HTML_GUIDE);
});

test('canvas_show saves an OpenUI view and returns its id, revision and viewing link', async () => {
  const result = await call('canvas_show', { title: 'Release plan', summary: 'Shipped work and the next milestone.', format: 'openui', source: OPENUI });
  openuiId = viewIdOf(result);
  assert.match(result.content, /- Revision: 1\b/);
  assert.match(result.content, new RegExp(`- Link: ${config.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/#key=[^&\\s]+&view=${openuiId}`));
  assert.doesNotMatch(result.content, /Warnings/);
  assert.equal(result.metadata?.title, 'Canvas: Release plan');
  assert.equal(result.metadata?.viewId, openuiId);
});

test('canvas_show saves an HTML page and returns the checker warnings', async () => {
  const result = await call('canvas_show', { title: 'Layout choice', format: 'html', source: HTML });
  htmlId = viewIdOf(result);
  assert.match(result.content, /Warnings \(the view was saved/);
  assert.match(result.content, /widget\.js/);
});

test('invalid content is a tool error that lists every problem and how to repair it', async () => {
  await assert.rejects(call('canvas_show', { title: 'Broken', format: 'openui', source: 'root = Stack([Missing("x")])' }), (e: Error) => {
    assert.match(e.message, /Missing/);
    assert.match(e.message, /Nothing was saved/);
    assert.match(e.message, /canvas_guide\(\{ topic: "openui" \}\)/);
    return true;
  });
  await assert.rejects(call('canvas_show', { title: 'Broken page', format: 'html', source: '<script src="canvas:lib/jquery"></script><p>x</p>' }), /canvas:lib\/jquery[\s\S]*topic: "html"/);
  const listing = await call('canvas_read', {});
  assert.doesNotMatch(listing.content, /Broken/);
});

test('revising needs the latest revision, and a stale one says to read first', async () => {
  await assert.rejects(call('canvas_show', { title: 'Release plan', format: 'openui', source: OPENUI, viewId: openuiId, expectedRevision: 4 }), /revision 1[\s\S]*canvas_read\(\{ viewId: "/);
  const revised = await call('canvas_show', { title: 'Release plan v2', format: 'openui', source: OPENUI.replace('Pick the next milestone', 'Pick again'), viewId: openuiId, expectedRevision: 1 });
  assert.match(revised.content, /^Revised Canvas view "Release plan v2"/);
  assert.match(revised.content, /- Revision: 2\b/);
  assert.equal(viewIdOf(revised), openuiId);
});

test('canvas_read lists the conversation\'s views and returns one in full', async () => {
  const listing = await call('canvas_read', {});
  assert.match(listing.content, new RegExp(`"Release plan v2": view ${openuiId}, openui, latest revision 2`));
  assert.match(listing.content, new RegExp(`"Layout choice": view ${htmlId}, html, latest revision 1`));
  const detail = await call('canvas_read', { viewId: openuiId });
  assert.match(detail.content, /^# Release plan v2/);
  assert.match(detail.content, /- Latest revision: 2, by build/);
  assert.match(detail.content, /- Earlier revisions: 1 "Release plan"/);
  assert.ok(detail.content.includes('```openui\n' + OPENUI.replace('Pick the next milestone', 'Pick again') + '\n```'));
  assert.match(detail.content, /expectedRevision 2/);
  await assert.rejects(call('canvas_read', { viewId: randomUUID() }), /canvas_read\(\) without a viewId/);
});

test('canvas_pin shares a view with the project; other conversations keep their own revision', async () => {
  assert.doesNotMatch((await call('canvas_read', {}, 'ses_b')).content, new RegExp(openuiId));
  await assert.rejects(call('canvas_pin', { viewId: openuiId, name: 'Release plan', expectedRevision: 1 }), /revision 2[\s\S]*canvas_read/);
  assert.match((await call('canvas_pin', { viewId: openuiId, name: 'Release plan', expectedRevision: 2 })).content, /Pinned view .* as project view "Release plan" at revision 2/);
  const seen = await call('canvas_read', {}, 'ses_b');
  assert.match(seen.content, new RegExp(`view ${openuiId}, openui, latest revision 2, not shown in this conversation yet, pinned as "Release plan"`));
  assert.doesNotMatch(seen.content, new RegExp(htmlId));
  const revised = await call('canvas_show', { title: 'Release plan v3', format: 'openui', source: OPENUI, viewId: openuiId, expectedRevision: 2 }, 'ses_b');
  assert.match(revised.content, /- Revision: 3\b/);
  const a = resolve('ses_a')!;
  const snapshot = await request<Snapshot>(config, '/api/snapshot', undefined, a.viewerKey);
  const view = snapshot.views.find(v => v.id === openuiId)!;
  assert.equal(view.revision.number, 2, 'conversation A keeps showing its own revision');
  assert.equal(view.latest, 3);
  assert.match((await call('canvas_read', { viewId: openuiId })).content, /- Latest revision: 3, by plan/);
});

test('the worker delivers viewer input to its conversation exactly once', async () => {
  const a = resolve('ses_a')!;
  const input: Submission = { id: randomUUID(), sessionKey: a.key, viewId: htmlId, revision: 1, action: 'Choose layout', data: { layout: 'B' }, notes: 'Keep the old header.' };
  await request(config, '/api/submit', input, a.viewerKey);
  await request(config, '/api/submit', input, a.viewerKey);
  const delivered = await waitFor(async () => {
    const s = await request<Snapshot>(config, '/api/snapshot', undefined, a.viewerKey);
    return s.interactions.find(i => i.id === input.id && i.status === 'delivered');
  }, 'delivery');
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0], { sessionID: 'ses_a', id: delivered.messageId, text: delivered.prompt, delivery: 'queue', resume: true });
  assert.equal(delivered.messageId, `msg_canvas${input.id.replaceAll('-', '')}`);
  assert.ok(delivered.prompt.startsWith(`[Agent Canvas] Layout choice (view ${htmlId}, revision 1)\nAction: Choose layout`));
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(prompts.length, 1, 'a duplicate submission is not delivered again');
  const detail = await call('canvas_read', { viewId: htmlId });
  assert.match(detail.content, /"Choose layout", data \{"layout":"B"\}, note "Keep the old header." \(delivered\)/);
});

test('after OpenCode restarts, input reaches the conversation before anyone types in it', async () => {
  const a = resolve('ses_a')!, before = prompts.length, oldOwner = a.owner;
  // OpenCode stops the old instance and starts a new one, which has not seen this conversation yet.
  if (typeof cleanup === 'function') await cleanup();
  store.heartbeats.set(oldOwner, Date.now() - 60_000);
  restarted = await plugin.setup(ctx);
  const input: Submission = { id: randomUUID(), sessionKey: a.key, viewId: htmlId, revision: 1, action: 'Choose layout', data: { layout: 'A' }, notes: '' };
  await request(config, '/api/submit', input, a.viewerKey);
  await waitFor(async () => (await request<Snapshot>(config, '/api/snapshot', undefined, a.viewerKey)).interactions.find(i => i.id === input.id && i.status === 'delivered'), 'delivery by the new instance');
  assert.equal(prompts.length, before + 1);
  assert.notEqual(resolve('ses_a')!.owner, oldOwner);
  assert.equal((await request<Snapshot>(config, '/api/snapshot', undefined, a.viewerKey)).connected, true);
});

test('deliverToSession: moved, busy, unavailable, admitted and uncertain', async () => {
  const job = {
    action: { id: randomUUID(), messageId: 'msg_canvastest', prompt: '[Agent Canvas] Test (view x, revision 1)\nAction: Go' } as Interaction,
    session: { sessionId: 'ses_x', directory: '/work/a' } as Session,
  } as DeliveryJob;
  const fake = (o: { directory?: string; get?: () => Promise<unknown>; wait?: () => Promise<void>; prompt?: () => Promise<unknown> } = {}) => {
    const calls: unknown[] = [];
    const api = {
      get: o.get ?? (async () => ({ location: { directory: o.directory ?? '/work/a' } })),
      wait: o.wait ?? (async () => {}),
      prompt: async (input: unknown) => { calls.push(input); return o.prompt ? o.prompt() : {}; },
    } as unknown as Parameters<typeof deliverToSession>[0];
    return { calls, api };
  };
  const moved = fake({ directory: '/work/b' });
  assert.deepEqual(await deliverToSession(moved.api, job), { id: job.action.id, status: 'unsent', detail: 'This conversation moved to another directory. Reopen Canvas from that conversation before sending.' });
  assert.equal(moved.calls.length, 0);
  const busy = fake({ wait: () => new Promise(() => {}) });
  const started = Date.now(), result = await deliverToSession(busy.api, job);
  assert.equal(result.status, 'unsent');
  assert.match(result.detail, /busy/);
  assert.ok(Date.now() - started < 3000, 'a busy session is only waited on briefly');
  assert.equal(busy.calls.length, 0);
  const gone = fake({ get: async () => { throw new Error('Session not found'); } });
  assert.equal((await deliverToSession(gone.api, job)).status, 'unsent');
  const admitted = fake();
  assert.deepEqual(await deliverToSession(admitted.api, job), { id: job.action.id, status: 'delivered', detail: 'Accepted into this OpenCode conversation.' });
  assert.deepEqual(admitted.calls, [{ sessionID: 'ses_x', id: 'msg_canvastest', text: job.action.prompt, delivery: 'queue', resume: true }]);
  const interrupted = fake({ prompt: async () => { throw new Error('socket hang up'); } });
  const uncertain = await deliverToSession(interrupted.api, job);
  assert.equal(uncertain.status, 'uncertain');
  assert.match(uncertain.detail, /Check the conversation/);
  assert.equal(interrupted.calls.length, 1);
});

test('ensureService reuses the running service and refuses an incompatible one', async () => {
  await ensureService(config);
  const old = createHttpServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/health' ? { name: 'agent-canvas', version: 1 } : {})); });
  await new Promise<void>(r => old.listen(0, '127.0.0.1', r));
  try {
    const endpoint = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
    await assert.rejects(ensureService({ ...config, endpoint }), /incompatible Agent Canvas service \(version 1\)/);
  } finally { old.closeAllConnections(); await new Promise(r => old.close(r)); }
});

test('during an outage the hooks stay silent and tools say what failed', async () => {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  serverOpen = false;
  const event = { sessionID: 'ses_b', agent: 'plan', system: [] as unknown[] };
  await hooks.get('context')!(event);
  await hooks.get('prompt')!({ sessionID: 'ses_b', messageID: 'msg_x', prompt: { text: 'hi' }, delivery: 'queue' });
  assert.equal(event.system.length, 1, 'the system note does not depend on the service');
  process.env.AGENT_CANVAS_NODE = join(home, 'no-such-node');
  try {
    await assert.rejects(call('canvas_read', {}), /Could not start the Agent Canvas service: .*ENOENT/);
  } finally { delete process.env.AGENT_CANVAS_NODE; }
});
