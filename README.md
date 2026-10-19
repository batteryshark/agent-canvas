# Agent Canvas

<img src="assets/workstack-mark.png" alt="Agent Canvas comic mascot with an artist's palette" width="240">

Agent Canvas gives [OpenCode](https://opencode.ai) agents a visual surface alongside chat. An agent can show you an interface mockup, plot data, draw a system diagram or build a form. You can choose a layout, change a value or send a decision, and your input returns to the conversation as a message the agent can act on.

It works in a browser, an [OpenChamber](https://github.com/openchamber/openchamber) pane, or a phone connected over Tailscale. The conversation's own model writes the views; Canvas needs no additional model or API key.

![Agent Canvas showing two example phone layouts with a selection control](docs/canvas-mockup.png)

## Why use a visual surface

Comparing layouts through written descriptions is slow. A table makes differences easier to scan; a chart makes a trend easier to see. A form lets you give the agent several related choices together. Canvas keeps those visuals available while the conversation moves on, so you can return to a view and send more input later.

- Show a proposed screen and let the user pick a variant before implementation.
- Plot actual test results or costs, then collect the user's next step in the same view.
- Pin a useful diagram or dashboard to the project so another conversation can read and revise it.
- Revise a view after feedback, with saved revisions and conflict checks to protect concurrent edits.

New views don't open windows or take focus. The agent returns a viewing link; in OpenChamber you can also keep Canvas beside the conversation.

## Two ways to build a view

OpenUI uses [OpenUI Lang](https://github.com/thesysdev/openui) and its standard component library for themed charts, tables, forms and layouts. Canvas adds a directed-graph `Diagram` component. Buttons and forms send structured values without page code, and the parser reports mistakes before the view is saved. The component reference is generated from the installed library at build time and loaded by the agent on demand.

![OpenUI chart and table rendered in Agent Canvas with example checkout data](docs/canvas-openui.png)

HTML accepts a complete, self-contained document for custom layouts, SVG, animation or simulations. Inline scripts can use the `window.canvas` bridge to send input and keep draft state. Tailwind, Chart.js, D3 and Mermaid are bundled for use inside the sandbox.

![HTML capacity chart and decision form rendered in Agent Canvas with example figures](docs/canvas-html.png)

These existing captures show Canvas rendering demonstration content with illustrative figures. The phone layouts are HTML mockups. See [image notes](docs/SCREENSHOTS.md) for scope and provenance.

## Get started

You need Node.js 22 or newer, npm and OpenCode 2. The source pins the OpenCode plugin/client APIs to 2.0.23. OpenCode 1 isn't supported. OpenChamber is optional; its extension manifest requires 2.3.0 or newer.

```sh
git clone https://github.com/batteryshark/agent-canvas.git
cd agent-canvas
npm ci
npm run build
```

The build creates `dist/opencode` (plugin, Canvas service and browser app) and `dist/openchamber` (pane and host bridge). Keep the generated folders intact.

Add the absolute directory of `dist/opencode` to `plugins` in your OpenCode 2 configuration, preserving your other settings:

```json
{
  "plugins": ["file:///absolute/path/to/agent-canvas/dist/opencode"]
}
```

The plugin starts a shared local Canvas service during setup and retries startup when a tool needs it. By default it uses `127.0.0.1:4317` and saves data under `~/.local/share/agent-canvas`. Check [setup](docs/SETUP.md) before installation if that address or an older Canvas install is already in use.

In a new conversation, ask:

> Show the test durations from the last run on the canvas, with a form to choose which suites to parallelize.

Open the returned link. When you submit, the agent receives a user message beginning with `[Agent Canvas]`, followed by the view, revision, action, data and any note you added. A button's action or a form's values give the agent the context for its next response.

For OpenChamber, install the plugin on the backend running the conversation, then add `dist/openchamber` in **Settings → Extensions** and enable its local service. Open the Agent Canvas pane or page and select a conversation. Mobile uses the viewing link; OpenChamber doesn't load extension panes there.

[Setup and model-free demo](docs/SETUP.md) · [Private remote and phone access](docs/SETUP.md#private-remote-and-phone-access)

## Saved views and user input

Each conversation keeps the revision it last showed. Pinning gives a view a project name and lets other conversations on the same Canvas host find it. A view written elsewhere doesn't open automatically; the user chooses it from the sidebar. Input goes to the conversation currently viewing it.

Agents read the latest source before revising and pass `expectedRevision` with the complete replacement source. Conflicts return an error. Old revisions stay readable but can't submit once a newer revision exists. Draft form entries and notes survive reloads within the storage limits.

Delivery status distinguishes queued, sending, delivered, unsent and uncertain input. Delivered means OpenCode admitted the message. Unsent input offers Retry. If admission can't be confirmed, Canvas marks it uncertain and avoids automatic redelivery; check the conversation before sending again.

The plugin supplies `canvas_guide`, `canvas_show`, `canvas_read` and `canvas_pin`. See [the tool and content reference](docs/REFERENCE.md) for examples, bridge methods and size limits.

## Privacy and current limits

Views and input are stored on the Canvas host. Viewing links contain a session credential: anyone with the original link and network access can view that session's views and send input. Keep links, state and connection files private. HTML runs in a sandbox with network restrictions, guarded input and no access to the host app's credentials. Keep secrets out of generated pages. [Security and storage details](docs/SECURITY.md) explain the boundaries and remaining host/browser verification gaps.

Version 0.2.0 has no migration from the old 0.1 view store. It also has no cross-host synchronization, live edit merging, view deletion, unpinning or garbage collection. Files must be embedded as small `data:` URLs within the source limits; Canvas doesn't serve arbitrary files from the agent's machine.

The real OpenChamber app, Safari/Firefox and physical-phone path for 0.2 still need acceptance. The existing pane tests use a host-policy harness. [Development](docs/DEVELOPMENT.md) describes the tests and which commands start services or native hosts.

## License

Owned code and documentation are [MIT](LICENSE). The comic artwork is AI-generated and offered under MIT to the extent applicable, without an exclusive-copyright claim. Dependencies keep their own licences; generated packages include third-party notices. See [rights and attribution](RIGHTS.md).
