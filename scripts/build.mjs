// Builds both packages into dist/: the OpenCode plugin with its Canvas service and browser app, and the
// OpenChamber extension with its pane and host bridge. `npm run build` runs generate-openui first.
import { build } from 'esbuild';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { parseManifestJson } from '@openchamber/sdk/schemas';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const fail = message => { throw new Error(`Build failed: ${message}`); };
const exists = path => stat(path).then(() => true, () => false);

for (const file of ['src/generated/openui-schema.json', 'src/generated/openui-guide.md']) {
  if (!await exists(file)) fail(`${file} is missing. Run "npm run build", which generates it first.`);
}
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
// The real map, not a copy: html-check.ts decides which canvas:lib/NAME the service accepts.
const { HTML_LIBRARIES } = await tsImport('../src/shared/html-check.ts', import.meta.url);
if (!HTML_LIBRARIES || !Object.keys(HTML_LIBRARIES).length) fail('src/shared/html-check.ts exports no HTML_LIBRARIES.');

await rm('dist', { recursive: true, force: true });
const OPENCODE = 'dist/opencode', OPENCHAMBER = 'dist/openchamber';
for (const dir of [`${OPENCODE}/web/lib`, `${OPENCHAMBER}/panel/lib`, `${OPENCHAMBER}/service`]) await mkdir(dir, { recursive: true });

