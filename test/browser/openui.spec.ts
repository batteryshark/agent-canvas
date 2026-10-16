import { expect, test } from '@playwright/test';
import { TITLES } from './seeds';
import { deliveries, openView, pageErrors, received, revise, seed, selectRevision, show, staleBanner, viewUrl } from './helpers';

test('an OpenUI view renders a chart, a table and a form, and the form values reach the agent', async ({ page, request }) => {
  const errors = pageErrors(page);
  const s = await seed(request, 'OpenUI form delivery', ['openui']);
  await page.goto(s.url);
  await openView(page, TITLES.openui);
  const content = page.locator('[data-canvas-format="openui"]');
  await expect(content.getByText('Checkout redesign: week 3 results')).toBeVisible();
  await expect(content.locator('svg').first()).toBeVisible();
  await expect(content.getByText('Payment entered')).toBeVisible();
  await expect(content.getByText('Conversion by device')).toBeVisible();

  await content.getByRole('radio', { name: /All devices/ }).click();
  await content.getByPlaceholder('e.g. 50').fill('25');
  await content.getByPlaceholder('Anything the plan must respect').fill('Keep the legacy header for one release');
  await page.getByLabel('Note to the agent').fill('Coordinate with the payments team.');
  await content.getByRole('button', { name: 'Send decision' }).click();

  await expect(deliveries(page).first()).toHaveAttribute('data-status', 'delivered');
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
  const [prompt] = await received(request, s.sessionId);
  expect(prompt.text).toContain(`[Agent Canvas] ${TITLES.openui} (view ${s.views.openui!.id}, revision 1)`);
  expect(prompt.text).toContain('Action: Roll out checkout variant B');
  expect(prompt.text).toContain('"audience": "all"');
  expect(prompt.text).toMatch(/"share": "?25"?/);
  expect(prompt.text).toContain('"constraints": "Keep the legacy header for one release"');
  expect(prompt.text).toContain('Note: Coordinate with the payments team.');
  expect(prompt.delivery).toBe('queue');
  expect(prompt.duplicate).toBe(false);

  // The fixture answers like an agent, with a new revision; the conversation's view follows it.
  await expect(content.getByText("Received 'Roll out checkout variant B'")).toBeVisible();
  expect(errors).toEqual([]);
});

test('form fields the user left at their defaults are delivered too', async ({ page, request }) => {
  const s = await seed(request, 'OpenUI form defaults', ['openui']);
  await page.goto(s.url);
  await openView(page, TITLES.openui);
  const content = page.locator('[data-canvas-format="openui"]');
  // "Mobile only" is preselected by RadioGroup's defaultValue; the user only types the share.
  await expect(content.getByRole('radio', { name: /Mobile only/ })).toBeChecked();
  await content.getByPlaceholder('e.g. 50').fill('30');
  await content.getByRole('button', { name: 'Send decision' }).click();
  await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
  const [prompt] = await received(request, s.sessionId);
  expect(prompt.text).toMatch(/"share": "?30"?/);
  expect(prompt.text).toContain('"audience": "mobile"');
});

test('an OpenUI draft survives a reload', async ({ page, request }) => {
  const s = await seed(request, 'OpenUI drafts', ['openui']);
  await page.goto(s.url);
  await openView(page, TITLES.openui);
  const content = page.locator('[data-canvas-format="openui"]');
  await content.getByPlaceholder('e.g. 50').fill('35');
  await content.getByPlaceholder('Anything the plan must respect').fill('Draft: keep the legacy header');
  await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(v => v.includes('Draft: keep the legacy header')))).toBe(true);

  await page.reload();
  await openView(page, TITLES.openui);
  await expect(content.getByPlaceholder('e.g. 50')).toHaveValue('35');
  await expect(content.getByPlaceholder('Anything the plan must respect')).toHaveValue('Draft: keep the legacy header');
});

test('a stale OpenUI revision is marked and cannot send', async ({ page, request }) => {
  const s = await seed(request, 'OpenUI stale revision', ['openui']);
  await revise(request, s.sessionId, s.views.openui!.id, 'Updated: mobile conversion for variant B is now 3.3%.');
  await page.goto(s.url);
  await openView(page, TITLES.openui);
  const content = page.locator('[data-canvas-format="openui"]');
  await expect(content.getByText('Updated: mobile conversion')).toBeVisible();

  await selectRevision(page, 1);
  await expect(staleBanner(page)).toBeVisible();
  await expect(content.getByText('Updated: mobile conversion')).toHaveCount(0);
  // Try anyway, past any disabled state: nothing may reach the agent.
  await content.getByPlaceholder('e.g. 50').fill('40', { timeout: 2_000 }).catch(() => {});
  await content.getByRole('button', { name: 'Send decision' }).dispatchEvent('click');
  await page.waitForTimeout(2_500);
  expect(await received(request, s.sessionId)).toHaveLength(0);
  await expect(deliveries(page)).toHaveCount(0);
});

test('an OpenUI draft keeps what was typed just before a reload', async ({ page, request }) => {
  const s = await seed(request, 'OpenUI quick reload', ['openui']);
  await page.goto(s.url);
  await openView(page, TITLES.openui);
  const content = page.locator('[data-canvas-format="openui"]');
  await content.getByPlaceholder('Anything the plan must respect').fill('Typed then reloaded');
  await page.waitForTimeout(100);
  await page.reload();
  await openView(page, TITLES.openui);
  await expect(content.getByPlaceholder('Anything the plan must respect')).toHaveValue('Typed then reloaded');
});

test.describe('east of UTC', () => {
  test.use({ timezoneId: 'Europe/Berlin' });
  test('a required DatePicker sends the day the user picked, and its calendar gets out of the way', async ({ page, request }) => {
    const s = await seed(request, 'Launch date', []);
    const view = await show(request, s.sessionId, 'Launch date', 'openui', [
      'root = Stack([form])',
      'form = Form("launch", Buttons([go]), [field])',
      'field = FormControl("Launch date", DatePicker("launchDate", "single", { required: true }))',
      'go = Button("Set launch date", @ToAssistant("Set launch date"), "primary")',
    ].join('\n'));
    await page.goto(viewUrl(s.url, view.id));
    const content = page.locator('[data-canvas-format="openui"]');
    const calendar = page.locator('.openui-date-picker-renderer-floating-content');
    const opener = content.locator('.openui-date-picker-renderer-floating-input-container');
    await opener.click();
    await expect(calendar).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(calendar).toHaveCount(0);
    await opener.click();
    await calendar.locator('button', { hasText: /^15$/ }).first().click();
    await expect(calendar).toHaveCount(0);
    await content.getByRole('button', { name: 'Set launch date' }).click();
    await expect.poll(async () => (await received(request, s.sessionId)).length).toBe(1);
    const date = /"launchDate": "(\d{4}-\d{2}-\d{2})"/.exec((await received(request, s.sessionId))[0].text)?.[1];
    expect(date).toMatch(/-15$/);
  });
});
