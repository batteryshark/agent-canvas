// The agent-facing reference for format 'html', served by canvas_guide('html'). Agents learn the format
// only from this text, so every example must pass checkHtml cleanly (test/html.test.ts checks them).
import { LIMITS } from './contract';
import { HTML_LIBRARIES } from './html-check';

/** The complete example pages embedded in the guide, in order. */
export const HTML_GUIDE_EXAMPLES: Array<{ title: string; html: string }> = [
  {
    title: 'Mockup with variants',
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script src="canvas:lib/tailwind"></script>
</head>
<body class="p-4 sm:p-6">
  <header class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-lg font-semibold">Checkout header</h1>
      <p class="text-sm text-[var(--muted-foreground)]">Two directions. Compare them, then pick one.</p>
    </div>
    <div class="flex gap-1 rounded-[var(--radius)] border border-[var(--border)] p-1 text-sm">
      <button class="tab rounded-md px-3 py-1" data-variant="A">A · Compact</button>
      <button class="tab rounded-md px-3 py-1" data-variant="B">B · Guided</button>
    </div>
  </header>

  <section data-variant-panel="A" class="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4">
    <div class="flex items-center justify-between gap-4">
      <span class="font-semibold">Acme</span>
      <span class="text-sm text-[var(--muted-foreground)]">Cart (3) · $142.00</span>
    </div>
  </section>
  <section data-variant-panel="B" hidden class="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-4">
    <ol class="flex flex-wrap gap-2 text-sm">
      <li class="rounded-full bg-[var(--primary)] px-3 py-1 text-[var(--primary-foreground)]">1 · Cart</li>
      <li class="rounded-full bg-[var(--muted)] px-3 py-1">2 · Shipping</li>
      <li class="rounded-full bg-[var(--muted)] px-3 py-1">3 · Payment</li>
    </ol>
  </section>

  <div class="mt-4 flex flex-wrap items-center gap-3">
    <button id="choose" class="rounded-[var(--radius)] bg-[var(--primary)] px-4 py-2 font-medium text-[var(--primary-foreground)] disabled:opacity-60">Use variant A</button>
    <span id="note" class="text-sm text-[var(--muted-foreground)]"></span>
  </div>

<script>
const choose = document.getElementById('choose');
const note = document.getElementById('note');
let variant = canvas.state.get()?.variant ?? 'A';

function show(next) {
  variant = next;
  canvas.state.set({ variant });
  document.querySelectorAll('[data-variant-panel]').forEach(panel => { panel.hidden = panel.dataset.variantPanel !== variant; });
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('bg-[var(--muted)]', tab.dataset.variant === variant));
  choose.textContent = 'Use variant ' + variant;
}

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => show(tab.dataset.variant)));
choose.addEventListener('click', async () => {
  choose.disabled = true;
  note.textContent = 'Sending…';
  try {
    await canvas.send('Use checkout header ' + variant, { variant });
    note.textContent = 'Sent to the agent.';
  } catch (error) {
    note.textContent = error.message;
  } finally {
    choose.disabled = false;
  }
});
show(variant);
</script>
</body>
</html>`,
  },
  {
    title: 'Chart the user can ask about',
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script src="canvas:lib/chart.js"></script>
<style>
  body { margin: 0; padding: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  h2 { margin: 0 0 4px; font-size: 16px; }
  p { margin: 0 0 12px; color: var(--muted-foreground); font-size: 13px; }
  .chart { position: relative; height: 280px; }
</style>
</head>
<body>
<div class="card">
  <h2>CI build time by week</h2>
  <p>Median minutes per branch. Click a point to ask about that week. <span id="note"></span></p>
  <div class="chart"><canvas id="builds" aria-label="Line chart of median build minutes per week for main and release"></canvas></div>
</div>
<script>
const weeks = ['W31', 'W32', 'W33', 'W34', 'W35', 'W36'];
const minutes = { main: [11.2, 11.8, 12.5, 14.1, 9.6, 9.2], release: [15.0, 15.4, 16.2, 18.9, 13.1, 12.7] };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let chart;

function draw() {
  chart?.destroy();
  Chart.defaults.color = css('--muted-foreground');
  Chart.defaults.borderColor = css('--border');
  Chart.defaults.font.family = css('--font-sans');
  const line = (branch, color) => ({ label: branch, data: minutes[branch], borderColor: css(color), backgroundColor: css(color), borderWidth: 2, pointRadius: 4, pointHoverRadius: 6 });
  chart = new Chart(document.getElementById('builds'), {
    type: 'line',
    data: { labels: weeks, datasets: [line('main', '--chart-1'), line('release', '--chart-2')] },
    options: {
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: 'minutes' } } },
      onClick(event, points) {
        if (!points.length) return;
        const { datasetIndex, index } = points[0];
        const branch = chart.data.datasets[datasetIndex].label;
        canvas.send('Explain ' + branch + ' build time in ' + weeks[index], { branch, week: weeks[index], minutes: minutes[branch][index] })
          .then(() => { document.getElementById('note').textContent = 'Sent.'; })
          .catch(error => { document.getElementById('note').textContent = error.message; });
      },
    },
  });
}
draw();
canvas.onTheme(draw);
</script>
</body>
</html>`,
  },
  {
    title: 'Feedback form',
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 20px; }
  form { display: grid; gap: 14px; max-width: 560px; }
  .field { font-weight: 600; font-size: 14px; }
  fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; }
  legend { font-weight: 600; font-size: 14px; padding: 0 4px; }
  .option { display: inline-flex; gap: 6px; margin-right: 16px; font-size: 14px; }
  select, textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 8px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--card); font-weight: 400; }
  button { padding: 8px 16px; border: 0; border-radius: var(--radius); background: var(--primary); color: var(--primary-foreground); font-weight: 600; cursor: pointer; }
  .sent, .failed { display: none; margin-left: 10px; font-size: 14px; }
  .sent { color: var(--success); }
  .failed { color: var(--destructive); }
  form[data-canvas-state="sent"] .sent, form[data-canvas-state="failed"] .failed { display: inline; }
