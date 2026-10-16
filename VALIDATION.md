# Agent Canvas 0.2 validation — 2026-10-15

Version 0.2.0 is a hard-cutover rebuild. All three suites pass on the final tree, run by the lead after the build, integration, review and fix passes.

| Suite | Command | Result |
| --- | --- | --- |
| Types, unit tests, build | `npm run check` | 69/69 tests pass; build produces both packages with 4 bundled libraries |
| Browser (installed Chrome) | `npm run test:browser` | 29/29 pass |
| Native OpenCode | `npm run test:native` | 18/18 checks pass on OpenCode 2.0.23 |
| Native, OpenChamber's bundled OpenCode | `OPENCODE_BIN=/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode node scripts/test-runtime.mjs` | 18/18 checks pass on 2.0.28 |

## What the suites prove

- **Both formats render and send.**
  - An OpenUI view with a chart, a table and a form delivers its form values, including fields left at their defaults and a required DatePicker.
  - An HTML view renders a bundled library (Chart.js) and delivers through both `canvas.send` and a `data-canvas-action` form.
- **Real OpenCode.** The native test loads the built plugin into a real `opencode serve` with isolated data and a local fixture model, and checks:
  - The packaged service starts automatically.
  - `canvas_guide` returns the OpenUI reference.
  - Invalid content comes back as repairable errors.
  - Both formats show.
  - Viewer input is admitted exactly once; a duplicate is suppressed, and a reused id carrying different input is rejected.
  - The agent reads input back with `canvas_read`.
  - A pinned view can be revised from a second session while the first session's snapshot is preserved.
  - A stale revision cannot submit.
  - Input from a project view goes to the conversation that sent it.
  - Ordinary chat keeps working while Canvas is down.
- **OpenChamber pane.**
  - The panel is served with OpenChamber's real `sandbox="allow-scripts"` and guest CSP.
  - It renders both formats, delivers input, and follows conversation switches.
  - It never sends to the wrong conversation when a switch happens mid-save.
  - It remembers a browser preference.
- **Containment.** In the browser frame and in the pane, an agent-written page:
  - cannot fetch, reach the parent or its storage, or navigate the top window;
  - cannot open a link or send input without a real user click, which the host verifies, not the page;
  - cannot reach the network through prerender, preconnect, speculation rules or WebRTC.

  `canvas_show` also refuses static prerender links, speculation rules and WebRTC.
- **State and delivery.**
  - Drafts survive reloads in both formats, even immediately after typing.
  - Stale revisions are marked and cannot send.
  - A busy agent leaves input unsent until Retry.
  - A lost response to a send is confirmed rather than sent twice.
  - Pinned views from another conversation never open or send on their own.
- **Layout.** At 390×844 there is no horizontal overflow, and wrapping KPI rows don't clip their contents.

## Review

Three independent reviewers (security, correctness, generality) examined the integrated build. The generality reviewer wrote five realistic views using only the agent-facing guides:
- a phone mockup with variants;
- a KPI dashboard;
- a decision form;
- an architecture diagram;
- an interactive explainer.

All confirmed critical and major findings were fixed and are covered by tests. The two critical ones were:
- a page could spoof link messages to the host;
- `<link rel="prerender">` could reach the network.

## Not verified

- The rebuilt extension inside the real OpenChamber app. The pane is tested in a harness that reproduces its sandbox and guest CSP.
- Safari and Firefox.
- The Tailscale and physical-phone path for 0.2. The service and link format are unchanged from 0.1, which was verified on a phone.
- Residual risk: a nested frame inside an HTML page gets fresh globals and escapes the run-time prerender and WebRTC guards (PROJECT.md Q3).
