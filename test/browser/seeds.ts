// Views the browser fixture shows through the real canvas_show tool. They double as README screenshots,
// so they read like real agent output. `reply` is the line a revision adds after the user answered.
export type SeedKind = 'openui' | 'html' | 'attack';
export const TITLES: Record<SeedKind, string> = {
  openui: 'Checkout experiment results',
  html: 'Capacity plan',
  attack: 'Sandbox probe',
};
export const SUMMARIES: Record<SeedKind, string> = {
  openui: 'Week 3 of the one-page checkout test, with a roll-out decision form.',
  html: 'Peak load against three scaling options, with a choice to send back.',
  attack: 'Tries to escape the HTML sandbox and reports what it could reach.',
};

const quote = (text: string) => JSON.stringify(text);
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function openuiSeed(reply?: string) {
  return `root = Stack([${reply ? 'reply, ' : ''}title, intro, kpis, chartCard, tableCard, planCard])
${reply ? `reply = Callout("success", "Agent reply", ${quote(reply)})\n` : ''}title = TextContent("Checkout redesign: week 3 results", "large-heavy")
intro = TextContent("Variant B (one-page checkout) is ahead on tablet and mobile. Choose how to roll it out and I will draft the plan.")
kpis = SnippetCardBlock([kControl, kVariant, kLift, kConfidence])
kControl = SnippetCardItem("control", kControlLabel, BoldText("number", "5,310"))
kControlLabel = IconText(Icon("shopping-cart", "shopping"), "neutral", "m", "Orders, control", "Last 7 days", false, "horizontal")
kVariant = SnippetCardItem("variant", kVariantLabel, BoldText("number", "6,420"))
kVariantLabel = IconText(Icon("shopping-bag", "shopping"), "neutral", "m", "Orders, variant B", "Last 7 days", false, "horizontal")
kLift = SnippetCardItem("lift", kLiftLabel, BoldText("number", "+20.9%"))
kLiftLabel = IconText(Icon("trending-up", "finance"), "neutral", "m", "Lift", "Variant B over control", false, "horizontal")
kConfidence = SnippetCardItem("confidence", kConfidenceLabel, BoldText("number", "97%"))
kConfidenceLabel = IconText(Icon("shield-check", "security"), "neutral", "m", "Confidence", "50/50 split", false, "horizontal")
chartCard = Card([chartHeader, chart])
chartHeader = CardHeader("Conversion by device", "Share of sessions that placed an order")
chart = BarChart(devices, [control, variantB], "grouped", "Device", "Conversion (%)", 240)
devices = ["Desktop", "Tablet", "Mobile"]
control = Series("Control", [3.9, 3.1, 2.2])
variantB = Series("Variant B", [4.0, 3.6, 3.1])
tableCard = Card([tableHeader, tbl])
tableHeader = CardHeader("Funnel detail", "Sessions reaching each step")
tbl = Table([Col("Step", steps), Col("Control", ctl, "number"), Col("Variant B", vb, "number"), Col("Change", change)])
steps = ["Cart viewed", "Shipping entered", "Payment entered", "Order placed"]
ctl = [18420, 11230, 7480, 5310]
vb = [18390, 12950, 9120, 6420]
change = ["-0.2%", "+15.3%", "+21.9%", "+20.9%"]
planCard = Card([planHeader, rollout])
planHeader = CardHeader("Roll-out decision", "Your choice goes back to the agent as structured input")
rollout = Form("rollout", formButtons, [audienceField, shareField, notesField])
audienceField = FormControl("Audience", audience)
audience = RadioGroup("audience", [r1, r2, r3], "mobile")
r1 = RadioItem("Mobile only", "Ship where the lift is largest", "mobile")
r2 = RadioItem("All devices", "One checkout everywhere", "all")
r3 = RadioItem("Keep testing", "Run one more week first", "holdout")
shareField = FormControl("Traffic share (%)", Input("share", "e.g. 50", "number", {required: true, min: 1, max: 100}))
notesField = FormControl("Constraints", TextArea("constraints", "Anything the plan must respect", 3))
formButtons = Buttons([Button("Send decision", @ToAssistant("Roll out checkout variant B"), "primary")])
`;
}

