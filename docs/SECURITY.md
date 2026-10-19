# Security and storage

## Credentials and local data

The Canvas service binds to loopback. Its data directory defaults to `~/.local/share/agent-canvas`, overridden by `AGENT_CANVAS_HOME`.

- `connection.json` holds the endpoint, a random agent credential and the viewing base URL.
- `state.json` holds host/session identities, view sources, revisions, input and delivery records.
- `service.log` holds output from an automatically started service.

The service creates its directory owner-only and creates connection/state/log files with owner-only permissions. Existing directory permissions aren't repaired automatically. Keep the directory private, back up connection and state together, and exclude runtime data from repositories and bug reports. These files aren't encrypted at rest.

The plugin and OpenChamber host bridge hold the broader agent credential. A viewer receives a session-scoped key. Browser links carry it in the URL fragment; the app moves it to tab-local session storage and removes it from the address bar. Anyone with the original link and network access can read that session's accessible views and submit input. Removing the fragment after opening doesn't revoke the original link. There is no viewer-key rotation UI.

Project sharing is scoped by the stored host identity and project root; directory and session identity further bind each conversation. Pinned views are accessible to other sessions in that project. This is a local shared-service trust model: someone who can read the agent credential or state has broader access than a viewer.

## Browser and pane boundaries

The HTTP service rejects foreign browser origins, restricts viewer API routes and serves a fixed asset list at trusted host addresses. It doesn't serve arbitrary files. Tailscale Serve supplies a private HTTPS origin for remote viewers, subject to the operator's tailnet ACLs. Public hosting isn't supported by this setup.

Agent-written HTML runs in an opaque-origin iframe with `sandbox="allow-scripts"`. Content security policy restricts loads, requests, popups and navigation. Libraries are bundled and inlined. The host validates bridge messages against the expected frame and checks user activation/focus before accepting sends or links. Without the browser's User Activation API, the host falls back to checking frame focus, which is a weaker boundary.

Chrome prerender and WebRTC have network paths outside CSP. Canvas rejects their static forms, strips unsafe tags while building a document and guards runtime creation. Nested frames are refused because their fresh globals would escape those guards. Captured native methods protect the guards from redefined built-ins. New browser APIs or unwrapped DOM insertion paths could reopen those gaps. Keep secrets out of view content even with these restrictions.

## Frame navigation

Navigating a page's own frame could discard the bridge and its guards. The browser app's `frame-src` permits only its `/frame` shell at a validated origin. The pane adds `frame-src 'none'` alongside the host guest policy: its initial `srcdoc` page can render, while subsequent document navigations are blocked. A refused navigation produces a notice and a render-error report; Canvas doesn't reload the page automatically. A navigation to `about:blank` can leave an empty frame without a report.

The checked-in browser tests exercise these policies in a harness serving OpenChamber's guest policy. Real OpenChamber desktop/web/relay acceptance for 0.2 remains unverified, as do Safari and Firefox. Preserve the panel's authored CSP when packaging or changing host integration.

## Delivery and drafts

The store rejects cross-session submissions and stale revisions. Duplicate input ids with the same content reuse the existing interaction; reusing an id with different content fails. The worker checks the session's directory before admission. Failures before admission become unsent and can be retried; failures during admission become uncertain. Expired sending leases and service restarts also produce uncertain status. Check the conversation before resending uncertain input.

Browser drafts use local storage; pane drafts use host storage, keyed by session, view and revision. They can contain sensitive entries you haven't sent yet. Clearing browser storage removes local drafts; it doesn't erase server state or historical revisions. There is currently no view deletion, unpinning or garbage collection. Removing a file from a later source commit likewise doesn't erase old public Git history.

For implementation details, see [architecture](ARCHITECTURE.md). Report suspected bugs with a small, redacted reproduction and the affected versions. Never include real credentials or private view sources in a public report.
