// Layered (Sugiyama-style) layout for the Canvas Diagram component. Pure and DOM-free,
// so it runs in Node tests as well as the browser.
export type DiagramNodeData = { id: string; label: string; group?: string; detail?: string };
export type DiagramEdgeData = { from: string; to: string; label?: string };
export type DiagramDirection = 'right' | 'down';
export type Point = { x: number; y: number };
export type PlacedNode = DiagramNodeData & { x: number; y: number; layer: number };
export type PlacedEdge = DiagramEdgeData & { index: number; path: string; labelAt: Point };
export type DiagramLayout = { width: number; height: number; node: { width: number; height: number }; nodes: PlacedNode[]; edges: PlacedEdge[] };

const NODE = { width: 176, height: 64 };
const PAD = 36, SIBLING_GAP = 24, DUMMY = 12, DOWN_GAP = 64;
const LABEL = { chars: 24, char: 6.6, height: 16 };

/** Edge labels longer than this are cut with an ellipsis; the full text stays in a tooltip. */
export const labelText = (label: string) => label.length > LABEL.chars ? `${label.slice(0, LABEL.chars - 1)}…` : label;
const labelWidth = (label: string) => labelText(label).length * LABEL.char + 10;
type Box = { x: number; y: number; w: number; h: number };

type Vertex = { layer: number; size: number; pos: number; order: number };
type Link = DiagramEdgeData & { index: number; u: number; v: number };
type Chain = { link: Link; vertices: number[]; reversed: boolean };
type RoutePoint = { d: number; b: number; run?: boolean };

