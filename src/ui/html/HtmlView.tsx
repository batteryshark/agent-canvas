// Hosts one HTML revision in a sandboxed frame and is the only thing the frame can talk to.
// Every message must come from this frame's own window; replies go back to that window only.
import { useEffect, useRef, useState, type JSX } from 'react';
import { LIMITS } from '../../shared/contract';
import { HTML_LIBRARIES, libraryNames } from '../../shared/html-check';
import { buildDocument, themeVariables, type Appearance } from './document';

const CHANNEL = 'agent-canvas';
const MIN_HEIGHT = 240;
const FRAME_URL = '/frame';
export const SEND_DISABLED_REASON = 'Sending is turned off for this view: it shows an older revision, or Agent Canvas is not connected to the conversation.';
export const GESTURE_REASON = 'Input is sent only from a click or key press in the page, not on load or from a timer.';
export const LEFT_NOTICE = 'This page tried to navigate away from the canvas and was stopped.';
export const LEFT_ERROR = 'The page tried to navigate its own frame to another document (by setting location, following a link or a meta refresh), so Canvas stopped it and hid the page. A Canvas page cannot load another document: open web pages with canvas.openLink(url) from a click, and show other screens by changing the page\'s own content, keeping what should survive a reload in canvas.state.';

/**
 * Whether the user is acting in this frame right now, judged in the app's own window, which the page cannot reach:
 * a recent click or key press (transient activation) that landed in the frame, not in the rest of the app.
 * Browsers without the User Activation API fall back to focus alone.
 */
export function userActingIn(frame: HTMLIFrameElement | null): boolean {
  if (!frame || document.activeElement !== frame) return false;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return activation ? activation.isActive : true;
}

type Props = {
  source: string; view: { id: string; revision: number; title: string };
  appearance: Appearance; disabled: boolean; frameMode: 'srcdoc' | 'shell';
  loadLibrary(name: string): Promise<string>;
  initialState: unknown | null; onState(state: unknown): void;
  onSend(action: string, data: unknown): Promise<void>; onOpenUrl(url: string): void; onErrors(errors: string[]): void;
  fill?: boolean;
};
type Built = { key: number; viewKey: string; html?: string; error?: string };

let builds = 0;
const jsonLength = (value: unknown) => { try { return JSON.stringify(value ?? null).length; } catch { return Infinity; } };

