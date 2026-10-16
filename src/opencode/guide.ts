import { readFileSync } from 'node:fs';
import { LIMITS } from '../shared/contract';
import { HTML_GUIDE } from '../shared/html-guide';

export type GuideTopic = 'overview' | 'openui' | 'html';

// The plugin bundle inlines the generated reference through esbuild's text loader. tsx (tests) cannot import .md,
// so there the generated file is read from disk on first use.
// @ts-ignore: .md is a text module only under the bundler.
let openui: string | undefined = await import('../generated/openui-guide.md').then(m => m.default as string, () => undefined);

const n = (value: number) => value.toLocaleString('en-US');

const OVERVIEW = `# Agent Canvas

Canvas puts something the user can see and use beside the conversation: a UI mockup, a chart, a table, a form, a diagram, a comparison, a dashboard, a simulation. It appears in the OpenChamber pane, a browser tab, or on the user's phone, and what the user sends from it comes back to this conversation. Use it whenever an answer has shape (layout, data, structure, options with tradeoffs) or you need structured input. Showing a view never opens a window or steals focus, so present proactively.

## Choose a format
- \`openui\`: OpenUI Lang, a compact language over a themed component library: layout, cards, tables, charts, forms, buttons, tabs, steps, tags, and Diagram for directed graphs. Best for data, dashboards, forms, choices and structured explanations: short to write, consistent, and themed to match the host. Reference: canvas_guide({ topic: "openui" }).
- \`html\`: one complete, self-contained HTML document, run in a sandbox with no network access. Best for a mockup of a specific screen, custom visuals (SVG, canvas), animation, simulations, or anything the components cannot express. Inline all CSS and JavaScript; Tailwind, Chart.js, D3 and Mermaid are bundled. Reference: canvas_guide({ topic: "html" }).
Read a format's reference once per conversation before you first write that format.

## Show
canvas_show({ title, summary, format, source }) saves the view and returns its id, revision and link. Always give the link in your reply; it also works in a browser and on a phone. Invalid source is rejected with every problem listed and nothing is saved: fix them all and send the complete corrected source. Warnings mean the view was saved but part of it may not work.

## Input from the user
- OpenUI: a Button sends its @ToAssistant("...") message (or its label); a Form's button sends every field of the form as data.
- HTML: canvas.send(action, data), <form data-canvas-action="...">, or <button data-canvas-action="...">. A page sends only from the user's click or key press, never on load or from a timer.
Input arrives later as a user message that starts with "[Agent Canvas]" and names the view, revision, action and data, plus any note the user added. Treat it like any user message. Never claim the user chose or entered something before that message appears.

## Revise
canvas_read({ viewId }) returns the latest source, render errors that viewers reported, and recent input. Revise with canvas_show({ viewId, expectedRevision, title, format, source }), passing the latest revision number and the complete new source. A stale expectedRevision is rejected: read again and merge. Once a newer revision exists the user can no longer send from older ones, so revise when it helps rather than on every turn. When canvas_read reports render errors, fix them in a new revision. canvas_read() with no viewId lists this conversation's views and the project's pinned views.

## Pin
canvas_pin({ viewId, name, expectedRevision }) makes a view a named project view when the user wants to keep or reuse it. Every conversation in the project can then read and revise it; each conversation keeps showing the revision it last saw until it revises.

## Limits
Title ${n(LIMITS.title)} characters, summary ${n(LIMITS.summary)}, OpenUI source ${n(LIMITS.openuiSource)}, HTML source ${n(LIMITS.htmlSource)}. From a view: action ${n(LIMITS.action)}, data ${n(LIMITS.dataBytes)} characters as JSON, note ${n(LIMITS.notes)}, saved draft ${n(LIMITS.draftBytes)}.
`;

export function guide(topic: GuideTopic): string {
  if (topic === 'openui') return openui ??= readFileSync(new URL('../generated/openui-guide.md', import.meta.url), 'utf8');
  if (topic === 'html') return HTML_GUIDE;
  return OVERVIEW;
}
