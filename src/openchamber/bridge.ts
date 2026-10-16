// OpenChamber host service: the pane's only route to the Canvas service. The opaque-origin pane never sees the
// agent token; it gets one conversation's viewer key and can reach only the viewer API and bundled libraries.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { connection } from '../server/config';
import { HTML_LIBRARIES } from '../shared/html-check';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT), token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!port || !token) throw new Error('This service must be launched by OpenChamber.');
const API_PATH = /^\/api\/(snapshot|revision|pin|submit|retry|report)(\?|$)/;
// Built as service/main.cjs; the build copies the libraries to panel/lib beside it.
const LIBRARY_DIR = join(__dirname, '..', 'panel', 'lib');
const BODY_MAX = 256_000;

class BridgeError extends Error { constructor(public status: number, message: string) { super(message); } }
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function authorized(req: IncomingMessage) {
  const header = req.headers.authorization || '', given = header.startsWith('Bearer ') ? header.slice(7) : '';
  return Buffer.byteLength(given) === Buffer.byteLength(token!) && timingSafeEqual(Buffer.from(given), Buffer.from(token!));
}
async function readJson(req: IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > BODY_MAX) throw new BridgeError(413, 'Request is too large for the Canvas bridge');
  }
  try { return JSON.parse(text || '{}'); } catch { throw new BridgeError(400, 'Invalid JSON'); }
}
/** Call the Canvas service and keep its status, so the pane sees a 409 as a 409. */
async function forward(path: string, body: unknown, credential: string): Promise<{ status: number; text: string }> {
  const { endpoint } = connection();
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new BridgeError(502, `The Agent Canvas service is not reachable at ${endpoint}. It starts with OpenCode; ${(e as Error).message}`);
  }
  return { status: response.status, text: await response.text() };
}
function relay(res: ServerResponse, result: { status: number; text: string }) {
  res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(result.text);
}

createServer(async (req, res) => {
  try {
    if (!authorized(req)) { json(res, 401, { error: 'Host credential required' }); return; }
    const path = new URL(req.url || '/', 'http://bridge.invalid').pathname;
    if (path === '/health') { json(res, 200, { ok: true }); return; }
    const library = /^\/lib\/([^/]{1,80})$/.exec(path);
    if (library && req.method === 'GET') {
      let name = '';
      try { name = decodeURIComponent(library[1]); } catch { throw new BridgeError(400, 'Invalid library name'); }
      if (!Object.hasOwn(HTML_LIBRARIES, name)) { json(res, 404, { error: `Unknown library "${name}"` }); return; }
      const source = await readFile(join(LIBRARY_DIR, `${name}.js`), 'utf8').catch(() => { throw new BridgeError(404, `The ${name} library is missing from this package. Rebuild Agent Canvas.`); });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(source); return;
    }
    if (req.method !== 'POST') { json(res, 405, { error: 'Method not allowed' }); return; }
    const body = await readJson(req);
    if (path === '/connect') {
      if (typeof body.directory !== 'string' || typeof body.sessionId !== 'string') throw new BridgeError(400, 'A directory and session id are required');
      const result = await forward('/agent/resolve', { directory: body.directory, sessionId: body.sessionId }, connection().token);
      if (result.status !== 200) { relay(res, result); return; }
      // Only this session's viewer credential crosses the host bridge.
      const session = JSON.parse(result.text) as { viewerKey?: unknown };
      if (typeof session.viewerKey !== 'string') throw new BridgeError(502, 'The Canvas service returned no viewer key');
      json(res, 200, { key: session.viewerKey }); return;
    }
    if (path === '/request') {
      if (typeof body.path !== 'string' || !API_PATH.test(body.path) || typeof body.key !== 'string' || !body.key) throw new BridgeError(400, 'Invalid Canvas request');
      relay(res, await forward(body.path, body.body, body.key)); return;
    }
    json(res, 404, { error: 'Unknown bridge route' });
  } catch (e) {
    json(res, e instanceof BridgeError ? e.status : 502, { error: (e as Error).message });
  }
}).listen(port, '127.0.0.1');
