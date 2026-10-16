# Agent Canvas architecture

Version 0.2. A hard-cutover rebuild of 0.1 (see PROJECT.md, D1–D3). The 0.1 code is readable with `git show HEAD:<path>` for proven patterns; nothing from it is kept as legacy.

## What the agent gets

Four OpenCode 2 tools:

| Tool | Input | Returns |
| --- | --- | --- |
| `canvas_guide` | `{ topic?: 'overview' \| 'openui' \| 'html' }` (default `overview`) | Reference text. `openui` is the generated OpenUI Lang component reference; `html` documents the page bridge, theme variables, and bundled libraries. |
| `canvas_show` | `ShowInput`: `{ title, summary?, format: 'openui' \| 'html', source, viewId?, expectedRevision? }` | Markdown: view id, revision, viewing link, warnings. On invalid content, a tool error listing repairable problems. |
| `canvas_read` | `{ viewId? }` | Without id: `ViewListing` for this conversation and its project. With id: `ViewDetail`, including the latest source, client render errors, and the last interactions. |
| `canvas_pin` | `{ viewId, name, expectedRevision }` | Confirmation. Makes the view a named project view. |

The system note added to every conversation is short: Canvas exists, what it is good for (mockups, charts, tables, forms, diagrams, comparisons, interactive pages), call `canvas_guide` for the format before first use in a conversation, include the returned link, read before revising, never claim input arrived until it appears as a message.

User input reaches the conversation as a queued user message whose text is `interactionPrompt()` from the contract:

```
[Agent Canvas] Checkout redesign (view 7c1e…, revision 3)
Action: Choose layout B
Data:
```json
{ "layout": "B", "density": "compact" }
```
Note: keep the old header
```

## Content formats

### OpenUI (`format: 'openui'`)

- Library: `openuiLibrary` from `@openuidev/react-ui/genui-lib` (82 components; root `Stack`) extended with Canvas components via `openuiLibrary.extend({ components: { add: [...] } })`. Import from `/genui-lib`, never the package root.
- Canvas extension components: `Diagram` (directed graph: nodes with id, label, optional group/kind and detail; edges with optional label; click a node to see its detail; layered layout; a graph slightly wider than its container shrinks to fit, a much wider one scrolls, and a "Fit to width" / "Actual size" toggle switches between them). Add others only if a real gap appears.
- Canvas overrides of upstream components, same schema and description (`src/ui/openui/defaults.tsx`, `containers.tsx`):
  - `Tabs`, `Accordion`: open on the first item.
  - `RadioGroup`, `Slider`, `CheckBoxGroup`, `SwitchGroup`: store their default in form state. A `Slider` without a label hides its field name.
  - `DatePicker`: stores `"YYYY-MM-DD"` (a `{ from, to }` pair for a range) built from local date parts, so required-field validation sees a value and no time zone shifts the day; the calendar closes on pick and on Escape.
  - `ScatterChart`: shows the `xLabel`/`yLabel` that upstream drops, as a caption under the chart.
- Theme: `src/ui/openui/theme.tsx` fills OpenUI's private theme context with the Canvas chart palette (`--chart-1…6` per mode, ordered for OpenUI's middle-out color picking) and the current mode. `scripts/build.mjs` exposes that context from `genui-lib` with an esbuild plugin and fails the build if upstream renames it. `openui.css` maps OpenUI's accent variables to the shell's `--accent*`, gives `Card`'s default "card" variant a visible surface, and lets cards in a wrapping row keep a 14rem basis so they wrap on a phone.
- Validation (service side, no DOM): `createParser(schema, root).parse(source)` from `@openuidev/lang-core`. Reject when `root` is null, `meta.incomplete` is true, or `meta.errors` contains errors. Report `unresolved` and `orphaned` statements as errors. Messages go back to the agent verbatim, with each signature replaced by the guide's (optional arguments marked `?`).
  - Named arguments (`Stack([a], direction: "row")`) are found before parsing and reported as one error with the component's signature, instead of the parser's misleading type and reference errors.
  - Warnings for image sources that are not `data:image/` URLs (`Image`, `ImageBlock`, `ImageGallery`, `ImageText`, `ImageTextLarge`, `ListItem`, `ContextCardItem`, `VisualCardItem`): they render blank. The view reports images that fail to load as render errors.
