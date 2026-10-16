import { LIMITS, SubmissionSchema, type Submission } from '../shared/contract';

/** What a viewer has not sent yet for one revision: the note, the view's own state, and an input awaiting confirmation. */
export type Draft = { note: string; state: unknown | null; pending?: Submission };
type Storage = { load<T>(key: string): Promise<T | null>; save(key: string, value: unknown): Promise<void> };

const empty = (): Draft => ({ note: '', state: null });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function normalize(value: any): Draft {
  if (!value || typeof value !== 'object') return empty();
  const pending = SubmissionSchema.safeParse(value.pending);
  return { note: typeof value.note === 'string' ? value.note : '', state: value.state ?? null, ...(pending.success ? { pending: pending.data } : {}) };
}

/** Keep each draft's identity and write order intact across asynchronous host storage calls. */
export class Drafts {
  private values = new Map<string, Draft>();
  private reads = new Map<string, Promise<Draft>>();
  private writes = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private oversized = new Set<string>();
  private hidden = false;
  constructor(private storage: Storage, private report: (message: string) => void = () => {}) {}
  peek(key: string): Draft { return this.values.get(key) ?? empty(); }
  read(key: string): Promise<Draft> {
    if (this.values.has(key)) return Promise.resolve(this.peek(key));
    const existing = this.reads.get(key); if (existing) return existing;
    const read = this.storage.load<Draft>(key).then(value => {
      // Typing while a load is in progress always wins over the older stored value.
      if (!this.values.has(key)) this.values.set(key, normalize(value));
      return this.peek(key);
    });
    this.reads.set(key, read);
    read.then(() => this.reads.delete(key), () => this.reads.delete(key));
    return read;
  }
  /**
   * Change a draft and store it in order. A delay coalesces rapid changes (typing, form state) into one write.
   * A change to a draft that is still loading waits for it, so it lands on the stored draft instead of replacing it.
   */
  update(key: string, change: (draft: Draft) => Draft, delay = 0): Promise<void> {
    const loading = !this.values.has(key) && this.reads.get(key);
    if (loading) return loading.catch(() => {}).then(() => this.update(key, change, delay));
    this.values.set(key, change(this.peek(key)));
    clearTimeout(this.timers.get(key)); this.timers.delete(key);
    if (delay <= 0 || this.hidden) return this.write(key);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.write(key).catch(e => this.report(`Draft could not be saved: ${(e as Error).message}`));
    }, delay));
    return Promise.resolve();
  }
  /** While the page is hidden or going away, write every change at once: a delayed write may never run. */
  setHidden(hidden: boolean): Promise<void> {
    this.hidden = hidden;
    return hidden ? this.flush() : Promise.resolve();
  }
  /** Write every delayed change now, for example before the page goes away. */
  flush(): Promise<void> {
    const keys = [...this.timers.keys()];
    keys.forEach(key => { clearTimeout(this.timers.get(key)); this.timers.delete(key); });
    return Promise.all(keys.map(key => this.write(key).catch(e => this.report(`Draft could not be saved: ${(e as Error).message}`)))).then(() => {});
  }
  /** After a confirmed send: drop the pending input, and the note too if it is still the one that was sent. */
  clearPending(key: string, sent: Submission) {
    return this.update(key, draft => draft.pending?.id !== sent.id ? draft : { note: draft.note.trim() === sent.notes ? '' : draft.note, state: draft.state });
  }
  private write(key: string): Promise<void> {
    const value = this.fit(key, this.peek(key));
    const write = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(() => value ? this.storage.save(key, value) : undefined);
    this.writes.set(key, write);
    const clear = () => { if (this.writes.get(key) === write) this.writes.delete(key); };
    write.then(clear, clear);
    return write;
  }
  /** Host storage refuses large values. Keep the full draft in memory, store what fits, and say what will not survive a reload. */
  private fit(key: string, draft: Draft): Draft | null {
    const size = bytes(draft);
    if (size <= LIMITS.draftBytes) { this.oversized.delete(key); return draft; }
    const reduced: Draft = { note: draft.note, state: null, ...(draft.pending ? { pending: draft.pending } : {}) };
    const fits = bytes(reduced) <= LIMITS.draftBytes;
    if (!this.oversized.has(key)) {
      this.oversized.add(key);
      const lost = fits ? 'Your entries in the view will not survive a reload.' : 'None of it will survive a reload.';
      this.report(`This view's draft is too large to save (${Math.ceil(size / 1024)} KB, limit ${Math.floor(LIMITS.draftBytes / 1024)} KB). ${lost}`);
    }
    return fits ? reduced : null;
  }
}