export function HtmlView(p: Props): JSX.Element {
  const latest = useRef(p);
  latest.current = p;
  const frame = useRef<HTMLIFrameElement>(null);
  const built = useRef<Built | null>(null);
  const errors = useRef<string[]>([]);
  // The build whose frame tried to leave its page: it stays hidden until the user asks for the page again.
  const leftKey = useRef<number | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // The newest draft the page posted; a rebuild of the same revision restores it rather than the older prop.
  const draft = useRef<{ viewKey: string; state: unknown } | null>(null);
  const [doc, setDoc] = useState<Built | null>(null);
  const [contentHeight, setContentHeight] = useState(MIN_HEIGHT);
  const [viewport, setViewport] = useState(() => typeof window === 'undefined' ? 800 : window.innerHeight);
  const viewKey = `${p.view.id}:${p.view.revision}`;
  const report = (message: string) => {
    if (!message || errors.current.includes(message) || errors.current.length >= 20) return;
    errors.current = [...errors.current, message];
    latest.current.onErrors(errors.current);
  };

  useEffect(() => {
    let live = true;
    const key = ++builds;
    built.current = null; errors.current = []; setDoc(null);
    const names = libraryNames(p.source);
    const unknown = names.filter(name => !HTML_LIBRARIES[name]);
    Promise.resolve().then(async () => {
      if (unknown.length) throw new Error(`Unknown bundled library: ${unknown.map(n => `canvas:lib/${n}`).join(', ')}.`);
      const libraries: Record<string, string> = {};
      await Promise.all(names.map(async name => {
        try { libraries[name] = await latest.current.loadLibrary(name); }
        catch (error) { throw new Error(`The bundled library canvas:lib/${name} could not be loaded: ${(error as Error).message}`); }
      }));
      const { appearance, initialState, view } = latest.current;
      const state = draft.current?.viewKey === viewKey ? draft.current.state : initialState;
      return buildDocument(p.source, { view, appearance, variables: themeVariables(appearance), libraries, initialState: state });
    }).then(html => {
      if (!live) return;
      built.current = { key, viewKey, html };
      setDoc(built.current);
    }, (error: Error) => {
      if (!live) return;
      built.current = { key, viewKey, error: error.message };
      setDoc(built.current);
      // The agent must learn why its page did not show, just as it learns about errors inside a page.
      errors.current = [`This page could not be shown: ${error.message}`.slice(0, 1000)];
      latest.current.onErrors(errors.current);
    });
    return () => { live = false; };
  }, [p.source, p.view.id, p.view.revision, p.view.title, attempt]);

  useEffect(() => {
    const post = (target: Window, message: Record<string, unknown>) => target.postMessage({ channel: CHANNEL, v: 1, ...message }, '*');
    const theme = (target: Window) => {
      const appearance = latest.current.appearance;
      post(target, { type: 'theme', appearance, variables: themeVariables(appearance) });
    };
    async function send(target: Window, m: Record<string, unknown>) {
      const id = typeof m.id === 'string' ? m.id.slice(0, 120) : '';
      if (!id) return;
      const ack = (ok: boolean, error?: string) => post(target, { type: 'ack', id, ok, ...(error ? { error } : {}) });
      const action = typeof m.action === 'string' ? m.action.trim() : '';
      const data = m.data === undefined ? null : m.data;
      if (!action) return ack(false, 'canvas.send needs an action label.');
      if (action.length > LIMITS.action) return ack(false, `The action label is longer than ${LIMITS.action} characters.`);
      const size = jsonLength(data);
      if (size > LIMITS.dataBytes) return ack(false, size === Infinity ? 'The data is not JSON.' : `The data is ${size} characters as JSON; the limit is ${LIMITS.dataBytes}.`);
      const current = latest.current;
      if (current.disabled) return ack(false, SEND_DISABLED_REASON);
      // A page could post this message itself on load; only a gesture this window saw makes it the user's input.
      if (!userActingIn(frame.current)) return ack(false, GESTURE_REASON);
      try { await current.onSend(action, data); ack(true); }
      catch (error) { ack(false, error instanceof Error ? error.message : String(error)); }
    }
    function onMessage(event: MessageEvent) {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const m = event.data as Record<string, unknown> | null;
      if (!m || typeof m !== 'object' || m.channel !== CHANNEL || m.v !== 1) return;
      const p = latest.current, current = built.current;
      switch (m.type) {
        case 'ready':
          // The shell announces itself before any page exists; the bridge announces the page.
          if (m.shell === true) { if (p.frameMode === 'shell' && current?.html) post(target, { type: 'render', html: current.html }); }
          else theme(target);
          return;
        case 'send': void send(target, m); return;
        case 'state': {
          const state = m.state === undefined ? null : m.state;
          if (!current || jsonLength(state) > LIMITS.draftBytes) return;
          draft.current = { viewKey: current.viewKey, state };
          p.onState(state);
          return;
        }
        case 'size':
          if (typeof m.height === 'number' && Number.isFinite(m.height)) setContentHeight(Math.max(0, Math.ceil(m.height)));
          return;
        case 'link': {
          if (typeof m.url !== 'string') return;
          let url: URL;
          try { url = new URL(m.url); } catch { return; }
          // Opening a link sends a request from the user's real browser and takes focus: never without their click.
          if ((url.protocol === 'http:' || url.protocol === 'https:') && userActingIn(frame.current)) p.onOpenUrl(url.href);
          return;
        }
        case 'error': report(typeof m.message === 'string' ? m.message.trim().slice(0, 1000) : ''); return;
      }
    }
    // A page that navigates its own frame is refused by this document's frame-src, and Chrome puts its error page in the
    // frame. The page cannot be held in place from its own realm, so this window, whose policy saw the refusal, hides
    // the frame and tells the agent. It never reloads the page itself: a page that navigates on load would loop.
    // This document embeds no other frame, so a frame-src refusal here is the page's.
    function onViolation(event: SecurityPolicyViolationEvent) {
      const current = built.current;
      if (!frame.current || !current?.html || leftKey.current === current.key) return;
      if (event.effectiveDirective !== 'frame-src' && event.effectiveDirective !== 'child-src') return;
      leftKey.current = current.key;
      setLeft(current.key);
      report(LEFT_ERROR);
    }
    const onResize = () => setViewport(window.innerHeight);
    window.addEventListener('message', onMessage);
    window.addEventListener('resize', onResize);
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => {
      window.removeEventListener('message', onMessage); window.removeEventListener('resize', onResize);
      document.removeEventListener('securitypolicyviolation', onViolation);
    };
  }, []);

  // Theme changes restyle the running page through the bridge; the page is never reloaded for them.
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (target && built.current?.html) target.postMessage({ channel: CHANNEL, v: 1, type: 'theme', appearance: p.appearance, variables: themeVariables(p.appearance) }, '*');
  }, [p.appearance]);

  const maxHeight = Math.max(MIN_HEIGHT, Math.round(viewport * 0.85));
  const height = Math.min(Math.max(contentHeight, MIN_HEIGHT), maxHeight);
  const fill = !!p.fill;
  return <div className="canvas-html" style={{ position: 'relative', width: '100%', ...(fill ? { height: '100%' } : {}) }}>
    {doc?.error ? <div className="canvas-html-error" role="alert">This page could not be shown. {doc.error}</div>
      : doc && left === doc.key ? <div className="canvas-html-error" role="alert">
        <span>{LEFT_NOTICE}</span><button type="button" onClick={() => setAttempt(n => n + 1)}>Show the page again</button>
      </div>
      : doc?.html ? <iframe
        key={`${doc.key}:${p.frameMode}`}
        ref={frame}
        title={`Canvas page: ${p.view.title}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        {...(p.frameMode === 'shell' ? { src: FRAME_URL } : { srcDoc: doc.html })}
        style={{ display: 'block', width: '100%', height: fill ? '100%' : height, border: 0, colorScheme: p.appearance, background: 'transparent' }}
      />
      : <div className="canvas-html-loading" aria-busy="true" style={{ height: fill ? '100%' : height }} />}
  </div>;
}
