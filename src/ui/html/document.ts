// Turns agent HTML into the document the sandboxed frame renders: theme variables and the bridge at
// the top of <head>, and every <script src="canvas:lib/NAME"></script> replaced by the library inline.
import { LIMITS } from '../../shared/contract';
import { frameTags, libraryTags, speculativeTags } from '../../shared/html-check';
import { bridgeScript, type BridgeConfig } from './bridge';

export type Appearance = 'light' | 'dark';

const FONT_SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

/** OpenChamber-compatible theme variables (plus common shadcn aliases). Chart colors are a CVD-checked categorical order. */
export const THEME_PALETTES: Record<Appearance, Record<string, string>> = {
  light: {
    '--background': '#f6f8f4', '--foreground': '#1c3027',
    '--muted': '#eaf0ea', '--muted-foreground': '#5a7167',
    '--card': '#ffffff', '--card-foreground': '#1c3027',
    '--popover': '#ffffff', '--popover-foreground': '#1c3027',
    '--secondary': '#eaf0ea', '--secondary-foreground': '#1c3027',
    '--accent': '#e1ece4', '--accent-foreground': '#1c3027',
    '--border': '#d3ded5', '--input': '#c5d3c9', '--ring': '#227953',
    '--primary': '#227953', '--primary-foreground': '#ffffff',
    '--destructive': '#c2392d', '--warning': '#9a6200', '--success': '#1d7f4b', '--info': '#1f6db5',
    '--chart-1': '#2a78d6', '--chart-2': '#eb6834', '--chart-3': '#1baf7a',
    '--chart-4': '#eda100', '--chart-5': '#e87ba4', '--chart-6': '#008300',
    '--radius': '8px', '--font-sans': FONT_SANS, '--font-mono': FONT_MONO,
  },
  dark: {
    '--background': '#101817', '--foreground': '#dce8e6',
    '--muted': '#1b2a27', '--muted-foreground': '#96ada6',
    '--card': '#15211f', '--card-foreground': '#dce8e6',
    '--popover': '#15211f', '--popover-foreground': '#dce8e6',
    '--secondary': '#1b2a27', '--secondary-foreground': '#dce8e6',
    '--accent': '#21332f', '--accent-foreground': '#dce8e6',
    '--border': '#2a3b37', '--input': '#344843', '--ring': '#91dfbd',
    '--primary': '#91dfbd', '--primary-foreground': '#11251d',
    '--destructive': '#f0857a', '--warning': '#e6c18e', '--success': '#7fd6a4', '--info': '#83cbe0',
    '--chart-1': '#3987e5', '--chart-2': '#d95926', '--chart-3': '#199e70',
    '--chart-4': '#c98500', '--chart-5': '#d55181', '--chart-6': '#008300',
    '--radius': '8px', '--font-sans': FONT_SANS, '--font-mono': FONT_MONO,
  },
};

export function themeVariables(appearance: Appearance): Record<string, string> {
  return { ...THEME_PALETTES[appearance] };
}

/** The :root rule the bridge rewrites on theme changes; values cannot close the style element. */
export function themeCss(appearance: Appearance, variables: Record<string, string>): string {
  const rules = Object.entries(variables).filter(([k]) => /^--[A-Za-z0-9-]+$/.test(k)).map(([k, v]) => `${k}:${String(v).replace(/[<>{};]/g, '')}`);
  return `:root{${[...rules, `color-scheme:${appearance}`].join(';')}}`;
}

// The lowest cascade layer: the page's own CSS, Tailwind's layers included, always wins over these defaults.
const BASE_CSS = '@layer canvas{:root{background:var(--background);color:var(--foreground);accent-color:var(--primary);font-family:var(--font-sans);line-height:1.5;-webkit-font-smoothing:antialiased}a{color:var(--primary)}button,input,select,textarea{font:inherit;color:inherit}code,kbd,pre,samp{font-family:var(--font-mono)}[data-canvas-state=sending]{opacity:.6;cursor:progress}}';

/** Library and bridge text inside <script>: neither `</script` nor `<!--` may reach the HTML parser. */
export function escapeScript(text: string): string {
  return text.replace(/<(\/script|!--)/gi, '\\x3C$1');
}

/** JSON that is safe inside an inline script, including U+2028/2029. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const newlines = (text: string) => { let n = 0; for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++; return n; };

/** Where the head content goes: after <head>, else after <html>, else after the doctype, else at the start. */
function headPosition(source: string): { index: number; doctype: boolean } {
  const doctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\b[^>]*>/i.exec(source);
  const head = /<head(?=[\s>/])[^>]*>/i.exec(source);
  if (head) return { index: head.index + head[0].length, doctype: !!doctype };
  const html = /<html(?=[\s>/])[^>]*>/i.exec(source);
  if (html) return { index: html.index + html[0].length, doctype: !!doctype };
  return { index: doctype ? doctype[0].length : 0, doctype: !!doctype };
}

