import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../src/shared/contract';
import { HTML_LIBRARIES, checkHtml, libraryNames } from '../src/shared/html-check';
import { HTML_GUIDE, HTML_GUIDE_EXAMPLES } from '../src/shared/html-guide';
import { FRAME_CSP, FRAME_SHELL_HTML } from '../src/server/frame-shell';
import { BRIDGE_SOURCE, type BridgeConfig } from '../src/ui/html/bridge';
import { THEME_PALETTES, buildDocument, escapeScript, themeCss, themeVariables, type BuildOptions } from '../src/ui/html/document';

const page = (body: string, head = '') => `<!doctype html>\n<html lang="en">\n<head>\n<title>Test</title>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>`;
const options = (over: Partial<BuildOptions> = {}): BuildOptions => ({
  view: { id: '7c1e0000-0000-4000-8000-000000000001', revision: 3, title: 'Checkout redesign' },
  appearance: 'dark', variables: themeVariables('dark'), libraries: {}, initialState: null, ...over,
});
const stubs = Object.fromEntries(Object.keys(HTML_LIBRARIES).map(name => [name, `/* ${name} */ window.lib = ${JSON.stringify(name)};`]));
const bridgeText = (html: string) => {
  const start = html.indexOf('<script id="canvas-bridge">') + '<script id="canvas-bridge">'.length;
  return html.slice(start, html.indexOf('</script>', start));
};
const configOf = (html: string): BridgeConfig => {
  const text = bridgeText(html), marker = '})(';
  return JSON.parse(text.slice(text.lastIndexOf(marker) + marker.length, text.lastIndexOf(');')));
};
const REQUIRED_VARIABLES = ['--background', '--foreground', '--muted', '--muted-foreground', '--card', '--card-foreground', '--border', '--primary', '--primary-foreground', '--destructive', '--warning', '--success', '--info', '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--radius', '--font-sans', '--font-mono'];

test('bundled libraries name real files with descriptions', () => {
  assert.deepEqual(Object.keys(HTML_LIBRARIES).sort(), ['chart.js', 'd3', 'mermaid', 'tailwind']);
  for (const [name, library] of Object.entries(HTML_LIBRARIES)) {
    assert.ok(existsSync(join('node_modules', library.file)), `${name}: ${library.file} is installed`);
    assert.ok(library.description.length > 20, `${name} has a description`);
  }
  assert.equal(HTML_LIBRARIES.tailwind.file, '@tailwindcss/browser/dist/index.global.js');
  assert.equal(HTML_LIBRARIES['chart.js'].file, 'chart.js/dist/chart.umd.min.js');
});

test('checkHtml rejects empty, oversized and unknown-library pages', () => {
  assert.match(checkHtml('  \n ').errors[0], /empty/);
  const big = checkHtml(page('x'.repeat(LIMITS.htmlSource)));
  assert.equal(big.errors.length, 1);
  assert.match(big.errors[0], /400,000/);
  const unknown = checkHtml(page('<p>x</p>', '<script src="canvas:lib/jquery"></script>'));
  assert.equal(unknown.errors.length, 1);
  assert.match(unknown.errors[0], /canvas:lib\/jquery/);
  assert.match(unknown.errors[0], /canvas:lib\/chart\.js/);
  assert.match(checkHtml(page('', '<link rel="stylesheet" href="canvas:lib/tailwind">')).errors[0], /empty script tag/);
  assert.deepEqual(checkHtml(page('<p>x</p>', '<script src="canvas:lib/tailwind"></script>\n<script src=\'canvas:lib/chart.js\'></script>')).errors, []);
});

