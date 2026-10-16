import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Drafts, type Draft } from '../src/ui/drafts';

function storage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  let release: () => void = () => {};
  const held = new Promise<void>(r => { release = r; });
  return {
    data, release,
    async load<T>(key: string) { await held; return (data.get(key) ?? null) as T | null; },
    async save(key: string, value: unknown) { data.set(key, JSON.parse(JSON.stringify(value))); },
  };
}

test('a change made while a draft loads lands on the stored draft instead of replacing it', async () => {
  const pending = { id: randomUUID(), sessionKey: 's', viewId: randomUUID(), revision: 1, action: 'Go', data: null, notes: '' };
  const host = storage({ k: { note: 'old note', state: { forms: { a: 1 } }, pending } });
  const drafts = new Drafts(host);
  const loaded = drafts.read('k');
  const typed = drafts.update('k', d => ({ ...d, note: 'typed while loading' }));
  host.release();
  await loaded; await typed;
  const stored = host.data.get('k') as Draft;
  assert.equal(stored.note, 'typed while loading');
  assert.deepEqual(stored.state, { forms: { a: 1 } });
  assert.equal(stored.pending?.id, pending.id);
});

test('while the page is hidden, delayed changes are written at once', async () => {
  const host = storage();
  host.release();
  const drafts = new Drafts(host);
  await drafts.read('k');
  await drafts.update('k', d => ({ ...d, state: { a: 1 } }), 10_000);
  assert.equal(host.data.get('k'), undefined, 'a delayed change waits');
  await drafts.setHidden(true);
  assert.deepEqual((host.data.get('k') as Draft).state, { a: 1 }, 'hiding flushes it');
  await drafts.update('k', d => ({ ...d, state: { a: 2 } }), 10_000);
  assert.deepEqual((host.data.get('k') as Draft).state, { a: 2 }, 'and later changes are not delayed');
  await drafts.setHidden(false);
});
