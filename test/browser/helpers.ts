import { expect, type APIRequestContext, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SeedKind } from './seeds';

export const CONTROL = 'http://127.0.0.1:4319/control';
export const SERVICE = 'http://127.0.0.1:4318';
export type Scope = Page | FrameLocator;
export type Seeded = { sessionId: string; title: string; url: string; viewerKey: string; views: Partial<Record<SeedKind, { id: string; title: string }>> };
export type Received = { sessionID: string; id: string | null; text: string; delivery: unknown; resume: unknown; duplicate: boolean };

export const fixture = () => JSON.parse(readFileSync('.runtime/browser-fixture.json', 'utf8'));

/** A fresh conversation in the fixture project, with views shown through the real canvas_show tool. */
export async function seed(request: APIRequestContext, title: string, views: SeedKind[]): Promise<Seeded> {
  const response = await request.post(`${CONTROL}/seed`, { data: { title, views } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
/** Like the agent revising a view between turns. */
export async function revise(request: APIRequestContext, sessionId: string, viewId: string, reply: string): Promise<number> {
  const response = await request.post(`${CONTROL}/revise`, { data: { sessionId, viewId, reply } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).revision;
}
/** Prompts the fake OpenCode received through session.prompt, oldest first. */
export async function received(request: APIRequestContext, sessionId: string): Promise<Received[]> {
  const data = await (await request.get(CONTROL)).json();
  return data.received.filter((r: Received) => r.sessionID === sessionId);
}
export async function setBusy(request: APIRequestContext, busy: boolean) {
  expect((await request.post(CONTROL, { data: { busy } })).ok()).toBe(true);
}
export const viewUrl = (url: string, viewId: string) => `${url}&view=${viewId}`;

export const sidebar = (scope: Scope) => scope.locator('nav[aria-label="Saved views"]');
export async function openView(scope: Scope, title: string) {
  await sidebar(scope).getByRole('button', { name: title }).first().click();
}
export const htmlFrame = (scope: Scope, title: string) => scope.frameLocator(`iframe[title="Canvas page: ${title}"]`);
export const deliveries = (scope: Scope) => scope.locator('section[aria-label="Sent to your agent"] .delivery');
export const staleBanner = (scope: Scope) => scope.getByRole('status').filter({ hasText: 'newer revision' });

async function options(select: Locator) {
  return select.locator('option').evaluateAll(list => list.map(o => ({ value: (o as HTMLOptionElement).value, text: o.textContent || '' })));
}
/** Picks revision n in the "Revision" select, whatever the option labels say. */
export async function selectRevision(scope: Scope, n: number) {
  const select = scope.getByLabel('Revision', { exact: true });
  const pattern = new RegExp(`(^|\\D)${n}(\\D|$)`);
  const find = async () => { const all = await options(select); return all.find(o => o.value === String(n)) ?? all.find(o => pattern.test(o.text)); };
  await expect.poll(async () => !!(await find())).toBe(true);
  await select.selectOption((await find())!.value);
}

export function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}
export async function noHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(widths.document, JSON.stringify(widths)).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body, JSON.stringify(widths)).toBeLessThanOrEqual(widths.viewport);
}

/** Shows any view in a seeded conversation, through the real canvas_show tool. */
export async function show(request: APIRequestContext, sessionId: string, title: string, format: 'openui' | 'html', source: string): Promise<{ id: string; title: string; result: string }> {
  const response = await request.post(`${CONTROL}/show`, { data: { sessionId, title, format, source } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
/** Pins a view as the conversation's viewer would, through the service's viewer API. */
export async function pin(request: APIRequestContext, viewerKey: string, viewId: string, name: string, expectedRevision: number) {
  const response = await request.post(`${SERVICE}/api/pin`, { headers: { Authorization: `Bearer ${viewerKey}` }, data: { viewId, name, expectedRevision } });
  expect(response.ok(), await response.text()).toBe(true);
}
/** Requests that reached the fixture's /beacon/ listener: a page with no network must never add one. */
export async function beacons(request: APIRequestContext): Promise<string[]> {
  return (await (await request.get(`${CONTROL}/beacons`)).json()).beacons;
}
export const BEACON = 'http://127.0.0.1:4319/beacon/';
