// Browser test fixture. Runs the packaged Canvas service on 4318, the real OpenCode plugin against a fake
// OpenCode 2 context, and an OpenChamber 2.3 stand-in on 4319 that serves the built pane with the real guest
// headers and proxies its service requests to the packaged host bridge. Playwright starts it (playwright.config.ts).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guestFramePolicy } from '@openchamber/sdk';
import { guestMessageSchema } from '@openchamber/sdk/schemas';
import type { Session, Snapshot, ViewDetail, ViewListing } from '../src/shared/contract';
import { SUMMARIES, TITLES, seedFormat, seedSource, type SeedKind } from './browser/seeds';

const root = fileURLToPath(new URL('..', import.meta.url));
const SERVICE_PORT = 4318, FIXTURE_PORT = 4319, GUEST_ID = 'agent-canvas', FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const home = realpathSync(mkdtempSync(join(tmpdir(), 'canvas-browser-')));
const projectDir = join(home, 'project'), canvasHome = join(home, 'canvas');
mkdirSync(projectDir);
// Everything below, the plugin included, reads these: never the user's live install on 4317.
process.env.AGENT_CANVAS_HOME = canvasHome;
process.env.AGENT_CANVAS_PORT = String(SERVICE_PORT);

// guide.ts may import the generated Markdown as text. esbuild bundles that; plain Node under tsx cannot.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.md')) return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};` };
    return nextLoad(url, context);
  },
});

const children: ChildProcess[] = [];
let stopping = false, cleanup: (() => unknown) | void;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  try { await cleanup?.(); } catch {}
  const exited = children.filter(child => child.exitCode === null && child.signalCode === null)
    .map(child => new Promise(done => { child.once('exit', done); child.kill('SIGTERM'); }));
  await Promise.race([Promise.all(exited), new Promise(done => setTimeout(done, 3000))]);
  // The data is throwaway; keep it only when the run failed to start, for the logs it names.
  if (code === 0) rmSync(home, { recursive: true, force: true });
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void shutdown(0));
process.on('exit', () => { for (const child of children) child.kill('SIGTERM'); });
function launch(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => { if (!stopping) { console.error(`Fixture: ${name} exited (${code ?? signal}).`); void shutdown(1); } });
  children.push(child);
}
async function waitFor(what: string, check: () => Promise<boolean>, ms = 20_000) {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Fixture: timed out waiting for ${what}. ${last instanceof Error ? last.message : ''}`);
}
const freePort = () => new Promise<number>((done, fail) => {
  const server = createNetServer().once('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address() as AddressInfo; server.close(() => done(port)); });
});

// The packaged service, exactly as the plugin would start it.
const { connection } = await import('../src/server/config');
const config = connection();
launch('Canvas service', [join(root, 'dist/opencode/canvas-service.cjs'), 'serve', '--home', canvasHome, '--port', String(SERVICE_PORT)], { ...process.env });
await waitFor('the Canvas service', async () => (await fetch(`${config.endpoint}/health`)).ok);
async function call<T>(path: string, body?: unknown, token = config.token): Promise<T> {
  const response = await fetch(`${config.endpoint}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(data?.error || `Canvas HTTP ${response.status}`), { status: response.status });
  return data as T;
}

// The packaged OpenChamber host bridge. OpenChamber gives it a port and token; here AGENT_CANVAS_HOME is passed
// through as well so it reads this fixture's connection.json.
const bridgePort = await freePort(), bridgeToken = randomBytes(24).toString('hex');
launch('OpenChamber bridge', [join(root, 'dist/openchamber/service/main.cjs')], { ...process.env, OPENCHAMBER_SERVICE_PORT: String(bridgePort), OPENCHAMBER_SERVICE_TOKEN: bridgeToken });
await waitFor('the OpenChamber bridge', async () => (await fetch(`http://127.0.0.1:${bridgePort}/health`, { headers: { Authorization: `Bearer ${bridgeToken}` } })).ok);