test('checkHtml warns about what silently fails in the sandbox, with a repair', () => {
  const warnings = (html: string) => checkHtml(html).warnings;
  const cdn = warnings(page('<p>x</p>', '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>'));
  assert.equal(cdn.length, 1);
  assert.match(cdn[0], /will not load/);
  assert.match(cdn[0], /canvas:lib\/chart\.js/);
  assert.match(warnings(page('', '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">')).join(), /--font-sans/);
  assert.match(warnings(page('', '<style>@import url("https://example.com/a.css");</style>')).join(), /@import/);
  assert.deepEqual(warnings(page('<div class="p-2">x</div>', '<script src="canvas:lib/tailwind"></script><style type="text/tailwindcss">@import "tailwindcss"; @theme { --color-brand: red; }</style>')), []);
  assert.match(warnings(page('<img src="https://placehold.co/600x400">')).join(), /Remote images/);
  assert.match(warnings(page('<form><input name="q"><button>Go</button></form>')).join(), /data-canvas-action/);
  assert.deepEqual(warnings(page('<form data-canvas-action="Search"><input name="q"><button>Go</button></form>')), []);
  assert.deepEqual(warnings(page('<form id="f"><button>Go</button></form><script>f.addEventListener("submit", e => { e.preventDefault(); canvas.send("Go"); });</script>')), []);
  assert.match(warnings(page('<script>fetch("/api/data").then(r => r.json());</script>')).join(), /fetch\(\)/);
  assert.match(warnings(page('<script>new XMLHttpRequest();</script>')).join(), /XMLHttpRequest/);
  assert.deepEqual(warnings(page('<script>d3.fetch; obj.prefetch(1);</script>')), []);
  assert.match(warnings(page('<button onclick="alert(1)">x</button>')).join(), /alert\(\)/);
  assert.match(warnings(page('<script>localStorage.setItem("a", "b")</script>')).join(), /canvas\.state/);
  assert.match(warnings(page('<script>const canvas = document.querySelector("canvas"); canvas.send("x");</script>')).join(), /window\.canvas/);
  assert.match(warnings(page('<script type="module">import React from "react";</script>')).join(), /Module imports/);
  assert.deepEqual(warnings(page('<!-- <script src="https://cdn.example.com/x.js"></script> --><p>ok</p>')), []);
  assert.match(warnings('root = Stack([])').join(), /plain text/);
  assert.deepEqual(checkHtml(page('<h1>Plain page</h1><button data-canvas-action="Go">Go</button>')), { errors: [], warnings: [] });
});

test('checkHtml refuses network paths the frame CSP cannot close', () => {
  for (const tag of ['<link rel="prerender" href="http://127.0.0.1:9/x?secret=1">', "<link rel='dns-prefetch' href='//leak.example'>", '<link rel=preconnect href=https://x.example>',
    '<link rel="pre&#114;ender" href="http://x.example">', '<link rel="&Tab;prerender" href="http://x.example">', '<script type="speculationrules">{"prerender":[{"urls":["/x"]}]}</script>']) {
    assert.match(checkHtml(page('<p>x</p>', tag)).errors.join('\n'), /no network|have none/, tag);
  }
  assert.match(checkHtml(page('<script>new RTCPeerConnection({ iceServers: [] });</script>')).errors.join('\n'), /WebRTC/);
  assert.deepEqual(checkHtml(page('<p>x</p>', '<!-- <link rel="prerender" href="http://x"> -->')).errors, [], 'commented-out markup never runs');
  // A page saved before the rule, or one that slips past it, is built without them, keeping its line numbers.
  const source = page('<p id="after">x</p>', '<link rel="prerender"\n href="http://127.0.0.1:9/x">');
  const html = buildDocument(source, options());
  assert.ok(!/rel="prerender"/.test(html));
  assert.ok(html.includes('<!-- removed by Agent Canvas: no network -->\n'));
  assert.equal(html.split('\n').findIndex(l => l.includes('id="after"')) - html.split('\n').findIndex(l => l.includes('<title>Test')), source.split('\n').findIndex(l => l.includes('id="after"')) - source.split('\n').findIndex(l => l.includes('<title>Test')));
});

