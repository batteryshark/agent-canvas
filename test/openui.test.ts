import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Renderer, type ActionEvent } from '@openuidev/react-lang';
import { LIMITS } from '../src/shared/contract';
import { canvasLibrary } from '../src/ui/openui/library';
import { guideExamples } from '../src/ui/openui/prompt';
import { toSubmission } from '../src/ui/openui/actions';
import { layoutDiagram } from '../src/ui/openui/diagram-layout';

// src/generated is a build product; make sure it exists and matches the library before validating against it.
const root = fileURLToPath(new URL('..', import.meta.url));
const schemaFile = `${root}src/generated/openui-schema.json`, guideFile = `${root}src/generated/openui-guide.md`;
const inputs = ['src/ui/openui/library.tsx', 'src/ui/openui/containers.tsx', 'src/ui/openui/prompt.ts', 'scripts/generate-openui.mjs'].map(f => statSync(`${root}${f}`).mtimeMs);
if (!existsSync(schemaFile) || !existsSync(guideFile) || statSync(schemaFile).mtimeMs < Math.max(...inputs))
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/generate-openui.mjs'], { cwd: root, stdio: 'pipe' });
const { validateOpenUI } = await import('../src/shared/openui-validate');
const guide = readFileSync(guideFile, 'utf8');

const rich = `root = Stack([header, kpis, chartCard, tableCard, diagramTabs, form])
header = CardHeader("Release readiness", "Build 412 against the checklist")
kpis = Stack([passCard, failCard], "row", "m", "stretch", "start", true)
passCard = Card([TextContent("Passing", "small"), TextContent("38", "large-heavy")])
failCard = Card([TextContent("Failing", "small"), TextContent("2", "large-heavy")])
chartCard = Card([CardHeader("Test time by suite"), chart])
chart = BarChart(["unit", "api", "browser"], [Series("seconds", [42, 118, 260])], "grouped", "Suite", "s")
tableCard = Card([failures])
failures = Table([Col("Test", ["checkout totals", "login redirect"]), Col("Owner", ["payments", "identity"]), Col("Runs failed", [3, 1], "number")])
diagramTabs = Tabs([TabItem("flow", "Pipeline", [pipeline])])
pipeline = Diagram([build, test, deploy], [e1, e2, e3], "right")
build = DiagramNode("build", "Build", "CI", "Compiles and packages the app.")
test = DiagramNode("test", "Test", "CI")
deploy = DiagramNode("deploy", "Deploy", "CD", "Blue/green to production.")
e1 = DiagramEdge("build", "test", "artifact")
e2 = DiagramEdge("test", "deploy", "green")
e3 = DiagramEdge("test", "build", "retry")
form = Form("ship", buttons, [decision, reason])
decision = FormControl("Decision", RadioGroup("decision", [RadioItem("Ship", "Release now", "ship"), RadioItem("Hold", "Wait for fixes", "hold")], "hold", { required: true }))
reason = FormControl("Reason", TextArea("reason", "Why?", 3))
buttons = Buttons([Button("Send decision", @ToAssistant("Send release decision"), "primary")])`;

const errorsOf = (source: string) => validateOpenUI(source).errors;
const assertRejects = (source: string, ...patterns: RegExp[]) => {
  const errors = errorsOf(source);
  assert.ok(errors.length > 0, `expected errors for:\n${source}`);
  for (const p of patterns) assert.ok(errors.some(e => p.test(e)), `no error matches ${p}:\n${errors.join('\n')}`);
  return errors;
};

test('a rich view with a chart, a table, a form and a Diagram validates cleanly', () => {
  assert.deepEqual(validateOpenUI(rich), { errors: [], warnings: [] });
});

