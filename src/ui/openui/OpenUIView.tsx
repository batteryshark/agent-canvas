import '@openuidev/react-ui/styles/index.css';
import './openui.css';
import { useCallback, useEffect, useLayoutEffect, useRef, type JSX } from 'react';
import { z } from 'zod';
import { Renderer, type ActionEvent, type OpenUIError } from '@openuidev/react-lang';
import { canvasLibrary } from './library';
import { toSubmission } from './actions';
import { OpenUITheme } from './theme';

// Zod compiles validators with new Function unless told not to; the app CSP forbids eval.
z.config({ jitless: true });

const DRAFT_DELAY = 400;

type Props = {
  source: string; appearance: 'light' | 'dark'; disabled: boolean;
  initialState: unknown | null; onState(state: unknown): void;
  onSend(action: string, data: unknown): void; onOpenUrl(url: string): void; onErrors(errors: string[]): void;
};

const asState = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function describeError(e: OpenUIError) {
  const where = [e.statementId && `statement "${e.statementId}"`, e.component, e.path].filter(Boolean).join(' ');
  return `${where ? `${where}: ` : ''}${e.message}${e.hint ? ` Hint: ${e.hint}` : ''}`.slice(0, 1000);
}

export function OpenUIView(p: Props): JSX.Element {
  const latest = useRef(p);
  latest.current = p;

  useLayoutEffect(() => { document.documentElement.setAttribute('data-openui-theme', p.appearance); }, [p.appearance]);

  // The draft is applied once per source. A draft that loads late still applies until the user touches the view;
  // after that, later initialState props (often our own saved drafts echoing back) must not overwrite live input.
  const hydration = useRef<{ source: string; state?: Record<string, unknown>; touched: boolean; reported?: string }>(undefined);
  if (hydration.current?.source !== p.source) hydration.current = { source: p.source, state: asState(p.initialState), touched: false };
  else if (!hydration.current.touched && asState(p.initialState) && JSON.stringify(p.initialState) !== JSON.stringify(hydration.current.state)) hydration.current.state = asState(p.initialState);
  const touch = useCallback(() => { if (hydration.current) hydration.current.touched = true; }, []);

  const pending = useRef<{ state: unknown; save(state: unknown): void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    next?.save(next.state);
  }, []);
  // Save the draft of the source being left, with the callback that belonged to it.
  useLayoutEffect(() => flush, [p.source, flush]);
  // A reload or a closed tab would drop the debounced draft; hand it over while the page can still store it.
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    addEventListener('pagehide', flush); document.addEventListener('visibilitychange', hidden);
    return () => { removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); };
  }, [flush]);
  const onStateUpdate = useCallback((state: Record<string, unknown>) => {
    pending.current = { state, save: latest.current.onState };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DRAFT_DELAY);
  }, [flush]);

  const onAction = useCallback((event: ActionEvent) => {
    const submission = toSubmission(event);
    if (!submission) return;
    if (submission.kind === 'open') { latest.current.onOpenUrl(submission.url); return; }
    if (latest.current.disabled) return;
    flush();
    latest.current.onSend(submission.action, submission.data);
  }, [flush]);

  // Report each distinct error list once per source; the host forwards it to the service.
  const onError = useCallback((errors: OpenUIError[]) => {
    const messages = errors.filter(e => e.severity !== 'warning').map(describeError).slice(0, 20);
    const key = JSON.stringify(messages), current = hydration.current!;
    if (key === current.reported) return;
    current.reported = key;
    latest.current.onErrors(messages);
  }, []);

  // An image that cannot load leaves a blank area; tell the agent, as HTML views do for blocked resources.
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const failed = new Set<string>();
    const onFailure = (event: Event) => {
      const img = event.target as HTMLImageElement;
      if (img?.tagName !== 'IMG') return;
      const src = (img.currentSrc || img.src || '').slice(0, 200);
      if (!src || failed.has(src) || failed.size >= 5) return;
      failed.add(src);
      latest.current.onErrors([`Image could not load: ${src}. Canvas has no network and cannot read files; use a data: URL or leave the image out.`]);
    };
    el.addEventListener('error', onFailure, true);
    return () => el.removeEventListener('error', onFailure, true);
  }, [p.source]);

  return <div ref={host} className="canvas-openui" data-disabled={p.disabled ? '' : undefined} onPointerDownCapture={touch} onKeyDownCapture={touch} onInputCapture={touch}>
    <OpenUITheme mode={p.appearance}>
      <Renderer response={p.source} library={canvasLibrary} isStreaming={false} onAction={onAction} onStateUpdate={onStateUpdate} initialState={hydration.current.state} onError={onError}/>
    </OpenUITheme>
  </div>;
}