export function htmlSeed(reply?: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Capacity plan</title>
<script src="canvas:lib/chart.js"></script>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font: 14px/1.5 var(--font-sans); background: var(--background); color: var(--foreground); }
  h1 { font-size: 20px; line-height: 1.3; margin: 0 0 4px; }
  .lede { margin: 0 0 16px; color: var(--muted-foreground); max-width: 70ch; }
  .reply { margin: 0 0 16px; padding: 10px 14px; border-radius: var(--radius); border: 1px solid var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
  .grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 16px; }
  @media (max-width: 760px) { .grid { grid-template-columns: minmax(0, 1fr); } body { padding: 14px; } }
  .card { min-width: 0; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 12px; }
  .chart { position: relative; height: 260px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-top: 14px; }
  .stat { padding: 10px; border-radius: calc(var(--radius) - 2px); background: var(--muted); }
  .stat b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .stat small, .option small { display: block; color: var(--muted-foreground); font-size: 12px; }
  fieldset { border: 0; padding: 0; margin: 0 0 14px; display: grid; gap: 8px; }
  legend { font-weight: 600; margin-bottom: 8px; padding: 0; }
  .option { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); cursor: pointer; }
  .option:has(input:checked) { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 12%, transparent); }
  .option input { margin-top: 3px; accent-color: var(--primary); }
  .field { display: grid; gap: 4px; margin-bottom: 12px; font-weight: 600; }
  input[type=number] { font: inherit; font-weight: 400; padding: 8px 10px; width: 100%; border-radius: calc(var(--radius) - 2px); border: 1px solid var(--border); background: var(--background); color: var(--foreground); }
  .check { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
  .check input { accent-color: var(--primary); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: inherit; padding: 8px 14px; border-radius: calc(var(--radius) - 2px); border: 1px solid var(--border); background: transparent; color: var(--foreground); cursor: pointer; }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); font-weight: 600; }
  .status { margin: 10px 0 0; min-height: 1.5em; color: var(--muted-foreground); }
</style>
</head>
<body>
${reply ? `<p class="reply" role="note">${escapeHtml(reply)}</p>\n` : ''}<h1>Capacity plan for the March launch</h1>
<p class="lede">Projected peak requests per second against what each scaling option provides. Pick one and I will write the rollout.</p>
<div class="grid">
  <section class="card">
    <h2>Peak load vs. capacity</h2>
    <div class="chart"><canvas id="chart" role="img" aria-label="Projected peak load and capacity by month"></canvas></div>
    <div class="stats">
      <div class="stat"><b id="headroom">-</b><small>Lowest headroom</small></div>
      <div class="stat"><b id="cost">-</b><small>Monthly cost</small></div>
      <div class="stat"><b id="risk">-</b><small>Launch risk</small></div>
    </div>
  </section>
  <section class="card">
    <h2>Decision</h2>
    <form id="decision" data-canvas-action="Choose scaling option">
      <fieldset>
        <legend>Scaling option</legend>
        <label class="option"><input type="radio" name="option" value="autoscale" checked><span>Autoscale<small>Pay per use; 90 seconds to scale out</small></span></label>
        <label class="option"><input type="radio" name="option" value="reserved"><span>Reserved<small>Fixed 2,400 rps; cheapest at steady load</small></span></label>
        <label class="option"><input type="radio" name="option" value="hybrid"><span>Hybrid<small>1,800 rps reserved plus autoscale bursts</small></span></label>
      </fieldset>
      <label class="field">Monthly budget cap (USD)<input type="number" name="budget" value="12000" min="0" step="500"></label>
      <label class="check"><input type="checkbox" name="alerts" checked> Page on-call above 80% utilization</label>
      <div class="actions">
        <button class="primary" type="submit">Send choice</button>
        <button type="button" id="ask">Ask for a cost breakdown</button>
      </div>
      <p class="status" id="status" aria-live="polite"></p>
    </form>
  </section>