test('checkHtml refuses nested frames, in markup and in script strings', () => {
  for (const source of [page('<iframe src="https://www.youtube.com/embed/x"></iframe>'), page('<IFRAME srcdoc="<p>x</p>"></IFRAME>'), page('<object data="data:text/html,x"></object>'),
    page('<embed src="x.svg">'), page('<frameset><frame src="about:blank"></frameset>'), page('<fencedframe></fencedframe>'),
    page('<div id="v"></div><script>v.innerHTML = \'<iframe src="\' + url + \'">\';</script>')]) {
    const errors = checkHtml(source).errors;
    assert.equal(errors.length, 1, source);
    assert.match(errors[0], /nested frames/);
    assert.match(errors[0], /<a href>/);
  }
  for (const source of [page('<script>for (let i = 0; i<Object.keys(o).length; i++) {} const frames = [], x = a<embedded;</script>'), page('<p>&lt;iframe&gt; is not allowed</p>'),
    page('<frameset-like></frameset-like><objective></objective>'), page('<p>x</p>', '<!-- <iframe src="https://x"></iframe> -->')]) {
    assert.deepEqual(checkHtml(source).errors, [], source);
  }
  // A page saved before the rule is built without them, keeping its line numbers.
  const source = page('<p id="after">x</p>', '<iframe\n srcdoc="<b>x</b>"></iframe>');
  const html = buildDocument(source, options());
  assert.ok(!/<iframe/i.test(html));
  assert.ok(html.includes('<!-- removed by Agent Canvas: no nested frames -->\n'));
  assert.equal(html.split('\n').findIndex(l => l.includes('id="after"')) - html.split('\n').findIndex(l => l.includes('<title>Test')), source.split('\n').findIndex(l => l.includes('id="after"')) - source.split('\n').findIndex(l => l.includes('<title>Test')));
});

test('library tags inside comments are ignored everywhere, as checkHtml ignores them', () => {
  const source = page('<p>x</p>', '<!-- old: <script src="canvas:lib/chartjs"></script> -->\n<script src="canvas:lib/d3"></script>');
  assert.deepEqual(checkHtml(source).errors, []);
  assert.deepEqual(libraryNames(source), ['d3']);
  const html = buildDocument(source, options({ libraries: stubs }));
  assert.ok(html.includes('data-canvas-lib="d3"') && !html.includes('data-canvas-lib="chartjs"'));
});

test('buildDocument puts the theme and bridge at the top of <head>', () => {
  const source = page('<header>Top</header><p>Hi</p>');
  const html = buildDocument(source, options());
  assert.ok(html.startsWith('<!doctype html>'));
  const head = html.indexOf('<head>'), theme = html.indexOf('<style id="canvas-theme">'), bridge = html.indexOf('<script id="canvas-bridge">'), title = html.indexOf('<title>');
  assert.ok(head < theme && theme < bridge && bridge < title, 'injected right after <head>, before page content');
  for (const name of REQUIRED_VARIABLES) assert.ok(html.includes(`${name}:${THEME_PALETTES.dark[name]}`), `defines ${name}`);
  assert.match(html, /color-scheme:dark/);
  assert.ok(html.includes('<header>Top</header><p>Hi</p>'), 'the page is otherwise untouched');
  const light = buildDocument(source, options({ appearance: 'light', variables: themeVariables('light') }));
  assert.ok(light.includes(`--background:${THEME_PALETTES.light['--background']}`));
  assert.match(light, /color-scheme:light/);
  const config = configOf(html);
  assert.deepEqual(config.view, options().view);
  assert.equal(config.appearance, 'dark');
  assert.deepEqual(config.limits, { action: LIMITS.action, dataBytes: LIMITS.dataBytes, draftBytes: LIMITS.draftBytes });
  assert.deepEqual(configOf(buildDocument(source, options({ initialState: { tab: 'b' } }))).state, { tab: 'b' });
});

test('buildDocument works without <head>, <html> or a doctype', () => {
  const noHead = buildDocument('<!doctype html><html class="x"><body><p>a</p></body></html>', options());
  assert.ok(noHead.startsWith('<!doctype html><html class="x"><style id="canvas-theme">'));
  const doctypeOnly = buildDocument('<!DOCTYPE html>\n<p>a</p>', options());
  assert.ok(doctypeOnly.startsWith('<!DOCTYPE html><style id="canvas-theme">'), 'the doctype stays first so the page is in standards mode');
  const fragment = buildDocument('<p>a</p>', options());
  assert.ok(fragment.startsWith('<!doctype html><style id="canvas-theme">'));
  assert.ok(fragment.endsWith('\n</script><p>a</p>'), 'the source follows the inserted head content, unchanged');
  const header = buildDocument('<header>Not a head</header>', options());
  assert.ok(header.indexOf('<style id="canvas-theme">') < header.indexOf('<header>'), '<header> is not mistaken for <head>');
});