- Generated at build time by `scripts/generate-openui.mjs` (run with tsx) into `src/generated/` (gitignored): `openui-schema.json` (`{ root, schema, signatures }`: `library.toJSONSchema()` plus each component's signature line from the guide) and `openui-guide.md` (`library.prompt({...openuiPromptOptions, preamble})` with a Canvas preamble: the source is a whole view, not a chat reply; how actions reach the agent; the shape of each input's value in `data.form`). Upstream rules and notes that assume `Query()`/`Mutation()` are dropped or rewritten (`DROPPED_RULES`, `CANVAS_EDITS` in `prompt.ts`); generation fails if one of them no longer matches.
- Actions → submissions:
  - `continue_conversation` → `action` = `humanFriendlyMessage` or `'Continue'`; `data` = `{ params?, form?: { [field]: value } }` with `formState` flattened to plain values.
  - `open_url` → open in a new tab or the host browser; nothing is sent.
  - Any custom action type → `action` = type, `data` = params.
- Drafts: `onStateUpdate` snapshots saved (debounced) as the view's draft; restored through `initialState`. The pending snapshot is handed over on `pagehide` and when the page is hidden, so a reload right after typing keeps it.
- Render errors (`onError`) are reported to `/api/report`.
- CSS: `@openuidev/react-ui/styles/index.css` bundled into `app.css`. Force the mode with `<html data-openui-theme>`. Set an explicit body font stack. Never use `ThemeProvider` (it injects style elements); the theme context comes from `theme.tsx` instead. Call `z.config({ jitless: true })` before rendering.

### HTML (`format: 'html'`)

A complete, self-contained HTML document. It runs in a nested iframe whose origin is opaque. CSP blocks every fetch and load the page can make; the paths CSP does not govern are refused in the source and guarded at run time (see **Network paths outside CSP**).

- **Frame modes:**
  - **Pane, `srcdoc`:** inherits the OpenChamber guest policy and the panel's own `frame-src 'none'` (see **Network paths outside CSP**). Inline scripts run, remote scripts are blocked, the sandbox is `allow-scripts`.
  - **Browser, `shell`:** iframe `src="/frame"`, `sandbox="allow-scripts"`. The service serves a static shell under its own CSP. The parent posts the built document, and the shell calls `document.open(); document.write(html); document.close()`. The shell's CSP stays in force.
- **`/frame` CSP:** `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`. Same in spirit as the pane: nothing CSP governs reaches the network, so a page behaves the same on every surface (for what CSP does not govern, see **Network paths outside CSP**).
- **Built document:** `buildDocument(source, options)` inserts at the top of `<head>`:
  - a theme `<style>` defining OpenChamber-compatible variables on `:root`: `--background`, `--foreground`, `--muted`, `--muted-foreground`, `--card`, `--card-foreground`, `--border`, `--primary`, `--primary-foreground`, `--destructive`, `--warning`, `--success`, `--info`, `--chart-1`…`--chart-6`, `--radius`, `--font-sans`, `--font-mono`; plus `color-scheme`;
  - `<meta http-equiv="x-dns-prefetch-control" content="off">`;
  - the bridge `<script>`;
  - inlined bundled libraries.

  It also replaces every nested-frame start tag (`frameTags`) and every speculative `<link>` and speculation-rules script (`speculativeTags`, both from `html-check.ts`) with a comment, keeping line numbers, and ignores library tags inside HTML comments, as `checkHtml` does.
