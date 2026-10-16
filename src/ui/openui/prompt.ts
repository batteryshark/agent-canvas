// The OpenUI Lang reference that canvas_guide({ topic: 'openui' }) returns, generated from the
// library so signatures never drift. scripts/generate-openui.mjs writes it to src/generated/.
import { openuiAdditionalRules, openuiExamples, openuiPromptOptions } from '@openuidev/react-ui/genui-lib';
import { canvasLibrary } from './library';

export const CANVAS_PREAMBLE = `# Agent Canvas: OpenUI Lang reference

You are writing an Agent Canvas view in OpenUI Lang. The source you pass to canvas_show is one complete view that Agent Canvas shows beside the chat: in an OpenChamber pane, a browser tab, or on the user's phone. It is not a chat reply, so do not greet or address the user inside it. Every canvas_show call with a viewId replaces the whole view with a new revision; read the view first so you revise what the user actually saw.

How the user's input reaches you:
- A Button with @ToAssistant("message") sends that message back to this conversation as the action, with any context argument under data.params. A Button without an action sends its label.
- Inside a Form, the primary Button checks the field rules, then sends its action with every field of that Form under data.form, keyed by each input's name. EditableTable's Save Changes sends the edited rows the same way.
- @OpenUrl("https://...") opens the link for the user in a new tab; nothing is sent to you.
- Everything else (Tabs, Accordion, Modal, $variables, @Set, @Reset, sorting, filtering, clicking a Diagram node) stays inside the view.
- Input arrives later as a new user message that starts with "[Agent Canvas]" and names the view, revision, action and data. Never claim the user chose or entered something until that message arrives.

What each input puts in data.form:
- Input and TextArea: the text as a string, also for Input type "number" ("8", not 8); convert it yourself.
- Select, RadioGroup, and Chips or OptionCards in "single" mode: the chosen value as a string; Chips and OptionCards in "multiple" mode: an array of values.
- CheckBoxGroup and SwitchGroup: an object of each item's name to true or false.
- Slider: an array, [value] for one thumb or [low, high] for a range.
- DatePicker: "YYYY-MM-DD" in "single" mode; { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } in "range" mode.
- A field the user never touched and that has no default is missing.

Keep views focused: one purpose per view, a clear CardHeader first, then the information the user needs, then the controls that answer it. Use real data from the project and the conversation. The canvas has no network, so Query(), Mutation(), @Run and remote images do not work: inline every value.`;

export const CANVAS_RULES = [
  'Use real values from the project and conversation. Label estimates or illustrative numbers as such; never present invented data as measured.',
  'Make each @ToAssistant message a short imperative under 120 characters that still makes sense on its own, e.g. "Use caching plan B": it becomes the action label of the input you receive.',
  'Put every input whose value you need inside a Form, give each input a descriptive name (it is the key you receive), and give the Form one primary Button with @ToAssistant.',
  'Images only render from data:image/… URLs: there is no network and no file access, so a path or https URL shows a blank area. Leave images out unless you have one.',
  'TextContent and MarkDownRenderer render headings, lists, emphasis, links and code, not markdown tables: use Table for anything tabular.',
  'Always pass Slider its label argument, or put it in a FormControl; a Slider without either shows only the track.',
  'Built-in functions return raw numbers (7289, 0.4231). Write display strings yourself, such as "7,289" or "42.3%", when formatting matters.',
  'EditableTable: Save Changes sends the edited rows to you; use Table for read-only data.',
  '$variables are reactive: changing one with a Select or @Set re-evaluates every expression that uses it.',
  'Diagram: define each DiagramNode and DiagramEdge as its own statement, keep ids unique, labels short (about 24 characters) and explanations in detail. Use direction "down" for hierarchies and for anything deeper than about four layers, which is too wide for a pane or phone left to right; "right" suits short flows.',
  'The view follows the user\'s light or dark theme; do not hard-code colors.',
];

