// The one contract every Agent Canvas module codes against: content, views,
// sessions, interactions, and the HTTP payloads that carry them.
import { z } from 'zod';

export const LIMITS = {
  title: 120,
  summary: 2000,
  openuiSource: 200_000,
  htmlSource: 400_000,
  action: 120,
  dataBytes: 32_000,
  notes: 4000,
  pinnedName: 120,
  requestBytes: 1_000_000,
  draftBytes: 64_000,
  interactionsPerView: 50,
} as const;

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const title = z.string().trim().min(1).max(LIMITS.title);

/** What the agent writes. OpenUI Lang for themed components; a full HTML document for anything else. */
export const ContentSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('openui'), source: z.string().min(1).max(LIMITS.openuiSource) }),
  z.object({ format: z.literal('html'), source: z.string().min(1).max(LIMITS.htmlSource) }),
]);
export type Content = z.infer<typeof ContentSchema>;
export type Format = Content['format'];

/** canvas_show input, minus the session binding the plugin adds. */
export const ShowInputSchema = z.object({
  title,
  summary: z.string().max(LIMITS.summary).default(''),
  format: z.enum(['openui', 'html']),
  source: z.string().min(1).max(LIMITS.htmlSource),
  viewId: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().optional(),
}).strict();
export type ShowInput = z.infer<typeof ShowInputSchema>;
export const ShowRequestSchema = ShowInputSchema.extend({ sessionKey: z.string().min(1) });

export type Revision = {
  number: number;
  title: string;
  summary: string;
  content: Content;
  sessionKey: string;
  agent: string;
  createdAt: string;
  /** Render errors reported by a viewer (OpenUI onError, HTML window errors), so the agent can repair them. */
  clientErrors?: string[];
};
export type View = { id: string; projectId: string; pinnedName?: string; revisions: Revision[] };

export const RegistrationSchema = z.object({
  sessionId: z.string().min(1).max(200),
  directory: z.string().min(1).max(2000),
  projectRoot: z.string().min(1).max(2000),
  agent: z.string().max(200),
  owner: z.string().min(1).max(200),
  title: z.string().max(300).default('Agent session'),
});
export type Session = z.infer<typeof RegistrationSchema> & {
  key: string;
  projectId: string;
  viewerKey: string;
  /** viewId → the revision this conversation last showed. */
  views: Record<string, number>;
  createdAt: string;
};

/** Anything the user sends from a view: an OpenUI action or form, or canvas.send() from HTML. */
export const SubmissionSchema = z.object({
  id: z.string().uuid(),
  sessionKey: z.string().min(1),
  viewId: z.string().uuid(),
  revision: z.number().int().positive(),
  action: z.string().trim().min(1).max(LIMITS.action),
  data: z.unknown().default(null)
    .refine(v => JSON.stringify(v ?? null).length <= LIMITS.dataBytes, `data must serialize to at most ${LIMITS.dataBytes} characters`),
  notes: z.string().max(LIMITS.notes).default(''),
}).strict();
export type Submission = z.infer<typeof SubmissionSchema>;

export type DeliveryStatus = 'queued' | 'sending' | 'delivered' | 'unsent' | 'uncertain';
export type Interaction = Submission & {
  /** The OpenCode message id; derived from the submission id so a repeat cannot create a second message. */
  messageId: string;
  /** The exact text delivered to the conversation. */
  prompt: string;
  status: DeliveryStatus;
  detail: string;
  createdAt: string;
  updatedAt: string;
};
export type DeliveryResult = { id: string; status: 'delivered' | 'unsent' | 'uncertain'; detail: string };
export type DeliveryJob = { action: Interaction; session: Session };

/** A revision without its source: what snapshots carry, so they stay small however many views a project holds. */
export type RevisionInfo = Omit<Revision, 'content'> & { format: Format };
export type ViewSummary = {
  id: string;
  pinnedName?: string;
  latest: number;
  /** The revision this conversation shows: its own last revision, or the latest for a pinned view it never showed. Its source comes from GET /api/revision. */
  revision: RevisionInfo;
  history: Array<Omit<Revision, 'content'>>;
};
export type Snapshot = {
  session: Omit<Session, 'viewerKey' | 'owner'>;
  views: ViewSummary[];
  interactions: Interaction[];
  browserUrl: string;
  connected: boolean;
};

export const PinSchema = z.object({
  viewId: z.string().uuid(),
  name: z.string().trim().min(1).max(LIMITS.pinnedName),
  expectedRevision: z.number().int().positive(),
}).strict();

/** A viewer reports render errors for the revision it shows. Replaces that revision's clientErrors. */
export const ReportSchema = z.object({
  viewId: z.string().uuid(),
  revision: z.number().int().positive(),
  errors: z.array(z.string().max(1000)).max(20),
}).strict();

/** Result of validating agent content before it is saved. Errors reject the call; warnings are returned to the agent. */
export type Check = { errors: string[]; warnings: string[] };

/** canvas_read without a viewId: what this conversation and project can see. */
export type ViewListing = Array<{ id: string; title: string; format: Format; pinnedName?: string; latest: number; shownHere?: number; updatedAt: string; agent: string }>;
/** canvas_read with a viewId: the latest revision in full plus recent input from the user. */
export type ViewDetail = { id: string; pinnedName?: string; latest: Revision; history: Array<Omit<Revision, 'content'>>; interactions: Interaction[]; link: string };

export class CanvasError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The message text an interaction delivers to the agent. Stable: agents and tests parse it. */
export function interactionPrompt(view: { id: string; title: string }, s: Submission) {
  const data = s.data === null || s.data === undefined ? '' : `\nData:\n\`\`\`json\n${JSON.stringify(s.data, null, 2)}\n\`\`\``;
  const notes = s.notes ? `\nNote: ${s.notes}` : '';
  return `[Agent Canvas] ${view.title} (view ${view.id}, revision ${s.revision})\nAction: ${s.action}${data}${notes}`;
}
