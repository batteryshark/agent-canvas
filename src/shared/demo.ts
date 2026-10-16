// The built-in demo: one OpenUI view and one HTML view that exercise the whole
// show → interact → deliver → revise loop without calling a model.
import type { Format, ShowInput } from './contract';

export const DEMO_LABEL = 'Interactive demo · no model calls';
export const DEMO_DASHBOARD_TITLE = 'Product dashboard';
export const DEMO_CHECKOUT_TITLE = 'Checkout layout options';

/** What the demo worker received, echoed back in the next revision. */
export type DemoReceipt = { action: string; data: unknown; notes: string; revision: number };

// OpenUI Lang strings are double-quoted with backslash escapes, which JSON string syntax satisfies.
const q = (text: string) => JSON.stringify(text);
const pretty = (data: unknown) => JSON.stringify(data ?? null, null, 2);

export function demoDashboard(receipt?: DemoReceipt): ShowInput {
  const ack = receipt ? [
    `ack = Card([ackCallout, ackData, ackNote])`,
    `ackCallout = Callout("success", ${q(`Demo agent received “${receipt.action}”`)}, ${q(`From revision ${receipt.revision}. This new revision is the demo agent's reply.`)})`,
    `ackData = CodeBlock("json", ${q(pretty(receipt.data))})`,
    `ackNote = TextContent(${q(receipt.notes ? `Your note: ${receipt.notes}` : 'In a real conversation this arrives as a message your agent can act on.')}, "small")`,
  ] : [];
  const source = [
    `root = Stack([${receipt ? 'ack, ' : ''}title, intro, chartCard, tableCard, requestCard])`,
    ...ack,
    `title = TextContent(${q(DEMO_DASHBOARD_TITLE)}, "large-heavy")`,
    `intro = TextContent(${q(`Weekly signups, top accounts, and a request form that sends its values back to the conversation. ${DEMO_LABEL}.`)}, "small")`,
    `chartCard = Card([chartHeader, chart])`,
    `chartHeader = CardHeader("Signups by week", "Free and Pro plans")`,
    `chart = BarChart(weeks, [freeSeries, proSeries], "grouped", "Week", "Signups")`,
    `weeks = ["W1", "W2", "W3", "W4", "W5", "W6"]`,
    `freeSeries = Series("Free", [320, 410, 380, 460, 520, 590])`,
    `proSeries = Series("Pro", [84, 96, 120, 131, 150, 172])`,
    `tableCard = Card([tableHeader, accounts])`,
    `tableHeader = CardHeader("Top accounts", "By monthly recurring revenue")`,
    `accounts = Table([Col("Account", names), Col("Plan", plans), Col("Seats", seats, "number"), Col("MRR ($)", mrr, "number")])`,
    `names = ["Northwind", "Contoso", "Fabrikam", "Tailspin", "Litware"]`,
    `plans = ["Enterprise", "Pro", "Pro", "Team", "Team"]`,
    `seats = [240, 85, 62, 30, 24]`,
    `mrr = [12400, 4250, 3100, 1500, 1200]`,
    `requestCard = Card([requestHeader, requestForm])`,
    `requestHeader = CardHeader("Ask the agent", "The focus and details you enter are sent to the conversation")`,
    `requestForm = Form("request", requestButtons, [focusField, detailsField])`,
    `focusField = FormControl("Focus", Select("focus", focusOptions, "Choose an area", { required: true }))`,
    `focusOptions = [SelectItem("growth", "Grow Pro signups"), SelectItem("retention", "Reduce churn"), SelectItem("pricing", "Revisit pricing")]`,
    `detailsField = FormControl("Details", TextArea("details", "What should the agent look into?", 3))`,
    `requestButtons = Buttons([Button("Send request", @ToAssistant("Send request"), "primary")])`,
  ].join('\n');
  return { title: DEMO_DASHBOARD_TITLE, summary: DEMO_LABEL, format: 'openui', source };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function demoCheckout(receipt?: DemoReceipt): ShowInput {
  const chosen = (receipt?.data as { layout?: unknown } | null)?.layout;
  const initial = chosen === 'B' ? 'B' : 'A';
  const ack = receipt ? `
  <section class="card ack" role="status">
    <strong>Demo agent received “${escapeHtml(receipt.action)}” from revision ${receipt.revision}</strong>
    <pre>${escapeHtml(pretty(receipt.data))}</pre>
    <p class="muted">${escapeHtml(receipt.notes ? `Your note: ${receipt.notes}` : 'In a real conversation this arrives as a message your agent can act on.')}</p>
  </section>` : '';
  const source = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DEMO_CHECKOUT_TITLE}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: var(--background); color: var(--foreground); font: 14px/1.5 var(--font-sans, system-ui, sans-serif); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .muted { color: var(--muted-foreground); margin: 0; }
  .card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: var(--radius, 10px); padding: 16px; }
  .top { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; justify-content: space-between; margin-bottom: 16px; }
  .toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; padding: 3px; background: var(--muted); }
  .toggle button { border: 0; background: transparent; color: var(--muted-foreground); padding: 6px 12px; border-radius: 999px; font: inherit; cursor: pointer; }
  .toggle button[aria-pressed="true"] { background: var(--background); color: var(--foreground); box-shadow: 0 1px 2px rgb(0 0 0 / .15); }
  .checkout { display: grid; gap: 16px; }
  .checkout.layout-B { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); align-items: start; }
  .checkout.layout-A .summary { order: -1; }
  @media (max-width: 640px) { .checkout.layout-B { grid-template-columns: minmax(0, 1fr); } }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .field { border: 1px solid var(--border); border-radius: calc(var(--radius, 10px) - 4px); padding: 8px 10px; background: var(--background); }
  .field span { display: block; font-size: 12px; color: var(--muted-foreground); }
  .items { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 6px; }
  .items li, .total { display: flex; justify-content: space-between; gap: 12px; }
  .total { border-top: 1px solid var(--border); padding-top: 10px; font-weight: 600; }
  .pay, .primary, form button { border: 0; border-radius: calc(var(--radius, 10px) - 2px); padding: 10px 16px; font: inherit; font-weight: 600; cursor: pointer; background: var(--primary); color: var(--primary-foreground); }
  .pay { width: 100%; margin-top: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 16px 0; }
  form { display: grid; gap: 10px; }
  textarea { width: 100%; font: inherit; color: var(--foreground); background: var(--background); border: 1px solid var(--border); border-radius: calc(var(--radius, 10px) - 4px); padding: 8px; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 14px; }
  legend { font-weight: 600; margin-bottom: 6px; }
  form button { justify-self: start; }
  .ack { border-color: var(--success); margin-bottom: 16px; }
  .ack pre { font: 12px/1.4 var(--font-mono, ui-monospace, monospace); background: var(--muted); padding: 8px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
</style>
</head>
<body>${ack}
  <header class="top">
    <div>
      <h1>Checkout redesign</h1>
      <p class="muted">Compare the two layouts here; choosing one sends it to the agent. ${DEMO_LABEL}.</p>
    </div>
    <div class="toggle" role="group" aria-label="Layout variant">
      <button type="button" data-layout="A" aria-pressed="false">A · Summary first</button>
      <button type="button" data-layout="B" aria-pressed="false">B · Summary beside</button>
    </div>
  </header>
  <main id="checkout" class="checkout">
    <section class="card">
      <h2>Shipping</h2>
      <div class="fields">
        <div class="field"><span>Name</span>Ada Lovelace</div>
        <div class="field"><span>Email</span>ada@example.com</div>
        <div class="field"><span>Address</span>12 Analytical Way</div>
        <div class="field"><span>Delivery</span>Standard · 3–5 days</div>
      </div>
      <h2>Payment</h2>
      <div class="fields">
        <div class="field"><span>Card</span>•••• •••• •••• 4242</div>
        <div class="field"><span>Billing</span>Same as shipping</div>
      </div>
    </section>
    <aside class="card summary">
      <h2>Order summary</h2>
      <ul class="items">
        <li><span>Trail runner · size 9</span><span>$128.00</span></li>
        <li><span>Merino socks × 2</span><span>$24.00</span></li>
        <li><span>Shipping</span><span>$6.00</span></li>
        <li><span>Tax</span><span>$5.40</span></li>
      </ul>
      <div class="total"><span>Total</span><span>$163.40</span></div>
      <button type="button" class="pay">Pay $163.40</button>
    </aside>
  </main>
  <div class="actions">
    <button type="button" class="primary" id="choose">Choose this layout</button>
    <span id="status" class="muted" role="status"></span>
  </div>
  <form id="feedback" class="card" data-canvas-action="Send feedback">
    <h2>Feedback</h2>
    <label for="comment">What works, and what doesn't?</label>
    <textarea id="comment" name="comment" rows="3" placeholder="The summary should stay visible while paying…"></textarea>
    <fieldset>
      <legend>Concerns</legend>
      <label><input type="checkbox" name="mobile"> Mobile fit</label>
      <label><input type="checkbox" name="trust"> Payment trust</label>
      <label><input type="checkbox" name="speed"> Checkout speed</label>
    </fieldset>
    <button type="submit">Send feedback</button>
  </form>
<script>
  const names = { A: 'Summary first', B: 'Summary beside' };
  const saved = (window.canvas && window.canvas.state.get()) || {};
  let layout = names[saved.layout] ? saved.layout : ${JSON.stringify(initial)};
  const main = document.getElementById('checkout'), status = document.getElementById('status'), form = document.getElementById('feedback');
  // The layout and the unsent feedback are this page's draft: they survive reloads and reconnects.
  const fields = () => Array.from(form.elements).filter(el => el.name);
  const draft = saved.feedback || {};
  fields().forEach(el => { if (el.name in draft) el.type === 'checkbox' ? el.checked = !!draft[el.name] : el.value = draft[el.name]; });
  function save() {
    const feedback = {};
    fields().forEach(el => { feedback[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
    if (window.canvas) window.canvas.state.set({ layout, feedback });
  }
  form.addEventListener('input', save);
  function apply(next) {
    layout = next;
    main.className = 'checkout layout-' + next;
    document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layout === next)));
  }
  document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => { apply(b.dataset.layout); save(); }));
  document.getElementById('choose').addEventListener('click', async () => {
    status.textContent = 'Sending…';
    try {
      await window.canvas.send('Choose this layout', { layout, name: names[layout] });
      status.textContent = 'Sent to your agent.';
    } catch (error) {
      status.textContent = 'Not sent: ' + (error && error.message ? error.message : error);
    }
  });
  apply(layout);
</script>
</body>
</html>
`;
  return { title: DEMO_CHECKOUT_TITLE, summary: DEMO_LABEL, format: 'html', source };
}

export const demoViews = (): ShowInput[] => [demoDashboard(), demoCheckout()];

/** The demo agent's answer to an interaction: a new revision of the same view that echoes it. */
export const demoReply = (format: Format, receipt: DemoReceipt): ShowInput =>
  format === 'openui' ? demoDashboard(receipt) : demoCheckout(receipt);
