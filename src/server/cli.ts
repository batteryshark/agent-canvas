import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { connection, dataHome, DEFAULT_PORT, saveConnection, statePath, type Connection } from './config';
import { Store, type ShowResult } from './store';
import { createCanvasServer } from './http';
import { request } from './client';
import { DEMO_LABEL, demoReply, demoViews } from '../shared/demo';
import { CanvasError, type DeliveryJob, type Session, type ViewDetail, type ViewListing } from '../shared/contract';

declare const __dirname: string | undefined;
// The bundled CommonJS service sits next to web/; under tsx (ESM) fall back to the script's folder.
const here = typeof __dirname === 'string' ? __dirname : dirname(process.argv[1] ?? '.');
const USAGE = 'Agent Canvas service: serve [--home PATH] [--port PORT] [--assets DIR] | demo | public-url --url https://host.tailnet.ts.net[:port]';

function serve(config: Connection, home: string, assets: string) {
  const url = new URL(config.endpoint);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('This connection points to a remote service; run serve on its host.');
  let store: Store | undefined;
  const server = createCanvasServer(() => store, config, assets);
  server.on('error', e => { console.error(`Agent Canvas could not listen on ${config.endpoint}: ${e.message}`); process.exitCode = 1; });
  // Open the state only after binding: the port doubles as the lock that keeps one writer per state file.
  server.listen(Number(url.port) || DEFAULT_PORT, '127.0.0.1', () => {
    try { store = new Store(statePath(home)); }
    catch (error) { console.error((error as Error).message); server.close(); process.exitCode = 1; return; }
    console.log(`Agent Canvas listening at ${config.endpoint}\nBrowser base: ${config.publicUrl}\nData: ${home}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

function publicUrl(config: Connection, home: string, value: string | undefined) {
  let url: URL | undefined;
  try { url = new URL(value || ''); } catch { /* reported below */ }
  if (!url || url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the private HTTPS origin returned by Tailscale Serve (https://host.tailnet.ts.net[:port]).');
  }
  saveConnection({ ...config, publicUrl: url.origin }, home);
  console.log(`Saved private browser base ${url.origin}. Restart the Canvas service to use it.`);
}

async function demo(config: Connection) {
  const owner = `demo-${process.pid}`;
  let session: Session;
  try {
    session = await request<Session>(config, '/agent/register', { sessionId: 'agent-canvas-demo', directory: process.cwd(), projectRoot: process.cwd(), agent: 'Demo agent', owner, title: DEMO_LABEL });
  } catch (error) {
    if (error instanceof CanvasError) throw error;
    throw new Error(`Agent Canvas is not running at ${config.endpoint}. Start it with "serve" first.`);
  }
  // Re-running the demo revises its existing views instead of piling up new ones.
  const listing = await request<ViewListing>(config, '/agent/read', { sessionKey: session.key });
  const links: string[] = [];
  for (const view of demoViews()) {
    const existing = listing.find(v => v.shownHere && v.title === view.title && v.format === view.format);
    const shown = await request<ShowResult & { link: string }>(config, '/agent/show', { ...view, sessionKey: session.key, ...(existing ? { viewId: existing.id, expectedRevision: existing.latest } : {}) });
    for (const warning of shown.warnings) console.warn(`${view.title}: ${warning}`);
    links.push(`${view.title} (${view.format}): ${shown.link}`);
  }
  console.log(`${DEMO_LABEL}\n${links.join('\n')}\nThe demo worker answers each submission with a new revision. Ctrl+C stops it; saved views remain.`);

  async function answer({ action, session }: DeliveryJob) {
    console.log(`Received “${action.action}” for view ${action.viewId}, revision ${action.revision}`);
    let detail = 'Received by the demo worker. A new revision shows its reply.';
    try {
      for (let attempt = 1; ; attempt++) {
        const view = await request<ViewDetail>(config, '/agent/read', { sessionKey: session.key, viewId: action.viewId });
        const reply = demoReply(view.latest.content.format, { action: action.action, data: action.data, notes: action.notes, revision: action.revision });
        try {
          await request(config, '/agent/show', { ...reply, sessionKey: session.key, viewId: view.id, expectedRevision: view.latest.number });
          break;
        } catch (error) {
          // Someone revised the view between read and show: read again rather than overwrite.
          if (!(error instanceof CanvasError && error.status === 409) || attempt >= 3) throw error;
        }
      }
    } catch (error) {
      detail = `Received by the demo worker, but it could not show a reply: ${(error as Error).message}`.slice(0, 1000);
      console.error(detail);
    }
    await request(config, '/agent/ack', { owner, result: { id: action.id, status: 'delivered', detail } });
  }
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const job = await request<DeliveryJob | null>(config, '/agent/claim', { owner });
      if (job) await answer(job);
    } catch (error) { console.error((error as Error).message); }
    finally { busy = false; }
  }, 1000);
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { url: { type: 'string' }, port: { type: 'string' }, home: { type: 'string' }, assets: { type: 'string' } } });
  if (values.home) process.env.AGENT_CANVAS_HOME = values.home;
  if (values.port) process.env.AGENT_CANVAS_PORT = values.port;
  const command = positionals[0] || 'serve', home = dataHome(), config = connection(home);
  if (command === 'serve') serve(config, home, values.assets || join(here, 'web'));
  else if (command === 'public-url') publicUrl(config, home, values.url);
  else if (command === 'demo') await demo(config);
  else { console.log(USAGE); process.exitCode = 1; }
}
void main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
