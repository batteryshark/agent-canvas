import { expect, test } from '@playwright/test';
import { TITLES } from './seeds';
import { deliveries, htmlFrame, openView, pageErrors, received, revise, seed, selectRevision, setBusy, show, staleBanner, viewUrl } from './helpers';

test('an HTML view renders chart.js, and canvas.send and a data-canvas-action form both deliver', async ({ page, request }) => {
  const errors = pageErrors(page);
  const s = await seed(request, 'HTML delivery', ['html']);
  await page.goto(s.url);
  await openView(page, TITLES.html);
  await expect(page.locator('[data-canvas-format="html"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open viewing link' })).toBeVisible();
  const frame = htmlFrame(page, TITLES.html);

  // canvas:lib/chart.js was inlined and drew on the canvas.
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();
  expect(await frame.locator('body').getAttribute('data-chart-version')).toMatch(/^4\./);
  const painted = await frame.locator('#chart').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
    return count;
  });
  expect(painted).toBeGreaterThan(500);
  await expect(frame.locator('#risk')).toHaveText('Comfortable');

  await frame.getByRole('button', { name: 'Ask for a cost breakdown' }).click();
  await expect(frame.locator('#status')).toHaveText('Sent to your agent.');
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
  const [ask] = await received(request, s.sessionId);
  expect(ask.text).toContain(`[Agent Canvas] ${TITLES.html} (view ${s.views.html!.id}, revision 1)`);
  expect(ask.text).toContain('Action: Ask for a cost breakdown');
  expect(ask.text).toContain('"option": "autoscale"');
  expect(ask.text).toContain('"budget": 12000');

  // The agent's answer arrives as revision 2, which the conversation now shows.
  await expect(frame.getByRole('note')).toContainText("Received 'Ask for a cost breakdown'");
  await frame.getByLabel(/^Hybrid/).check();
  await expect(frame.locator('#risk')).toHaveText('Comfortable');
  await frame.getByLabel('Monthly budget cap (USD)').fill('15000');
  await expect(frame.getByLabel(/Page on-call/)).toBeChecked();
  await frame.getByRole('button', { name: 'Send choice' }).click();
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(2);
  const choice = (await received(request, s.sessionId))[1];
  expect(choice.text).toContain(`(view ${s.views.html!.id}, revision 2)`);
  expect(choice.text).toContain('Action: Choose scaling option');
  expect(choice.text).toContain('"option": "hybrid"');
  expect(choice.text).toMatch(/"budget": "?15000"?/);
  expect(choice.text).toContain('"alerts": true');
  await expect(deliveries(page).and(page.locator('[data-status="delivered"]'))).toHaveCount(2);

  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit full screen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an HTML draft (canvas.state) survives a reload', async ({ page, request }) => {
  const s = await seed(request, 'HTML drafts', ['html']);
  await page.goto(s.url);
  await openView(page, TITLES.html);
  const frame = htmlFrame(page, TITLES.html);
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();
  await frame.getByLabel(/^Reserved/).check();
  await frame.getByLabel('Monthly budget cap (USD)').fill('9500');
  await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(v => v.includes('9500') && v.includes('reserved')))).toBe(true);

  await page.reload();
  await openView(page, TITLES.html);
  await expect(frame.getByLabel('Monthly budget cap (USD)')).toHaveValue('9500');
  await expect(frame.getByLabel(/^Reserved/)).toBeChecked();
  await expect(frame.locator('#risk')).toHaveText('Shortfall in Mar');
});

test('a stale HTML revision is marked and cannot send', async ({ page, request }) => {
  const s = await seed(request, 'HTML stale revision', ['html']);
  await revise(request, s.sessionId, s.views.html!.id, 'Capacity numbers refreshed for April.');
  await page.goto(s.url);
  await openView(page, TITLES.html);
  const frame = htmlFrame(page, TITLES.html);
  await expect(frame.getByRole('note')).toContainText('Capacity numbers refreshed');

  await selectRevision(page, 1);
  await expect(staleBanner(page)).toBeVisible();
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();
  await expect(frame.getByRole('note')).toHaveCount(0);
  // Clicked from inside the page, past any overlay the shell may draw: the bridge must still refuse.
  await frame.getByRole('button', { name: 'Ask for a cost breakdown' }).dispatchEvent('click');
  await page.waitForTimeout(2_500);
  await expect(frame.locator('#status')).not.toHaveText('Sent to your agent.');
  expect(await received(request, s.sessionId)).toHaveLength(0);
  await expect(deliveries(page)).toHaveCount(0);
});

test('a busy agent leaves input unsent until Retry delivers it', async ({ page, request }) => {
  const s = await seed(request, 'Busy agent', ['html']);
  await page.goto(s.url);
  await openView(page, TITLES.html);
  const frame = htmlFrame(page, TITLES.html);
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();

  await setBusy(request, true);
  try {
    await frame.getByRole('button', { name: 'Ask for a cost breakdown' }).click();
    await expect(frame.locator('#status')).toHaveText('Sent to your agent.');
    await expect(deliveries(page).first()).toHaveAttribute('data-status', 'unsent');
    expect(await received(request, s.sessionId)).toHaveLength(0);
  } finally {
    await setBusy(request, false);
  }
  await deliveries(page).first().getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(deliveries(page).first()).toHaveAttribute('data-status', 'delivered');
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
  const [prompt] = await received(request, s.sessionId);
  expect(prompt.text).toContain('Action: Ask for a cost breakdown');
  await expect(deliveries(page)).toHaveCount(1);
});

test('a script-free data-canvas-action form keeps what was typed just before a reload', async ({ page, request }) => {
  const s = await seed(request, 'Form-only draft', []);
  const view = await show(request, s.sessionId, 'Form draft', 'html', '<!doctype html><html><head><title>Form draft</title></head><body><form data-canvas-action="Go"><label>Name <input name="who"></label><button type="submit">Go</button></form></body></html>');
  await page.goto(viewUrl(s.url, view.id));
  const frame = htmlFrame(page, 'Form draft');
  await frame.getByLabel('Name').fill('Typed then reloaded');
  await page.waitForTimeout(100);
  await page.reload();
  await expect(frame.getByLabel('Name')).toHaveValue('Typed then reloaded');
});

test('when the answer to a send is lost, the input is confirmed instead of sent twice', async ({ page, request }) => {
  const s = await seed(request, 'Lost answer', ['html']);
  await page.goto(s.url);
  await openView(page, TITLES.html);
  const frame = htmlFrame(page, TITLES.html);
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();
  let dropped = 0;
  await page.route('**/api/submit', async route => {
    if (dropped++) { await route.continue(); return; }
    // The service admits the input, but its answer never reaches the page.
    await route.fetch();
    await route.abort('connectionreset');
  });
  await frame.getByRole('button', { name: 'Ask for a cost breakdown' }).click();
  await expect(frame.locator('#status')).toHaveText('Sent to your agent.');
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
  await page.waitForTimeout(1_500);
  const all = await received(request, s.sessionId);
  expect(all).toHaveLength(1);
  expect(all[0].duplicate).toBe(false);
  expect(dropped).toBe(2);
});
