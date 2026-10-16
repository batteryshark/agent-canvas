// Service-side checks for agent-written HTML pages. No DOM: regular expressions over the source,
// tuned to catch what silently breaks inside the sandbox and to say how to repair it.
import { LIMITS, type Check } from './contract';

/** Libraries a page can load with <script src="canvas:lib/NAME"></script>. `file` is relative to node_modules. */
export const HTML_LIBRARIES: Record<string, { file: string; description: string }> = {
  tailwind: {
    file: '@tailwindcss/browser/dist/index.global.js',
    description: 'Tailwind CSS 4 (browser build). Utility classes are compiled in the page as it renders; add `<style type="text/tailwindcss">` for `@theme` or `@apply`.',
  },
  'chart.js': {
    file: 'chart.js/dist/chart.umd.min.js',
    description: 'Chart.js 4 as the global `Chart`: line, bar, pie, doughnut, radar, polar area, scatter and bubble charts on a `<canvas>`.',
  },
  d3: {
    file: 'd3/dist/d3.min.js',
    description: 'D3 7 as the global `d3`: scales, axes, shapes, hierarchies, force layouts and geo for custom SVG visuals.',
  },
  mermaid: {
    file: 'mermaid/dist/mermaid.min.js',
    description: 'Mermaid 12 as the global `mermaid`: flowchart, sequence, class, state, ER, gantt and timeline diagrams from text. About 5.5 MB, so use it only when a text diagram is the point.',
  },
};

const LIBRARY_TAG = /<script\b[^>]*?\bsrc\s*=\s*(["'])canvas:lib\/([^"']*)\1[^>]*>\s*<\/script\s*>/gi;

/** The source with every HTML comment blanked out, keeping each character's position and every line break. */
export function blankComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ' '));
}

/** Every <script src="canvas:lib/NAME"></script> outside comments, in order, with its position. */
export function libraryTags(source: string): Array<{ name: string; index: number; length: number }> {
  return [...blankComments(source).matchAll(LIBRARY_TAG)].map(m => ({ name: m[2], index: m.index, length: m[0].length }));
}

