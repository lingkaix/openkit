# Web Workspace Dashboard Read Model

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

## Context

US-012 requires the web workspace route to render the typed dashboard read model returned by `GET /api/app/workspaces/:id/dashboard`.

The route already loads `workspaceDashboard` through `@openkit/core-client`, so this change keeps the protocol and nanocore surfaces stable and upgrades the web presentation layer.

## Behavior

- The selected workspace route renders `WorkspaceDashboard`.
- The component prefers the dashboard read model and falls back to selected workspace defaults while data is loading.
- Aggregate tiles show thread, artifact, memory entry, and provider counts.
- Default context shows the default model, default agent, and default skills when present.
- Agent health lists each agent status or a no-agents empty state.
- Recent threads list the latest updated thread names or a no-recent-threads empty state.
- Zero thread, artifact, and memory counts render explicit empty states.

## Verification

- `apps/web/src/components/WorkspaceDashboard.test.tsx` covers populated and empty dashboard states.
- Browser verification used the internal self-check nanocore server and Vite dev server.
- The populated demo workspace showed counts, default context, agent health, and recent threads.
- The created empty workspace showed zero-resource empty states for threads, artifacts, and memory.
