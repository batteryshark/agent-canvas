# Development

Use Node.js 22 or newer and the checked-in npm lockfile. `npm ci` installs dependencies; it may run package lifecycle scripts. The build generates the OpenUI schema and guide and bundles the plugin, service, browser app and extension. No dependency binaries or generated bundles are checked in.

| Command | Work performed |
| --- | --- |
| `npm run build` | Generate OpenUI resources and build both distribution folders. |
| `npm run typecheck` | Generate OpenUI resources, then TypeScript checks. |
| `npm test` | Generate resources, then `test/*.test.ts` via tsx. Includes HTTP listeners and plugin/service tests. |
| `npm run check` | Generate resources, typecheck, unit tests and build. |
| `npm run test:browser` | Build and launch Playwright with installed Chrome and a local fixture server. |
| `npm run test:native` | Build, launch real OpenCode and Canvas processes, and a local HTTP model fixture. |

These commands require an environment where those effects are permitted. The native test uses isolated XDG data and no account credentials, but starts processes/listeners and sends fixture-model tool calls. Set `OPENCODE_BIN` to select the OpenCode 2 executable. Its reports use `.runtime`; browser reports/screenshots use ignored test output directories. Don't point fixtures at a live Canvas store or port.

## Tests and acceptance

The retained tests cover persistence, project/session scoping, revision conflicts, delivery idempotency, draft ordering, HTML validation/document policies, OpenUI schema and actions, the pane host protocol and mobile layout. Browser security fixtures deliberately attempt network and frame escapes against local beacon listeners. They require explicit permission to run.

Real OpenChamber 0.2 host integration, Safari/Firefox and the Tailscale physical-phone path still need acceptance. Host-policy fixtures do not establish compatibility with those environments.

This source tree has no checked-in CI workflow. The test scripts and portable fixtures are retained for an operator-authorized validation run.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/shared/contract.ts` | Public schemas, limits, payloads and input-message format. |
| `src/shared` | Content validation, guides and synthetic demo content. |
| `src/server` | Persistence, credentials, HTTP API, delivery records and CLI. |
| `src/opencode` | Plugin registration, tools, delivery worker and service launcher. |
| `src/openchamber` | Authenticated host service bridge for the pane. |
| `src/ui` | App shell, transport, drafts, OpenUI components and HTML sandbox. |
| `scripts` | OpenUI generation, packaging/notices and native test runner. |
| `test` | Unit, browser, host-policy and native-model fixtures. |

Read [architecture](ARCHITECTURE.md) before changing cross-module interfaces, [security](SECURITY.md) before changing HTML handling or transport, and [rights](../RIGHTS.md) before distributing bundles. Packaging exposes a private OpenUI theme context and fails if the pinned upstream structure changes; review that adapter when updating dependencies.