test('buildDocument inlines bundled libraries and rejects unknown ones', () => {
  const source = page('<canvas id="c"></canvas><script>new Chart(c, {});</script>', '<script src="canvas:lib/chart.js"></script>\n<script src="canvas:lib/tailwind"></script>');
  assert.deepEqual(libraryNames(source), ['chart.js', 'tailwind']);
  const html = buildDocument(source, options({ libraries: stubs }));
  assert.ok(!html.includes('src="canvas:lib/'), 'every library tag is replaced');
  assert.ok(html.includes('<script data-canvas-lib="chart.js">\n/* chart.js */ window.lib = "chart.js";\n//# sourceURL=canvas-lib-chart.js.js\n</script>'));
  assert.ok(html.indexOf('data-canvas-lib="chart.js"') < html.indexOf('new Chart'), 'libraries stay before the code that uses them');
  assert.ok(html.indexOf('canvas-bridge') < html.indexOf('data-canvas-lib'), 'the bridge runs first');
  assert.match(html, /<\/script><style type="text\/tailwindcss">@custom-variant dark/, 'Tailwind dark: follows the Canvas theme');
  assert.throws(() => buildDocument(page('', '<script src="canvas:lib/nope"></script>'), options({ libraries: stubs })), /canvas:lib\/nope/);
  assert.throws(() => buildDocument(source, options({ libraries: { tailwind: '' } })), /canvas:lib\/chart\.js/);
});

test('inlined script text can never close its script element early', () => {
  const library = 'return ["</script><script>alert(1)</script>", "<!-- x", "</SCRIPT >", /<\\/script>/.source].join("|");';
  const expected = new Function(library)();
  assert.equal(escapeScript('a</script>b<!--c</Script'), 'a\\x3C/script>b\\x3C!--c\\x3C/Script');
  const html = buildDocument(page('<p>x</p>', '<script src="canvas:lib/d3"></script>'), options({ libraries: { d3: library } }));
  const start = html.indexOf('<script data-canvas-lib="d3">') + '<script data-canvas-lib="d3">'.length;
  const inline = html.slice(start, html.indexOf('</script>', start));
  assert.ok(inline.includes('//# sourceURL=canvas-lib-d3.js'), 'the first </script> after the library is its own end tag');
  assert.ok(!/<!--/.test(inline));
  assert.equal(new Function(inline)(), expected, 'the escaped library still computes the same strings');
  const titled = buildDocument(page('<p>x</p>'), options({ view: { ...options().view, title: 'A </script><script>alert(1)</script> \u2028 title' } }));
  assert.ok(!bridgeText(titled).includes('</'), 'the view title cannot break out of the bridge');
  assert.equal(configOf(titled).view.title, 'A </script><script>alert(1)</script> \u2028 title');
  assert.ok(!BRIDGE_SOURCE.includes('</script') && !BRIDGE_SOURCE.includes('<!--') && !BRIDGE_SOURCE.includes('`') && !BRIDGE_SOURCE.includes('${'));
  assert.doesNotThrow(() => new Function(bridgeText(titled)), 'the bridge is valid JavaScript');
  const css = themeCss('dark', { '--x': 'red;}</style><script>alert(1)</script>', 'not a variable': 'blue' });
  assert.ok(!css.includes('<') && !css.includes('not a variable'));
});

