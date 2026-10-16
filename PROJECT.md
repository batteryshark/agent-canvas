# Agent Canvas

## Summary
A general-purpose visual surface for OpenCode agents. An agent can build anything it would otherwise describe in words: an interface mockup, a chart, a table, a form, a diagram, a comparison, a simulation. The user sees it in an OpenChamber pane, a browser, or on a phone over Tailscale, and can interact with it. Anything the user does that is meant for the agent comes back to the conversation that made the view. Views are saved and revisioned, and useful ones can be pinned to the project for other conversations and agents to reuse.

## Why
- "Give the agent a generic surface to be able to create things and explain things visually and interact with the user visually and interactively so that we could get more done."
- Chat is a poor medium for anything with shape: layouts, data, systems, options with tradeoffs. Both directions suffer: the agent can only describe, and the user can only type back.
- The first version (0.1) collapsed this into a fixed system-diagram document. That was too narrow and was replaced wholesale (D1).

## Users and success criteria
- For: the user across desktop, mobile, local OpenCode, and remote OpenCode.
- Success looks like: an agent picks the right visual for the moment (mockup, chart, form, map, anything), the user works with it directly, and what they choose or enter reaches the agent as structured input it can act on.

## Scope / non-goals
- In: two content formats behind one surface (D2):
  - **OpenUI**: the agent writes OpenUI Lang against OpenUI's full standard component library plus Canvas extensions. Themed, compact, interactive.
  - **HTML**: the agent writes a self-contained HTML document, rendered in a locked-down sandbox, with a small bridge for sending input back. For mockups, custom visuals, simulations, anything components can't express.
- In: an OpenCode 2 plugin, an OpenChamber extension, and a responsive browser surface, all showing the same saved views.
- In: saved conversation views and pinned, revisioned project views.
- Non-goals: public hosting, a second chat application, live multi-user co-editing, cross-host synchronization, OpenCode 1 support.

## Requirements
- The agent can show any visual it can express in OpenUI Lang or HTML, and revise it.
- Any interactive element can send input to the agent: buttons, forms, selections, and custom HTML controls. Input arrives in the originating conversation as a message that says which view, which revision, what action, and what data.
- The agent can read a view's latest source and the input it produced, so it can revise against what the user actually did.
- Invalid content returns errors the agent can repair in its next call.
- Component and bridge reference is loaded on demand, not pushed into every prompt.
- Agents may present proactively; nothing opens windows or steals focus.
- Let the user choose the viewing surface; remember the preference.
- Remote and mobile access through private Tailscale Serve.
- Every view and interaction is bound to its host, project, session, and revision. Stale revisions cannot submit. Concurrent edits to a project view conflict rather than overwrite.
- Drafts (partially filled forms) survive reloads and reconnects; delivery states are shown honestly: queued, sending, delivered, unsent with retry, uncertain.
- HTML views cannot reach the network, cannot read Canvas credentials, and cannot navigate the parent. Bundled libraries replace CDNs. Chrome prerenders and WebRTC are outside CSP; Canvas refuses and guards them, and refuses nested frames, which would escape those guards. A page cannot leave the guards behind by navigating its own frame either (Q4).
- Nothing reaches the conversation or opens a link without the user: HTML pages send and open links only during a click or key press in the page, verified by the host; a project view written in another conversation never opens on its own.

## Constraints
- Runtimes: OpenCode 2.0.x, OpenChamber 2.3.x (the installed app is 2.3.2).
- OpenChamber loads extension panes in a sandboxed iframe on web and desktop, not on mobile or VS Code.
- No additional model provider. The conversation's own model writes all content.

## Decisions
- D1 (2026-10-15): Rebuild from scratch as a hard cutover. No migration of 0.1 views, no 0.1 tool names, no OpenCode 1 adapter, fresh Git history. Rejected: extending the 0.1 document schema.
- D2 (2026-10-15): Two content formats, OpenUI and sandboxed HTML, behind one surface and one interaction path. Rejected: HTML only (loses themed, compact, structured components) and OpenUI only (mockups limited to what components express).
- D3 (2026-10-15): Keep the 0.1 architecture's proven behaviors: one local service beside OpenCode, session-scoped viewing credentials, revision conflicts, honest delivery states, private Tailscale access. They are rebuilt, not carried over as legacy code.