const CANVAS_EXAMPLES = [
  `Dashboard with metrics, a chart and a table

root = Stack([header, kpis, trendCard, tableCard, actions])
header = CardHeader("API latency this week", "p95 per service from Monday's load test")
kpis = Stack([kpiLatency, kpiErrors, kpiThroughput], "row", "m", "stretch", "start", true)
kpiLatency = Card([TextContent("p95 latency", "small"), TextContent("212 ms", "large-heavy"), Tag("+18% vs last week", null, "sm", "warning")])
kpiErrors = Card([TextContent("Error rate", "small"), TextContent("0.42%", "large-heavy"), Tag("Within budget", null, "sm", "success")])
kpiThroughput = Card([TextContent("Peak throughput", "small"), TextContent("1,840 rps", "large-heavy"), Tag("Steady", null, "sm", "neutral")])
trendCard = Card([CardHeader("p95 by day (ms)"), trend])
trend = LineChart(days, [authSeries, searchSeries], "natural", "Day", "ms")
days = ["Mon", "Tue", "Wed", "Thu", "Fri"]
authSeries = Series("auth", [150, 158, 162, 171, 190])
searchSeries = Series("search", [180, 176, 201, 214, 236])
tableCard = Card([CardHeader("Slowest endpoints"), slowest])
slowest = Table([Col("Endpoint", endpoints), Col("p95 (ms)", p95, "number"), Col("Calls", calls, "number")])
endpoints = ["GET /search", "POST /login", "GET /orders"]
p95 = [236, 190, 154]
calls = [48210, 12034, 30177]
actions = Buttons([profileBtn, compareBtn])
profileBtn = Button("Profile /search", @ToAssistant("Profile GET /search"), "primary")
compareBtn = Button("Compare with last release", @ToAssistant("Compare latency with the last release"), "secondary")`,

  `Decision form whose answers come back to you as data.form

root = Stack([header, why, form])
header = CardHeader("Choose a caching strategy", "Pick one and I will implement it next")
why = Callout("info", "Why now", "Search p95 doubled after the catalog grew to 2M items.")
form = Form("cache", buttons, [strategyField, ttlField, scopeField, notesField])
strategyField = FormControl("Strategy", strategy)
strategy = OptionCards("strategy", "single", [optRedis, optCdn, optMemo], { required: true })
optRedis = OptionCard("redis", "Redis read-through", "Shared across pods; adds a dependency", Icon("database", "development"))
optCdn = OptionCard("cdn", "CDN edge cache", "Cheapest; anonymous traffic only", Icon("globe", "connectivity"))
optMemo = OptionCard("memo", "In-process memo", "No new infrastructure; per-pod hit rate", Icon("cpu", "devices"))
ttlField = FormControl("Cache lifetime (minutes)", ttl)
ttl = Slider("ttlMinutes", "discrete", 1, 60, 1, [15])
scopeField = FormControl("Apply to", scope, "Select all that apply")
scope = Chips("scope", "multiple", [ChipItem("search", "Search"), ChipItem("catalog", "Catalog"), ChipItem("reviews", "Reviews")])
notesField = FormControl("Constraints", notes)
notes = TextArea("constraints", "Anything I should keep in mind?", 3)
buttons = Buttons([useBtn, explainBtn])
useBtn = Button("Use this plan", @ToAssistant("Use this caching plan"), "primary")
explainBtn = Button("Explain the trade-offs first", @ToAssistant("Explain the caching trade-offs first"), "secondary")`,

  `Comparison of two options, then a choice

root = Stack([header, tabs, verdict, pick])
header = CardHeader("Postgres or SQLite for the sync service", "Measured on this repository's fixtures")
tabs = Tabs([summaryTab, benchTab])
summaryTab = TabItem("summary", "Summary", [compareTable])
compareTable = Table([Col("Aspect", aspects), Col("Postgres", pg), Col("SQLite", lite)])
aspects = ["Concurrent writers", "Operations", "Migration effort", "Local development"]
pg = ["Many", "Managed instance", "About 2 days", "Needs Docker"]
lite = ["One at a time", "None", "Half a day", "Zero setup"]
benchTab = TabItem("bench", "Benchmarks", [bench])
bench = BarChart(["Insert", "Query", "Sync batch"], [pgSeries, liteSeries], "grouped", "Operation", "ms")
pgSeries = Series("Postgres", [4.1, 1.2, 38])
liteSeries = Series("SQLite", [2.3, 0.9, 51])
verdict = Callout("success", "Recommendation", "SQLite until a second writer appears; the schema stays portable.")
pick = Buttons([sqliteBtn, postgresBtn])
sqliteBtn = Button("Go with SQLite", @ToAssistant("Go with SQLite"), "primary")
postgresBtn = Button("Go with Postgres", @ToAssistant("Go with Postgres"), "secondary")`,

  `Diagram the user can explore node by node

root = Stack([header, card])
header = CardHeader("How an order reaches the database", "Select a component for details")
card = Card([flow, next])
flow = Diagram([client, gateway, auth, orders, db, outbox], [e1, e2, e3, e4, e5, e6])
client = DiagramNode("client", "Web client", "Edge", "React app; retries idempotent calls twice.")
gateway = DiagramNode("gateway", "API gateway", "Edge", "Terminates TLS and rate-limits per token.")
auth = DiagramNode("auth", "Auth service", "Services", "Validates JWTs and caches signing keys for 10 minutes.")
orders = DiagramNode("orders", "Orders service", "Services", "Owns order state; every write goes through the outbox.")
db = DiagramNode("db", "Postgres", "Data", "Primary plus one read replica.")
outbox = DiagramNode("outbox", "Outbox queue", "Data", "Delivers events to billing at least once.")
e1 = DiagramEdge("client", "gateway", "HTTPS")
e2 = DiagramEdge("gateway", "auth", "verify token")
e3 = DiagramEdge("gateway", "orders", "route")
e4 = DiagramEdge("orders", "db", "SQL")
e5 = DiagramEdge("orders", "outbox", "publish")
e6 = DiagramEdge("auth", "db", "read users")
next = Buttons([traceBtn])
traceBtn = Button("Trace a failing order", @ToAssistant("Trace a failing order through this flow"), "primary")`,
];

