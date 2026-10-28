// First import: it switches zod's JIT off before the contract or OpenUI build a schema.
import { CallError, createTransport, type Appearance, type Transport } from './transport';
// Before OpenUIView: esbuild keeps the last copy of a CSS file imported twice, so OpenUI's base sheet lands after
// the shell sheet and before the OpenUI view's own overrides.
import './style.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LIMITS, type Content, type DeliveryStatus, type Interaction, type Revision, type RevisionInfo, type Snapshot, type Submission, type ViewSummary } from '../shared/contract';
import { OpenUIView } from './openui/OpenUIView';
import { HtmlView } from './html/HtmlView';
import { Drafts } from './drafts';

/** The view revision a piece of rendered content belongs to. Every send, draft and report is bound to it. */
type Target = { draftKey: string; sessionKey: string; viewId: string; revision: number; title: string };

const POLL_MS = 1500, STATE_SAVE_DELAY = 150;
const STATUS_LABEL: Record<DeliveryStatus, string> = { queued: 'waiting', sending: 'sending', delivered: 'delivered', unsent: 'unsent', uncertain: 'uncertain' };
const CHANGED = 'The conversation changed before your input was sent. Your draft is saved in its original view.';

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID needs a secure context; an OpenChamber reached over plain HTTP is not one.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** OpenChamber storage keys are at most 128 characters. */
function draftKeyFor(session: string, view: string, revision: number) {
  const key = `draft:${session}:${view}:${revision}`;
  return key.length <= 128 ? key : `draft:${session.slice(-40)}:${view}:${revision}`;
}
const viewLink = (url: string, id?: string) => id ? `${url}${url.includes('#') ? '&' : '#'}view=${encodeURIComponent(id)}` : url;
const sameData = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const viewLabel = (v: ViewSummary) => v.pinnedName || v.revision.title;
const shownHere = (s: Snapshot, id: string) => s.session.views[id] !== undefined;
/**
 * The view to open: the one asked for, else this conversation's newest. A project view is never opened on its own:
 * another conversation wrote it, so it waits for the user to choose it.
 */