export function layoutDiagram(inputNodes: DiagramNodeData[], inputEdges: DiagramEdgeData[], direction: DiagramDirection = 'right'): DiagramLayout {
  const nodes: DiagramNodeData[] = [], index = new Map<string, number>();
  for (const n of inputNodes) if (!index.has(n.id)) { index.set(n.id, nodes.length); nodes.push(n); }
  const known: Link[] = [];
  inputEdges.forEach((e, i) => {
    const u = index.get(e.from), v = index.get(e.to);
    if (u !== undefined && v !== undefined) known.push({ ...e, index: i, u, v });
  });
  const links = known.filter(e => e.u !== e.v), loops = known.filter(e => e.u === e.v);
  const reversed = breakCycles(nodes.length, links);
  const dag = links.map((e, i) => reversed.has(i) ? { u: e.v, v: e.u } : { u: e.u, v: e.v });
  const layer = assignLayers(nodes.length, dag);

  // Breadth is the axis siblings share: y when layers run left to right, x when they run downward.
  const breadth = direction === 'right' ? NODE.height : NODE.width, depth = direction === 'right' ? NODE.width : NODE.height;
  const vertices: Vertex[] = nodes.map((_, i) => ({ layer: layer[i], size: breadth, pos: 0, order: i }));
  const chains: Chain[] = links.map((link, i) => {
    const { u, v } = dag[i], path = [u];
    for (let l = layer[u] + 1; l < layer[v]; l++) { vertices.push({ layer: l, size: DUMMY, pos: 0, order: vertices.length }); path.push(vertices.length - 1); }
    path.push(v);
    return { link, vertices: path, reversed: reversed.has(i) };
  });
  const layers = orderLayers(vertices, chains);
  placeBreadth(vertices, layers, chains);

  // Side-by-side layers leave room between them for the widest label.
  const widest = Math.max(0, ...known.map(e => e.label ? labelWidth(e.label) : 0));
  const gap = direction === 'right' ? Math.min(200, Math.max(80, widest + 24)) : DOWN_GAP;
  const layerStart = (l: number) => PAD + l * (depth + gap);
  const toPoint = (d: number, b: number): Point => direction === 'right' ? { x: d, y: b } : { x: b, y: d };
  const ports = portOffsets(vertices, chains);
  const routes = chains.map(chain => {
    const pts: RoutePoint[] = [];
    chain.vertices.forEach((id, k) => {
      const v = vertices[id], start = layerStart(v.layer), center = v.pos + v.size / 2;
      if (k === 0) pts.push({ d: start + depth, b: center + (ports.get(`${chain.link.index}:out`) ?? 0) });
      else if (k === chain.vertices.length - 1) pts.push({ d: start, b: center + (ports.get(`${chain.link.index}:in`) ?? 0) });
      else pts.push({ d: start, b: center }, { d: start + depth, b: center, run: true });
    });
    if (chain.reversed) pts.reverse();
    return { link: chain.link, pts };
  });

  const placedEdges: PlacedEdge[] = [], boxes: Box[] = [];
  const free = (b: Box) => !boxes.some(o => Math.abs(o.x - b.x) * 2 < o.w + b.w && Math.abs(o.y - b.y) * 2 < o.h + b.h);
  for (const { from, to, label, index, u } of loops) {
    const v = vertices[u], start = layerStart(v.layer);
    const [x, y] = direction === 'right' ? [start + depth, v.pos] : [v.pos + v.size, start];
    const loop = direction === 'right'
      ? { path: `M${x - 40},${y} C${x - 40},${y - 30} ${x - 12},${y - 30} ${x - 12},${y}`, labelAt: { x: x - 26, y: y - 28 } }
      : { path: `M${x},${y + 14} C${x + 30},${y + 14} ${x + 30},${y + 44} ${x},${y + 44}`, labelAt: { x: x + 22 + (label ? labelWidth(label) / 2 : 0), y: y + 29 } };
    if (label) boxes.push({ ...loop.labelAt, w: labelWidth(label), h: LABEL.height });
    placedEdges.push({ from, to, label, index, ...loop });
  }
  // Points alternate gap, run, gap…, so labels sit between layers, never on a node. Short edges choose first;
  // a label tries the middle gap, then the others, then slides sideways until it no longer covers another label.
  const shifts = direction === 'right' ? [18, -18, 36, -36, 54, -54, 72, -72] : [18, -18];
  for (const { link, pts } of [...routes].sort((a, b) => a.pts.length - b.pts.length)) {
    const { from, to, label, index } = link;
    const gaps = pts.length / 2, middle = Math.floor((gaps - 1) / 2);
    const centers = Array.from({ length: gaps }, (_, g) => g).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b)
      .map(g => toPoint((pts[2 * g].d + pts[2 * g + 1].d) / 2, (pts[2 * g].b + pts[2 * g + 1].b) / 2));
    let labelAt = centers[0];
    if (label) {
      const box = (p: Point): Box => ({ ...p, w: labelWidth(label), h: LABEL.height });
      labelAt = centers.find(p => free(box(p))) ?? shifts.map(dy => ({ x: centers[0].x, y: centers[0].y + dy })).find(p => free(box(p))) ?? centers[0];
      boxes.push(box(labelAt));
    }
    placedEdges.push({ from, to, label, index, path: curve(pts, toPoint), labelAt });
  }
  placedEdges.sort((a, b) => a.index - b.index);

  const placed = nodes.map((n, i) => ({ ...n, ...toPoint(layerStart(layer[i]), vertices[i].pos), layer: layer[i] }));
  const maxDepth = layers.length ? layerStart(layers.length - 1) + depth : 0;
  const maxBreadth = vertices.reduce((m, v) => Math.max(m, v.pos + v.size), 0);
  const size = toPoint(maxDepth + PAD, maxBreadth + PAD);
  return { width: Math.max(size.x, 2 * PAD), height: Math.max(size.y, 2 * PAD), node: { ...NODE }, nodes: placed, edges: placedEdges };
}