// Upstream rules that do not hold in Canvas: no tools, no network, input goes to the agent.
const DROPPED_RULES = [
  'When asked about data, generate realistic/plausible data',
  '$variables are reactive: changing via Select or @Set re-evaluates all Queries',
  'Multi-query refresh:',
  'Use @Reset($var1, $var2) after form submit',
  'Image URLs must be real',
  'EditableTable requires the consuming app',
];

export function buildOpenUIGuide() {
  for (const prefix of DROPPED_RULES) if (!openuiAdditionalRules.some(r => r.startsWith(prefix))) throw new Error(`OpenUI no longer has the rule "${prefix}…"; review DROPPED_RULES.`);
  const examples = [...openuiExamples, ...CANVAS_EXAMPLES.map((e, i) => `Example ${openuiExamples.length + i + 1} — ${e.replace('\n\n', ':\n\n')}`)];
  const guide = canvasLibrary.prompt({
    ...openuiPromptOptions,
    preamble: CANVAS_PREAMBLE,
    examples,
    additionalRules: [...openuiAdditionalRules.filter(r => !DROPPED_RULES.some(p => r.startsWith(p))), ...CANVAS_RULES],
    // $variables and built-in functions run in the view without tools: filters, sorting, show/hide.
    bindings: true,
    builtinFunctions: true,
  });
  if (!guide.includes('\n### Other\n')) throw new Error('The OpenUI prompt no longer has an "Other" section for Canvas components.');
  // Upstream lines elsewhere in the reference that assume Query() and Mutation(), which Canvas does not have.
  const edited = CANVAS_EDITS.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`The OpenUI prompt no longer contains "${from}"; review CANVAS_EDITS.`);
    return text.replace(from, () => to);
  }, guide);
  return edited.replace('\n### Other\n', '\n### Diagrams (Agent Canvas)\n');
}

const CANVAS_EDITS: Array<[string, string]> = [
  ['- Shared filter across Tabs: same $days binding in Query args works across all TabItems', '- Shared filter across Tabs: one $variable set by a Select can filter the data in every TabItem'],
  [' For errors: result.status == "error" ? Callout("error", "Failed", result.error) : null', ''],
  ['Do NOT hardcode computed values.', 'Use them when they keep totals consistent with the data; they return raw numbers, so format display text yourself.'],
];

/** The source of every example in a generated guide, for tests that must keep them valid. */
export function guideExamples(guide: string) {
  const start = guide.indexOf('\n## Examples\n'), end = guide.indexOf('\n## ', start + 1);
  if (start < 0) return [];
  return guide.slice(start, end < 0 ? undefined : end).split(/^Example \d+ — .*:\s*$/m).slice(1).map(s => s.trim()).filter(Boolean);
}
