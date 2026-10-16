import type { Plugin } from '@opencode/plugin';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CanvasError, PinSchema, ShowInputSchema,
  type Interaction, type Session, type ShowInput, type ViewDetail, type ViewListing,
} from '../shared/contract';
import { connection } from '../server/config';
import { request } from '../server/client';
import { ensureService } from './service';
import { deliverToSession, startWorker } from './worker';
import { guide } from './guide';

const SYSTEM_NOTE = 'Agent Canvas is available: canvas_show puts something in front of the user that they can see and interact with, such as a UI mockup, chart, table, form, diagram, comparison, or any interactive page (OpenUI components or a self-contained HTML document). Use it proactively whenever an answer has shape or you want structured input; it never opens windows or steals focus. Before your first canvas_show in a conversation, call canvas_guide for the format you will use. Include the returned link in your reply. Call canvas_read before revising a view. Input from Canvas arrives as a user message starting with "[Agent Canvas]"; never claim the user sent something before that message appears.';

const S = ShowInputSchema.shape, P = PinSchema.shape;
const ShowInput = z.object({
  title: S.title.describe('Short name for the view, shown in the viewer and on this tool call.'),
  summary: S.summary.describe('Optional. One or two sentences on what the view shows and what you want back from the user.'),
  format: S.format.describe('"openui": OpenUI Lang over themed components (charts, tables, forms, cards, diagrams). "html": one complete self-contained HTML document (mockups, custom visuals, simulations).'),
  source: S.source.describe('The whole view: an OpenUI Lang program or a complete HTML document. A revision replaces the whole source.'),
  viewId: S.viewId.describe('Revise this existing view instead of creating a new one.'),
  expectedRevision: S.expectedRevision.describe('Required with viewId: the latest revision number, from canvas_read or the last canvas_show.'),
}).strict();
const ReadInput = z.object({
  viewId: z.string().uuid().optional().describe('Read this view in full. Omit to list the views this conversation can see.'),
}).strict();
const PinInput = z.object({
  viewId: P.viewId.describe('The view to pin.'),
  name: P.name.describe('Project view name, unique within the project.'),
  expectedRevision: P.expectedRevision.describe('The view\'s latest revision number.'),
}).strict();
const GuideInput = z.object({
  topic: z.enum(['overview', 'openui', 'html']).default('overview').describe('"overview" (default), "openui" for the component reference, or "html" for the page bridge.'),
}).strict();

const fenceFor = (source: string) => '`'.repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map(m => m[0].length + 1)));
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}… (truncated)` : text;

function inputLine(a: Interaction) {
  const data = a.data === null || a.data === undefined ? '' : `, data ${clip(JSON.stringify(a.data), 4000)}`;
  const status = a.status === 'delivered' ? 'delivered' : `${a.status}: ${a.detail}`;
  return `- Revision ${a.revision}, ${a.createdAt}: "${a.action}"${data}${a.notes ? `, note ${JSON.stringify(a.notes)}` : ''} (${status})`;
}

function listing(views: ViewListing) {
  if (!views.length) return 'No Canvas views in this conversation or pinned in this project yet. Call canvas_guide, then canvas_show to create one.';
  return [
    `Canvas views in this conversation and pinned in this project (${views.length}):`,
    ...views.map(v => {
      const here = v.shownHere === undefined ? ', not shown in this conversation yet' : v.shownHere === v.latest ? '' : `, this conversation shows revision ${v.shownHere}`;
      return `- "${v.title}": view ${v.id}, ${v.format}, latest revision ${v.latest}${here}${v.pinnedName ? `, pinned as "${v.pinnedName}"` : ''}, updated ${v.updatedAt}${v.agent ? ` by ${v.agent}` : ''}`;
    }),
    '',
    'Call canvas_read({ viewId }) for a view\'s source and the user\'s input before revising it.',
  ].join('\n');
}

function detail(d: ViewDetail) {
  const r = d.latest, fence = fenceFor(r.content.source);
  const out = [
    `# ${r.title}`,
    `- View: ${d.id} (${r.content.format})${d.pinnedName ? `, pinned as project view "${d.pinnedName}"` : ''}`,
    `- Latest revision: ${r.number}, by ${r.agent || 'an agent'} at ${r.createdAt}`,
    `- Link: ${d.link}`,
  ];
  if (r.summary) out.push(`- Summary: ${r.summary}`);
  const earlier = d.history.filter(h => h.number !== r.number).slice(-10);
  if (earlier.length) out.push(`- Earlier revisions: ${earlier.map(h => `${h.number} "${h.title}" (${h.agent || 'agent'}, ${h.createdAt})`).join('; ')}`);
  if (r.clientErrors?.length) out.push('', `## Render errors reported by viewers (revision ${r.number})`, ...r.clientErrors.map(e => `- ${e}`), 'Fix these in a new revision.');
  // Each input was also delivered as its own message; this is a reminder, so keep it bounded.
  out.push('', '## Input from the user in this conversation', ...(d.interactions.length ? d.interactions.slice(-10).map(inputLine) : ['None yet.']));
  out.push('', `## Source (revision ${r.number})`, `${fence}${r.content.format}`, r.content.source, fence, '',
    `To revise, call canvas_show with viewId ${d.id}, expectedRevision ${r.number}, and the complete new source.`);
  return out.join('\n');
}

