import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { ZodError, z } from 'zod';
import { CanvasError, LIMITS } from '../shared/contract';
import { HTML_LIBRARIES } from '../shared/html-check';
import { FRAME_CSP, FRAME_SHELL_HTML } from './frame-shell';
// Type-only: the OpenChamber bridge imports this module's helpers without bundling the store and its validators.
import type { Store } from './store';
import type { Connection } from './config';

export const SERVICE_VERSION = 2;
export const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Reads a JSON body up to `limit` bytes. Over the limit it answers 413 and lets Node discard the rest, so clients still read the response. */
export function readJson(req: IncomingMessage, limit: number = LIMITS.requestBytes): Promise<any> {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new CanvasError(413, `Request is larger than ${limit} bytes.`);
    if (Number(req.headers['content-length'] ?? 0) > limit) { reject(tooLarge()); return; }
    const chunks: Buffer[] = [];
    let size = 0, failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; chunks.length = 0; reject(tooLarge()); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text || '{}')); } catch { reject(new CanvasError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
export function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body ?? null));
}
export const tokenFrom = (req: IncomingMessage) => req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
export const equalToken = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const describeError = (error: unknown) => error instanceof ZodError
  ? error.issues.map(i => `${i.path.length ? i.path.join('.') : 'input'}: ${i.message}`).join('\n')
  : (error as Error).message;

function allowedOrigins(config: Connection) {
  const endpoint = new URL(config.endpoint), origins = new Set([endpoint.origin, new URL(config.publicUrl).origin]);
  // The same loopback service, opened by name instead of address.
  if (endpoint.hostname === '127.0.0.1') origins.add(`${endpoint.protocol}//localhost${endpoint.port ? `:${endpoint.port}` : ''}`);
  return origins;
}
const baseHeaders = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function sendFile(req: IncomingMessage, res: ServerResponse, path: string, type: string, headers: Record<string, string> = {}) {
  let stat;
  try { stat = statSync(path); } catch { throw new CanvasError(404, 'Not found'); }
  if (!stat.isFile()) throw new CanvasError(404, 'Not found');
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const head = { ...baseHeaders, 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, ...headers };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(readFileSync(path));
}
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'],
};

/**
 * The Canvas service. `source` may be a getter that returns undefined while the store is opening.
 * `assets` is the built browser app (dist/opencode/web); bundled libraries live in its lib/ folder as NAME.js.
 */
export function createCanvasServer(source: Store | (() => Store | undefined), config: Connection, assets: string): Server {
  const origins = allowedOrigins(config);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://canvas.invalid'), path = url.pathname, method = req.method;
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin)) throw new CanvasError(403, 'Untrusted request origin');
      if (path === '/health' && method === 'GET') { json(res, 200, { name: 'agent-canvas', version: SERVICE_VERSION }); return; }
      if (path.startsWith('/agent/') || path.startsWith('/api/')) {
        const store = typeof source === 'function' ? source() : source;
        if (!store) throw new CanvasError(503, 'Agent Canvas is starting. Try again in a moment.');
        if (path.startsWith('/agent/')) {
          if (!equalToken(tokenFrom(req), config.token)) throw new CanvasError(401, 'Agent credential required');
          if (method !== 'POST') throw new CanvasError(405, 'Method not allowed');
          const body = await readJson(req);
          if (path === '/agent/register') { json(res, 200, store.register(body)); return; }
          if (path === '/agent/resolve') { const r = z.object({ directory: z.string(), sessionId: z.string() }).parse(body); json(res, 200, store.resolve(r.directory, r.sessionId)); return; }
          if (path === '/agent/show') {
            const shown = store.show(body);
            json(res, 200, { ...shown, link: store.link(store.session(body.sessionKey), config.publicUrl, shown.id) }); return;
          }
          if (path === '/agent/read') {
            const r = z.object({ sessionKey: z.string().min(1), viewId: z.string().optional() }).parse(body);
            json(res, 200, store.read(store.session(r.sessionKey), r.viewId, config.publicUrl)); return;
          }
          if (path === '/agent/claim') { const r = z.object({ owner: z.string().min(1), projectRoot: z.string().min(1).max(2000).optional() }).parse(body); json(res, 200, store.claim(r.owner, r.projectRoot)); return; }
          if (path === '/agent/ack') { const r = z.object({ owner: z.string().min(1), result: z.unknown() }).parse(body); json(res, 200, store.acknowledge(r.owner, r.result)); return; }
          throw new CanvasError(404, 'Agent route not found');
        }
        const session = store.viewer(tokenFrom(req));
        if (method === 'GET' && path === '/api/snapshot') { json(res, 200, store.snapshot(session, config.publicUrl)); return; }
        if (method === 'GET' && path === '/api/revision') {
          json(res, 200, store.revision(session, url.searchParams.get('id') || '', z.coerce.number().int().positive().parse(url.searchParams.get('revision')))); return;
        }
        if (method === 'POST' && path === '/api/pin') { json(res, 200, store.pin(session, await readJson(req))); return; }
        if (method === 'POST' && path === '/api/submit') { json(res, 200, store.submit(session, await readJson(req))); return; }
        if (method === 'POST' && path === '/api/retry') { json(res, 200, store.retry(session, z.object({ id: z.string() }).parse(await readJson(req)).id)); return; }
        if (method === 'POST' && path === '/api/report') { json(res, 200, store.report(session, await readJson(req))); return; }
        throw new CanvasError(404, 'Canvas route not found');
      }
      if (method !== 'GET') throw new CanvasError(405, 'Method not allowed');
      if (path === '/frame') {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': FRAME_CSP });
        res.end(FRAME_SHELL_HTML); return;
      }
      const library = /^\/lib\/(.+)\.js$/.exec(path)?.[1];
      if (library !== undefined) {
        if (!Object.hasOwn(HTML_LIBRARIES, library)) throw new CanvasError(404, 'Unknown library');
        sendFile(req, res, join(assets, 'lib', `${library}.js`), 'text/javascript; charset=utf-8'); return;
      }
      const file = STATIC[path];
      if (!file) throw new CanvasError(404, 'Not found');
      sendFile(req, res, join(assets, file[0]), file[1], { 'Content-Security-Policy': APP_CSP });
    } catch (error) {
      const status = error instanceof CanvasError ? error.status : error instanceof ZodError ? 400 : 500;
      json(res, status, { error: status === 500 ? 'Canvas service error. Check the service log.' : describeError(error) });
      if (status === 500) console.error(error);
    }
  });
}