function pickView(s: Snapshot, wanted: string) {
  if (wanted && s.views.some(v => v.id === wanted)) return wanted;
  return s.views.find(v => shownHere(s, v.id))?.id ?? '';
}
const info = ({ content, ...revision }: Revision): RevisionInfo => ({ ...revision, format: content.format });
/** A failure the service answered: definite. Anything else (no answer, a timeout, a host or bridge failure) may have been admitted. */
const answered = (e: unknown) => e instanceof CallError && e.status >= 400 && e.status < 500;
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
/** A view's time in the list and header: the time today, else the date. */
function when(iso: string) {
  const d = new Date(iso), now = new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
const icon = (d: string) => <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const ICONS = {
  pin: icon('M10.5 2 14 5.5l-2.5 1-2.5 2.5.5 3L8 13.5 2.5 8 4 6.5l3 .5L9.5 4.5zM5 11l-3 3'),
  pinned: <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 2 14 5.5l-2.5 1-2.5 2.5.5 3L8 13.5 2.5 8 4 6.5l3 .5L9.5 4.5zM5 11l-3 3" /></svg>,
  open: icon('M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7'),
  expand: icon('M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10'),
  shrink: icon('M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5'),
};

function App({ transport: t }: { transport: Transport }) {
  const initialView = useRef(new URLSearchParams(location.hash.slice(1)).get('view') || '');
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [selected, setSelected] = useState('');
  // Another revision the user chose to look at, while the conversation's own revision was `base`.
  const [override, setOverride] = useState<{ viewId: string; base: number; revision: RevisionInfo }>();
  // Sources by view and revision. Revisions never change, so each is fetched once.
  const [sources, setSources] = useState<Record<string, Content>>({});
  const fetching = useRef(new Set<string>());
  const [error, setError] = useState(''), [connectionError, setConnectionError] = useState(''), [ready, setReady] = useState(false);
  const [contextVersion, setContextVersion] = useState(0);
  const [note, setNote] = useState(''), [initialState, setInitialState] = useState<unknown>(null), [loadedDraft, setLoadedDraft] = useState('');
  const [pending, setPending] = useState<Submission>();
  const [sending, setSending] = useState<string>();
  const [pinName, setPinName] = useState(''), [pinning, setPinning] = useState(false);
  const [full, setFull] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(() => t.appearance());
  const [, setReportVersion] = useState(0);
  const generation = useRef(0), draftKey = useRef(''), draftLoad = useRef(0), revisionRequest = useRef(0), sendingRef = useRef(false);
  // An input the page was told could not be confirmed: the same input sent again reuses its id, so it is admitted once.
  const unconfirmed = useRef<Submission | undefined>(undefined);
  const nav = useRef<HTMLElement>(null);
  const reported = useRef(new Map<string, string[]>());
  const badge = useRef(-1);
  const drafts = useMemo(() => new Drafts(t, text => setError(text)), [t]);

  const view = snapshot?.views.find(v => v.id === selected);
  // Once the conversation moves to a new revision of its own (the agent answered), the view follows it.
  const revision = override && view && override.viewId === view.id && override.base === view.revision.number ? override.revision : view?.revision;
  const contentKey = view && revision ? `${view.id}:${revision.number}` : '';
  const source = contentKey ? sources[contentKey] : undefined;
  const stale = !!view && !!revision && revision.number !== view.latest;
  const key = snapshot && view && revision ? draftKeyFor(snapshot.session.key, view.id, revision.number) : '';
  const conversationViews = snapshot ? snapshot.views.filter(v => shownHere(snapshot, v.id)) : [];
  const projectViews = snapshot ? snapshot.views.filter(v => v.pinnedName && !shownHere(snapshot, v.id)) : [];
  const deliveries = snapshot && view ? snapshot.interactions.filter(a => a.viewId === view.id) : [];
  const disabled = !!sending || stale || !ready;
  const live = useRef({ snapshot, view, ready, note });
  live.current = { snapshot, view, ready, note };

  async function refresh(version = generation.current) {
    const s = await t.call<Snapshot>('/api/snapshot');
    if (version !== generation.current) return;
    setSnapshot(s);
    setSelected(current => current || pickView(s, t.mode === 'browser' ? initialView.current : ''));
    setConnectionError('');
    const count = s.views.filter(v => shownHere(s, v.id)).length;
    if (count !== badge.current) { badge.current = count; t.badge(count); }
  }

  useEffect(() => t.onContext(state => {
    generation.current++; setContextVersion(generation.current); setReady(state.ready);
    setSnapshot(undefined); setOverride(undefined); setSelected(''); setNote(''); setPending(undefined); setPinning(false);
    sendingRef.current = false; setSending(undefined); revisionRequest.current++;
    setError(''); setConnectionError(state.error || '');
  }), [t]);

  useEffect(() => {
    if (!ready) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const version = generation.current;
    // One request at a time: a slow host bridge must not pile up snapshots.
    const poll = async () => {
      try { await refresh(version); } catch (e) { if (active && version === generation.current) setConnectionError(message(e)); }
      if (active) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [ready, contextVersion, t]);

  useEffect(() => { const off = t.onAppearance(setAppearance); setAppearance(t.appearance()); return off; }, [t]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = appearance; root.setAttribute('data-openui-theme', appearance); root.style.colorScheme = appearance;
  }, [appearance]);
  useEffect(() => {
    // While the page is hidden or going away, drafts are written at once: a delayed write may never run.
    const hide = () => { void drafts.setHidden(true); }, show = () => { void drafts.setHidden(false); };
    const visibility = () => { void drafts.setHidden(document.visibilityState === 'hidden'); };
    addEventListener('pagehide', hide); addEventListener('pageshow', show); document.addEventListener('visibilitychange', visibility);
    return () => { removeEventListener('pagehide', hide); removeEventListener('pageshow', show); document.removeEventListener('visibilitychange', visibility); };
  }, [drafts]);
  useEffect(() => {
    // On a phone the views strip scrolls sideways; keep the open view in it.
    const strip = nav.current, item = strip?.querySelector<HTMLElement>('.nav-item.active');
    if (!strip || !item || strip.scrollWidth <= strip.clientWidth) return;
    const outer = strip.getBoundingClientRect(), inner = item.getBoundingClientRect();
    if (inner.left < outer.left || inner.right > outer.right) strip.scrollLeft += inner.left - outer.left - (outer.width - inner.width) / 2;
  }, [view?.id, snapshot?.views.length]);
  useEffect(() => {
    if (!contentKey || source || fetching.current.has(contentKey) || !view || !revision) return;
    const key = contentKey, version = generation.current;
    fetching.current.add(key);
    t.call<Revision>(`/api/revision?id=${encodeURIComponent(view.id)}&revision=${revision.number}`).then(r => {
      if (version === generation.current) setSources(all => ({ ...all, [key]: r.content }));
    }, e => { if (version === generation.current) setError(`This view could not be loaded: ${message(e)}`); })
      .finally(() => fetching.current.delete(key));
  }, [contentKey, source, contextVersion, t]);
  useEffect(() => {
    if (t.mode !== 'browser' || !view) return;
    // Keep the open view in the address so a reload returns to it (and to its draft).
    const hash = `#view=${encodeURIComponent(view.id)}`;
    if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
  }, [t, view?.id]);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  }, [full]);

  useLayoutEffect(() => {
    draftKey.current = key; setNote(''); setInitialState(null); setPending(undefined); setLoadedDraft('');
    if (!key) return;
    const load = ++draftLoad.current;
    drafts.read(key).then(draft => {
      if (draftKey.current !== key || draftLoad.current !== load) return;
      setNote(draft.note); setInitialState(draft.state); setPending(draft.pending); setLoadedDraft(key);
    }, e => {
      if (draftKey.current !== key || draftLoad.current !== load) return;
      setError(`Draft could not be loaded: ${message(e)}`); setLoadedDraft(key);
    });
  }, [key, drafts]);

  // An input the service already holds needs no local copy.
  const accepted = !!pending && !!snapshot?.interactions.some(a => a.id === pending.id);
  useEffect(() => {
    if (!accepted || !pending || !key) return;
    void drafts.clearPending(key, pending).catch(() => {});
    setPending(undefined);
  }, [accepted, pending, key, drafts]);

  function changeNote(value: string) {
    setNote(value);
    const k = draftKey.current;
    if (k) drafts.update(k, d => ({ ...d, note: value })).catch(e => { if (draftKey.current === k) setError(`Draft could not be saved: ${message(e)}`); });
  }

  function submit(target: Target, action: string, data: unknown): Promise<void> {
    const fail = (text: string) => { setError(text); return Promise.reject(new Error(text)); };
    const now = live.current;
    if (!now.ready || !now.snapshot || now.snapshot.session.key !== target.sessionKey) return fail('The conversation is still connecting. Try again in a moment.');
    if (!now.view || now.view.id !== target.viewId) return fail('This view is no longer open.');
    if (now.view.latest !== target.revision) return fail(`A newer revision (${now.view.latest}) of this view exists. Review it before sending.`);
    const label = (action || '').trim().slice(0, LIMITS.action) || 'Continue';
    const payload = data === undefined ? null : data;
    let size: number;
    try { size = JSON.stringify(payload).length; } catch (e) { return fail(`This input cannot be sent: ${message(e)}`); }
    if (size > LIMITS.dataBytes) return fail(`This input is too large to send (${size} characters, limit ${LIMITS.dataBytes}).`);
    const notes = now.note.trim();
    const previous = drafts.peek(target.draftKey).pending ?? unconfirmed.current;
    // Retrying the same input reuses its id, so the service admits it at most once.
    const same = previous && previous.sessionKey === target.sessionKey && previous.viewId === target.viewId && previous.revision === target.revision && previous.action === label && previous.notes === notes && sameData(previous.data, payload);
    return deliver(target, { id: same ? previous.id : uuid(), sessionKey: target.sessionKey, viewId: target.viewId, revision: target.revision, action: label, data: payload, notes });
  }

  async function deliver(target: Target, input: Submission) {
    if (sendingRef.current) { const text = 'Your previous input is still being sent.'; setError(text); throw new Error(text); }
    const version = generation.current;
    sendingRef.current = true; setSending(input.action); setError('');
    try {
      let saveProblem = '';
      try { await drafts.update(target.draftKey, d => ({ ...d, pending: input })); } catch (e) { saveProblem = message(e); }
      if (version !== generation.current) { setError(CHANGED); throw new Error(CHANGED); }
      if (draftKey.current === target.draftKey) setPending(input);
      try { await t.call<Interaction>('/api/submit', input); }
      catch (e) {
        if (answered(e)) throw e;
        // The service may have admitted it before the answer was lost. Submitting the same id again is safe: it is
        // admitted at most once, and the answer says whether it was.
        await new Promise(r => setTimeout(r, 400));
        if (version !== generation.current) { setError(CHANGED); throw new Error(CHANGED); }
        try { await t.call<Interaction>('/api/submit', input); }
        catch (again) {
          if (answered(again)) throw again;
          unconfirmed.current = input;
          throw new Error(`Agent Canvas could not confirm this input (${message(again)}); it may have been received. Check the list below before sending it again.`);
        }
      }
      unconfirmed.current = undefined;
      await drafts.clearPending(target.draftKey, input).catch(() => {});
      if (version !== generation.current) return;
      if (draftKey.current === target.draftKey) { setPending(undefined); setNote(current => current.trim() === input.notes ? '' : current); }
      if (saveProblem) setError(`Sent, but the draft could not be saved: ${saveProblem}`);
      await refresh(version).catch(() => {});
    } catch (e) {
      const text = message(e);
      if (text !== CHANGED && version === generation.current) setError(`${text} Your input is kept in this view.`);
      throw e;
    } finally {
      if (version === generation.current) { sendingRef.current = false; setSending(undefined); }
    }
  }

  function saveState(target: Target, state: unknown) {
    drafts.update(target.draftKey, d => ({ ...d, state }), STATE_SAVE_DELAY).catch(() => {});
  }

  function reportErrors(target: Target, errors: string[]) {
    const clean = errors.map(e => String(e).slice(0, 1000)).filter(Boolean);
    if (!clean.length) return;
    const id = `${target.sessionKey}:${target.viewId}:${target.revision}`;
    const previous = reported.current.get(id) ?? [];
    // A report replaces the revision's errors, so send the accumulated set, and only when it grows.
    const merged = [...new Set([...previous, ...clean])].slice(0, 20);
    if (merged.length === previous.length) return;
    reported.current.set(id, merged); setReportVersion(n => n + 1);
    t.call('/api/report', { viewId: target.viewId, revision: target.revision, errors: merged }).catch(() => {});
  }

  function openLink(url: string) { if (/^https?:\/\//i.test(url)) t.open(url); }

  async function retry(id: string) {
    const version = generation.current;
    try { await t.call('/api/retry', { id }); if (version === generation.current) await refresh(version); }
    catch (e) { if (version === generation.current) setError(message(e)); }
  }

  async function pin() {
    if (!view || !pinName.trim()) return;
    const version = generation.current;
    try {
      await t.call('/api/pin', { viewId: view.id, name: pinName.trim(), expectedRevision: view.latest });
      if (version !== generation.current) return;
      setPinning(false); await refresh(version);
    } catch (e) { if (version === generation.current) setError(message(e)); }
  }

  async function selectRevision(n: number) {
    if (!view) return;
    const id = view.id, request = ++revisionRequest.current, version = generation.current;
    if (n === view.revision.number) { setOverride(undefined); return; }
    const base = view.revision.number;
    try {
      const r = await t.call<Revision>(`/api/revision?id=${encodeURIComponent(id)}&revision=${n}`);
      if (version !== generation.current || request !== revisionRequest.current) return;
      setSources(all => ({ ...all, [`${id}:${n}`]: r.content }));
      setOverride({ viewId: id, base, revision: info(r) });
    } catch (e) { if (version === generation.current) setError(message(e)); }
  }

  function selectView(id: string) { revisionRequest.current++; setSelected(id); setOverride(undefined); setPinning(false); }

  const target = useMemo<Target | undefined>(() => snapshot && view && revision && key
    ? { draftKey: key, sessionKey: snapshot.session.key, viewId: view.id, revision: revision.number, title: revision.title } : undefined,
  // key already encodes the session, view and revision.
  [key, revision?.title]);
  const actions = useRef({ submit, saveState, reportErrors, openLink });
  actions.current = { submit, saveState, reportErrors, openLink };
  // Stable per revision, so polling never hands the content new callbacks.
  const handlers = useMemo(() => target && {
    onState: (state: unknown) => actions.current.saveState(target, state),
    onSend: (action: string, data: unknown) => actions.current.submit(target, action, data),
    onSendQuietly: (action: string, data: unknown) => { actions.current.submit(target, action, data).catch(() => {}); },
    onErrors: (errors: string[]) => actions.current.reportErrors(target, errors),
    onOpenUrl: (url: string) => actions.current.openLink(url),
    view: { id: target.viewId, revision: target.revision, title: target.title },
  }, [target]);
  const renderErrors = target ? reported.current.get(`${target.sessionKey}:${target.viewId}:${target.revision}`) ?? [] : [];

  let content: ReactElement | null = null;
  if (revision && handlers && loadedDraft === key && source) {
    content = source.format === 'openui'
      ? <OpenUIView key={key} source={source.source} appearance={appearance} disabled={disabled} initialState={initialState}
          onState={handlers.onState} onSend={handlers.onSendQuietly} onOpenUrl={handlers.onOpenUrl} onErrors={handlers.onErrors} />
      : <HtmlView key={key} source={source.source} view={handlers.view} appearance={appearance} disabled={disabled} frameMode={t.frameMode}
          loadLibrary={t.loadLibrary} initialState={initialState} onState={handlers.onState} onSend={handlers.onSend} onOpenUrl={handlers.onOpenUrl}
          onErrors={handlers.onErrors} fill={full} />;
  }
  const openHere = () => snapshot && t.open(viewLink(snapshot.browserUrl, view?.id));
  // Conversation views first, then project views this conversation never showed.
  const listed = snapshot ? [...conversationViews, ...projectViews] : [];
  const navButton = (v: ViewSummary) => <button type="button" key={v.id} className={`nav-item${view?.id === v.id ? ' active' : ''}`} aria-current={view?.id === v.id ? 'true' : undefined} onClick={() => selectView(v.id)}>
    <span className="nav-label">{viewLabel(v)}</span>
    <small>{v.pinnedName ? 'pinned · ' : ''}<time dateTime={v.revision.createdAt}>{when(v.revision.createdAt)}</time></small>
  </button>;
  const status = snapshot ? (snapshot.connected ? 'Agent connected' : 'Agent offline: saved views remain available') : ready ? 'Connecting…' : 'Not connected';

  return <div className={`shell${full ? ' full' : ''}`}>
    <aside className="sidebar">
      <div className="session-info" title={status}>
        <span className={`status-dot${snapshot?.connected ? ' online' : ''}`} role="img" aria-label={status} />
        <span className="session-title">{snapshot?.session.title || (t.mode === 'openchamber' ? 'Connect a conversation' : 'No conversation')}</span>
      </div>
      <nav aria-label="Saved views" ref={nav}>
        {listed.map(navButton)}
        {snapshot && !listed.length && <p className="nav-empty">No views yet.</p>}
      </nav>
    </aside>
    <main>
      {view && revision && snapshot ? <header className="toolbar">
        <h1 className="view-title" title={revision.summary || undefined}>{viewLabel(view)}</h1>
        <span className="view-meta"><time dateTime={revision.createdAt}>{when(revision.createdAt)}</time>
          {view.history.length > 1 && <select aria-label="Revision" value={revision.number} onChange={e => void selectRevision(Number(e.target.value))}>
            {view.history.map(r => <option value={r.number} key={r.number}>v{r.number}{r.number === view.latest ? ' (latest)' : ''}</option>)}
          </select>}
        </span>
        <div className="toolbar-actions">
          <button type="button" className="icon" aria-label={view.pinnedName ? 'Rename project view' : 'Pin to project'} title={view.pinnedName ? 'Rename project view' : 'Pin to project'} aria-pressed={pinning}
            onClick={() => { setPinName(view.pinnedName || view.revision.title); setPinning(!pinning); }}>{view.pinnedName ? ICONS.pinned : ICONS.pin}</button>
          <button type="button" className="icon" aria-label={t.mode === 'openchamber' ? 'Open in browser' : 'Open viewing link'} title={t.mode === 'openchamber' ? 'Open in browser' : 'Open viewing link'} onClick={openHere}>{ICONS.open}</button>
          <button type="button" className="icon" aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen'} onClick={() => setFull(!full)}>{full ? ICONS.shrink : ICONS.expand}</button>
        </div>
      </header> : null}
      {(error || connectionError) && <div className="banner error" role="alert">
        <span>{[error, connectionError].filter(Boolean).join(' ')}</span>
        {error && <button type="button" onClick={() => setError('')}>Dismiss</button>}
      </div>}
      {pinning && view && <div className="pin-form" role="group" aria-label="Pin project view">
        <input aria-label="Project view name" value={pinName} maxLength={LIMITS.pinnedName} onChange={e => setPinName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void pin(); } if (e.key === 'Escape') setPinning(false); }} autoFocus />
        <button type="button" className="primary" disabled={!pinName.trim()} onClick={() => void pin()}>Save project view</button>
        <button type="button" onClick={() => setPinning(false)}>Cancel</button>
      </div>}
      {view && revision && snapshot ? <article>
        {stale && <div className="banner notice" role="status">
          You are looking at revision {revision.number}. A newer revision ({view.latest}) exists, so sending from this one is paused.
          <button type="button" onClick={() => void selectRevision(view.latest)}>Show revision {view.latest}</button>
        </div>}
        {pending && !accepted && !sending && !stale && handlers && target && <div className="banner notice">
          Your input “{pending.action}” was not confirmed as received.
          <button type="button" onClick={() => { deliver(target, pending).catch(() => {}); }}>Send it again</button>
        </div>}
        <div className={`content-host${disabled ? ' is-disabled' : ''}`} data-canvas-format={revision.format} aria-busy={!!sending}>
          {content ?? <p className="content-loading">Loading view…</p>}
        </div>
        {sending && <p className="sending-line" aria-live="polite">Sending “{sending}” to your agent…</p>}
        {renderErrors.length > 0 && <details className="render-errors">
          <summary>{renderErrors.length === 1 ? 'One problem' : `${renderErrors.length} problems`} while rendering this view. Your agent sees {renderErrors.length === 1 ? 'it' : 'them'} when it reads the view.</summary>
          <ul>{renderErrors.map(e => <li key={e}>{e}</li>)}</ul>
        </details>}
        <textarea className="note" aria-label="Note to the agent" rows={1} value={note} maxLength={LIMITS.notes} disabled={loadedDraft !== key}
          placeholder="Note to the agent, sent with your next input (optional)" onChange={e => changeNote(e.target.value)} />
        {deliveries.length > 0 && <section className="deliveries" aria-label="Sent to your agent">
          {deliveries.slice(-6).reverse().map(a => <div className="delivery" data-status={a.status} key={a.id}>
            <span className="status-pill">{STATUS_LABEL[a.status]}</span>
            <div className="delivery-body">
              <strong>{a.action}</strong> <small>v{a.revision} · <time dateTime={a.updatedAt}>{new Date(a.updatedAt).toLocaleTimeString()}</time></small>
              {a.notes && <q>{a.notes}</q>}
              {a.detail && <p>{a.detail}</p>}
            </div>
            {a.status === 'unsent' && <button type="button" onClick={() => void retry(a.id)}>Retry</button>}
          </div>)}
        </section>}
      </article> : <p className="empty-state">{!ready ? (connectionError ? '' : 'Connecting…') : snapshot ? 'No view open. Views your agent shows appear here.' : 'Connecting…'}</p>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App transport={createTransport()} />);