/** Marks edges that close a cycle (they reach a node still on the DFS stack), visiting nodes in input order. */
function breakCycles(count: number, links: Array<{ u: number; v: number }>) {
  const out: number[][] = Array.from({ length: count }, () => []);
  links.forEach((e, i) => out[e.u].push(i));
  const state = new Uint8Array(count), reversed = new Set<number>();
  for (let root = 0; root < count; root++) {
    if (state[root]) continue;
    const stack = [{ node: root, next: 0 }];
    state[root] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.next >= out[top.node].length) { state[top.node] = 2; stack.pop(); continue; }
      const edge = out[top.node][top.next++], v = links[edge].v;
      if (state[v] === 1) reversed.add(edge);
      else if (!state[v]) { state[v] = 1; stack.push({ node: v, next: 0 }); }
    }
  }
  return reversed;
}

/** Longest-path layering; then nodes move as close to their successors as their predecessors allow, and empty layers close up. */
function assignLayers(count: number, dag: Array<{ u: number; v: number }>) {
  const preds: number[][] = Array.from({ length: count }, () => []), succs: number[][] = Array.from({ length: count }, () => []);
  for (const { u, v } of dag) { succs[u].push(v); preds[v].push(u); }
  const indegree = preds.map(p => p.length), order: number[] = [];
  const queue = indegree.flatMap((d, i) => d ? [] : [i]);
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const s of succs[n]) if (--indegree[s] === 0) queue.push(s);
  }
  const layer = new Array<number>(count).fill(0);
  for (const n of order) for (const s of succs[n]) layer[s] = Math.max(layer[s], layer[n] + 1);
  for (const n of [...order].reverse()) if (succs[n].length) layer[n] = Math.max(layer[n], Math.min(...succs[n].map(s => layer[s])) - 1);
  const used = [...new Set(layer)].sort((a, b) => a - b), compact = new Map(used.map((l, i) => [l, i]));
  return layer.map(l => compact.get(l)!);
}

function adjacency(vertices: Vertex[], chains: Chain[]) {
  const up: number[][] = vertices.map(() => []), down: number[][] = vertices.map(() => []);
  for (const c of chains) for (let k = 1; k < c.vertices.length; k++) { down[c.vertices[k - 1]].push(c.vertices[k]); up[c.vertices[k]].push(c.vertices[k - 1]); }
  return { up, down };
}

/** Barycenter ordering with alternating sweeps, keeping the ordering with the fewest crossings. */
function orderLayers(vertices: Vertex[], chains: Chain[]) {
  const count = vertices.reduce((m, v) => Math.max(m, v.layer + 1), 0);
  const layers: number[][] = Array.from({ length: count }, () => []);
  vertices.forEach((v, i) => layers[v.layer].push(i));
  const { up, down } = adjacency(vertices, chains);
  const renumber = () => layers.forEach(l => l.forEach((id, i) => { vertices[id].order = i; }));
  const crossings = () => {
    let total = 0;
    for (let l = 0; l + 1 < layers.length; l++) {
      const pairs = layers[l].flatMap(u => down[u].map(v => [vertices[u].order, vertices[v].order]));
      for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++)
        if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) total++;
    }
    return total;
  };
  renumber();
  let best = layers.map(l => [...l]), bestScore = crossings();
  const indices = layers.map((_, i) => i);
  for (let pass = 0; pass < 8 && bestScore > 0; pass++) {
    const downward = pass % 2 === 0, neighbors = downward ? up : down;
    for (const l of downward ? indices.slice(1) : [...indices].reverse().slice(1)) {
      const weight = new Map(layers[l].map(id => {
        const n = neighbors[id];
        return [id, n.length ? n.reduce((s, x) => s + vertices[x].order, 0) / n.length : vertices[id].order];
      }));
      layers[l].sort((a, b) => weight.get(a)! - weight.get(b)! || vertices[a].order - vertices[b].order);
      layers[l].forEach((id, i) => { vertices[id].order = i; });
    }
    const score = crossings();
    if (score < bestScore) { bestScore = score; best = layers.map(l => [...l]); }
  }
  best.forEach((l, i) => { layers[i] = l; });
  renumber();
  return layers;
}