## Open questions
- Q1 [resolved]: HTML views render in the pane as nested `srcdoc` frames, which inherit OpenChamber's guest policy (inline scripts run, remote scripts and frames are blocked). The browser uses a `/frame` shell with an equivalent policy, so pages behave the same everywhere; libraries are bundled instead of loaded from CDNs.
- Q2 [resolved]: No. OpenChamber's `contributes.tools` is declarative (title and output format only); its own `openchamber_render` view is matched by tool name internally. Canvas tool calls show a title and a markdown result with the viewing link.
- Q3 [resolved]: Nested frames would get fresh globals and escape the run-time prerender and WebRTC guards, so pages cannot have them. `canvas_show` refuses `<iframe>`, `<frame>`, `<object>` and `<embed>`, and the bridge blocks creating or inserting one at run time by every DOM, markup and `document.write` path, with guards that hold when the page redefines built-ins.
- Q4 [narrowed]: In the OpenChamber pane a page could navigate its own frame to a `data:` URL (`location`, a link click kept from bubbling, a meta refresh), because the guest CSP allows `frame-src 'self' data: blob:`. The new document had no bridge, so its WebRTC and prerender reached the network without a click. The panel's `index.html` now adds a meta policy, `frame-src 'none'`, which the browser enforces alongside the guest header. CSP does not check the `srcdoc` page itself, so it still renders, but its navigations to `data:`, `blob:` and OpenChamber's own origin are refused; Chrome shows its error page in the frame. The browser surface already refused them (app CSP `frame-src 'self'`). Browser tests in the pane harness, which serves OpenChamber's real guest policy, fail without the meta policy and pass with it. Open: confirm in the real OpenChamber 2.3, on desktop and web, and in relay mode, which renders the panel as `srcDoc` and keeps its authored CSP.

## Risks
- Agent-written HTML is arbitrary code: contain it with an opaque-origin sandbox, a strict CSP, and a bridge that validates every message.
- CSP does not cover Chrome's prerender of `<link rel="prerender">` or WebRTC, so a page could reach a server of its choosing without a click. Canvas rejects them in `canvas_show`, strips them when building the page, and guards their creation at run time; nested frames, which would escape those guards, are refused the same way. The guards live in the page's own realm, so a new browser API that creates a browsing context, or a DOM path the bridge does not wrap, would reopen the gap. Navigating its own frame to a new document would also leave them behind; `frame-src` refuses that on both surfaces, in the pane only through the panel's own meta policy (Q4), so a host change that dropped it would reopen the gap. OpenChamber's guest CSP has the same gaps, and its `frame-src 'self' data: blob:` lets any guest's nested frame do this; worth reporting upstream.
- The OpenUI component reference is large: serve it on demand through a tool, not the system prompt.
- Larger content increases tool-call size: enforce limits and return clear errors.

## Session log
- 2026-10-12 to 2026-10-13: Version 0.1 built and validated: fixed diagram, sections, and choices; native OpenCode and OpenChamber loops; Tailscale mobile access.
- 2026-10-15: The user rejected 0.1's narrow scope. Decided on a hard-cutover rebuild with OpenUI plus sandboxed HTML (D1–D3).
- 2026-10-15: Review fixes for 0.2: host-verified user gestures for HTML sends and links, project views no longer auto-open, prerender/WebRTC refused and guarded, session adoption after an OpenCode restart, lost submit answers confirmed instead of resent, snapshots without sources, OpenUI themed with the Canvas palette and accent, DatePicker and other component fixes, README rewritten for 0.2.
- 2026-10-15: Nested frames refused in `canvas_show` and blocked at run time (Q3 resolved). The bridge guards were hardened against redefined built-ins, attribute nodes and split `document.write` calls. Found that a page in the pane can navigate its own frame to a `data:` URL (Q4).
- 2026-10-15: The panel adds `frame-src 'none'` to OpenChamber's guest policy, so a page cannot navigate its own frame to a `data:`, `blob:` or OpenChamber URL; verified in the pane harness in both surfaces (Q4 narrowed; the real OpenChamber is still to check).
