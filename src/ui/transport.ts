import { z } from 'zod';
import { connectHost, type HostClient, type HostThemeTokens } from '@openchamber/sdk';

// Zod probes for eval while it builds schemas, and the browser page CSP forbids eval. app.tsx imports
// this module first so the JIT is off before the contract or OpenUI build any schema.
z.config({ jitless: true });

declare const __CANVAS_SURFACE__: 'browser' | 'openchamber';
export type Appearance = 'light' | 'dark';
export interface Transport {
  mode: 'browser' | 'openchamber'; frameMode: 'srcdoc' | 'shell';
  call<T>(path: string, body?: unknown): Promise<T>;
  load<T>(key: string): Promise<T | null>; save(key: string, value: unknown): Promise<void>;
  loadLibrary(name: string): Promise<string>;
  open(url: string): void; badge(count: number): void;
  appearance(): Appearance; onAppearance(cb: (a: Appearance) => void): () => void;
  onContext(cb: (state: { ready: boolean; error?: string }) => void): () => void;
}

/** OpenChamber's GUEST_REQUEST_BODY_MAX: the host refuses larger serviceRequest bodies. */
const BRIDGE_BODY_MAX = 64_000;
const VIEWER_KEY = 'canvas.viewer';

/** The Canvas service, or the host bridge in front of it, answered with this status. Any other failure got no answer. */
export class CallError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
function checked<T>(result: any, status: number): T {
  if (status < 200 || status >= 300) throw new CallError(result?.error || `Request failed (${status})`, status);
  return result as T;
}
function parse(text: string, status: number) {
  try { return JSON.parse(text); } catch { throw new Error(`The Canvas service answered ${status} without JSON.`); }
}
/** One fetch per library; a failure is forgotten so the next page can try again. */
function libraryCache(fetchLibrary: (name: string) => Promise<string>) {
  const cache = new Map<string, Promise<string>>();
  return (name: string) => {
    let entry = cache.get(name);
    if (!entry) {
      entry = fetchLibrary(name);
      cache.set(name, entry);
      entry.catch(() => cache.delete(name));
    }
    return entry;
  };
}
const media = () => typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
const systemAppearance = (): Appearance => media()?.matches === false ? 'light' : 'dark';

export function createTransport(): Transport {
  return __CANVAS_SURFACE__ === 'openchamber' ? paneTransport(connectHost()) : browserTransport();
}

function browserTransport(): Transport {
  const hash = new URLSearchParams(location.hash.slice(1));
  const initialKey = hash.get('key');
  if (initialKey) {
    try { sessionStorage.setItem(VIEWER_KEY, initialKey); } catch {}
    // The viewing credential leaves the address bar so it is not bookmarked, shared, or kept in history.
    const view = hash.get('view');
    history.replaceState(null, '', location.pathname + location.search + (view ? `#view=${encodeURIComponent(view)}` : ''));
  }
  let stored = '';
  try { stored = sessionStorage.getItem(VIEWER_KEY) || ''; } catch {}
  const key = initialKey || stored;
  const scheme = media();
  return {
    mode: 'browser', frameMode: 'shell',
    async call<T>(path: string, body?: unknown) {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      return checked<T>(parse(await response.text(), response.status), response.status);
    },
    async load<T>(k: string) { try { return JSON.parse(localStorage.getItem(`canvas.${k}`) || 'null') as T | null; } catch { return null; } },
    async save(k, value) { localStorage.setItem(`canvas.${k}`, JSON.stringify(value)); },
    loadLibrary: libraryCache(async name => {
      const response = await fetch(`/lib/${encodeURIComponent(name)}.js`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`The ${name} library is unavailable (${response.status}).`);
      return response.text();
    }),
    open(url) { window.open(url, '_blank', 'noopener,noreferrer'); },
    badge() {},
    appearance: systemAppearance,
    onAppearance(cb) {
      const listener = () => cb(systemAppearance());
      scheme?.addEventListener('change', listener);
      return () => scheme?.removeEventListener('change', listener);
    },
    onContext(cb) {
      cb({ ready: !!key, error: key ? undefined : 'Open the viewing link from your agent conversation to see its Canvas views.' });
      return () => {};
    },
  };
}