export type BuildOptions = {
  view: { id: string; revision: number; title: string };
  appearance: Appearance;
  variables: Record<string, string>;
  /** Library name → its source text, for every canvas:lib/NAME the page uses. */
  libraries: Record<string, string>;
  initialState: unknown | null;
};

const JS_TYPES = /^(?:|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|module)$/i;
// Tailwind's own `dark:` follows prefers-color-scheme, which a frame cannot take from the app; key it to the theme instead.
const TAILWIND_DARK = '<style type="text/tailwindcss">@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));</style>';

/** Inline classic and module scripts, by where their text starts and ends. */
function inlineScripts(source: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  for (const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = m[1];
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attributes)?.[1] ?? '';
    if (!JS_TYPES.test(type.trim())) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    found.push({ start, end: start + m[2].length });
  }
  return found;
}

/** checkHtml refuses these; a page saved before that rule, or one that slips past it, still never gets them. */
function withoutTags(source: string, tags: Array<{ index: number; length: number; tag: string }>, reason: string): string {
  let out = '', cursor = 0;
  for (const tag of tags.sort((a, b) => a.index - b.index)) {
    if (tag.index < cursor) continue;
    out += source.slice(cursor, tag.index) + `<!-- removed by Agent Canvas: ${reason} -->` + '\n'.repeat(newlines(tag.tag));
    cursor = tag.index + tag.length;
  }
  return out + source.slice(cursor);
}

export function buildDocument(original: string, options: BuildOptions): string {
  const unframed = withoutTags(original, frameTags(original), 'no nested frames');
  const source = withoutTags(unframed, speculativeTags(unframed), 'no network');
  const tags = libraryTags(source);
  const missing = [...new Set(tags.map(t => t.name).filter(name => typeof options.libraries[name] !== 'string'))];
  if (missing.length) throw new Error(`Unknown or unavailable bundled library: ${missing.map(n => `canvas:lib/${n}`).join(', ')}.`);
  const position = headPosition(source);
  if (tags.length && tags[0].index < position.index) position.index = tags[0].index;

  // Edits in source order: libraries replace their tag; inline scripts get a sourceURL naming the source
  // line they start on, because browsers number lines inside written documents per script.
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineOf = (index: number) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1; } return lo + 1; };
  const edits = [
    ...tags.map(t => ({ index: t.index, length: t.length, library: t.name, line: 0 })),
    ...inlineScripts(source).filter(s => s.start >= position.index).map(s => ({ index: s.end, length: 0, library: '', line: lineOf(s.start) })),
  ].sort((a, b) => a.index - b.index);

  const placeholder = '__CANVAS_BRIDGE_CONFIG__';
  const lines: BridgeConfig['lines'] = [];
  let out = position.doctype ? '' : '<!doctype html>', line = 1, sourceLine = 1, cursor = 0;
  const copy = (end: number) => {
    const text = source.slice(cursor, end);
    if (text) { lines.push([line, sourceLine]); out += text; line += newlines(text); sourceLine += newlines(text); }
    cursor = end;
  };
  // Inserted text sits on lines of its own, so every built line maps to one source line or one label.
  const insert = (open: string, text: string, close: string, label: string) => {
    out += `${open}\n`; line++;
    lines.push([line, label]); out += text; line += newlines(text);
    out += `\n${close}`; line++;
    lines.push([line, sourceLine]);
  };

  copy(position.index);
  // The meta turns off implicit DNS prefetching of the page's links.
  const theme = `<style id="canvas-theme">${themeCss(options.appearance, options.variables)}</style><style id="canvas-base">${BASE_CSS}</style><meta http-equiv="x-dns-prefetch-control" content="off">`;
  insert(`${theme}<script id="canvas-bridge">`, `${escapeScript(bridgeScript(placeholder))}\n//# sourceURL=canvas-bridge.js`, '</script>', 'the Canvas bridge');
  for (const edit of edits) {
    copy(edit.index);
    if (edit.library) {
      const name = edit.library;
      insert(`<script data-canvas-lib="${name}">`, `${escapeScript(options.libraries[name])}\n//# sourceURL=canvas-lib-${name}.js`, `</script>${name === 'tailwind' ? TAILWIND_DARK : ''}`, `bundled library ${name}`);
      sourceLine += newlines(source.slice(edit.index, edit.index + edit.length));
      lines[lines.length - 1][1] = sourceLine;
      cursor = edit.index + edit.length;
    } else insert('', `//# sourceURL=page-script-at-line-${edit.line}.js`, '', 'a Canvas source comment');
  }
  copy(source.length);

  const config: BridgeConfig = {
    view: { id: options.view.id, revision: options.view.revision, title: options.view.title },
    appearance: options.appearance,
    variables: options.variables,
    state: options.initialState ?? null,
    limits: { action: LIMITS.action, dataBytes: LIMITS.dataBytes, draftBytes: LIMITS.draftBytes },
    lines,
  };
  // The config is one line of JSON, so swapping it in keeps every line number above valid.
  const at = out.indexOf(placeholder);
  return out.slice(0, at) + scriptJson(config) + out.slice(at + placeholder.length);
}