- **Bundled libraries:** a page asks for one with `<script src="canvas:lib/NAME"></script>`, which is replaced by the library inline before rendering. `HTML_LIBRARIES` maps names to files:
  - `tailwind`: `@tailwindcss/browser` `dist/index.global.js`
  - `chart.js`: `chart.js` `dist/chart.umd.min.js`
  - `d3`: `d3` `dist/d3.min.js`
  - `mermaid`: `mermaid` `dist/mermaid.min.js`, about 5.5 MB, so use it only when needed

  The build copies them to `dist/opencode/web/lib/` and `dist/openchamber/panel/lib/`. The browser fetches `/lib/NAME.js`. The pane fetches `./lib/NAME.js` from its own package and falls back to the host service route `/lib/NAME`.
- **Bridge API**, `window.canvas`:
  - `canvas.send(action: string, data?: unknown): Promise<void>` resolves once the input is queued and rejects with the reason (stale revision, too large, not connected, no user gesture). It works only while the user is acting in the page (see **User gestures**).
  - `canvas.state.get(): unknown | null` and `canvas.state.set(value): void` hold a JSON draft (64 KB or less) that is restored on reload.
  - `canvas.view`: `{ id, revision, title }`.
  - `canvas.theme`: `{ appearance, variables }`, and `canvas.onTheme(cb)`.
  - `canvas.openLink(url)` opens http(s) links. Plain `<a href="http...">` clicks are intercepted to do the same, and so is `window.open`. Links open only while the user is acting in the page (see **User gestures**).
- **User gestures.** A `send` or `link` message counts only when the host's own window shows transient user activation (`navigator.userActivation.isActive`) and its `document.activeElement` is this frame, meaning the click or key press landed in the page and not elsewhere in the app. The page cannot fake either: they are read in the host realm (`userActingIn` in `HtmlView.tsx`). The bridge checks the frame's own activation first only to give the page a clear error. So a page cannot open a link or send input on load, from a timer, or by posting the bridge's messages itself; a pinned page another conversation wrote cannot inject input either. Browsers without the User Activation API fall back to the focus check alone.
- **Declarative sends.** The pane sandbox blocks real form submission, and the browser frame matches that:
  - `<form data-canvas-action="Label">`: submit-button clicks and Enter are intercepted, `FormData` is collected (a repeated name becomes an array, a checkbox becomes a boolean) and sent as `data`.
  - `<button data-canvas-action="Label" data-canvas-data='{"json":true}'>` sends on click.
