# Tools and content

The OpenCode 2 plugin registers these four tools and adds a short note explaining when to use Canvas. Format references load on demand.

| Tool | Contract |
| --- | --- |
| `canvas_guide` | `{ topic?: "overview" \| "openui" \| "html" }`; defaults to overview. Read the format reference before first use. |
| `canvas_show` | `{ title, summary?, format, source, viewId?, expectedRevision? }`; returns id, revision, link and warnings. Omit the last two fields for a new view. A revision replaces the entire source. |
| `canvas_read` | `{ viewId? }`; lists this conversation's views and pinned project views, or reads the latest source, revision history, render errors and recent input for one view. |
| `canvas_pin` | `{ viewId, name, expectedRevision }`; gives a view a project name. Names are unique within the project, case-insensitively. |

Revising or pinning requires the latest revision number. A conflict returns an error; read again and incorporate the changes before retrying. Invalid content is rejected without saving. Warnings describe content that was saved but may not work. After a connection failure during show, read before trying again because the view may have been saved.

## OpenUI

OpenUI Lang uses the standard `@openuidev/react-ui` library plus Canvas's `Diagram`. Use the generated guide from `canvas_guide({ topic: "openui" })` for signatures. This example uses illustrative figures:

```text
root = Stack([header, chart, form])
header = CardHeader("Checkout experiment", "Week 3 results")
chart = BarChart(["Desktop", "Tablet", "Mobile"], [Series("Control", [3.9, 3.1, 2.2]), Series("Variant B", [4.0, 3.6, 3.1])], "grouped", "Device", "Conversion (%)")
form = Form("rollout", Buttons([send]), [audience])
audience = FormControl("Audience", RadioGroup("audience", [RadioItem("Mobile only", "", "mobile"), RadioItem("All devices", "", "all")], "mobile"))
send = Button("Send decision", @ToAssistant("Roll out checkout variant B"), "primary")
```

A conversation action sends its human-friendly message as `action`, with optional parameters and flattened form values in `data.form`. An `open_url` action opens a link without sending a message. Custom actions send their type and parameters. OpenUI image sources need embedded `data:image/` URLs.

## HTML

Send a complete document with inline CSS and JavaScript. This script-free form collects its named fields and sends them as data:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Capacity choice</title></head>
<body>
  <form data-canvas-action="Choose scaling option">
    <label><input type="radio" name="option" value="autoscale" checked> Autoscale</label>
    <label><input type="radio" name="option" value="reserved"> Reserved</label>
    <button type="submit">Send choice</button>
  </form>
</body>
</html>
```

The `window.canvas` bridge provides:

| Method or property | Use |
| --- | --- |
| `canvas.send(action, data?)` | Promise that resolves after input is queued. Call from the user's click or key press; handle rejection. |
| `canvas.state.get()` / `.set(value)` | Restore or save JSON draft state. |
| `canvas.view` | The view's id, revision and title. |
| `canvas.theme` / `canvas.onTheme(callback)` | Current appearance and theme variables; respond to theme changes. |
| `canvas.openLink(url)` | Open an HTTP(S) link during user interaction. Plain links are intercepted too. |

Use `data-canvas-action` and optional `data-canvas-data` on a button for a declarative send. The host verifies HTML sends and links against user activation and focus. A page cannot send on load or from a timer under supported activation checks. Browsers lacking the User Activation API use a weaker focus-only host check; see [security](SECURITY.md).

Load a bundled library with an empty tag such as `<script src="canvas:lib/chart.js"></script>`, followed by your own script. Available names are `tailwind`, `chart.js`, `d3` and `mermaid`. No CDN is needed. Use theme variables such as `--background`, `--foreground`, `--primary`, `--chart-1` through `--chart-6`, `--font-sans` and `--font-mono`. The full HTML guide in the tool documents the palette and library examples.

Pages can't load remote assets, fetch data, embed nested frames or navigate the parent. Embed the data to display. Scripts, SVG and canvas drawings run inside the page sandbox; they don't gain the agent's filesystem or credentials.

## Input and delivery

The conversation receives a message like this example:

````text
[Agent Canvas] Capacity choice (view 00000000-0000-4000-8000-000000000001, revision 1)
Action: Choose scaling option
Data:
```json
{ "option": "reserved" }
```
Note: keep the current budget
````

The session viewing a pinned view receives its input. Each conversation's last shown revision stays selected until it shows another; stale revisions cannot submit. Delivery uses a stable submission id and message id. A lost submit response is checked again with the same id; ambiguous admission is never automatically delivered a second time. Delivered means admitted into OpenCode, with no guarantee that the requested work has finished.

## Limits

These values come from `src/shared/contract.ts`. Source and serialized input limits are measured by JavaScript string length; draft persistence also checks UTF-8 size.

| Field | Limit |
| --- | ---: |
| Title / action / pinned name | 120 characters each |
| Summary | 2,000 characters |
| OpenUI source | 200,000 characters |
| HTML source | 400,000 characters |
| Input data serialized as JSON | 32,000 characters |
| Note | 4,000 characters |
| Saved draft | 64,000 bytes |
| HTTP request body | 1,000,000 bytes |

The store targets 50 retained interactions per view, pruning oldest delivered or uncertain entries; unsettled entries can exceed that target. The tool shows up to ten recent interactions when reading a view. Oversized drafts retain what fits and report which entries won't survive reloads. There is no old-view garbage collection.