/** Tool errors are the agent's only signal, so each one says what to do next. */
function failure(error: unknown, hints: Partial<Record<number, string>>) {
  if (!(error instanceof CanvasError)) return error instanceof Error ? error : new Error(String(error));
  const hint = hints[error.status] ?? (error.status >= 500 || error.status === 401 ? 'Agent Canvas is not working right now. Tell the user, and continue without it.' : '');
  return new Error(hint ? `${error.message}\n\n${hint}` : error.message);
}
const NOT_FOUND = 'Call canvas_read() without a viewId to list the views this conversation can see.';

function showFailure(error: unknown, args: ShowInput) {
  if (!(error instanceof CanvasError)) {
    return new Error(`Agent Canvas did not answer: ${(error as Error)?.message ?? error}. The view may or may not have been saved; call canvas_read() to check before showing it again.`);
  }
  return failure(error, {
    400: `Nothing was saved. Send the complete corrected source; the ${args.format === 'openui' ? 'OpenUI Lang' : 'HTML'} reference is canvas_guide({ topic: "${args.format}" }).`,
    404: `${NOT_FOUND} Omit viewId to create a new view instead.`,
    409: `Use canvas_read({ viewId: "${args.viewId}" }) to read it.`,
    413: 'Nothing was saved. Make the source smaller: generate repeated markup with a script or summarize the data.',
  });
}