// OpenUI keeps its theme context private and fills it only through ThemeProvider, which injects style elements.
// Exposing the context lets src/ui/openui/theme.tsx give charts the Canvas palette and the current mode.
const exposeOpenUITheme = {
  name: 'expose-openui-theme',
  setup(b) {
    b.onLoad({ filter: /[\\/]@openuidev[\\/]react-ui[\\/]dist[\\/]genui-lib[\\/]index\.mjs$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      if (!/\nconst ThemeContext = createContext\(\{/.test(source) || !/\nconst defaultLightTheme = /.test(source)) fail(`${args.path} no longer defines ThemeContext and defaultLightTheme; update exposeOpenUITheme and src/ui/openui/theme.tsx.`);
      return { contents: `${source}\nexport { ThemeContext as __canvasThemeContext, defaultLightTheme as __canvasLightTheme };\n`, loader: 'js', resolveDir: dirname(args.path) };
    });
  },
};
const bundledInputs = new Set();
async function compile(options) {
  const result = await build({ bundle: true, logLevel: 'warning', loader: { '.md': 'text' }, metafile: true, ...options });
  for (const input of Object.keys(result.metafile.inputs)) bundledInputs.add(input);
}
const node = { platform: 'node', target: 'node22', sourcemap: true };
await compile({
  ...node, entryPoints: ['src/opencode/plugin.ts'], outfile: `${OPENCODE}/index.js`, format: 'esm',
  // CommonJS dependencies inside an ESM bundle call require() for Node builtins.
  banner: { js: "import { createRequire as __canvasCreateRequire } from 'node:module'; const require = __canvasCreateRequire(import.meta.url);" },
});
await compile({ ...node, entryPoints: ['src/server/cli.ts'], outfile: `${OPENCODE}/canvas-service.cjs`, format: 'cjs', banner: { js: '#!/usr/bin/env node' } });
await chmod(`${OPENCODE}/canvas-service.cjs`, 0o755);
await compile({ ...node, entryPoints: ['src/openchamber/bridge.ts'], outfile: `${OPENCHAMBER}/service/main.cjs`, format: 'cjs' });

// OpenChamber panels must be classic scripts, so both surfaces get an IIFE. Fonts and images are inlined:
// the service serves only index.html, app.js and app.css, and OpenChamber serves no font types.
const assetLoaders = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.otf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl' };
const page = (head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">${head}<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>Agent Canvas</title><link rel="icon" href="data:,"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>\n`;
// OpenChamber's guest CSP lets the pane's frames load 'self', data: and blob:, so an HTML page could navigate its own
// frame to a document the bridge never runs in (docs/SECURITY.md). The pane's only frame is the srcdoc page, which CSP does
// not check, so the panel adds frame-src 'none'; browsers enforce it alongside the guest header. The browser surface's
// app CSP, whose frame-src names only /frame, is sent by the service.
const PANEL_HEAD = `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'">`;
for (const [surface, dir] of [['browser', `${OPENCODE}/web`], ['openchamber', `${OPENCHAMBER}/panel`]]) {
  await compile({
    entryPoints: ['src/ui/app.tsx'], outfile: `${dir}/app.js`, platform: 'browser', format: 'iife', target: 'es2022', minify: true,
    loader: { '.md': 'text', ...assetLoaders },
    define: { __CANVAS_SURFACE__: JSON.stringify(surface), 'process.env.NODE_ENV': '"production"' },
    plugins: [exposeOpenUITheme],
  });
  if (!await exists(`${dir}/app.css`)) fail(`${dir}/app.css was not produced. src/ui/app.tsx must import its stylesheets, including OpenUI's.`);
  await writeFile(`${dir}/index.html`, page(surface === 'openchamber' ? PANEL_HEAD : ''));
}

const copiedPackages = new Set();
for (const [name, library] of Object.entries(HTML_LIBRARIES)) {
  if (!/^[a-z0-9][a-z0-9.-]{0,40}$/.test(name)) fail(`HTML library name "${name}" is not a safe file name.`);
  const source = join('node_modules', library.file);
  if (!await exists(source)) fail(`HTML library "${name}" points at ${source}, which is not installed.`);
  for (const dir of [`${OPENCODE}/web/lib`, `${OPENCHAMBER}/panel/lib`]) await copyFile(source, join(dir, `${name}.js`));
  copiedPackages.add(packageDirOf(source));
}

await writeFile(`${OPENCODE}/package.json`, JSON.stringify({
  name: 'agent-canvas-opencode', version, license: 'MIT', type: 'module',
  description: 'Agent Canvas for OpenCode 2: a visual surface where agents show OpenUI or HTML views and users answer back.',
  main: 'index.js', exports: { '.': './index.js' }, bin: { 'agent-canvas': 'canvas-service.cjs' },
  files: ['index.js', 'canvas-service.cjs', 'web', 'README.md', 'THIRD_PARTY_NOTICES.md'], engines: { node: '>=22' },
}, null, 2) + '\n');
const manifest = {
  name: 'agent-canvas-openchamber', version, license: 'MIT',
  description: 'Agent Canvas pane: see and answer the views your OpenCode agent shows, beside the conversation.',
  openchamber: {
    apiVersion: 1, engines: { openchamber: '>=2.3.0' },
    contributes: {
      panel: { id: 'agent-canvas', name: 'Agent Canvas', icon: 'layout', entry: 'panel/index.html' },
      page: true,
      service: { entry: 'service/main.cjs', runtime: 'host' },
      tools: [{ match: 'canvas_*', name: 'Agent Canvas', icon: 'layout', title: '{input.title}', output: 'markdown' }],
    },
  },
};
await writeFile(`${OPENCHAMBER}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
const parsed = parseManifestJson(await readFile(`${OPENCHAMBER}/package.json`, 'utf8'));
if (!parsed.ok) fail(`invalid OpenChamber manifest: ${JSON.stringify(parsed)}`);
for (const dir of [OPENCODE, OPENCHAMBER]) await copyFile('README.md', join(dir, 'README.md'));

// Notices: every package esbuild pulled in, plus each copied library and the dependencies bundled inside it.
function packageDirOf(file) {
  const parts = resolve(file).split(sep), at = parts.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  return parts.slice(0, at + (parts[at + 1]?.startsWith('@') ? 3 : 2)).join(sep);
}
const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const declared = pkg => pkg.license ?? pkg.licenses?.map(l => l.type ?? l).join(' OR ');
const person = value => typeof value === 'string' ? value : value?.name;
/** Who holds the copyright of an MIT package that ships no license file: its readme's line, else its author. */
async function copyrightOf(dir, pkg) {
  if (pkg.name.startsWith('@opencode/')) return 'Copyright (c) 2025 opencode';
  const readme = (await readdir(dir)).find(name => /^readme(\.(md|markdown|txt))?$/i.test(name));
  const line = readme && (await readFile(join(dir, readme), 'utf8')).split('\n').find(l => /^\s*copyright\b/i.test(l));
  if (line) return line.trim();
  const holder = person(pkg.author) ?? person(pkg.contributors?.[0]) ?? person(pkg.maintainers?.[0]);
  return holder && `Copyright (c) ${holder}`;
}
const notices = new Map(), unlicensed = new Map();
async function notice(dir, via) {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (notices.has(key) || unlicensed.has(key)) return pkg;
  const file = (await readdir(dir)).find(name => /^(licen[cs]e|copying)([.-].*)?$/i.test(name));
  let text = file ? await readFile(join(dir, file), 'utf8') : undefined, license = declared(pkg) ?? 'see text';
  // Some MIT packages declare the license in package.json only. MIT is the copyright line plus fixed terms, so
  // rebuild it from the declared holder; any other license must ship its own text.
  if (!text && declared(pkg) === 'MIT') {
    const copyright = await copyrightOf(dir, pkg);
    if (copyright) { text = `MIT License\n\n${copyright}\n\n${MIT_TERMS}`; license = 'MIT (declared in package.json; the package ships no license file)'; }
  }
  if (!text) unlicensed.set(key, via);
  else notices.set(key, { license, text: text.trim() });
  return pkg;
}
/** Node's lookup: the package's own node_modules first, then each parent's. */
async function installedDir(name, from) {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (await exists(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}
const visited = new Set();
async function noticeWithDependencies(dir, via) {
  if (visited.has(dir)) return;
  visited.add(dir);
  const pkg = await notice(dir, via);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith('@types/')) continue;
    const found = await installedDir(dep, dir);
    if (!found) fail(`${dep}, a dependency bundled inside ${pkg.name}, is not installed, so its license cannot be included.`);
    await noticeWithDependencies(found, `bundled inside ${pkg.name}`);
  }
}
for (const input of bundledInputs) {
  if (!input.includes('node_modules/')) continue;
  // Nested package.json files (dist/esm/package.json) carry no name; walk up to the package that does.
  for (let dir = dirname(resolve(input)); dir !== dirname(dir); dir = dirname(dir)) {
    let pkg;
    try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); } catch { continue; }
    if (!pkg.name) continue;
    await notice(dir, `bundled from ${input}`);
    break;
  }
}
for (const dir of copiedPackages) await noticeWithDependencies(dir, 'copied HTML library');
if (unlicensed.size) fail(`no license text for:\n  ${[...unlicensed].map(([key, via]) => `${key} (${via})`).join('\n  ')}\nAdd each license before shipping it.`);
const noticeText = `# Third-party notices\n\nAgent Canvas ${version} bundles or copies the following packages. Each is listed with its license text.\n\n`
  + [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `## ${key}\n\nLicense: ${n.license}\n\n\`\`\`text\n${n.text.replaceAll('```', "'''")}\n\`\`\``).join('\n\n') + '\n';
for (const dir of [OPENCODE, OPENCHAMBER]) await writeFile(join(dir, 'THIRD_PARTY_NOTICES.md'), noticeText);

// The plugin is loaded by OpenCode as ESM; a syntax-level check catches a bad banner or bundling mistake here.
const check = spawnSync(process.execPath, ['--check', `${OPENCODE}/index.js`], { encoding: 'utf8' });
if (check.status !== 0) fail(`${OPENCODE}/index.js does not parse as a module:\n${check.stderr}`);
const required = [
  `${OPENCODE}/index.js`, `${OPENCODE}/canvas-service.cjs`, `${OPENCODE}/web/index.html`, `${OPENCODE}/web/app.js`, `${OPENCODE}/web/app.css`,
  `${OPENCHAMBER}/panel/index.html`, `${OPENCHAMBER}/panel/app.js`, `${OPENCHAMBER}/panel/app.css`, `${OPENCHAMBER}/service/main.cjs`,
];
for (const file of required) if (!await exists(file)) fail(`${file} is missing.`);
console.log(`Built Agent Canvas ${version}: ${relative(root, OPENCODE)} (plugin, service, browser app) and ${relative(root, OPENCHAMBER)} (pane, host bridge); ${Object.keys(HTML_LIBRARIES).length} libraries, ${notices.size} notices.`);