</div>
<script>
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
  const load = [1200, 1450, 2900, 2300, 1900, 2050];
  const capacity = { autoscale: [1500, 1750, 3300, 2700, 2250, 2400], reserved: [2400, 2400, 2400, 2400, 2400, 2400], hybrid: [1800, 1800, 3400, 2800, 2300, 2400] };
  const cost = { autoscale: 11800, reserved: 8600, hybrid: 10400 };
  const form = document.getElementById('decision');
  // Chart.js needs plain rgb(): resolve whatever color syntax the theme uses through a 1px canvas.
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  function themeColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!value) return fallback;
    probe.clearRect(0, 0, 1, 1); probe.fillStyle = fallback; probe.fillStyle = value; probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + (a / 255).toFixed(3) + ')';
  }
  const saved = canvas.state.get();
  if (saved && typeof saved === 'object') {
    const radio = form.querySelector('input[name="option"][value="' + saved.option + '"]');
    if (radio) radio.checked = true;
    if (saved.budget !== undefined) form.elements.budget.value = saved.budget;
    if (typeof saved.alerts === 'boolean') form.elements.alerts.checked = saved.alerts;
  }
  const option = () => new FormData(form).get('option');
  const line = themeColor('--chart-1', '#4f8cff'), cap = themeColor('--chart-2', '#e9a23b');
  const text = themeColor('--muted-foreground', '#888888'), grid = themeColor('--border', '#33333366');
  const chart = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: { labels: months, datasets: [
      { label: 'Projected peak (rps)', data: load, borderColor: line, backgroundColor: line, tension: 0.35, pointRadius: 3, pointStyle: 'circle' },
      { label: 'Capacity (rps)', data: capacity[option()], borderColor: cap, backgroundColor: cap, borderDash: [6, 4], tension: 0.35, pointRadius: 0, pointStyle: 'line' },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { labels: { color: text, usePointStyle: true, pointStyleWidth: 18 } } },
      scales: { x: { ticks: { color: text }, grid: { color: grid } }, y: { ticks: { color: text }, grid: { color: grid }, beginAtZero: true } },
    },
  });
  function render() {
    const chosen = option(), headroom = Math.min(...capacity[chosen].map((c, i) => c - load[i]));
    chart.data.datasets[1].data = capacity[chosen]; chart.update();
    document.getElementById('headroom').textContent = (headroom >= 0 ? '+' : '') + headroom.toLocaleString('en-US') + ' rps';
    document.getElementById('cost').textContent = '$' + cost[chosen].toLocaleString('en-US');
    document.getElementById('risk').textContent = headroom < 0 ? 'Shortfall in Mar' : headroom < 300 ? 'Tight' : 'Comfortable';
  }
  render();
  form.addEventListener('change', () => { render(); save(); });
  form.addEventListener('input', save);
  function save() { canvas.state.set({ option: option(), budget: form.elements.budget.value, alerts: form.elements.alerts.checked }); }
  document.body.dataset.chart = 'ready';
  document.body.dataset.chartVersion = Chart.version;
  document.getElementById('ask').addEventListener('click', async () => {
    const status = document.getElementById('status');
    status.textContent = 'Sending...';
    try {
      await canvas.send('Ask for a cost breakdown', { option: option(), budget: Number(form.elements.budget.value) });
      status.textContent = 'Sent to your agent.';
    } catch (error) {
      status.textContent = 'Not sent: ' + (error && error.message ? error.message : String(error));
    }
  });