/** Mirror the host palette onto the shell so the pane sits naturally inside OpenChamber. */
function applyHostTokens(tokens: HostThemeTokens) {
  const map: Array<[string, string | undefined]> = [
    ['--bg', tokens.background], ['--panel', tokens.mutedSurface], ['--card', tokens.elevated], ['--border', tokens.border],
    ['--text', tokens.foreground], ['--muted', tokens.muted], ['--accent', tokens.primaryText || tokens.primary],
    ['--accent-fill', tokens.primary], ['--accent-ink', tokens.primaryForeground], ['--warn', tokens.warningText],
    ['--danger', tokens.errorText], ['--ok', tokens.successText], ['--font-sans', tokens.font], ['--font-mono', tokens.mono], ['--radius', tokens.radius],
  ];
  const style = document.documentElement.style;
  for (const [name, value] of map) {
    if (typeof value === 'string' && value.trim() && value.length < 400) style.setProperty(name, value);
    else style.removeProperty(name);
  }
}

function paneTransport(host: HostClient): Transport {
  let key = '', generation = 0, appearance: Appearance = systemAppearance();
  const appearanceListeners = new Set<(a: Appearance) => void>();
  // The host repeats `ready` whenever the theme changes.
  host.onReady(context => {
    applyHostTokens(context.theme.tokens);
    if (context.theme.mode === appearance) return;
    appearance = context.theme.mode;
    appearanceListeners.forEach(listener => listener(appearance));
  });
  async function bridge<T>(path: string, body: unknown): Promise<T> {
    const text = JSON.stringify(body);
    if (text.length > BRIDGE_BODY_MAX) throw new CallError(`This request is too large for the OpenChamber bridge (${text.length} characters, limit ${BRIDGE_BODY_MAX}). Send less data at once.`, 413);
    const response = await host.serviceRequest({ method: 'POST', path, body: text });
    return checked<T>(parse(response.body, response.status), response.status);
  }
  return {
    mode: 'openchamber', frameMode: 'srcdoc',
    async call<T>(path: string, body?: unknown) {
      if (!key) throw new Error('Waiting for a Canvas-enabled conversation.');
      return bridge<T>('/request', { key, path, body });
    },
    async load<T>(k: string) { return ((await host.storage.get(k)) ?? null) as T | null; },
    async save(k, value) { await host.storage.set(k, JSON.parse(JSON.stringify(value ?? null))); },
    loadLibrary: libraryCache(async name => {
      // The package's own copy is cheapest; an opaque-origin frame may be refused it, so the host service is the fallback.
      try {
        const response = await fetch(`./lib/${encodeURIComponent(name)}.js`);
        if (response.ok && !(response.headers.get('content-type') || '').includes('text/html')) return await response.text();
      } catch {}
      const response = await host.serviceRequest({ method: 'GET', path: `/lib/${encodeURIComponent(name)}` });
      if (response.status !== 200) {
        let message = '';
        try { message = JSON.parse(response.body).error; } catch {}
        throw new Error(message || `The ${name} library is unavailable (${response.status}).`);
      }
      return response.body;
    }),
    open(url) { void host.openUrl(url).catch(() => {}); },
    badge(count) { void host.setBadge(count || null).catch(() => {}); },
    appearance: () => appearance,
    onAppearance(cb) { appearanceListeners.add(cb); return () => { appearanceListeners.delete(cb); }; },
    onContext(cb) {
      let current: string | undefined, retry: ReturnType<typeof setTimeout> | undefined;
      let directory: string | null = null, sessionId: string | null = null;
      function changed() {
        const identity = `${directory}\0${sessionId}`;
        if (identity === current) return;
        current = identity; key = ''; const version = ++generation; cb({ ready: false });
        clearTimeout(retry);
        const targetDirectory = directory, targetSession = sessionId;
        async function connect() {
          if (!targetDirectory || !targetSession) { cb({ ready: false, error: 'Open a conversation to see its Canvas views.' }); return; }
          try {
            const result = await bridge<{ key: string }>('/connect', { directory: targetDirectory, sessionId: targetSession });
            if (version !== generation) return;
            key = result.key; cb({ ready: true });
          } catch (e) {
            if (version !== generation) return;
            cb({ ready: false, error: (e as Error).message }); retry = setTimeout(connect, 3000);
          }
        }
        void connect();
      }
      // `ready` fires the directory and session listeners in the same turn; settle once both have landed.
      const unsubscribers = [
        host.onReady(context => { directory = context.directory; sessionId = context.session?.id ?? null; changed(); }),
        host.onDirectory(value => { directory = value; queueMicrotask(changed); }),
        host.onSession(value => { sessionId = value?.id ?? null; queueMicrotask(changed); }),
      ];
      return () => { generation++; key = ''; clearTimeout(retry); unsubscribers.forEach(fn => fn()); };
    },
  };
}
