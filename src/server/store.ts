import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  CanvasError, LIMITS, PinSchema, RegistrationSchema, ReportSchema, ShowRequestSchema, SubmissionSchema, interactionPrompt,
  type Check, type Content, type DeliveryJob, type Format, type Interaction, type Revision, type RevisionInfo, type Session, type Snapshot,
  type Submission, type View, type ViewDetail, type ViewListing,
} from '../shared/contract';
import { validateOpenUI } from '../shared/openui-validate';
import { checkHtml } from '../shared/html-check';

export const STATE_VERSION = 2;
/** A delivery still `sending` after this long lost its worker; it becomes `uncertain`, never resent. */
export const LEASE_MS = 30_000;
const CONNECTED_MS = 10_000;

type Database = { version: typeof STATE_VERSION; hostId: string; sessions: Record<string, Session>; views: Record<string, View>; interactions: Record<string, Interaction> };
export type ShowResult = { id: string; revision: number; warnings: string[] };

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const now = () => new Date().toISOString();
const label = (format: Format) => format === 'openui' ? 'OpenUI' : 'HTML';
const list = (items: string[]) => items.map(item => `- ${item}`).join('\n');
const info = ({ content, ...revision }: Revision): RevisionInfo => ({ ...revision, format: content.format });
const sameSubmission = (a: Submission, b: Submission) => a.sessionKey === b.sessionKey && a.viewId === b.viewId && a.revision === b.revision
  && a.action === b.action && a.notes === b.notes && JSON.stringify(a.data ?? null) === JSON.stringify(b.data ?? null);

export function contentProblems(format: Format, check: Check) {
  const n = check.errors.length;
  return `The ${label(format)} source has ${n} problem${n === 1 ? '' : 's'}. Fix ${n === 1 ? 'it' : 'them'} and show the view again:\n${list(check.errors)}`
    + (check.warnings.length ? `\nWarnings:\n${list(check.warnings)}` : '');
}