/** Moves each vertex toward its neighbors' centers without overlapping its siblings (isotonic regression by pool-adjacent-violators). */
function placeBreadth(vertices: Vertex[], layers: number[][], chains: Chain[]) {
  const { up, down } = adjacency(vertices, chains);
  const extent = (layer: number[]) => layer.reduce((s, id) => s + vertices[id].size + SIBLING_GAP, -SIBLING_GAP);
  const widest = Math.max(0, ...layers.map(extent));
  for (const layer of layers) {
    let at = (widest - extent(layer)) / 2;
    for (const id of layer) { vertices[id].pos = at; at += vertices[id].size + SIBLING_GAP; }
  }
  const center = (id: number) => vertices[id].pos + vertices[id].size / 2;
  const indices = layers.map((_, i) => i);
  for (let pass = 0; pass < 6; pass++) {
    const neighbors = pass % 2 === 0 ? up : down;
    for (const l of pass % 2 === 0 ? indices : [...indices].reverse()) {
      const layer = layers[l], offsets: number[] = [];
      let offset = 0;
      for (const id of layer) { offsets.push(offset); offset += vertices[id].size + SIBLING_GAP; }
      const desired = layer.map((id, i) => {
        const n = neighbors[id];
        return (n.length ? n.reduce((s, x) => s + center(x), 0) / n.length - vertices[id].size / 2 : vertices[id].pos) - offsets[i];
      });
      isotonic(desired).forEach((q, i) => { vertices[layer[i]].pos = q + offsets[i]; });
    }
  }
  const shift = PAD - Math.min(...vertices.map(v => v.pos), Infinity);
  if (Number.isFinite(shift)) for (const v of vertices) v.pos += shift;
}

function isotonic(values: number[]) {
  const blocks: Array<{ sum: number; count: number }> = [];
  for (const value of values) {
    blocks.push({ sum: value, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1], prev = blocks[blocks.length - 2];
      if (prev.sum / prev.count <= last.sum / last.count) break;
      prev.sum += last.sum; prev.count += last.count; blocks.pop();
    }
  }
  return blocks.flatMap(b => new Array<number>(b.count).fill(b.sum / b.count));
}

/** Spreads the ends of several edges that leave or enter the same node so they do not overlap. */
function portOffsets(vertices: Vertex[], chains: Chain[]) {
  const ends = new Map<string, Array<{ key: string; other: number; size: number }>>();
  const add = (slot: string, key: string, other: number, size: number) => ends.set(slot, [...(ends.get(slot) ?? []), { key, other, size }]);
  for (const { link, vertices: path } of chains) {
    add(`${path[0]}:out`, `${link.index}:out`, path[1], vertices[path[0]].size);
    add(`${path[path.length - 1]}:in`, `${link.index}:in`, path[path.length - 2], vertices[path[path.length - 1]].size);
  }
  const offsets = new Map<string, number>();
  for (const list of ends.values()) {
    list.sort((a, b) => vertices[a.other].pos - vertices[b.other].pos);
    const step = Math.min(12, (list[0].size - 20) / Math.max(1, list.length - 1));
    list.forEach((end, i) => offsets.set(end.key, (i - (list.length - 1) / 2) * step));
  }
  return offsets;
}

function curve(pts: RoutePoint[], toPoint: (d: number, b: number) => Point) {
  const at = (d: number, b: number) => { const q = toPoint(d, b); return `${round(q.x)},${round(q.y)}`; };
  let path = `M${at(pts[0].d, pts[0].b)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.b === b.b && (a.run || b.run)) { path += ` L${at(b.d, b.b)}`; continue; }
    const mid = (a.d + b.d) / 2;
    path += ` C${at(mid, a.b)} ${at(mid, b.b)} ${at(b.d, b.b)}`;
  }
  return path;
}

const round = (n: number) => Math.round(n * 10) / 10;