</style>
</head>
<body>
<form data-canvas-action="Review feedback">
  <label class="field">How close is this design?
    <select name="verdict">
      <option value="ship">Ship it</option>
      <option value="tweak" selected>Close, needs tweaks</option>
      <option value="rethink">Rethink it</option>
    </select>
  </label>
  <fieldset>
    <legend>Keep</legend>
    <label class="option"><input type="checkbox" name="keep" value="sidebar" checked> Sidebar</label>
    <label class="option"><input type="checkbox" name="keep" value="search"> Search bar</label>
    <label class="option"><input type="checkbox" name="keep" value="dense-table"> Dense table</label>
  </fieldset>
  <label class="field">What should change?
    <textarea name="changes" rows="4" required placeholder="What, where, and why"></textarea>
  </label>
  <label class="option"><input type="checkbox" name="blocking"> Block the release on this</label>
  <div><button>Send feedback</button><span class="sent">Sent ✓</span><span class="failed">Not sent. Try again.</span></div>
</form>
</body>
</html>`,
  },
  {
    title: 'Interactive simulation',
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 20px; }
  .controls { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: end; margin-bottom: 12px; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--muted-foreground); }
  output { color: var(--foreground); font-weight: 600; }
  #board { display: block; width: 100%; height: 220px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); }
  .stats { font-family: var(--font-mono); font-size: 13px; margin: 10px 0 0; }
  .key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 12px; }
  button { padding: 8px 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--muted); cursor: pointer; }
</style>
</head>
<body>
<div class="controls">
  <label>Bucket size <input id="size" type="range" min="1" max="50" value="10"> <output for="size"></output></label>
  <label>Refill per second <input id="rate" type="range" min="1" max="40" value="5"> <output for="rate"></output></label>
  <label>Traffic per second <input id="load" type="range" min="1" max="60" value="12"> <output for="load"></output></label>
  <button id="use">Use these limits</button>
</div>
<canvas id="board" aria-label="Accepted and rejected requests per quarter second"></canvas>
<p class="stats"><span id="stats"></span><span class="key" style="background: var(--chart-1)"></span>accepted<span class="key" style="background: var(--chart-2)"></span>rejected</p>
<script>
const knobs = ['size', 'rate', 'load'];
const saved = canvas.state.get();
if (saved) knobs.forEach(id => { document.getElementById(id).value = saved[id]; });
const settings = () => Object.fromEntries(knobs.map(id => [id, Number(document.getElementById(id).value)]));
function label() {
  knobs.forEach(id => { document.querySelector('output[for="' + id + '"]').textContent = document.getElementById(id).value; });
  canvas.state.set(settings());
}
knobs.forEach(id => document.getElementById(id).addEventListener('input', label));
label();

const board = document.getElementById('board'), ctx = board.getContext('2d');
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let colors = { ok: css('--chart-1'), rejected: css('--chart-2') };
canvas.onTheme(() => { colors = { ok: css('--chart-1'), rejected: css('--chart-2') }; });

let tokens = 10, owed = 0, bins = [], bin = { ok: 0, rejected: 0 }, binStart = performance.now(), last = binStart;
function step(now) {
  const { size, rate, load } = settings();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  tokens = Math.min(size, tokens + rate * dt);
  owed += load * dt * (0.5 + Math.random());
  for (; owed >= 1; owed--) {
    if (tokens >= 1) { tokens--; bin.ok++; } else bin.rejected++;
  }
  if (now - binStart >= 250) { bins = [...bins, bin].slice(-80); bin = { ok: 0, rejected: 0 }; binStart = now; }
  draw();
  requestAnimationFrame(step);
}
function draw() {
  const ratio = window.devicePixelRatio || 1, width = board.clientWidth, height = board.clientHeight;
  if (board.width !== Math.round(width * ratio)) { board.width = Math.round(width * ratio); board.height = Math.round(height * ratio); }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const most = Math.max(4, ...bins.map(b => b.ok + b.rejected)), barWidth = width / 80;
  bins.forEach((b, i) => {
    const okHeight = (b.ok / most) * (height - 12), rejectedHeight = (b.rejected / most) * (height - 12);
    ctx.fillStyle = colors.ok;
    ctx.fillRect(i * barWidth + 1, height - okHeight, barWidth - 2, okHeight);
    ctx.fillStyle = colors.rejected;
    ctx.fillRect(i * barWidth + 1, height - okHeight - rejectedHeight - 2, barWidth - 2, rejectedHeight);
  });
  const sent = bins.reduce((sum, b) => sum + b.ok + b.rejected, 0), rejected = bins.reduce((sum, b) => sum + b.rejected, 0);
  document.getElementById('stats').textContent = 'last 20 s: ' + Math.round((100 * rejected) / Math.max(1, sent)) + '% rejected · tokens ' + tokens.toFixed(1);
}
requestAnimationFrame(step);

document.getElementById('use').addEventListener('click', () => {
  const chosen = settings();
  const rejected = bins.reduce((sum, b) => sum + b.rejected, 0), sent = bins.reduce((sum, b) => sum + b.ok + b.rejected, 0);
  canvas.send('Use rate limit ' + chosen.size + ' burst, ' + chosen.rate + '/s', { ...chosen, observedRejectRate: Number((rejected / Math.max(1, sent)).toFixed(3)) })
    .catch(error => { document.getElementById('stats').textContent = error.message; });
});
</script>
</body>
</html>`,
  },
];

