import { expect, test, type Page } from '@playwright/test';
import { TITLES } from './seeds';
import { deliveries, htmlFrame, openView, pageErrors, received, seed } from './helpers';

const harness = (a: string, b: string) => `http://127.0.0.1:4319/harness?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
const paneOf = (page: Page) => page.frameLocator('iframe[title="Agent Canvas pane"]');

test('the guest panel ships with the sandbox and guest CSP OpenChamber serves it with', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:4319/api/guests/agent-canvas/panel/index.html');
  expect(response.ok()).toBe(true);
  const csp = response.headers()['content-security-policy'];
  expect(csp).toContain('sandbox allow-scripts');
  expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' 'self' data: blob:");
  expect(csp).toContain("frame-src 'self' data: blob:");
  expect(csp).toContain('connect-src 127.0.0.1:4319/api/guests/agent-canvas/');
  // The panel page must be a classic script: OpenChamber cannot load a module entry.
  expect(await response.text()).toMatch(/<script src="app\.js"><\/script>/);
});

test('the sandboxed pane renders both formats, delivers sends, and follows the conversation', async ({ page, request }) => {
  const errors = pageErrors(page);
  const s = await seed(request, 'Checkout redesign', ['openui', 'html']);
  const other = await seed(request, 'Second conversation', []);
  await page.goto(harness(s.sessionId, other.sessionId));
  const pane = paneOf(page);
  await expect(pane.locator('.session-info')).toContainText('Checkout redesign');

  await openView(pane, TITLES.openui);
  const openui = pane.locator('[data-canvas-format="openui"]');
  await expect(openui.getByText('Funnel detail')).toBeVisible();
  await expect(openui.locator('svg').first()).toBeVisible();
  await page.waitForTimeout(600);
  // The pane alone, without the harness controls, in OpenChamber's light theme: the pane follows the host.
  await page.getByRole('button', { name: 'Light theme', exact: true }).click();
  await page.waitForTimeout(600);
  await page.locator('iframe[title="Agent Canvas pane"]').screenshot({ path: 'test-results/canvas-pane.png' });
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click();

  await openui.getByPlaceholder('e.g. 50').fill('50');
  await openui.getByRole('button', { name: 'Send decision' }).click();
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
  const [decision] = await received(request, s.sessionId);
  expect(decision.text).toContain(`(view ${s.views.openui!.id}, revision 1)`);
  expect(decision.text).toMatch(/"share": "?50"?/);

  // HTML in the pane renders in srcdoc under the guest policy; chart.js comes from the package's lib/.
  await openView(pane, TITLES.html);
  const frame = htmlFrame(pane, TITLES.html);
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();
  await frame.getByRole('button', { name: 'Ask for a cost breakdown' }).click();
  await expect(frame.locator('#status')).toHaveText('Sent to your agent.');
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(2);
  expect((await received(request, s.sessionId))[1].text).toContain(`(view ${s.views.html!.id}, revision 1)`);
  // The delivery list belongs to the view on screen.
  await expect(deliveries(pane)).toHaveCount(1);
  await expect(deliveries(pane).first()).toHaveAttribute('data-status', 'delivered');

  await page.getByRole('button', { name: 'Conversation B', exact: true }).click();
  await expect(pane.locator('.session-info')).toContainText('Second conversation');
  await expect(deliveries(pane)).toHaveCount(0);
  await page.getByRole('button', { name: 'Conversation A', exact: true }).click();
  await expect(pane.locator('.session-info')).toContainText('Checkout redesign');

  await pane.getByRole('button', { name: 'Open in browser', exact: true }).click();
  await expect(page.locator('#opened')).toContainText('http://127.0.0.1:4318/#');
  expect(errors).toEqual([]);
});

test('the pane remembers a browser preference and can still show a view here once', async ({ page, request }) => {
  const s = await seed(request, 'Surface preference', ['openui']);
  await page.goto(harness(s.sessionId, s.sessionId));
  const pane = paneOf(page);
  await openView(pane, TITLES.openui);
  await expect(pane.locator('[data-canvas-format="openui"]')).toBeVisible();
  const select = pane.getByLabel('Preferred surface');
  const browser = await select.locator('option').filter({ hasText: /browser/i }).first().getAttribute('value');
  await select.selectOption(browser!);

  await page.reload();
  await expect(pane.getByRole('button', { name: 'Show here this time', exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Show here this time', exact: true }).click();
  await openView(pane, TITLES.openui);
  await expect(pane.locator('[data-canvas-format="openui"]').getByText('Funnel detail')).toBeVisible();
});

test('switching conversations while the pane is saving never sends input to the other conversation', async ({ page, request }) => {
  const s = await seed(request, 'Race conversation', ['html']);
  const other = await seed(request, 'Other conversation', ['html']);
  await page.goto(harness(s.sessionId, other.sessionId));
  const pane = paneOf(page);
  await openView(pane, TITLES.html);
  const frame = htmlFrame(pane, TITLES.html);
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();

  // Hold every host storage write, send, and switch conversations before anything is released.
  await page.getByLabel('Hold storage saves').check();
  await frame.getByRole('button', { name: 'Ask for a cost breakdown' }).click();
  await expect(page.locator('#pending')).toHaveText('Storage save held');
  await page.getByRole('button', { name: 'Conversation B', exact: true }).click();
  await page.getByLabel('Hold storage saves').uncheck();
  await page.getByRole('button', { name: 'Release save', exact: true }).click();
  await expect(pane.locator('.session-info')).toContainText('Other conversation');
  await page.getByRole('button', { name: 'Release save', exact: true }).click();
  await expect(pane.getByRole('alert')).toContainText('The conversation changed before your input was sent');
  await page.waitForTimeout(2_000);
  expect(await received(request, other.sessionId)).toHaveLength(0);
  expect(await received(request, s.sessionId)).toHaveLength(0);

  // Back in its own conversation, the input waits as unconfirmed, and sending it again delivers it once.
  await page.getByRole('button', { name: 'Conversation A', exact: true }).click();
  await expect(pane.locator('.session-info')).toContainText('Race conversation');
  const banner = pane.locator('.banner').filter({ hasText: 'was not confirmed as received' });
  await expect(banner).toContainText('Ask for a cost breakdown');
  await banner.getByRole('button', { name: 'Send it again' }).click();
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
  expect((await received(request, s.sessionId))[0].text).toContain(`(view ${s.views.html!.id}, revision 1)`);
  await page.waitForTimeout(1_500);
  expect(await received(request, s.sessionId)).toHaveLength(1);
  expect(await received(request, other.sessionId)).toHaveLength(0);
});
