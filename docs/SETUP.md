# Setup

## Build from source

Use Node.js 22 or newer and npm. OpenCode 2 is required for agent integration; OpenChamber is optional. Dependencies are pinned in `package-lock.json`. This repository is a source checkout, with no install-by-name package command.

```sh
git clone https://github.com/batteryshark/agent-canvas.git
cd agent-canvas
npm ci
npm run build
```

Building generates the OpenUI schema/reference under `src/generated`, then creates two self-contained folders. `dist/opencode` holds the plugin, service, browser app and bundled libraries. `dist/openchamber` holds the pane, host service bridge and libraries. Keep each folder intact and in a stable location after configuring its absolute path.

## OpenCode 2

Add the plugin directory to the `plugins` array, preserving other entries:

```json
{
  "plugins": ["file:///absolute/path/to/agent-canvas/dist/opencode"]
}
```

The global configuration is `~/.config/opencode/opencode.json` or `.jsonc`; `XDG_CONFIG_HOME` changes its parent. A project configuration also works. The source uses the 2.0.23 plugin/client APIs and has no OpenCode 1 adapter.

Plugin setup checks the configured endpoint and starts a detached, shared Canvas service if none answers on loopback. The service outlives the OpenCode process. It writes `service.log` under the Canvas data directory. If another program or an incompatible Canvas version answers, startup reports the conflict instead of replacing it. Ordinary chat can continue during a Canvas outage.

Node must be on the host's PATH. Set `AGENT_CANVAS_NODE` to an absolute Node executable if needed. The plugin's tool calls retry service startup after a failure.

### Data directory and port

Defaults are `~/.local/share/agent-canvas` and `127.0.0.1:4317`. Set `AGENT_CANVAS_HOME` before starting the plugin or CLI to use a different data directory. On first creation, `AGENT_CANVAS_PORT` selects a port between 1024 and 65535. Once `connection.json` exists, its endpoint is authoritative; changing the environment variable alone won't change it.

Stop the service before changing its connection file. Keep the plugin and OpenChamber host bridge pointed at the same Canvas host. Never run two services against the same state file. Back up `connection.json` and `state.json` together. The 0.2 store refuses old state formats with instructions to move the old file aside; it doesn't migrate 0.1 views.

## Model-free demo

After building, run in separate terminals:

```sh
npm start       # Canvas service on the configured loopback endpoint
```

```sh
npm run demo    # prints viewing links and stays running to answer input
```

The demo uses synthetic content and no model calls. It creates an OpenUI dashboard and an HTML layout chooser; submissions produce revised views. Ctrl+C stops each foreground command. Saved demo views remain in the configured store. For a disposable demo, set the same fresh `AGENT_CANVAS_HOME` in both terminals and choose an unused port before either command runs.

## OpenChamber pane

Requires OpenChamber 2.3.0 or newer and the OpenCode plugin on the backend running the conversation.

1. In **Settings → Extensions**, add the absolute path to `dist/openchamber`.
2. Enable its local service when prompted.
3. Open **Agent Canvas** in the extension pane or page, then select a conversation.

![Canvas pane surface showing an OpenUI demonstration in the light theme](canvas-pane.png)

The pane follows the selected directory, conversation and theme, stores drafts through host storage, shows a badge and opens links through the host SDK. **Preferred surface → Browser** replaces the content with a compact launcher. **Show here this time** temporarily displays the view in the pane. After updating a local extension build, disable and re-enable it to clear cached pane instances.

The image is an existing demonstration of the Canvas pane surface; real OpenChamber host acceptance for 0.2 remains unverified. See [image notes](SCREENSHOTS.md). On mobile, use the browser viewing link.

## Private remote and phone access

With Canvas running beside OpenCode and Tailscale connected, configure private access on that host:

```sh
tailscale serve status
# Choose an unused HTTPS port after inspecting existing routes.
tailscale serve --bg --https=9443 http://127.0.0.1:4317
# Substitute the exact private origin printed by Tailscale.
node dist/opencode/canvas-service.cjs public-url --url https://HOST.TAILNET.ts.net:9443
```

Restart Canvas after changing its public URL. New links use that private HTTPS origin. Devices need tailnet access under your ACLs; the host must stay awake and the service running. This uses Tailscale Serve. Public Funnel is outside this setup. Remove the route with `tailscale serve --https=9443 off`.

You can run the service manually with `node dist/opencode/canvas-service.cjs serve`. It still binds loopback. The public-url command accepts only a private HTTPS `.ts.net` origin, without a path, query or fragment.

If OpenChamber's server and OpenCode run on different machines, the host bridge needs an explicit connection to the remote Canvas host. Its private `connection.json` can contain that host's HTTPS origin as `endpoint`, its agent token and its private `publicUrl`. Never put the agent token in pane settings or viewing links. Without that bridge configuration, the remote agent's browser link remains usable from a permitted device.

## Troubleshooting

- No views: ask the agent to show a view in the selected conversation. The pane resolves both directory and session identity.
- Unsent input: wait for the agent to be available, then Retry. Uncertain input: check the conversation before resending.
- Blank assets: remote images, styles and scripts don't load inside HTML pages. Use bundled libraries, inline SVG or small embedded assets.
- Port conflict or startup failure: read the error and local `service.log`, check the configured endpoint and Node path. Don't replace an unrelated service.

For a bug report, include redacted reproduction steps, Node/host versions and format errors. Don't attach connection/state files, service logs with private content, or credential-bearing viewing links.