- **Sizing:** a ResizeObserver posts the document height. The host sets the iframe height between 240 px and 85% of the viewport height, and the frame scrolls beyond that. A full-screen toggle fills the content area.
- **Errors:** `window.onerror` and `unhandledrejection` are reported to the host, which posts them to `/api/report`. A page that cannot be built (an unknown or unloadable library) is reported the same way.
- **Drafts:** form drafts are posted to the host as soon as a field changes (coalesced per task); the host stores them with a short delay and flushes when the app is hidden or unloads.
- **Network paths outside CSP.** Chrome starts a prerender (NoStatePrefetch) for `<link rel="prerender">` even under `default-src 'none'`, and CSP does not govern WebRTC, so a page could reach a server of its choosing without a click. A nested frame (a `srcdoc` iframe, `about:blank`, `<object>`, `<embed>`) would bring fresh globals that no run-time guard reaches, so pages cannot have one. Canvas closes all three:
  - `checkHtml` rejects prerender, prefetch, dns-prefetch and preconnect links, speculation-rules scripts, `RTCPeerConnection`/`RTCDataChannel`/`RTCIceTransport`, and `<iframe>`, `<frame>`, `<object>`, `<embed>` and `<fencedframe>` start tags anywhere in the source, script strings included;
  - `buildDocument` strips such tags from older or obfuscated sources;
  - before page scripts run, the bridge deletes the WebRTC constructors and guards every way to create a speculative link or script, or a frame, at run time:
    - creation: `createElement` and `createElementNS` refuse frame names; the `rel` and `type` setters, `relList` and its token methods, `setAttribute(NS)`, and attribute nodes (`setAttributeNode`, `setNamedItem`, `Attr.value`) refuse speculative values;
    - insertion: every node-insertion method (on `Node`, elements, text and doctype nodes, documents and fragments, `moveBefore`, `Range.insertNode`/`surroundContents`, the `document.body` setter) refuses a node that is or contains a frame, and scrubs speculative links before the node joins the document;
    - markup: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `setHTMLUnsafe`/`setHTML`, `Document.parseHTMLUnsafe`, `execCommand('insertHTML')` and `document.write` refuse any frame start tag, and parse link markup inert first, template contents (declarative shadow roots) included. `document.write` also refuses text that ends inside a tag, comment, script or style: the markup after it, from the next write or the page's own source, would finish the tag unchecked (`'<ifr'` then `'ame srcdoc=…>'`);
    - `contentWindow`, `contentDocument` and `getSVGDocument` of frame elements return `null`;
    - backstops: a `MutationObserver` on the document and every shadow root removes any frame and defuses any link that lands, and a capturing `load` listener removes a frame in its own synchronous load event, before page listeners run.

  The guards use only natives captured before page scripts run, called through `Reflect.apply`, so a page that redefines built-ins (`Function.prototype.call`, `RegExp.prototype.exec`, a node's own `localName`) cannot change their answers or obtain an unguarded native. They hold only while the page has no fresh realm, so a new browser API that creates a browsing context, or a DOM insertion path the bridge does not wrap, would reopen the gap until added here.

  A page could also leave the guards behind by navigating its own frame to a new document (through `location`, a link click it keeps from bubbling past the bridge, or a meta refresh): the new document has no bridge. The `frame-src` of the document around the frame decides such a navigation, not the page's own policy:
  - **Pane:** OpenChamber's guest CSP allows `frame-src 'self' data: blob:`, so the panel's `index.html` (written by `scripts/build.mjs` for the pane only) adds `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'">`. The browser enforces it together with the guest header, so every navigation of the HTML frame is refused. The `srcdoc` page itself is not fetched, so CSP does not check it. OpenChamber's relay mode renders the panel as `srcDoc` with the guest policy as its first `<meta>` and, by the SDK's documentation, keeps the panel's own CSP.
  - **Browser:** the app CSP's `frame-src` names one URL, `/frame` at the address the browser is using (`frame-src http://127.0.0.1:4317/frame`, or the Tailscale origin's), so every other navigation of the HTML frame is refused: `data:`, `blob:`, and any other Canvas URL, such as `/api/snapshot`. A CSP path needs a host-source, so the service builds the policy for each request from its `Host` header, which must be the host of a trusted origin: the endpoint, its `localhost` name, or the public URL (Tailscale Serve passes the browser's `Host` on). At any other host the app is not served. CSP percent-decodes the path and ignores the query, so the service serves the shell at every spelling it allows (`/%66rame`, `/frame?x`); such a navigation reloads the shell, which renders the page again, as a self-reload does. CSP also skips path matching after a redirect, so the service never redirects.

  Chrome shows its error page in a frame whose navigation was refused. The page cannot be held in place instead: `location` cannot be wrapped, and the Navigation API fires no `navigate` event in an opaque-origin document. The refusal does reach the host realm, though: the app or panel document whose `frame-src` refused it receives a `securitypolicyviolation` event, and `HtmlView.tsx` then replaces the frame with a notice ("This page tried to navigate away from the canvas and was stopped", with a button to show the page again) and reports a render error that tells the agent to use `canvas.openLink` or in-page content. It never reloads the page on its own, since a page that navigates on load would loop. CSP does not check a navigation to `about:blank`: in the browser such a frame turns blank, with nothing left to run, and is not reported. See PROJECT.md Q4.
- **Message channel:** `{ channel: 'agent-canvas', v: 1, type, ... }`. The host accepts messages only when `event.source` is its own frame's `contentWindow`, and `send` and `link` only during a user gesture. Host → frame: `render` (shell mode), `theme`, `ack`. Frame → host: `ready`, `send`, `state`, `size`, `link`, `error`.
- **Service-side `checkHtml(source)`:**
  - errors: empty source, an unknown `canvas:lib/NAME`, size over the limit, speculative links and speculation rules, WebRTC, nested frames;
  - warnings: remote `<script src>`, `<link href>` or `@import` (they will not load); `<form>` without `data-canvas-action`; `fetch(` or `XMLHttpRequest` (no network).
  - HTML comments are ignored for every check, and `libraryTags` ignores them too, so the service, the viewer and `buildDocument` agree on which libraries a page uses.

## Service

`node dist/opencode/canvas-service.cjs serve|demo|public-url`. Binds loopback only. Data lives in `AGENT_CANVAS_HOME`, default `~/.local/share/agent-canvas`, and is made up of:
- `connection.json`: endpoint, agent token, public URL; created with mode 0600.
- `state.json`: format version 2. Any other version fails with a message telling the user to move the file aside; there is no migration.

Store, `src/server/store.ts`. It keeps the 0.1 semantics, rebuilt:
- `register`, `session`, `viewer`, `resolve`, as in 0.1.
- `show(ShowRequest) → { id, revision, warnings }`:
  - Validates with `validateOpenUI` or `checkHtml`; errors become a 400 with every message.
  - A new view gets a new id. Revising needs `expectedRevision === latest`, otherwise 409.
  - Sets `session.views[id]`.
- `read(session, viewId?)`, which produces `ViewListing` or `ViewDetail`.
- `pin`, `revision`, `snapshot` (which also expires stale `sending` leases).
- `submit(session, Submission)`. It:
  - checks the session key, the latest revision, and the size limits;
  - is idempotent on the same id with the same content, and returns 409 for the same id with different content;
  - sets `messageId` to `msg_canvas` plus the uuid without dashes;
  - builds `prompt` with `interactionPrompt`.
- `retry` (unsent only), `claim(owner, projectRoot?)`, `acknowledge(owner, result)`, `report(session, Report)`.
- `claim` with a `projectRoot` first adopts that project's sessions whose owner is not live (no claim or registration for 10 seconds, counting from service start for owners never seen). After an OpenCode restart the new plugin instance therefore delivers queued input, and the viewer shows the agent as connected, before anyone types in the conversation.
- `snapshot` lists each view's shown revision without its source (`RevisionInfo`); the viewer fetches the source with `GET /api/revision`. This keeps snapshots small however many views a project holds (OpenChamber drops service answers over 8 MB).
- The 30-second lease turns a stalled `sending` into `uncertain`. A restart turns `sending` into `uncertain`.

HTTP, `src/server/http.ts`:
- `GET /health`.
- `/agent/*` (agent token): `register`, `resolve`, `show`, `read` (body `{ sessionKey, viewId? }`), `claim` (body `{ owner, projectRoot? }`), `ack`.
- `/api/*` (viewer key): `GET snapshot`, `GET revision?id&revision`, `POST pin`, `POST submit`, `POST retry`, `POST report`.
- `GET /frame`: the shell, with the frame CSP, at every path that percent-decodes to `/frame`.
- `GET /lib/NAME.js`: only names in `HTML_LIBRARIES`.
- Static: `/`, `/index.html`, `/app.js`, `/app.css`.
- The app page CSP is `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; frame-src ORIGIN/frame; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, where ORIGIN is the trusted origin (endpoint, `localhost` alias or public URL) whose host is the request's `Host`. The static files answer 421 at any other host.
- The request body limit is `LIMITS.requestBytes`.
- Requests from foreign origins are rejected. The frame's opaque origin never calls the service; only the parent does.

## Delivery

The plugin's worker claims queued interactions for its owner every second, passing its project root (the project's canonical directory, or its own directory outside a project, as `register` scopes sessions) so it can adopt sessions after a restart. For each one it:
1. Checks the session's location against its recorded directory.
2. Waits briefly for the session to be idle.
3. Calls `session.prompt({ sessionID, id: messageId, text: prompt, delivery: 'queue', resume: true })`.

Statuses are `delivered`, `unsent` (failed before admission; safe to retry) and `uncertain` (failed after an admission attempt; never repeated automatically). A Canvas outage must never block ordinary chat: hooks swallow registration failures, and only explicit tool calls surface errors.

The viewer treats a submit that got no answer (a network error, a timeout, a host or bridge failure, a 5xx) as indeterminate, not failed: it submits the same id once more, which the service admits at most once, and reports success if that answer arrives. If it still cannot confirm, the page is told "could not confirm; it may have been received", and the id is kept, so sending the same input again reuses it instead of creating a second message. Only a 4xx answer is a definite failure. `transport.ts` exports `CallError` (with `status`) for answered failures.

## Surfaces

- **Browser:** `dist/opencode/web`, served by the service. The viewing link puts a session viewer key in the URL fragment; the page moves it to sessionStorage and strips it from the address bar.
- **OpenChamber pane:** `dist/openchamber`.
  - Manifest: `apiVersion 1`, `engines.openchamber >=2.3.0`, `panel` + `page`, a host `service`.
  - `tools`: `{ match: 'canvas_*', name: 'Agent Canvas', icon, title: '{input.title}', output: 'markdown' }`. The panel and tool icon is the Remix Icon `layout`.
  - The host service (`src/openchamber/bridge.ts`) keeps the 0.1 pattern: `/connect` returns only this session's viewer key; `/request` forwards an allowlisted `/api/*` path; `/lib/NAME` serves a bundled library.
- **App shell:**
  - Sidebar: this conversation's views and the project views. A project view another conversation wrote never opens on its own: with no view of its own, the conversation shows the empty state until the user picks one. On a phone the views strip scrolls sideways and keeps the open view in sight.
  - Toolbar: open in browser, pin/rename, full screen.
  - Revision bar, with a stale-revision banner that blocks sending. A revision the user chose to look at is dropped as soon as the conversation shows a new revision of its own, so an agent's reply is never hidden behind a stale banner.
  - A content host that switches on format, an optional "Note to the agent" field attached to the next send (disabled until the revision's draft has loaded), and a delivery list with retry.
  - Preferred surface (pane or browser), and an empty state that suggests mockups, charts and forms.
  - Theme follows the host (pane) or `prefers-color-scheme` (browser).
  - Mobile width must not overflow horizontally.

## Source layout and owners

| Path | Owner |
| --- | --- |
| `src/shared/contract.ts` | Lead. Builders must not edit it; report needed changes instead. |
| `src/server/*` (`store.ts`, `http.ts`, `config.ts`, `client.ts`, `cli.ts`), `src/shared/demo.ts`, `test/store.test.ts`, `test/http.test.ts` | Service builder |
| `src/opencode/*` (`plugin.ts`, `worker.ts`, `service.ts`, `guide.ts`), `scripts/test-runtime.mjs`, `test/runtime-model.ts`, `test/plugin.test.ts` | Plugin builder |
| `src/ui/openui/*`, `src/shared/openui-validate.ts`, `scripts/generate-openui.mjs`, `test/openui.test.ts` | OpenUI builder |
| `src/ui/html/*`, `src/shared/html-check.ts`, `src/shared/html-guide.ts`, `src/server/frame-shell.ts`, `test/html.test.ts` | HTML builder |
| `src/ui/app.tsx`, `src/ui/transport.ts`, `src/ui/drafts.ts`, `src/ui/style.css`, `src/openchamber/bridge.ts` | Shell builder |
| `scripts/build.mjs`, `package.json` scripts, `playwright.config.ts`, `test/browser/*`, `test/browser-fixture.ts`, `test/pane-host.html` | Build-and-browser-test builder |

### Cross-module interfaces (exact)

```ts
// src/shared/openui-validate.ts (Node-safe: imports src/generated/openui-schema.json, no React)
export function validateOpenUI(source: string): Check;

// src/ui/openui/OpenUIView.tsx
export function OpenUIView(p: {
  source: string; appearance: 'light' | 'dark'; disabled: boolean;
  initialState: unknown | null; onState(state: unknown): void;
  onSend(action: string, data: unknown): void; onOpenUrl(url: string): void; onErrors(errors: string[]): void;
}): JSX.Element;

// src/shared/html-check.ts
export const HTML_LIBRARIES: Record<string, { file: string; description: string }>; // file is relative to node_modules
export function checkHtml(source: string): Check;
// src/shared/html-guide.ts
export const HTML_GUIDE: string;
// src/server/frame-shell.ts
export const FRAME_SHELL_HTML: string; export const FRAME_CSP: string;

// src/ui/html/HtmlView.tsx
export function HtmlView(p: {
  source: string; view: { id: string; revision: number; title: string };
  appearance: 'light' | 'dark'; disabled: boolean; frameMode: 'srcdoc' | 'shell';
  loadLibrary(name: string): Promise<string>;
  initialState: unknown | null; onState(state: unknown): void;
  onSend(action: string, data: unknown): Promise<void>; onOpenUrl(url: string): void; onErrors(errors: string[]): void;
  fill?: boolean; // full screen: fill the parent's height instead of auto-sizing
}): JSX.Element;

// src/ui/transport.ts
export interface Transport {
  mode: 'browser' | 'openchamber'; frameMode: 'srcdoc' | 'shell';
  call<T>(path: string, body?: unknown): Promise<T>;
  load<T>(key: string): Promise<T | null>; save(key: string, value: unknown): Promise<void>;
  loadLibrary(name: string): Promise<string>;
  open(url: string): void; badge(count: number): void;
  appearance(): 'light' | 'dark'; onAppearance(cb: (a: 'light' | 'dark') => void): () => void;
  onContext(cb: (state: { ready: boolean; error?: string }) => void): () => void;
}

// src/opencode/guide.ts
export function guide(topic: 'overview' | 'openui' | 'html'): string; // overview is short and names both formats and when to use each

// src/opencode/plugin.ts: default export, an OpenCode 2 Plugin.Plugin with id 'agent-canvas'
// src/opencode/worker.ts
export function startWorker(deliver: (job: DeliveryJob) => Promise<DeliveryResult>, config: Connection, owner: string, projectRoot?: string): () => void;
export function deliverToSession(api: Pick<Plugin.Context['session'], 'get' | 'wait' | 'prompt'>, job: DeliveryJob): Promise<DeliveryResult>;
```

### UI test hooks (the shell provides them; browser tests rely on them)

- Sidebar: `nav[aria-label="Saved views"]`, with one button per view showing its title or pinned name.
- Toolbar buttons are labeled:
  - "Open in browser" in the pane, "Open viewing link" in the browser;
  - "Pin to project", or "Rename project view" once pinned;
  - "Full screen" and "Exit full screen".
- Pin form: an input labeled "Project view name" and a "Save project view" button.
- Revisions: a select labeled "Revision". When an older revision is shown, a `role="status"` banner contains "newer revision".
- A textarea labeled "Note to the agent".
- Deliveries: `section[aria-label="Sent to your agent"]`. Each item is `.delivery[data-status="queued|sending|delivered|unsent|uncertain"]`, with a "Retry" button when unsent.
- Content host: `[data-canvas-format="openui"]` or `[data-canvas-format="html"]`. The HTML iframe is titled `Canvas page: <view title>`.
- Errors: `role="alert"`. Session line: `.session-info`. A select labeled "Preferred surface", and a "Show here this time" button.

### Build output

`npm run build` runs `generate-openui`, then bundles:
- `dist/opencode/`: `index.js` (plugin, ESM), `canvas-service.cjs`, `web/` (`index.html`, `app.js`, `app.css`, `lib/`), `package.json`, `README.md`, `THIRD_PARTY_NOTICES.md`.
- `dist/openchamber/`: `panel/` (same app built with `__CANVAS_SURFACE__='openchamber'`, its `index.html` adding `frame-src 'none'`, `lib/`), `service/main.cjs`, `package.json` manifest (validated with `parseManifestJson`), `README.md`, `THIRD_PARTY_NOTICES.md`.

Notices cover every bundled or copied package. The 0.1 approach in `git show HEAD:scripts/build.mjs` works.

## Tests

- `npm test`: node:test through tsx over `test/*.test.ts`, covering the store, http, plugin, openui and html tests.
- `npm run test:browser`: Playwright against installed Chrome. It must cover:
  - an OpenUI view with a chart, a table and a form, where submitting the form delivers its values;
  - an HTML view whose `canvas.send` and `data-canvas-action` form deliver;
  - an HTML page that cannot `fetch`, cannot reach the parent's storage, and cannot navigate the top window;
  - a bundled library (`chart.js`) rendering;
  - drafts that survive a reload, for both formats, including a reload right after typing and a script-free `data-canvas-action` form;
  - a stale revision that blocks sending;
  - busy → unsent → retry → delivered;
  - mobile width at 390×844 with no horizontal overflow;
  - the pane harness: an iframe with `sandbox="allow-scripts"` serving the panel with the real OpenChamber guest CSP (`script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' 'self' data: blob:; frame-src 'self' data: blob:; …`), rendering both formats and delivering a send;
  - in both surfaces: a page cannot open a link or send without a click (through the bridge, by posting the bridge's messages, or after faking `navigator.userActivation`), and prerender, preconnect, speculation-rules and WebRTC attempts built at run time never reach the fixture's `/beacon/` listener, including through attribute nodes, a split `document.write`, or after the page redefines built-ins;
  - in both surfaces: a page that navigates its own frame to a `data:` URL (by `location`, a link click kept from bubbling, or a meta refresh), a `blob:` URL or an http URL never shows the new document, and nothing reaches the fixture;
  - in both surfaces: no nested frame built at run time (by `createElement`, markup, `document.write` split across calls or finished by the page's own markup, `DOMParser`, ranges, `execCommand`, declarative shadow roots, the `document.body` setter, or after the page redefines built-ins) gets a window, and neither its WebRTC nor a prerender reaches the fixture; `canvas_show` refuses static frames;
  - a pinned page from another conversation never opens or sends on its own;
  - a lost submit answer is confirmed, not delivered twice; switching conversations mid-send keeps the input for its own conversation;
  - a required `DatePicker` east of UTC sends the picked day; KPI cards in a wrapping row wrap at 390 px without clipping.

  The fixture can show any source (`POST /control/show`) and records requests to `/beacon/*`, plus WebRTC STUN and TURN traffic to its port (`GET /control/beacons`).

  The fixture drives the real plugin with a fake OpenCode 2 `ctx`.
- `npm run test:native`: the real `opencode` 2 binary with isolated XDG directories and a local fixture model. The model calls `canvas_guide`, then `canvas_show` (openui, then html). The test then checks:
  - admission exactly once for a duplicate submission;
  - pin, then revise from a second session;
  - the original snapshot is preserved;
  - the service starts automatically;
  - ordinary chat survives a Canvas outage.
- `npm run check`: typecheck, `npm test`, build.

## Rules for every builder

- Write only the files you own. Read anything. Use `git show HEAD:<path>` for the 0.1 code.
- Do not run `npm install`; every dependency is already installed. If you need another one, say so in your report.
- Never use port 4317 or `~/.local/share/agent-canvas`. They belong to the user's live 0.1 install. Set `AGENT_CANVAS_HOME` to a temp directory and `AGENT_CANVAS_PORT` to a free port for anything you run.
- Do not edit anything under `~/.config` or `~/Projects/_scratch`.
- Match the code style: compact TypeScript, few comments, each one explaining a reason.
- Typecheck your own files with `npx tsc --noEmit -p .`. Errors in other builders' files are expected while they work; ignore them.