export class Store {
  db: Database;
  heartbeats = new Map<string, number>();
  private started = Date.now();
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let text: string | undefined;
    try { text = readFileSync(path, 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (text === undefined) {
      this.db = { version: STATE_VERSION, hostId: randomUUID(), sessions: {}, views: {}, interactions: {} };
    } else {
      let db: any;
      try { db = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON. Move it aside (mv "${path}" "${path}.broken") and restart Agent Canvas to start with empty state.`); }
      // Hard cutover: older state is never migrated, so refuse it rather than misread it.
      if (db?.version !== STATE_VERSION) throw new Error(`${path} uses state format version ${db?.version ?? 'unknown'}, but this Agent Canvas reads only version ${STATE_VERSION} and does not migrate. Move it aside (mv "${path}" "${path}.v${db?.version ?? 'old'}") and restart; views start empty.`);
      this.db = db;
      for (const a of Object.values(this.db.interactions)) if (a.status === 'sending') {
        a.status = 'uncertain'; a.detail = 'Canvas restarted during delivery. Check the conversation before sending again.'; a.updatedAt = now();
      }
    }
    this.save();
  }
  private save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  register(input: unknown): Session {
    const r = RegistrationSchema.parse(input);
    const projectId = hash(`${this.db.hostId}\0${r.projectRoot}`);
    const key = hash(`${projectId}\0${r.directory}\0${r.sessionId}`);
    const previous = this.db.sessions[key];
    const session: Session = { ...r, projectId, key, viewerKey: previous?.viewerKey ?? randomBytes(32).toString('base64url'), views: previous?.views ?? {}, createdAt: previous?.createdAt ?? now() };
    this.heartbeats.set(r.owner, Date.now());
    // Registration runs on every prompt; only rewrite state when something changed.
    if (JSON.stringify(previous) !== JSON.stringify(session)) { this.db.sessions[key] = session; this.save(); }
    return this.db.sessions[key];
  }
  session(key: string) {
    const s = this.db.sessions[key];
    if (!s) throw new CanvasError(404, 'This conversation is not registered with Agent Canvas yet. Send a message in it, then try again.');
    return s;
  }
  viewer(token: string) {
    const session = token ? Object.values(this.db.sessions).find(s => s.viewerKey === token) : undefined;
    if (!session) throw new CanvasError(401, 'This viewing link is invalid. Open a fresh link from your agent.');
    return session;
  }
  resolve(directory: string, sessionId: string) {
    const found = Object.values(this.db.sessions).filter(s => s.directory === directory && s.sessionId === sessionId);
    if (found.length !== 1) throw new CanvasError(404, 'No Canvas session for this conversation yet. Ask the agent to show something in Agent Canvas.');
    return found[0];
  }
  /** A view is reachable from a session when it is in the same project and either pinned or shown by that session. */
  accessible(session: Session, id: string) {
    const v = this.db.views[id];
    if (!v || v.projectId !== session.projectId || (!v.pinnedName && !session.views[id])) throw new CanvasError(404, 'View not found in this conversation or project.');
    return v;
  }
  private visible(session: Session) {
    return Object.values(this.db.views).filter(v => v.projectId === session.projectId && (v.pinnedName || session.views[v.id]));
  }
  link(session: Session, publicUrl: string, viewId?: string) {
    return `${publicUrl}/#key=${encodeURIComponent(session.viewerKey)}${viewId ? `&view=${viewId}` : ''}`;
  }

  show(input: unknown): ShowResult {
    const r = ShowRequestSchema.parse(input), s = this.session(r.sessionKey);
    let view = r.viewId ? this.accessible(s, r.viewId) : undefined;
    if (view) {
      const latest = view.revisions.length;
      if (r.expectedRevision !== latest) throw new CanvasError(409, `View ${view.id} is at revision ${latest}${r.expectedRevision ? `, not ${r.expectedRevision}` : ''}. Read it, merge your changes into the latest source, and pass expectedRevision ${latest}.`);
    } else if (r.expectedRevision !== undefined) {
      throw new CanvasError(400, 'expectedRevision applies only when revising. Pass viewId with it, or omit both to create a new view.');
    }
    const limit = r.format === 'openui' ? LIMITS.openuiSource : LIMITS.htmlSource;
    if (r.source.length > limit) throw new CanvasError(400, contentProblems(r.format, { errors: [`The source is ${r.source.length} characters; ${label(r.format)} views allow at most ${limit}.`], warnings: [] }));
    const check = r.format === 'openui' ? validateOpenUI(r.source) : checkHtml(r.source);
    if (check.errors.length) throw new CanvasError(400, contentProblems(r.format, check));
    if (!view) {
      view = { id: randomUUID(), projectId: s.projectId, revisions: [] };
      this.db.views[view.id] = view;
    }
    const content = { format: r.format, source: r.source } as Content;
    const revision: Revision = { number: view.revisions.length + 1, title: r.title, summary: r.summary, content, sessionKey: s.key, agent: s.agent, createdAt: now() };
    view.revisions.push(revision); s.views[view.id] = revision.number; this.save();
    return { id: view.id, revision: revision.number, warnings: check.warnings };
  }

  read(s: Session, viewId: string | undefined, publicUrl: string): ViewListing | ViewDetail {
    this.expireDeliveries();
    if (!viewId) return this.visible(s).map(v => {
      const latest = v.revisions[v.revisions.length - 1];
      return { id: v.id, title: latest.title, format: latest.content.format, pinnedName: v.pinnedName, latest: latest.number, shownHere: s.views[v.id], updatedAt: latest.createdAt, agent: latest.agent };
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const v = this.accessible(s, viewId);
    return {
      id: v.id, pinnedName: v.pinnedName, latest: v.revisions[v.revisions.length - 1],
      history: v.revisions.map(({ content, ...revision }) => revision),
      interactions: Object.values(this.db.interactions).filter(a => a.sessionKey === s.key && a.viewId === v.id).slice(-LIMITS.interactionsPerView),
      link: this.link(s, publicUrl, v.id),
    };
  }

  pin(s: Session, input: unknown) {
    const r = PinSchema.parse(input), v = this.accessible(s, r.viewId), latest = v.revisions.length;
    if (latest !== r.expectedRevision) throw new CanvasError(409, `View changed before pinning: it is now at revision ${latest}. Review it and pin again.`);
    if (Object.values(this.db.views).some(x => x.projectId === s.projectId && x.id !== v.id && x.pinnedName?.toLowerCase() === r.name.toLowerCase())) {
      throw new CanvasError(409, `A project view named “${r.name}” already exists. Choose another name.`);
    }
    v.pinnedName = r.name; this.save();
    return { id: v.id, pinnedName: r.name, revision: latest };
  }
  revision(s: Session, id: string, number: number) {
    const revision = this.accessible(s, id).revisions[number - 1];
    if (!revision) throw new CanvasError(404, 'Revision not found.');
    return revision;
  }
  private expireDeliveries() {
    let changed = false;
    for (const a of Object.values(this.db.interactions)) if (a.status === 'sending' && Date.now() - Date.parse(a.updatedAt) > LEASE_MS) {
      a.status = 'uncertain'; a.detail = 'The agent disconnected during delivery. Check the conversation before sending again.'; a.updatedAt = now(); changed = true;
    }
    if (changed) this.save();
  }
  snapshot(s: Session, publicUrl: string): Snapshot {
    this.expireDeliveries();
    const { viewerKey, owner, ...session } = s;
    return {
      session,
      views: this.visible(s).map(v => ({
        id: v.id, pinnedName: v.pinnedName, latest: v.revisions.length,
        revision: info(v.revisions[(s.views[v.id] ?? v.revisions.length) - 1]),
        history: v.revisions.map(({ content, ...revision }) => revision),
      })).sort((a, b) => b.revision.createdAt.localeCompare(a.revision.createdAt)),
      interactions: Object.values(this.db.interactions).filter(a => a.sessionKey === s.key).slice(-100),
      browserUrl: this.link(s, publicUrl),
      connected: this.live(owner) && this.heartbeats.has(owner),
    };
  }

  submit(s: Session, input: unknown): Interaction {
    const r = SubmissionSchema.parse(input);
    if (r.sessionKey !== s.key) throw new CanvasError(409, 'This input belongs to another conversation. Reopen the view from that conversation before sending.');
    const old = this.db.interactions[r.id];
    if (old) {
      if (!sameSubmission(old, r)) throw new CanvasError(409, 'Submission id already used for different input.');
      return old;
    }
    const v = this.accessible(s, r.viewId), latest = v.revisions.length, revision = v.revisions[r.revision - 1];
    if (!revision) throw new CanvasError(404, 'Revision not found.');
    if (r.revision !== latest) throw new CanvasError(409, `This view has a newer revision (${latest}). Review it before sending.`);
    const at = now();
    const action: Interaction = {
      ...r, messageId: `msg_canvas${r.id.replaceAll('-', '')}`, prompt: interactionPrompt({ id: v.id, title: revision.title }, r),
      status: 'queued', detail: 'Waiting for the agent to pick this up.', createdAt: at, updatedAt: at,
    };
    this.db.interactions[r.id] = action;
    this.prune(v.id); this.save();
    return action;
  }
  /** Keeps each view's interaction history bounded, dropping only the oldest settled ones. */
  private prune(viewId: string) {
    const forView = Object.values(this.db.interactions).filter(a => a.viewId === viewId);
    let excess = forView.length - LIMITS.interactionsPerView;
    for (const a of forView) {
      if (excess <= 0) break;
      if (a.status === 'delivered' || a.status === 'uncertain') { delete this.db.interactions[a.id]; excess--; }
    }
  }
  retry(s: Session, id: string) {
    const a = this.db.interactions[id];
    if (!a || a.sessionKey !== s.key) throw new CanvasError(404, 'Submission not found.');
    if (a.status !== 'unsent') throw new CanvasError(409, 'Only input confirmed as unsent can be retried.');
    if (this.accessible(s, a.viewId).revisions.length !== a.revision) throw new CanvasError(409, 'This view has a newer revision. Review it before sending again.');
    a.status = 'queued'; a.detail = 'Waiting for the agent to pick this up.'; a.updatedAt = now(); this.save();
    return a;
  }
  /** An owner is live while its worker claims; one never seen since this service started counts from the start. */
  private live(owner: string) { return Date.now() - (this.heartbeats.get(owner) ?? this.started) < CONNECTED_MS; }
  /**
   * After OpenCode restarts, its new plugin instance takes over this project's conversations from the instance that went
   * quiet, so queued input is delivered and the viewer shows the agent as connected before anyone types in the chat.
   */
  private adopt(owner: string, projectRoot: string) {
    let changed = false;
    for (const s of Object.values(this.db.sessions)) {
      if (s.owner === owner || s.projectRoot !== projectRoot || this.live(s.owner)) continue;
      s.owner = owner; changed = true;
    }
    if (changed) this.save();
  }
  claim(owner: string, projectRoot?: string): DeliveryJob | null {
    this.expireDeliveries();
    this.heartbeats.set(owner, Date.now());
    if (projectRoot) this.adopt(owner, projectRoot);
    const action = Object.values(this.db.interactions).find(a => a.status === 'queued' && this.db.sessions[a.sessionKey]?.owner === owner);
    if (!action) return null;
    action.status = 'sending'; action.detail = 'Delivering to the conversation.'; action.updatedAt = now(); this.save();
    return { action, session: this.db.sessions[action.sessionKey] };
  }
  acknowledge(owner: string, input: unknown) {
    const r = z.object({ id: z.string(), status: z.enum(['delivered', 'unsent', 'uncertain']), detail: z.string().max(1000) }).parse(input);
    const a = this.db.interactions[r.id];
    if (!a || this.db.sessions[a.sessionKey]?.owner !== owner) throw new CanvasError(404, 'Submission not owned by this agent.');
    if (a.status !== 'sending') throw new CanvasError(409, 'Submission is no longer in flight.');
    a.status = r.status; a.detail = r.detail; a.updatedAt = now(); this.save();
    return a;
  }
  report(s: Session, input: unknown) {
    const r = ReportSchema.parse(input), revision = this.revision(s, r.viewId, r.revision);
    // Viewers report on every render; skip the write when nothing changed.
    if (JSON.stringify(revision.clientErrors ?? []) !== JSON.stringify(r.errors)) {
      if (r.errors.length) revision.clientErrors = r.errors; else delete revision.clientErrors;
      this.save();
    }
    return { ok: true };
  }
}