</script>
</body>
</html>
`;
}

/** Every probe should come back "blocked". The page reports through canvas.send only when asked. */
export function attackSeed() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sandbox probe</title>
<style>
  body { margin: 0; padding: 20px; font: 14px/1.5 var(--font-sans); background: var(--background); color: var(--foreground); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: var(--muted-foreground); margin: 0 0 16px; }
  ul { list-style: none; padding: 0; margin: 0 0 16px; display: grid; gap: 6px; max-width: 560px; }
  li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
  li b { font-family: var(--font-mono); font-weight: 600; }
  button { font: inherit; padding: 8px 14px; border-radius: var(--radius); border: 1px solid var(--primary); background: var(--primary); color: var(--primary-foreground); cursor: pointer; }
</style>
</head>
<body>
<h1>Sandbox probe</h1>
<p>This page tries to reach the network, the parent page, storage, and the top window.</p>
<ul id="results"></ul>
<p><a href="https://example.com/docs">Sandbox docs</a></p>
<button id="report" type="button">Report results to agent</button>
<p id="status" aria-live="polite"></p>
<script>
  const results = {};
  function show(name, value) {
    results[name] = value;
    let item = document.querySelector('[data-probe="' + name + '"]');
    if (!item) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><b></b>';
      li.firstChild.textContent = name;
      item = li.lastChild; item.dataset.probe = name;
      document.getElementById('results').append(li);
    }
    item.textContent = value;
  }
  const attempt = (name, fn) => { try { show(name, fn()); } catch (error) { show(name, 'blocked'); } };
  async function attemptAsync(name, fn) { try { show(name, await fn()); } catch (error) { show(name, 'blocked'); } }
  function navigateTop(name) {
    const before = Date.now();
    try { top.location.href = 'https://example.com/canvas-escape'; } catch (error) { show(name, 'blocked'); return; }
    // No exception: the browser may still have refused it. The test checks the top URL as well.
    setTimeout(() => show(name, 'ignored'), Math.max(0, 300 - (Date.now() - before)));
  }
  async function probe() {
    await attemptAsync('fetchService', async () => { await fetch('http://127.0.0.1:4318/health'); return 'reached'; });
    await attemptAsync('fetchRemote', async () => { await fetch('https://example.com/'); return 'reached'; });
    attempt('parentDocument', () => parent.document.title ? 'read' : 'read');
    attempt('parentLocalStorage', () => { parent.localStorage.setItem('canvas-probe', 'owned'); return 'written'; });
    attempt('parentSessionStorage', () => String(parent.sessionStorage.length) && 'read');
    // The bridge may stand in a memory store for refused storage; the native getter shows what the origin allows.
    const nativeStorage = name => Object.getOwnPropertyDescriptor(Window.prototype, name).get.call(window);
    attempt('ownLocalStorage', () => { nativeStorage('localStorage').setItem('canvas-probe', '1'); return 'available'; });
    attempt('ownSessionStorage', () => { nativeStorage('sessionStorage').getItem('canvas.viewer'); return 'available'; });
    attempt('cookie', () => { document.cookie = 'canvas-probe=1'; return document.cookie.includes('canvas-probe') ? 'available' : 'blocked'; });
    attempt('popup', () => window.open('https://example.com/', '_blank') ? 'opened' : 'blocked');
    navigateTop('topNavigation');
    await new Promise(resolve => setTimeout(resolve, 400));
    document.body.dataset.probeState = 'done';
  }
  probe();
  document.getElementById('report').addEventListener('click', async () => {
    navigateTop('topNavigationOnClick');
    await new Promise(resolve => setTimeout(resolve, 400));
    const status = document.getElementById('status');
    try { await canvas.send('Sandbox probe results', results); status.textContent = 'Reported.'; }
    catch (error) { status.textContent = 'Not sent: ' + (error && error.message ? error.message : String(error)); }
  });
</script>
</body>
</html>
`;
}

export function seedSource(kind: SeedKind, reply?: string) {
  return kind === 'openui' ? openuiSeed(reply) : kind === 'html' ? htmlSeed(reply) : attackSeed();
}
export const seedFormat = (kind: SeedKind) => kind === 'openui' ? 'openui' as const : 'html' as const;
