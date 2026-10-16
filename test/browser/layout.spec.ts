import { expect, test } from '@playwright/test';
import { TITLES } from './seeds';
import { htmlFrame, noHorizontalOverflow, openView, pageErrors, seed, show, viewUrl } from './helpers';

// These screenshots are the README images: a fresh conversation, nothing sent yet.
test('desktop browser shows both formats (README screenshots)', async ({ page, request }) => {
  const errors = pageErrors(page);
  const s = await seed(request, 'Checkout redesign', ['openui', 'html']);
  await page.goto(s.url);
  await expect(page.locator('.session-info')).toContainText('Checkout redesign');
  await openView(page, TITLES.openui);
  const openui = page.locator('[data-canvas-format="openui"]');
  await expect(openui.getByText('Funnel detail')).toBeVisible();
  await expect(openui.locator('svg').first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/canvas-openui.png' });

  await openView(page, TITLES.html);
  await expect(htmlFrame(page, TITLES.html).locator('body[data-chart="ready"]')).toBeAttached();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/canvas-html.png' });
  expect(errors).toEqual([]);
});

test('a 390x844 phone shows both formats without horizontal overflow', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = pageErrors(page);
  const s = await seed(request, 'Checkout redesign', ['openui', 'html']);

  // The sidebar may be folded away on a phone, so open each view by its link.
  await page.goto(viewUrl(s.url, s.views.html!.id));
  const frame = htmlFrame(page, TITLES.html);
  await expect(frame.locator('body[data-chart="ready"]')).toBeAttached();
  await noHorizontalOverflow(page);
  expect(await frame.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  // The views strip scrolls sideways on a phone; the open view is the one in sight.
  expect(await page.locator('nav[aria-label="Saved views"]').evaluate(nav => {
    const item = nav.querySelector('.nav-item.active')!.getBoundingClientRect(), strip = nav.getBoundingClientRect();
    return item.left >= strip.left - 1 && item.right <= strip.right + 1;
  })).toBe(true);
  await page.screenshot({ path: 'test-results/canvas-mobile-html.png', fullPage: true });

  await page.goto('about:blank');
  await page.goto(viewUrl(s.url, s.views.openui!.id));
  const openui = page.locator('[data-canvas-format="openui"]');
  await expect(openui.getByText('Funnel detail')).toBeVisible();
  await page.waitForTimeout(600);
  await noHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/canvas-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('at 390 px, a wrapping row of KPI cards wraps instead of clipping its contents', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await seed(request, 'KPI grid', []);
  const view = await show(request, s.sessionId, 'API latency', 'openui', [
    'root = Stack([header, kpis])',
    'header = CardHeader("API latency this week", "p95 per service from Monday\'s load test")',
    'kpis = Stack([kpiLatency, kpiErrors, kpiThroughput], "row", "m", "stretch", "start", true)',
    'kpiLatency = Card([TextContent("p95 latency", "small"), TextContent("212 ms", "large-heavy"), Tag("+18% vs last week", null, "sm", "warning")])',
    'kpiErrors = Card([TextContent("Error rate", "small"), TextContent("0.42%", "large-heavy"), Tag("Within budget", null, "sm", "success")])',
    'kpiThroughput = Card([TextContent("Peak throughput", "small"), TextContent("1,840 rps", "large-heavy"), Tag("Steady", null, "sm", "neutral")])',
  ].join('\n'));
  await page.goto(viewUrl(s.url, view.id));
  const content = page.locator('[data-canvas-format="openui"]');
  await expect(content.getByText('+18% vs last week')).toBeVisible();
  await page.waitForTimeout(300);
  await noHorizontalOverflow(page);
  const widths = await content.locator('.openui-card').evaluateAll(cards => cards.map(c => c.getBoundingClientRect().width));
  expect(widths.length).toBe(3);
  for (const width of widths) expect(width).toBeGreaterThan(250);
  // Nothing inside is cut off: no element that hides overflow is narrower than its content.
  const clipped = await content.evaluate(root => [...root.querySelectorAll('*')].filter(el => {
    const style = getComputedStyle(el);
    return (style.overflowX === 'hidden' || style.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1;
  }).map(el => `${el.className}: ${el.textContent?.slice(0, 40)}`));
  expect(clipped).toEqual([]);
});