// A fake OpenCode 2 plugin context: enough of ctx for the real plugin, with prompts recorded instead of run.
type FakeSession = { id: string; title: string; agent: string };
type Received = { sessionID: string; id: string | null; text: string; delivery: unknown; resume: unknown; duplicate: boolean; at: string };
const sessions = new Map<string, FakeSession>();
const tools = new Map<string, any>();
const hooks = new Map<string, Set<(input: any) => unknown>>();
const received: Received[] = [];
const systemNotes = new Map<string, string[]>();
let busy = false;
// Requests that reached /beacon/: anything here came from a page that was meant to have no network.
const beacons: string[] = [];
const idleWaiters = new Set<() => void>();
const registration = { dispose: async () => {} };

function notFaked(path: string): any {
  return new Proxy(function () {}, {
    get: (_target, key) => key === 'then' ? undefined : notFaked(`${path}.${String(key)}`),
    apply: () => { console.warn(`Fixture: the plugin called ctx.${path}(), which the fake OpenCode context does not implement.`); return Promise.resolve(registration); },
  });
}
const lenient = <T extends object>(name: string, value: T): T => new Proxy(value, {
  get: (target, key) => key in target ? (target as any)[key] : typeof key === 'string' ? notFaked(`${name}.${key}`) : undefined,
});
const editor = {
  add(tool: any) { tools.set(tool.name, tool); },
  get(id: string) { const tool = tools.get(id); return tool && { ...tool, id }; },
  list() { return [...tools.values()].map(tool => ({ ...tool, id: tool.name })); },
  update(id: string, change: (tool: any) => void) { const tool = tools.get(id); if (tool) change(tool); },
  remove(id: string) { tools.delete(id); },
  namespace() {},
};
const context = lenient('ctx', {
  location: { directory: projectDir, project: { id: 'prj_browser_fixture', directory: projectDir, canonical: projectDir } },
  options: {},
  session: lenient('session', {
    async get({ sessionID }: { sessionID: string }) {
      const s = sessions.get(sessionID);
      if (!s) throw new Error(`Session ${sessionID} not found`);
      const now = Date.now();
      return { id: s.id, projectID: 'prj_browser_fixture', agent: s.agent, title: s.title, location: { directory: projectDir }, time: { created: now, updated: now }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    },
    async wait(_input: { sessionID: string }, options?: { signal?: AbortSignal }) {
      if (!busy) return;
      await new Promise<void>((done, fail) => {
        const signal = options?.signal;
        const idle = () => { idleWaiters.delete(idle); signal?.removeEventListener('abort', abort); done(); };
        const abort = () => { idleWaiters.delete(idle); fail(signal?.reason ?? new Error('Aborted while the session was busy')); };
        idleWaiters.add(idle);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    async prompt(input: any) {
      const entry: Received = { sessionID: input.sessionID, id: input.id ?? null, text: String(input.text ?? ''), delivery: input.delivery, resume: input.resume, duplicate: false, at: new Date().toISOString() };
      entry.duplicate = !!entry.id && received.some(r => r.id === entry.id);
      received.push(entry);
      if (!entry.duplicate) setTimeout(() => void respond(entry), 200);
      return { id: entry.id ?? `msg_${randomUUID()}`, sessionID: entry.sessionID, text: entry.text, time: { created: Date.now() } };
    },
    async hook(name: string, callback: (input: any) => unknown) {
      const set = hooks.get(name) ?? new Set();
      hooks.set(name, set.add(callback));
      return { dispose: async () => { set.delete(callback); } };
    },
  }),
  tool: lenient('tool', {
    async transform(callback: (e: typeof editor) => void) { callback(editor); return registration; },
    async hook() { return registration; },
    async reload() {},
    async list() { return editor.list(); },
  }),
});

const plugin = (await import('../src/opencode/plugin')).default as any;
if (plugin?.id !== 'agent-canvas' || typeof plugin.setup !== 'function') throw new Error('Fixture: src/opencode/plugin.ts must default-export an OpenCode 2 plugin with id "agent-canvas".');
cleanup = await plugin.setup(context);
for (const name of ['canvas_guide', 'canvas_show', 'canvas_read', 'canvas_pin']) if (!tools.has(name)) throw new Error(`Fixture: the plugin did not register ${name}.`);

function resultText(result: any) {
  if (typeof result?.content === 'string') return result.content;
  if (Array.isArray(result?.content)) return result.content.map((part: any) => part.text ?? '').join('\n');
  return JSON.stringify(result?.output ?? result ?? null);
}
/** Runs a tool the way OpenCode does: input decoded by the tool's own schema, then execute with a tool context. */
async function runTool(sessionId: string, name: string, input: unknown) {
  const tool = tools.get(name), session = sessions.get(sessionId)!;
  let args = input;
  const standard = tool.input?.['~standard'];
  if (standard) {
    const checked = await standard.validate(input);
    if (checked.issues) throw new Error(`${name} input rejected: ${checked.issues.map((i: any) => i.message).join('; ')}`);
    args = checked.value;
  }
  const result = await tool.execute(args, { sessionID: sessionId, agent: session.agent, messageID: `msg_${randomUUID()}`, id: `call_${randomUUID()}`, signal: AbortSignal.timeout(30_000), progress: async () => {} });
  return resultText(result);
}
/** A conversation turn: OpenCode runs the prompt and context hooks, where the plugin registers and adds its note. */
async function openSession(id: string, title: string) {
  if (!sessions.has(id)) sessions.set(id, { id, title, agent: 'build' });
  for (const callback of hooks.get('prompt') ?? []) await callback({ sessionID: id, messageID: `msg_${randomUUID()}`, prompt: { text: 'Show me in Agent Canvas.' }, delivery: 'queue' });
  const event = { sessionID: id, agent: 'build', model: { providerID: 'fixture', id: 'fixture' }, system: [] as any[], messages: [], options: {}, tools: {} };
  for (const callback of hooks.get('context') ?? []) await callback(event);
  systemNotes.set(id, event.system.map(part => typeof part === 'string' ? part : part.text ?? JSON.stringify(part)));
  // A conversation that has not shown anything may not be registered yet; reading registers it.
  await call<Session>('/agent/resolve', { directory: projectDir, sessionId: id }).catch(() => runTool(id, 'canvas_read', {}));
  return call<Session>('/agent/resolve', { directory: projectDir, sessionId: id });
}
const knownViews = new Map<string, { kind: SeedKind; sessionId: string }>();
async function show(sessionId: string, kind: SeedKind) {
  const session = await openSession(sessionId, sessions.get(sessionId)?.title ?? 'Agent session');
  await runTool(sessionId, 'canvas_show', { title: TITLES[kind], summary: SUMMARIES[kind], format: seedFormat(kind), source: seedSource(kind) });
  const listing = await call<ViewListing>('/agent/read', { sessionKey: session.key });
  const view = listing.find(v => v.title === TITLES[kind] && v.shownHere && !knownViews.has(v.id));
  if (!view) throw new Error(`Fixture: canvas_show did not save "${TITLES[kind]}".`);
  knownViews.set(view.id, { kind, sessionId });
  return { id: view.id, title: TITLES[kind] };
}
/** What a real agent does after input arrives: read the view, then show a revision that answers it. */
async function revise(sessionId: string, viewId: string, reply: string) {
  const known = knownViews.get(viewId);
  if (!known) throw new Error(`Fixture: view ${viewId} was not seeded by the fixture.`);
  const session = await call<Session>('/agent/resolve', { directory: projectDir, sessionId });
  const detail = await call<ViewDetail>('/agent/read', { sessionKey: session.key, viewId });
  await runTool(sessionId, 'canvas_show', { title: detail.latest.title, summary: detail.latest.summary, format: seedFormat(known.kind), source: seedSource(known.kind, reply), viewId, expectedRevision: detail.latest.number });
  return detail.latest.number + 1;
}
async function respond(entry: Received) {
  const match = /\(view ([0-9a-f-]{36}), revision \d+\)\nAction: (.*)/.exec(entry.text);
  const known = match && knownViews.get(match[1]);
  // The probe page reports on demand; answering it would only re-render the page under test.
  if (!match || !known || known.kind === 'attack') return;
  try { await revise(entry.sessionID, match[1], `Received '${match[2]}'. I am drafting the plan now.`); }
  catch (error) { console.error(`Fixture: the agent could not answer: ${(error as Error).message}`); }
}
/** Any view, shown through the real canvas_show tool: for pages a test writes itself. */
async function showSource(input: { sessionId: string; title: string; format: 'openui' | 'html'; source: string }) {
  const session = await openSession(input.sessionId, sessions.get(input.sessionId)?.title ?? 'Agent session');
  const text = await runTool(input.sessionId, 'canvas_show', { title: input.title, format: input.format, source: input.source });
  const id = /- View: ([0-9a-f-]{36})/.exec(text)?.[1];
  if (!id) throw new Error(`Fixture: canvas_show did not save "${input.title}": ${text}`);
  return { id, title: input.title, viewerKey: session.viewerKey, result: text };
}
async function seed(input: { sessionId?: string; title?: string; views?: SeedKind[] }) {
  const sessionId = input.sessionId || `ses_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  if (!sessions.has(sessionId)) sessions.set(sessionId, { id: sessionId, title: input.title || 'Agent session', agent: 'build' });
  const views: Partial<Record<SeedKind, { id: string; title: string }>> = {};
  for (const kind of input.views ?? []) views[kind] = await show(sessionId, kind);
  const session = await openSession(sessionId, sessions.get(sessionId)!.title);
  const snapshot = await call<Snapshot>('/api/snapshot', undefined, session.viewerKey);
  return { sessionId, title: sessions.get(sessionId)!.title, url: snapshot.browserUrl, viewerKey: session.viewerKey, views };
}

const a = await seed({ sessionId: 'ses_browser_a', title: 'Checkout redesign', views: ['openui', 'html', 'attack'] });
const b = await seed({ sessionId: 'ses_browser_b', title: 'Second conversation' });
if (!systemNotes.get(a.sessionId)?.some(note => note.includes('canvas_guide'))) console.warn('Fixture: the context hook added no system note naming canvas_guide.');

// The OpenChamber stand-in.
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
/** Mirrors OpenChamber's GET /api/guests/:id/{*filePath}: package files only, known types only, guest CSP and sandbox. */
function guestAsset(req: IncomingMessage, res: ServerResponse, relativePath: string) {
  const segments = relativePath.split('/'), type = MIME[extname(relativePath)];
  if (!type || relativePath.includes('\\') || relativePath.includes('\0') || segments.some(s => s === '' || s === '.' || s === '..')) { res.writeHead(404); res.end(); return; }
  const file = join(root, 'dist/openchamber', ...segments);
  try { if (!statSync(file).isFile()) throw new Error(); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, {
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    'Content-Security-Policy': `sandbox allow-scripts; ${guestFramePolicy(`${req.headers.host}/api/guests/${GUEST_ID}/`)}`,
    // The sandboxed pane's origin is "null"; OpenChamber answers it so the package's own files load by fetch.
    'Access-Control-Allow-Origin': 'null',
  });
  res.end(readFileSync(file));
}
/** Mirrors OpenChamber's service proxy: the SDK's own message schema, bearer auth, 20 s, 8 MB answers. */
async function serviceRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.headers.origin !== FIXTURE_ORIGIN) { json(res, 403, { error: 'HOST_REJECTED', message: 'Only the harness page proxies service requests.' }); return; }
  const parsed = guestMessageSchema.safeParse({ channel: 'openchamber.sdk', v: 1, type: 'service-request', id: 'fixture', payload: await readBody(req) });
  if (!parsed.success || parsed.data.type !== 'service-request') { json(res, 400, { error: 'BAD_PATH', message: parsed.success ? 'Not a service request.' : parsed.error.issues[0]?.message }); return; }
  const p = parsed.data.payload, url = new URL(p.path, `http://127.0.0.1:${bridgePort}/`);
  for (const [key, value] of Object.entries(p.query ?? {})) url.searchParams.set(key, value);
  try {
    const response = await fetch(url, {
      method: p.method, signal: AbortSignal.timeout(20_000), body: p.body !== undefined && p.method !== 'GET' ? p.body : undefined,
      headers: { Accept: 'application/json', Authorization: `Bearer ${bridgeToken}`, ...(p.body !== undefined && p.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
    });
    const body = await response.text();
    if (Buffer.byteLength(body) > 8_000_000) { json(res, 502, { error: 'RESPONSE_TOO_LARGE', message: 'The service answered with more than 8000000 bytes.' }); return; }
    json(res, 200, { status: response.status, body });
  } catch (error) {
    json(res, 502, { error: 'REQUEST_FAILED', message: (error as Error).message });
  }
}
function sessionInfo(id: string | null, fallback: { sessionId: string; title: string }) {
  const s = sessions.get(id || fallback.sessionId);
  return s ? { id: s.id, title: s.title } : { id: fallback.sessionId, title: fallback.title };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', FIXTURE_ORIGIN), path = url.pathname;
  try {
    if (path === '/health') { json(res, 200, { ok: true }); return; }
    if (path.startsWith('/beacon/')) { beacons.push(`${req.method} ${url.pathname}${url.search}`); res.writeHead(204); res.end(); return; }
    if (path === '/control/beacons') { json(res, 200, { beacons }); return; }
    if (path === '/control/show' && req.method === 'POST') { json(res, 200, await showSource(await readBody(req))); return; }
    if (path === '/harness') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(readFileSync(join(root, 'test/pane-host.html'))); return; }
    if (path === '/fixture-config') { json(res, 200, { directory: projectDir, a: sessionInfo(url.searchParams.get('a'), a), b: sessionInfo(url.searchParams.get('b'), b) }); return; }
    if (path.startsWith(`/api/guests/${GUEST_ID}/`) && req.method === 'GET') { guestAsset(req, res, decodeURIComponent(path.slice(`/api/guests/${GUEST_ID}/`.length))); return; }
    if (path === '/host/service-request' && req.method === 'POST') { await serviceRequest(req, res); return; }
    if (path === '/control') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.busy === 'boolean') { busy = body.busy; if (!busy) [...idleWaiters].forEach(idle => idle()); }
      }
      json(res, 200, { busy, received, systemNotes: Object.fromEntries(systemNotes) }); return;
    }
    if (path === '/control/seed' && req.method === 'POST') { json(res, 200, await seed(await readBody(req))); return; }
    if (path === '/control/revise' && req.method === 'POST') {
      const body = await readBody(req);
      json(res, 200, { revision: await revise(body.sessionId, body.viewId, body.reply || 'Revised by the agent.') }); return;
    }
    json(res, 404, { error: 'Fixture route not found' });
  } catch (error) {
    json(res, 500, { error: (error as Error).message });
  }
});
await new Promise<void>(done => server.listen(FIXTURE_PORT, '127.0.0.1', done));

mkdirSync(join(root, '.runtime'), { recursive: true });
writeFileSync(join(root, '.runtime/browser-fixture.json'), JSON.stringify({
  url: a.url, sessionBUrl: b.url, sessions: { a: a.sessionId, b: b.sessionId }, views: a.views,
  harness: `${FIXTURE_ORIGIN}/harness`, control: `${FIXTURE_ORIGIN}/control`, directory: projectDir, home,
}, null, 2));
console.log(`Browser fixture ready: Canvas ${config.endpoint}, pane harness ${FIXTURE_ORIGIN}/harness, data ${home}`);
