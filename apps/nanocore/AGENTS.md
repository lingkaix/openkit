# NanoCore

Read `README.md` first. This file contains only local agent execution rules for NanoCore.

## Local Agent Rules

- Keep NanoCore focused as the kernel server for Core protocol, public App API, MCP dogfooding, Goal Mode, worker governance, runtime config, auth, and durable local state.
- Keep local and server modes explicit: local mode may use implicit local identity, while server mode must protect app and Core APIs through the configured auth boundary.
- Keep Core routes aligned with `packages/protocol`; do not invent Core payload shapes locally.
- Keep App API routes aligned with `@openkit/app-api-schemas`; do not define app read-model schemas inside route handlers.
- Keep `packages/protocol` focused on `UI <-> Core`; do not move `Core <-> Agent` runtime details there.
- Treat local agent, OpenShell, worker-control, and gateway integrations as internal runtime adapters behind NanoCore routes and public contracts.
- Use tests first for route and stream behavior changes.
- Prefer maintainable feature paths over arbitrary file splitting. Keep complete route-to-runtime flows cohesive and easy to trace, avoid duplicate mappings, and move logic only when the destination is the clear owner.
- Do not optimize NanoCore for small files. Prefer complete, direct, searchable implementation flows, even when that means keeping related route, runtime, or adapter logic in one larger cohesive file.
- Preserve existing behavior during cleanup; add characterization tests before refactors that could alter route, stream, Goal Mode, auth, storage, or worker behavior.
- Current protocol design work keeps `apps/nanocore`, `packages/protocol`, and `apps/web` structurally aligned.
- When changes are driven by external research, expect the order to be `researcher sub-agent -> docs/specs or docs/core -> packages/protocol -> apps/nanocore -> apps/web`.
- When changes are driven by UI play or end-user feedback, the agent should first decide whether the protocol must change; if it must, update `packages/protocol` first, then update this server, and finally reflect the upgraded behavior in `apps/web`.
- Update and commit each package separately in sequence so the history stays linear and bisectable.
- Keep capability flags in `/api/meta` aligned with what the active agent adapter actually supports.