const AgentCanvas: Plugin.Plugin = {
  id: 'agent-canvas',
  async setup(ctx) {
    const config = connection(), owner = randomUUID();
    let starting: Promise<void> | undefined;
    const start = () => starting ??= ensureService(config).finally(() => { starting = undefined; });
    // A Canvas outage must never stop OpenCode or a conversation; tool calls retry the start and report failures.
    await start().catch(() => {});

    async function register(sessionID: string, agent: string | undefined, autostart: boolean) {
      const info = await ctx.session.get({ sessionID }), project = ctx.location.project;
      // Sessions outside this plugin's project, or in no project, share views only with their own directory.
      const projectRoot = project.id !== 'global' && info.projectID === project.id ? project.canonical || project.directory : info.location.directory;
      const body = {
        sessionId: sessionID, directory: info.location.directory, projectRoot, owner,
        agent: (agent || info.agent || '').slice(0, 200), title: (info.title || `Agent · ${sessionID.slice(-8)}`).slice(0, 300),
      };
      try { return await request<Session>(config, '/agent/register', body); }
      catch (error) {
        if (!autostart || error instanceof CanvasError) throw error;
        await start();
        return request<Session>(config, '/agent/register', body);
      }
    }
    async function connect(c: { sessionID: string; agent: string }) {
      try { return await register(c.sessionID, c.agent, true); }
      catch (error) { throw failure(error, {}); }
    }
    const seen = new Map<string, number>();
    function touch(sessionID: string, agent?: string) {
      if (Date.now() - (seen.get(sessionID) ?? 0) < 30_000) return;
      seen.set(sessionID, Date.now());
      // Registering early lets the pane find this conversation before any tool call. It never delays or fails a turn.
      void register(sessionID, agent, false).catch(() => { seen.delete(sessionID); });
    }

    // The conversations this instance can deliver to: its project's, or its own directory's outside a project (as register scopes them).
    const project = ctx.location.project;
    const scope = project.id !== 'global' ? project.canonical || project.directory : ctx.location.directory;
    const stop = startWorker(job => deliverToSession(ctx.session, job), config, owner, scope);
    await ctx.session.hook('prompt', event => { touch(event.sessionID); });
    await ctx.session.hook('context', event => {
      touch(event.sessionID, event.agent);
      event.system.push({ type: 'text', text: SYSTEM_NOTE });
    });

    await ctx.tool.transform(editor => {
      editor.add({
        name: 'canvas_guide', options: { codemode: false },
        description: 'Reference for Agent Canvas, the visual surface beside this conversation. Call it before your first canvas_show in a conversation. topic "overview" (default): when to use Canvas, choosing OpenUI components or HTML, how the user\'s input comes back, revising, pinning and limits. "openui": the OpenUI Lang component reference (layout, charts, tables, forms, diagrams). "html": the HTML page bridge (canvas.send, forms), theme variables and bundled libraries.',
        input: GuideInput,
        async execute(input) {
          const topic = input.topic ?? 'overview';
          return { content: guide(topic), metadata: { title: `Canvas guide: ${topic}` } };
        },
      });
      editor.add({
        name: 'canvas_show', options: { codemode: false },
        description: 'Show the user something they can see and interact with in Agent Canvas: a UI mockup, chart, table, form, diagram, comparison, dashboard, or any interactive page. Use it whenever a visual explains better than text or you want structured input back. It appears in the OpenChamber pane, a browser, or on the user\'s phone without opening windows. format "openui" is OpenUI Lang over themed components; "html" is a complete self-contained HTML document. Call canvas_guide first for the format\'s reference. To revise a view, pass viewId and expectedRevision (its latest revision) with the complete new source. Returns the view id, revision and viewing link; include the link in your reply. What the user sends arrives later as a message starting with "[Agent Canvas]".',
        input: ShowInput,
        async execute(input, c) {
          const args = ShowInputSchema.parse(input), session = await connect(c);
          let shown: { id: string; revision: number; warnings: string[]; link?: string };
          try { shown = await request(config, '/agent/show', { ...args, sessionKey: session.key }); }
          catch (error) { throw showFailure(error, args); }
          const lines = [
            `${args.viewId ? 'Revised' : 'Created'} Canvas view "${args.title}".`,
            `- View: ${shown.id}`,
            `- Revision: ${shown.revision}`,
            `- Link: ${shown.link ?? 'unavailable here; canvas_read returns it'}`,
          ];
          if (shown.warnings.length) lines.push('', 'Warnings (the view was saved, but these parts may not work):', ...shown.warnings.map(w => `- ${w}`));
          lines.push('', `Include the link in your reply. To revise, call canvas_show with viewId ${shown.id} and expectedRevision ${shown.revision}. The user's input arrives as a message starting with "[Agent Canvas]".`);
          return { content: lines.join('\n'), metadata: { title: `Canvas: ${args.title}`, viewId: shown.id, revision: shown.revision } };
        },
      });
      editor.add({
        name: 'canvas_read', options: { codemode: false },
        description: 'Read Agent Canvas views. Without viewId: the views in this conversation and the project\'s pinned views, with ids and latest revisions. With viewId: that view\'s latest source, revision history, render errors viewers reported, and the user\'s recent input from it. Read a view before revising it.',
        input: ReadInput,
        async execute(input, c) {
          const session = await connect(c);
          try {
            const result = await request<ViewListing | ViewDetail>(config, '/agent/read', { sessionKey: session.key, ...(input.viewId ? { viewId: input.viewId } : {}) });
            return Array.isArray(result)
              ? { content: listing(result), metadata: { title: 'Canvas views' } }
              : { content: detail(result), metadata: { title: `Canvas: ${result.latest.title}`, viewId: result.id, revision: result.latest.number } };
          } catch (error) { throw failure(error, { 404: NOT_FOUND }); }
        },
      });
      editor.add({
        name: 'canvas_pin', options: { codemode: false },
        description: 'Pin an Agent Canvas view as a named project view, so other conversations and agents in this project can find, read and revise it. Use it when the user wants to keep or reuse a view. expectedRevision must be the view\'s latest revision.',
        input: PinInput,
        async execute(input, c) {
          const args = PinSchema.parse(input), session = await connect(c);
          try { await request(config, '/api/pin', args, session.viewerKey); }
          catch (error) {
            throw failure(error, { 404: NOT_FOUND, 409: `Call canvas_read({ viewId: "${args.viewId}" }) for its latest revision and pin again, or choose another name if that one is taken.` });
          }
          return {
            content: `Pinned view ${args.viewId} as project view "${args.name}" at revision ${args.expectedRevision}. Every conversation in this project can now find it with canvas_read and revise it with canvas_show.`,
            metadata: { title: `Canvas: pinned "${args.name}"`, viewId: args.viewId },
          };
        },
      });
    });
    return () => stop();
  },
};
export default AgentCanvas;