/** Link types Chrome acts on even under the frame's default-src 'none': each one can reach a server of the page's choosing. */
export const SPECULATIVE_REL = /(?:^|\s)(?:prerender|prefetch|dns-prefetch|preconnect)(?:\s|$)/i;
const codePoint = (n: number) => { try { return String.fromCodePoint(n); } catch { return '\uFFFD'; } };
const decodeNumeric = (text: string) => text.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, n: string) => codePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)));
/** <link> tags and speculation-rules scripts that make requests outside the CSP, with their positions. */
export function speculativeTags(source: string): Array<{ index: number; length: number; tag: string }> {
  const code = blankComments(source), found: Array<{ index: number; length: number; tag: string }> = [];
  for (const m of code.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/i.exec(m[0]);
    const value = rel ? decodeNumeric(rel[1] ?? rel[2] ?? rel[3] ?? '') : '';
    // A rel spelled with a named entity cannot be read here, so it is treated as one of these.
    if (SPECULATIVE_REL.test(value) || /&[a-z]+;?/i.test(value)) found.push({ index: m.index, length: m[0].length, tag: m[0] });
  }
  for (const m of code.matchAll(/<script\b[^>]*\btype\s*=\s*["']?\s*speculationrules\b[^>]*>[\s\S]*?<\/script\s*>/gi)) found.push({ index: m.index, length: m[0].length, tag: m[0] });
  return found.sort((a, b) => a.index - b.index);
}

/** Elements that open a nested frame: its fresh globals would escape the bridge's run-time network guards. */
const FRAME_TAG = /<(iframe|frame|object|embed|fencedframe)(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>?/gi;
/** Start tags of nested frames outside comments, with their positions: anywhere in the source, script strings included. */
export function frameTags(source: string): Array<{ index: number; length: number; tag: string }> {
  return [...blankComments(source).matchAll(FRAME_TAG)].map(m => ({ index: m.index, length: m[0].length, tag: m[0] }));
}

/** The distinct library names a page asks for, in first-use order. */
export function libraryNames(source: string): string[] {
  return [...new Set(libraryTags(source).map(t => t.name))];
}

const available = () => Object.keys(HTML_LIBRARIES).map(n => `canvas:lib/${n}`).join(', ');
const shown = (items: string[]) => items.slice(0, 3).map(u => `"${u}"`).join(', ') + (items.length > 3 ? ` and ${items.length - 3} more` : '');
const remote = (url: string) => /^(?:https?:)?\/\//i.test(url.trim()) || /^www\./i.test(url.trim());

function suggestLibrary(url: string) {
  const u = url.toLowerCase();
  if (u.includes('tailwind')) return 'tailwind';
  if (/chart(?:\.js|js|\.umd)/.test(u)) return 'chart.js';
  if (u.includes('mermaid')) return 'mermaid';
  if (/(^|[/@.-])d3(?:[@./-]|$)/.test(u)) return 'd3';
  return '';
}

export function checkHtml(source: string): Check {
  const errors: string[] = [], warnings: string[] = [];
  if (!source.trim()) {
    errors.push('The HTML source is empty. Send one complete document: <!doctype html><html><head>…</head><body>…</body></html>.');
    return { errors, warnings };
  }
  if (source.length > LIMITS.htmlSource) {
    errors.push(`The HTML source is ${source.length.toLocaleString('en-US')} characters; the limit is ${LIMITS.htmlSource.toLocaleString('en-US')}. Generate repeated markup with a small script, embed less data, and load libraries with <script src="canvas:lib/NAME"></script> instead of pasting their code.`);
  }
  // Comments are ignored for every check below: commented-out markup never runs.
  const code = source.replace(/<!--[\s\S]*?-->/g, '');

  const speculative = speculativeTags(source);
  if (speculative.length) errors.push(`Remove ${shown(speculative.map(s => s.tag.slice(0, 80)))}: prerender, prefetch, dns-prefetch and preconnect links and speculation rules would reach the network, and Canvas pages have none. Link to pages with <a href>; they open in the user's browser when clicked.`);
  const frames = frameTags(source);
  if (frames.length) errors.push(`Remove ${shown(frames.map(f => f.tag.slice(0, 80)))}: Canvas pages cannot contain nested frames (<iframe>, <frame>, <object>, <embed>), in the markup or built by a script. Put the content in the page itself (inline SVG, <img src="data:…">, plain markup), and link to other sites with <a href>; links open in the user's browser when clicked.`);
  if (/\b(?:webkit)?RTC(?:PeerConnection|DataChannel|IceTransport)\b/.test(code)) errors.push('WebRTC (RTCPeerConnection) is not available: Canvas pages have no network access. Simulate peers inside the page instead.');

  const tags = libraryTags(code);
  for (const name of new Set(tags.map(t => t.name))) {
    if (!HTML_LIBRARIES[name]) errors.push(`Unknown bundled library "canvas:lib/${name}". Available: ${available()}.`);
  }
  const references = [...code.matchAll(/\b(?:src|href)\s*=\s*["']?\s*canvas:lib\//gi)].length;
  if (references > tags.length) {
    errors.push(`canvas:lib/NAME only works as an empty script tag: <script src="canvas:lib/NAME"></script>. ${references - tags.length} reference(s) use another form (a <link>, an attribute without quotes, or code inside the script tag). Put your own code in a separate <script> after it.`);
  }

  if (!/<[a-z!][^>]*>/i.test(code)) {
    warnings.push('The source has no HTML tags, so it will render as plain text. Send a complete HTML document, or use format "openui" for OpenUI Lang.');
  }

  const scripts = [...code.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map(m => m[1]).filter(u => !/^(?:canvas:lib\/|data:|blob:)/i.test(u));
  for (const url of [...new Set(scripts)].slice(0, 5)) {
    const library = suggestLibrary(url);
    warnings.push(`<script src="${url}"> will not load: Canvas pages have no network access. ${library ? `Use the bundled copy instead: <script src="canvas:lib/${library}"></script>.` : `Inline the code in a <script> element, or use a bundled library (${available()}).`}`);
  }

  const links = [...code.matchAll(/<link\b[^>]*>/gi)]
    .map(m => /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(m[0])?.[1] ?? '')
    .filter(u => u && !/^(?:data:|blob:|canvas:lib\/)/i.test(u));
  if (links.length) {
    const fonts = links.some(u => /fonts\.(googleapis|gstatic)|typekit|fontawesome/i.test(u));
    warnings.push(`<link href> will not load (${shown(links)}): Canvas pages have no network access. Put CSS in a <style> element${fonts ? '; for text use the theme fonts var(--font-sans) and var(--font-mono), and draw icons as inline SVG' : ''}.`);
  }

  const imports = [...code.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)].map(m => m[1]).filter(u => !/^tailwindcss(?:\/|$)/i.test(u));
  if (imports.length) warnings.push(`CSS @import will not load (${shown(imports)}): Canvas pages have no network access. Inline the CSS in the <style> element instead.`);

  const assets = [
    ...[...code.matchAll(/\b(?:src|poster|data|srcset|xlink:href)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>)]+|www\.[^"'\s>)]+)/gi)].map(m => m[1]),
    ...[...code.matchAll(/<(?:img|image|video|audio|source|use|track)\b[^>]*?\bhref\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>)]+)/gi)].map(m => m[1]),
    ...[...code.matchAll(/url\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/gi)].map(m => m[1]),
  ].filter(u => remote(u) && !scripts.includes(u));
  if (assets.length) warnings.push(`Remote images, fonts and media will not load (${shown([...new Set(assets)])}): Canvas pages have no network access. Draw with inline SVG or CSS, or embed small assets as data: URLs.`);

  const modules = [...code.matchAll(/<script\b[^>]*\btype\s*=\s*["']?module\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .flatMap(m => [...m[1].matchAll(/\bimport\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map(i => i[1] ?? i[2]));
  if (modules.length) warnings.push(`Module imports cannot load (${shown(modules)}): there is no network and no bundler. Write plain scripts, inline the code, or use a bundled library global (Chart, d3, mermaid).`);
  if (/<script\b[^>]*\btype\s*=\s*["']?text\/(?:babel|jsx)/i.test(code)) warnings.push('<script type="text/babel"> needs a compiler that is not available. Write plain JavaScript (DOM APIs or template strings), or use format "openui" for component layouts.');

  const forms = [...code.matchAll(/<form\b[^>]*>/gi)].filter(m => !/\bdata-canvas-action\b/i.test(m[0])).length;
  if (forms && !/addEventListener\(\s*["']submit["']|\bonsubmit\s*=/i.test(code)) {
    warnings.push(`${forms} <form> element(s) without data-canvas-action: real form submission is blocked in Canvas, so their submit buttons send nothing. Add data-canvas-action="Label" to send the fields to the agent, or handle the submit event yourself and call canvas.send().`);
  }

  const network = [
    /(?<![\w$.])fetch\s*\(|\bwindow\.fetch\s*\(/.test(code) && 'fetch()',
    /\bXMLHttpRequest\b/.test(code) && 'XMLHttpRequest',
    /\bnew\s+(?:WebSocket|EventSource)\s*\(/.test(code) && 'WebSocket/EventSource',
    /\bsendBeacon\s*\(/.test(code) && 'navigator.sendBeacon()',
  ].filter(Boolean);
  if (network.length) warnings.push(`The page uses ${network.join(', ')}: Canvas pages have no network access, so those requests fail. Embed the data in the page (a JavaScript constant or <script type="application/json">) and send the user's input with canvas.send().`);

  if (/(?<![\w$.])(?:alert|confirm|prompt)\s*\(|\bwindow\.(?:alert|confirm|prompt)\s*\(/.test(code)) {
    warnings.push('alert(), confirm() and prompt() are blocked in the Canvas sandbox and do nothing. Show messages and confirmations inside the page.');
  }
  if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(code)) {
    warnings.push('localStorage and sessionStorage only last for this page view in the sandbox, and indexedDB is unavailable. Use canvas.state.set(value) to keep a draft that survives reloads.');
  }
  if (/\b(?:top|parent)\.location\b|\btarget\s*=\s*["']?_(?:top|parent)\b/.test(code)) {
    warnings.push('A Canvas page cannot navigate the app around it. Open links with canvas.openLink(url) or a plain <a href="https://…">; they open in a new browser tab.');
  }
  if (/\b(?:var|let|const)\s+canvas\s*=/.test(code) && /\bcanvas\.(?:send|state|view|theme|onTheme|openLink)\b/.test(code)) {
    warnings.push('The page declares its own variable named `canvas`, which hides the Canvas bridge where it is in scope. Rename it (for example `board` or `chartCanvas`), or call the bridge as window.canvas.send(...).');
  }
  return { errors, warnings };
}