const n = (value: number) => value.toLocaleString('en-US');
const libraries = Object.entries(HTML_LIBRARIES).map(([name, library]) => `   - \`${name}\`: ${library.description}`).join('\n');

export const HTML_GUIDE = `# HTML pages in Agent Canvas

An HTML page is one complete, self-contained HTML document. Canvas renders it in a sandboxed frame next to the conversation: in the OpenChamber pane, in a browser tab, or on a phone. You write the whole document. Canvas adds the theme, a small bridge (\`window.canvas\`) that sends the user's input back to you, and any bundled library you ask for.

## HTML or OpenUI?

Use **OpenUI** (\`format: "openui"\`) when standard components carry the idea: tables, standard charts, forms, cards, tabs, lists, comparisons, node-and-edge diagrams. It is shorter to write, always on theme, and sending and drafts work with no code.

Use **HTML** (\`format: "html"\`) when you need control that components do not give:
- a mockup that should look like the real product: layout, spacing, states, variants side by side;
- a custom visual: D3, canvas drawing, SVG illustration, Mermaid diagrams, an unusual chart;
- an interactive model: a simulation, a calculator, a playground with live sliders, a small game;
- any other layout or interaction OpenUI cannot express.

When unsure, use OpenUI for data and decisions and HTML for pixels and motion.

## Rules

1. **Send one complete document**: \`<!doctype html><html><head>…</head><body>…</body></html>\`, with every style and script inline. The limit is ${n(LIMITS.htmlSource)} characters. To revise, call \`canvas_show\` again with \`viewId\`, \`expectedRevision\` (the latest revision) and the whole new document.
2. **There is no network.** Nothing remote loads: CDN scripts, stylesheets, web fonts, \`@import\`, remote images, iframes, \`fetch\`, \`XMLHttpRequest\`, WebSockets. Embed data as JavaScript constants, draw images with inline SVG or CSS (or small \`data:\` URLs), and use the theme fonts. \`canvas_show\` refuses pages that use prerender, prefetch, dns-prefetch or preconnect links, speculation rules, or WebRTC (\`RTCPeerConnection\`), and the page cannot create them at run time either.
3. **Bundled libraries** load with an empty script tag, \`<script src="canvas:lib/NAME"></script>\`, placed before the code that uses them. Canvas inlines the library before the page renders. Available:
${libraries}
4. **The page is sandboxed.** It runs with scripts only, in an origin of its own:
   - \`alert()\`, \`confirm()\`, \`prompt()\` and popups do nothing. Show messages and confirmations in the page.
   - Real form submission is blocked. Use a \`data-canvas-action\` form or \`canvas.send()\` (below).
   - \`http(s)\` links open in a new browser tab through Canvas, \`#anchor\` links scroll the page, and other navigation is ignored. The page cannot navigate the app around it.
   - \`localStorage\` and \`sessionStorage\` last only for this page view; cookies and IndexedDB are unavailable. Use \`canvas.state\` for anything that should survive a reload.
5. **Do not name your own global \`canvas\`.** \`window.canvas\` is the bridge, so call your \`<canvas>\` element \`board\` or \`chartCanvas\`. \`window.agentCanvas\` is the same bridge under a name that never collides.
6. **Design for any width.** The same page shows in a narrow pane and on a 390 px phone. Use \`flex-wrap\`, \`grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr))\` and \`max-width: 100%\`; the page itself must never scroll sideways.

\`canvas_show\` returns warnings for things that will silently fail (remote resources, plain forms, network calls, \`alert\`). Fix them before the user sees the page.

## Theme

Canvas defines these CSS variables on \`:root\`, in light or dark to match the app, and changes them live when the app theme changes (the page is not reloaded). Build on them instead of hard-coding colors, and the page looks native in both themes.

| Variable | Use |
| --- | --- |
| \`--background\`, \`--foreground\` | page background and body text |
| \`--card\`, \`--card-foreground\` | raised surfaces: cards, panels, chart areas |
| \`--muted\`, \`--muted-foreground\` | quiet fills (chips, stripes, inactive tabs) and secondary text |
| \`--border\`, \`--input\`, \`--ring\` | dividers and outlines, form-field borders, focus rings |
| \`--primary\`, \`--primary-foreground\` | the main action and selected states, and text on them |
| \`--destructive\`, \`--warning\`, \`--success\`, \`--info\` | status only (failed, at risk, done, note); pair the color with a word or icon |
| \`--chart-1\`, \`--chart-2\`, \`--chart-3\`, \`--chart-4\`, \`--chart-5\`, \`--chart-6\` | data series in this order: a colorblind-checked categorical sequence. Do not cycle it; fold extra series into "Other" |
| \`--radius\` | corner radius |
| \`--font-sans\`, \`--font-mono\` | system font stacks; no web fonts are available |

Also defined: \`--accent\`, \`--accent-foreground\`, \`--secondary\`, \`--secondary-foreground\`, \`--popover\`, \`--popover-foreground\`. The values are complete CSS colors: write \`var(--card)\`, and tint with \`color-mix(in srgb, var(--primary) 15%, transparent)\`.

Canvas also sets:
- \`color-scheme\` and \`accent-color: var(--primary)\`, so native controls, checkboxes and scrollbars match the theme;
- \`data-theme="light"\` or \`data-theme="dark"\` on \`<html>\`. Style theme-specific details with \`[data-theme="dark"] .logo { … }\`. Do not use \`@media (prefers-color-scheme)\`: it follows the device, not the app;
- low-priority defaults (background, text color and font on \`:root\`, inherited fonts in form controls). Anything you write overrides them.

For what you draw with JavaScript (canvas, Chart.js, D3), read colors with \`getComputedStyle(document.documentElement).getPropertyValue('--chart-1').trim()\` and redraw in \`canvas.onTheme(callback)\`.

With Tailwind, use the variables in arbitrary values: \`bg-[var(--card)]\`, \`text-[var(--muted-foreground)]\`, \`border-[var(--border)]\`, \`rounded-[var(--radius)]\`. The \`dark:\` variant follows the Canvas theme.

## Sending the user's input to you

Everything the user does that is meant for you goes through the bridge, and each send arrives in this conversation as a message:

~~~
[Agent Canvas] <view title> (view <id>, revision <n>)
Action: <action label>
Data:
\`\`\`json
{ "plan": "B" }
\`\`\`
Note: <a note the user typed in Canvas, if any>
~~~

Write the action label as what the user did, in their words ("Choose variant B", "Send feedback"), at most ${n(LIMITS.action)} characters. Put the details in \`data\`: JSON, at most ${n(LIMITS.dataBytes)} characters. Send the user's choices and inputs, not the page's own data back. Never claim input arrived until that message appears.

### \`canvas.send(action, data?)\`

\`\`\`js
try {
  await canvas.send('Approve plan', { plan: 'B', budget: 1200 });
  note.textContent = 'Sent to the agent.';
} catch (error) {
  note.textContent = error.message;
}
\`\`\`

It returns a promise that resolves once Canvas has queued the input for the conversation, and rejects with a readable reason when it cannot: the user is looking at an older revision, the data is too large, or Canvas is not connected. Show the outcome next to the control that sent it.

Input reaches you only because the user acted: call \`canvas.send\` from a click or key press in the page (or within a few seconds of one, for example after a short animation). A call on load or from a timer is refused, so a page cannot report on its own; give it a button such as "Send results".

### Buttons: \`data-canvas-action\`

\`\`\`html
<button data-canvas-action="Choose plan B" data-canvas-data='{"plan":"B"}'>Choose B</button>
\`\`\`

A click on an element with \`data-canvas-action\` sends that label, with \`data-canvas-data\` as the data (JSON in single quotes) or \`null\`. Clicks anywhere inside the element count, so a whole card can be the button. Prefer real \`<button>\` elements so the keyboard works.

### Forms: \`<form data-canvas-action="…">\`

Clicking a submit button, or pressing Enter in a text field, validates the form (\`required\`, \`min\`, \`pattern\`…), fires a normal \`submit\` event, and then sends the fields as \`data\`:
- each named field becomes a property, and a name used by several fields becomes an array;
- a single checkbox becomes \`true\` or \`false\`; checkboxes sharing a name become an array of the checked values;
- a radio group becomes the chosen value or \`null\`, and \`<select multiple>\` an array;
- \`number\` and \`range\` inputs become numbers (\`null\` when empty);
- the clicked button's \`name\` and \`value\` are included, so \`<button name="decision" value="approve">\` says which button was used.

Call \`event.preventDefault()\` in your own \`submit\` listener to cancel the send, for example after custom validation. A form without \`data-canvas-action\` sends nothing, but its \`submit\` event still fires, so you can handle it and call \`canvas.send()\` yourself. A \`<button>\` in a form submits it unless it has \`type="button"\`.

### Showing progress

While a declarative send is in flight, the button or form has \`data-canvas-state="sending"\` (dimmed by default). Afterwards it is \`"sent"\` or \`"failed"\`, with the reason in \`data-canvas-error\`, and a bubbling \`canvas:result\` event carries \`detail: { ok, error }\`. Style the outcome in CSS, for example \`form[data-canvas-state="sent"] .done { display: inline; }\`.

## Drafts

Forms with \`data-canvas-action\` save their values as the user types and restore them when the page reloads or the user comes back to this revision. Passwords, files and hidden inputs are never saved. Opt a field or form out with \`data-canvas-draft="off"\`, or opt another form in with \`data-canvas-draft\`. A restored form receives a \`canvas:restored\` event if dependent UI needs refreshing.

For other state (the open tab, slider positions, a half-built configuration) use \`canvas.state\`:

\`\`\`js
const saved = canvas.state.get() ?? { tab: 'overview' }; // null on first load
showTab(saved.tab);
tabs.addEventListener('click', event => canvas.state.set({ tab: event.target.dataset.tab }));
\`\`\`

\`set\` takes JSON. Your state and the form drafts together are limited to ${n(LIMITS.draftBytes)} characters, and \`set\` throws beyond that. Save what restores the page, not the data it displays.

## The rest of \`window.canvas\`

- \`canvas.view\`: \`{ id, revision, title }\` of this page.
- \`canvas.theme\`: \`{ appearance: 'light' | 'dark', variables: { '--background': '#…', … } }\`.
- \`canvas.onTheme(callback)\`: called with the new theme after the app theme changes. Returns a function that unsubscribes.
- \`canvas.openLink(url)\`: opens an http(s) URL in a new browser tab. Plain \`<a href="https://…">\` links and \`window.open(url)\` do the same. Links open only from a click or key press; a call on load or from a timer is refused.

## Size and layout

The frame grows with the page's content, from 240 px up to 85% of the window height; a taller page scrolls inside the frame. In full screen the frame fills the content area.
- Do not size the page to the window (\`height: 100vh\`, \`h-screen\`): the window is the frame, so page and frame would chase each other. Let content set the height, and give charts and drawing surfaces a fixed height such as \`height: 280px\`.
- Chart.js: put the \`<canvas>\` in a wrapper with \`position: relative; height: 280px\` and set \`maintainAspectRatio: false\`.
- Canvas drawing: size the backing store from \`clientWidth * devicePixelRatio\` so lines stay sharp.

## Errors come back to you

Uncaught errors, unhandled promise rejections and blocked resources are reported to Canvas with line numbers that match your source. \`canvas_read\` with the view id shows them as \`clientErrors\` on the revision. When the user says something looks wrong, read the view before you revise it.

## Library notes

- **tailwind**: Tailwind 4 syntax. Utilities work as soon as the script tag is in \`<head>\`. For custom tokens or \`@apply\`, add \`<style type="text/tailwindcss">@theme { --color-brand: #3366ff; }</style>\` after it.
- **chart.js**: \`new Chart(element, config)\`. Set \`Chart.defaults.color\`, \`Chart.defaults.borderColor\` and \`Chart.defaults.font.family\` from the theme variables, and destroy and recreate the chart in \`canvas.onTheme\`. Use \`options.onClick(event, points)\` to send what the user clicked. Keep the legend for two or more series and the default hover tooltips.
- **d3**: the global \`d3\`. Give SVG a \`viewBox\` and \`width: 100%\` so it scales, and color marks with \`.style('fill', 'var(--chart-1)')\`.
- **mermaid**: write the diagram in \`<pre class="mermaid">…</pre>\`, then call \`mermaid.initialize({ startOnLoad: true, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default' })\`. It is about 5.5 MB, so for plain node-and-edge diagrams prefer OpenUI's \`Diagram\` or D3.

## Examples

Each is a complete page you can adapt.

### 1. Mockup with variants (Tailwind, \`canvas.send\`, \`canvas.state\`)

\`\`\`html
${HTML_GUIDE_EXAMPLES[0].html}
\`\`\`

### 2. Chart the user can ask about (Chart.js)

\`\`\`html
${HTML_GUIDE_EXAMPLES[1].html}
\`\`\`

### 3. Feedback form (no script needed)

The agent receives \`{ "verdict": "tweak", "keep": ["sidebar"], "changes": "…", "blocking": false }\`, and the draft survives reloads.

\`\`\`html
${HTML_GUIDE_EXAMPLES[2].html}
\`\`\`

### 4. Interactive simulation (canvas drawing, sliders, state)

\`\`\`html
${HTML_GUIDE_EXAMPLES[3].html}
\`\`\`

## Before you call \`canvas_show\`

- One complete document; nothing remote; libraries only through \`canvas:lib/NAME\`.
- Colors come from the theme variables, so the page works in light and dark.
- The page works at 390 px wide.
- Every control meant for you sends a clear action label and shows its outcome.
- No \`alert\`, no plain forms without a send, no \`100vh\` page.
- Give the user the link \`canvas_show\` returns.
`;