test('the guide explains Canvas, documents Diagram, and every example in it validates', () => {
  assert.match(guide, /^# Agent Canvas: OpenUI Lang reference/);
  assert.match(guide, /not a chat reply/);
  assert.match(guide, /data\.form/);
  assert.match(guide, /### Diagrams \(Agent Canvas\)\nDiagramNode\(id: string, label: string, group\?: string, detail\?: string\)/);
  assert.match(guide, /Diagram\(nodes: DiagramNode\[\], edges\?: DiagramEdge\[\], direction\?: "right" \| "down"\)/);
  assert.doesNotMatch(guide, /generate realistic\/plausible data/);
  const examples = guideExamples(guide);
  assert.ok(examples.length >= 10, `found ${examples.length} examples`);
  for (const pattern of [/LineChart\(/, /Table\(/, /Form\(/, /Diagram\(/]) assert.ok(examples.some(e => pattern.test(e)), `no example uses ${pattern}`);
  examples.forEach((source, i) => assert.deepEqual(validateOpenUI(source).errors, [], `example ${i + 1}:\n${source}`));
});

test('the generated schema is the extended library with Stack as root', () => {
  const generated = JSON.parse(readFileSync(schemaFile, 'utf8'));
  assert.equal(generated.root, 'Stack');
  for (const name of ['Diagram', 'DiagramNode', 'DiagramEdge', 'BarChart', 'Form']) assert.ok(generated.schema.$defs[name], name);
  assert.deepEqual(generated.schema, JSON.parse(JSON.stringify(canvasLibrary.toJSONSchema())));
});

test('rejects empty, garbage and oversized sources with a way forward', () => {
  assertRejects('   ', /empty/, /root = Stack/);
  assertRejects('Here is the dashboard you asked for!', /not OpenUI Lang/, /root = Stack\(\[\.\.\.\]\)/, /canvas_guide/);
  assertRejects('<div>hello</div>', /root = Stack/);
  assertRejects(`root = Stack([TextContent("${'x'.repeat(LIMITS.openuiSource)}")])`, /limited to 200000/);
});

test('rejects incomplete sources and names what is missing', () => {
  assertRejects('root = Stack([title, chart\ntitle = TextContent("Hi")', /incomplete/);
  assertRejects('root = Stack([title, chart])\ntitle = TextContent("Hi")', /never defined: "chart"/);
  assertRejects('root = Stack([title])\ntitle = TextContent("Hi")\nextra = TextContent("lost")', /not reachable from root.*"extra"/);
});

test('rejects unknown components and missing required props with statement ids and signatures', () => {
  const [unknown] = assertRejects('root = Stack([x])\nx = Sparkline([1, 2, 3])', /Statement "x".*Unknown component "Sparkline"/);
  assert.match(unknown, /Available components: .*Diagram/);
  // The signature is the guide's, so optional arguments read as optional ("variant?") just as the agent learned them.
  assertRejects('root = Stack([b])\nb = Button()', /Statement "b" \(Button\) at \/label: missing required field.*signature: Button\(label: string, action\?: /);
  assertRejects('root = Stack([n])\nn = Diagram([DiagramNode("a")])', /DiagramNode.*\/label.*missing required/);
  assertRejects('root = Stack([t])\nt = Table(42)', /Statement "t" \(Table\) at \/columns: .*expects array/);
});

test('named arguments get one plain error with the signature, not misleading type errors', () => {
  const [error, ...rest] = assertRejects('root = Stack([title, row], direction: "column")\ntitle = TextContent("Hi")\nrow = Stack([a], direction: "row", gap: "l")\na = TextContent("x")',
    /Arguments are positional, not named: remove "direction:", "gap:".*Stack\(children: any\[\], direction\?: "row" \| "column"/);
  assert.ok(error && !rest.length, 'only the one error');
  // Object literals and ternaries are not named arguments.
  assert.deepEqual(validateOpenUI('root = Stack([f])\nf = Form("x", Buttons([b]), [c])\nc = FormControl("Name", Input("name", "e.g. Ada", "text", { required: true }))\nb = Button("Go", @ToAssistant("Go"), "primary")').errors, []);
});

test('images that cannot load are warned about: no network and no file access', () => {
  const { errors, warnings } = validateOpenUI('root = Stack([a, b, c])\na = ImageBlock("/Users/me/shot.png", "Bug")\nb = Image("Logo", "https://example.com/logo.png")\nc = ImageBlock("data:image/png;base64,iVBORw0KGgo=", "Inline")');
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ImageBlock "\/Users\/me\/shot\.png", Image "https:\/\/example\.com\/logo\.png" will show as a blank area/);
  assert.doesNotMatch(warnings[0], /base64/, "a data: URL is fine");
});

test('rejects Query and Mutation, which have no tools in Canvas', () => {
  assertRejects('root = Stack([t])\ndata = Query("list_orders", {}, {rows: []})\nt = Table([Col("Id", data.rows.id)])', /Query\(\) and Mutation\(\) are not available.*"data"/);
});

test('rejects diagrams whose edges point at unknown or duplicate node ids', () => {
  assertRejects('root = Stack([d])\nd = Diagram([a], [e])\na = DiagramNode("api", "API")\ne = DiagramEdge("api", "db")',
    /Diagram "d": edge "e" "api" → "db" refers to unknown node id "db"\. Known ids: "api"/);
  assertRejects('root = Stack([d])\nd = Diagram([a, b])\na = DiagramNode("x", "One")\nb = DiagramNode("x", "Two")', /repeats node id "x"/);
  assertRejects('root = Stack([d])\nd = Diagram([])', /has no nodes/);
});

test('diagrams built with @Each validate and render', () => {
  const source = 'root = Stack([d])\nitems = [{id: "a", label: "Alpha"}, {id: "b", label: "Beta"}]\nd = Diagram(@Each(items, "n", DiagramNode(n.id, n.label)), [DiagramEdge("a", "b")], "down")';
  assert.deepEqual(validateOpenUI(source), { errors: [], warnings: [] });
  const html = renderToStaticMarkup(createElement(Renderer, { response: source, library: canvasLibrary, isStreaming: false }));
  assert.equal((html.match(/class="canvas-diagram-node/g) ?? []).length, 2);
  assert.match(html, /data-direction="down"/);
});

const event = (e: Partial<ActionEvent>): ActionEvent => ({ type: 'continue_conversation', params: {}, humanFriendlyMessage: '', ...e });

test('a button outside a form sends its message, with context but without unrelated view state', () => {
  assert.deepEqual(toSubmission(event({ humanFriendlyMessage: 'Approve the plan', formState: { other: { x: { value: 1 } }, $tab: 'a' } })),
    { kind: 'send', action: 'Approve the plan', data: null });
  assert.deepEqual(toSubmission(event({ humanFriendlyMessage: 'Show details', params: { context: { orderId: 42 } } })),
    { kind: 'send', action: 'Show details', data: { params: { context: { orderId: 42 } } } });
  assert.deepEqual(toSubmission(event({ humanFriendlyMessage: '  ' })), { kind: 'send', action: 'Continue', data: null });
});

test('a form submission flattens its own fields to plain values', () => {
  const formState = {
    cache: { strategy: { value: 'redis', componentType: 'OptionCards' }, ttlMinutes: { value: [15], componentType: 'Slider' }, scope: { value: ['search', 'catalog'], componentType: 'Chips' } },
    other: { ignored: { value: true, componentType: 'SwitchGroup' } },
  };
  assert.deepEqual(toSubmission(event({ humanFriendlyMessage: 'Use this caching plan', formName: 'cache', formState })),
    { kind: 'send', action: 'Use this caching plan', data: { form: { strategy: 'redis', ttlMinutes: [15], scope: ['search', 'catalog'] } } });
  assert.deepEqual(toSubmission(event({ humanFriendlyMessage: 'Send', formName: 'empty', formState: {} })), { kind: 'send', action: 'Send', data: { form: {} } });
});

test('long messages are shortened to the action limit and kept whole in the data', () => {
  const message = `Please ${'investigate '.repeat(20)}now`;
  const result = toSubmission(event({ humanFriendlyMessage: message }));
  assert.equal(result?.kind, 'send');
  if (result?.kind !== 'send') return;
  assert.equal(result.action.length, LIMITS.action);
  assert.ok(result.action.endsWith('…'));
  assert.deepEqual(result.data, { message: message.trim().replace(/\s+/g, ' ') });
});

test('open_url opens http(s) links only and sends nothing', () => {
  assert.deepEqual(toSubmission(event({ type: 'open_url', params: { url: 'https://example.com/docs?q=1' } })), { kind: 'open', url: 'https://example.com/docs?q=1' });
  assert.equal(toSubmission(event({ type: 'open_url', params: { url: 'javascript:alert(1)' } })), null);
  assert.equal(toSubmission(event({ type: 'open_url', params: {} })), null);
});

test('a custom action sends its type and params', () => {
  assert.deepEqual(toSubmission(event({ type: 'approve_plan', params: { plan: 'B', risk: 2 } })), { kind: 'send', action: 'approve_plan', data: { plan: 'B', risk: 2 } });
  assert.deepEqual(toSubmission(event({ type: 'refresh' })), { kind: 'send', action: 'refresh', data: null });
});

test('the Diagram renders accessible node buttons, escapes text, and shows a legend for groups', () => {
  const source = rich.replace('"Build", "CI"', '"Build <b>", "CI"');
  const html = renderToStaticMarkup(createElement(Renderer, { response: source, library: canvasLibrary, isStreaming: false }));
  assert.match(html, /role="group" aria-label="Diagram with 3 nodes/);
  assert.equal((html.match(/<button type="button" class="canvas-diagram-node/g) ?? []).length, 3);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Build &lt;b&gt;/);
  assert.match(html, /<ul class="canvas-diagram-legend" aria-label="Groups">.*CI.*CD/);
  assert.match(html, /<text[^>]*>artifact<title>artifact<\/title><\/text>/);
});

test('Tabs and Accordion open on their first item, not the last one OpenUI streamed', () => {
  const source = `root = Stack([tabs, sections])
tabs = Tabs([TabItem("one", "One", [TextContent("first tab body")]), TabItem("two", "Two", [TextContent("second tab body")])])
sections = Accordion([AccordionItem("a", "A", [TextContent("first section body")]), AccordionItem("b", "B", [TextContent("second section body")])])`;
  assert.deepEqual(validateOpenUI(source).errors, []);
  const html = renderToStaticMarkup(createElement(Renderer, { response: source, library: canvasLibrary, isStreaming: false }));
  assert.match(html, /aria-selected="true"[^>]*>.*?One/);
  assert.match(html, /first tab body/);
  assert.doesNotMatch(html, /second tab body/);
  assert.match(html, /first section body/);
  assert.doesNotMatch(html, /second section body/);
});

test('the layered layout orders nodes along edges, keeps siblings apart, and survives cycles', () => {
  const nodes = ['client', 'gateway', 'auth', 'orders', 'db', 'queue'].map(id => ({ id, label: id }));
  const edges = [['client', 'gateway'], ['gateway', 'auth'], ['gateway', 'orders'], ['orders', 'db'], ['orders', 'queue'], ['auth', 'db'], ['db', 'client'], ['db', 'db'], ['x', 'db']]
    .map(([from, to]) => ({ from, to }));
  for (const direction of ['right', 'down'] as const) {
    const layout = layoutDiagram(nodes, edges, direction);
    const at = Object.fromEntries(layout.nodes.map(n => [n.id, n]));
    const axis = direction === 'right' ? 'x' : 'y';
    assert.ok(at.client[axis] < at.gateway[axis] && at.gateway[axis] < at.orders[axis] && at.orders[axis] < at.db[axis], direction);
    assert.equal(layout.edges.length, 8, 'the edge from an unknown node is dropped; the self-loop is kept');
    for (const a of layout.nodes) {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + layout.node.width <= layout.width && a.y + layout.node.height <= layout.height);
      for (const b of layout.nodes) if (a !== b) {
        const apart = a.x + layout.node.width <= b.x || b.x + layout.node.width <= a.x || a.y + layout.node.height <= b.y || b.y + layout.node.height <= a.y;
        assert.ok(apart, `${a.id} overlaps ${b.id} (${direction})`);
      }
    }
    assert.ok(layout.edges.every(e => /^M[\d.]+,[\d.]+ /.test(e.path) && !e.path.includes('NaN')));
  }
  assert.deepEqual(layoutDiagram([], []).nodes, []);
});