test('built documents keep source line numbers for error reports', () => {
  const lines = ['<!doctype html>', '<html><head>', '<script src="canvas:lib/chart.js"></script>', '<title>L4</title>', '</head><body>', '<script>', 'const a = "L7";', 'const b = "L8";', '</script>', '<script type="application/json">{"L10": true}</script>', '<p>L11</p><script src="canvas:lib/d3"></script><p>L11b</p>', '<p>L12</p>', '</body></html>'];
  const html = buildDocument(lines.join('\n'), options({ libraries: { 'chart.js': 'line one\nline two\nline three', d3: 'd3\n'.repeat(5) } }));
  const map = configOf(html).lines;
  const sourceLine = (builtLine: number) => {
    let found: [number, number | string] | undefined;
    for (const entry of map) if (entry[0] <= builtLine) found = entry;
    return found && typeof found[1] === 'number' ? found[1] + builtLine - found[0] : found?.[1];
  };
  html.split('\n').forEach((text, index) => {
    for (const token of text.match(/L\d+/g) ?? []) assert.equal(sourceLine(index + 1), Number(token.slice(1)), `built line ${index + 1} (${text.slice(0, 40)}) maps to ${token}`);
    if (text.startsWith('line ') || text === 'd3') assert.match(String(sourceLine(index + 1)), /bundled library/);
  });
  assert.match(html, /const b = "L8";\n\n\/\/# sourceURL=page-script-at-line-6\.js\n<\/script>/, 'inline scripts are named after the line they start on');
  assert.ok(!html.includes('sourceURL=page-script-at-line-10'), 'data blocks are left alone');
});

test('the guide examples are complete pages that pass checkHtml cleanly', () => {
  assert.equal(HTML_GUIDE_EXAMPLES.length, 4);
  for (const example of HTML_GUIDE_EXAMPLES) {
    assert.deepEqual(checkHtml(example.html), { errors: [], warnings: [] }, example.title);
    assert.ok(HTML_GUIDE.includes(example.html), `${example.title} is in the guide`);
    const libraries = Object.fromEntries(libraryNames(example.html).map(name => [name, stubs[name]]));
    assert.doesNotThrow(() => buildDocument(example.html, options({ libraries })), example.title);
  }
  const all = HTML_GUIDE_EXAMPLES.map(e => e.html).join('\n');
  for (const needle of ['canvas:lib/tailwind', 'canvas:lib/chart.js', 'canvas.send(', 'data-canvas-action', 'canvas.state.get()', 'canvas.onTheme(']) assert.ok(all.includes(needle), `examples show ${needle}`);
});

test('the guide documents the whole format', () => {
  for (const needle of [
    ...REQUIRED_VARIABLES, ...Object.keys(HTML_LIBRARIES).map(n => `\`${n}\``), '<script src="canvas:lib/NAME"></script>',
    'canvas.send(action, data?)', 'canvas.state.get()', 'canvas.state.set', 'canvas.view', 'canvas.theme', 'canvas.onTheme', 'canvas.openLink',
    'data-canvas-action', 'data-canvas-data', 'data-canvas-state', 'data-canvas-draft', 'data-theme', 'OpenUI', '240 px', '85%',
    LIMITS.htmlSource.toLocaleString('en-US'), LIMITS.dataBytes.toLocaleString('en-US'), LIMITS.draftBytes.toLocaleString('en-US'),
  ]) assert.ok(HTML_GUIDE.includes(needle), `the guide mentions ${needle}`);
  assert.ok(!HTML_GUIDE.includes('{{'), 'no unfilled placeholders');
});

test('the /frame shell writes the posted page under the frame policy', () => {
  assert.equal(FRAME_CSP, "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
  assert.ok(FRAME_SHELL_HTML.startsWith('<!doctype html>'));
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(FRAME_SHELL_HTML)?.[1] ?? '';
  assert.ok(meta.includes("connect-src 'none'") && !meta.includes('frame-ancestors'));
  const script = /<script>([\s\S]*)<\/script>/.exec(FRAME_SHELL_HTML)?.[1] ?? '';
  assert.doesNotThrow(() => new Function(script));
  for (const needle of ["type!=='render'", 'event.source!==window.parent', 'document.open()', 'document.write(m.html)', 'document.close()', "type:'ready',shell:true"]) assert.ok(script.includes(needle), needle);
  assert.ok(script.startsWith('(function(){'), 'no shell globals leak into the written page');
});
