# Web App

Read `README.md` first. This file contains only local agent execution rules for the Web app.

## Local Agent Rules

- Follow `docs/cookbooks/spa-solid-vite.md` for stack and setup decisions.
- Keep the UI conversation-first, with an inspect/protocol mode for lower-level state visibility.
- Consume the server only through the composed `packages/core-client` sub-clients.
- Keep workspace, thread, turn, item, approval, agent session, and artifact views aligned with the protocol package.
- Use tests first for behavior changes.
- Current protocol design work keeps `apps/web`, `apps/nanocore`, and `packages/protocol` structurally aligned.
- When changes are driven by external research, expect the order to be `researcher sub-agent -> docs/specs or docs/core -> packages/protocol -> apps/nanocore -> apps/web`.
- When changes are driven by UI play or end-user feedback, first decide whether the protocol must change to support the request; if it must, update `packages/protocol` first, then `apps/nanocore`, and only then reflect the upgraded behavior in the UI.
- Update and commit each package separately in sequence so the history stays linear and bisectable.
