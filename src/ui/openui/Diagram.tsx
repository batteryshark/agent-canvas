import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { labelText, layoutDiagram, type DiagramDirection, type DiagramEdgeData, type DiagramNodeData } from './diagram-layout';

const TONES = 6;
/** A graph slightly wider than its container shrinks to fit; anything wider scrolls instead of becoming unreadable. */
const MIN_FIT = 0.72;

/** Child elements arrive as parsed OpenUI elements ({ props }); tolerate plain objects too. */
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const props = (value as { props?: unknown }).props;
  return (props && typeof props === 'object' ? props : value) as Record<string, unknown>;
}
const text = (value: unknown) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

export function readDiagram(props: { nodes?: unknown; edges?: unknown; direction?: unknown }) {
  const nodes: DiagramNodeData[] = (Array.isArray(props.nodes) ? props.nodes : []).map(fields)
    .flatMap(n => { const id = text(n.id); return id ? [{ id, label: text(n.label) ?? id, group: text(n.group) || undefined, detail: text(n.detail) || undefined }] : []; });
  const edges: DiagramEdgeData[] = (Array.isArray(props.edges) ? props.edges : []).map(fields)
    .flatMap(e => { const from = text(e.from), to = text(e.to); return from && to ? [{ from, to, label: text(e.label) || undefined }] : []; });
  const direction: DiagramDirection = props.direction === 'down' ? 'down' : 'right';
  return { nodes, edges, direction };
}

export function DiagramView({ nodes, edges, direction }: { nodes: DiagramNodeData[]; edges: DiagramEdgeData[]; direction: DiagramDirection }) {
  const key = JSON.stringify([nodes, edges, direction]);
  // Parsed props are rebuilt on every state change in the view; lay out again only when the graph itself changes.
  const layout = useMemo(() => layoutDiagram(nodes, edges, direction), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selected, setSelected] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null), [room, setRoom] = useState(0);
  // "auto" shrinks a slightly wide graph and scrolls a much wider one; the user can ask for either instead.
  const [zoom, setZoom] = useState<'auto' | 'fit' | 'actual'>('auto');
  const ratio = room ? room / layout.width : 1;
  const fit = ratio >= 1 ? 1 : zoom === 'fit' ? ratio : zoom === 'actual' || ratio < MIN_FIT ? 1 : ratio;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setRoom(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout.width]);
  const marker = `canvas-diagram-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const groups = useMemo(() => [...new Set(layout.nodes.flatMap(n => n.group ? [n.group] : []))], [layout]);
  const tone = (group?: string) => group ? `tone-${groups.indexOf(group) % TONES}` : 'tone-none';
  const byId = useMemo(() => new Map(layout.nodes.map(n => [n.id, n])), [layout]);
  const current = selected ? byId.get(selected) : undefined;
  const incoming = current ? layout.edges.filter(e => e.to === current.id && e.from !== current.id) : [];
  const outgoing = current ? layout.edges.filter(e => e.from === current.id && e.to !== current.id) : [];
  const active = (e: DiagramEdgeData) => !!current && (e.from === current.id || e.to === current.id);
  if (!layout.nodes.length) return <div className="canvas-diagram canvas-diagram-empty">This diagram has no nodes.</div>;
  const connection = (key: number, id: string, label?: string) => {
    const node = byId.get(id);
    return <li key={key}><button type="button" className="canvas-diagram-link" onClick={() => setSelected(id)}>{node?.label ?? id}</button>{label && <span className="canvas-diagram-edge-note"> · {label}</span>}</li>;
  };
  return <div className={`canvas-diagram${current ? ' has-selection' : ''}`} data-direction={direction}>
    {ratio < 1 && <div className="canvas-diagram-tools">
      <span>{fit < 1 ? `Shown at ${Math.round(fit * 100)}% to fit.` : 'Wider than this view: scroll sideways to see all of it.'}</span>
      <button type="button" onClick={() => setZoom(fit < 1 ? 'actual' : 'fit')}>{fit < 1 ? 'Actual size' : 'Fit to width'}</button>
    </div>}
    <div ref={scroller} className="canvas-diagram-scroll" role="group" aria-label={`Diagram with ${layout.nodes.length} nodes. Select a node for details.`}>
      <div className="canvas-diagram-plane" style={{ width: layout.width, height: layout.height, zoom: fit === 1 ? undefined : fit }}>
        <svg className="canvas-diagram-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          <defs>
            {['', '-active'].map(suffix => <marker key={suffix} id={marker + suffix} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={`canvas-diagram-arrowhead${suffix}`}/>
            </marker>)}
          </defs>
          {layout.edges.map(e => <path key={e.index} d={e.path} className={`canvas-diagram-edge${active(e) ? ' active' : ''}`} markerEnd={`url(#${marker}${active(e) ? '-active' : ''})`}/>)}
          {layout.edges.map(e => e.label ? <text key={`l${e.index}`} x={e.labelAt.x} y={e.labelAt.y} dy="0.35em" textAnchor="middle" className={`canvas-diagram-edge-label${active(e) ? ' active' : ''}`}>
            {labelText(e.label)}<title>{e.label}</title>
          </text> : null)}
        </svg>
        {layout.nodes.map(n => <button key={n.id} type="button" className={`canvas-diagram-node ${tone(n.group)}${n.id === selected ? ' selected' : ''}`}
          style={{ left: n.x, top: n.y, width: layout.node.width, height: layout.node.height }}
          aria-pressed={n.id === selected} title={n.label} onClick={() => setSelected(n.id === selected ? null : n.id)}>
          {n.group && <span className="canvas-diagram-group">{n.group}</span>}
          <span className="canvas-diagram-label">{n.label}</span>
        </button>)}
      </div>
    </div>
    {groups.length > 0 && <ul className="canvas-diagram-legend" aria-label="Groups">
      {groups.map(g => <li key={g} className={tone(g)}><span className="canvas-diagram-swatch" aria-hidden="true"/>{g}</li>)}
    </ul>}
    <div className="canvas-diagram-detail" aria-live="polite">
      {current ? <>
        <div className="canvas-diagram-detail-head"><strong>{current.label}</strong>{current.group && <span className={`canvas-diagram-chip ${tone(current.group)}`}>{current.group}</span>}</div>
        {current.detail ? <p className="canvas-diagram-detail-text">{current.detail}</p> : <p className="canvas-diagram-muted">No further detail for this node.</p>}
        {(incoming.length > 0 || outgoing.length > 0) && <div className="canvas-diagram-connections">
          {incoming.length > 0 && <div><span className="canvas-diagram-muted">From</span><ul>{incoming.map(e => connection(e.index, e.from, e.label))}</ul></div>}
          {outgoing.length > 0 && <div><span className="canvas-diagram-muted">To</span><ul>{outgoing.map(e => connection(e.index, e.to, e.label))}</ul></div>}
        </div>}
      </> : <p className="canvas-diagram-muted">Select a node to see its details.</p>}
    </div>
  </div>;
}
