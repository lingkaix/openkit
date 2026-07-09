# Web Workspace URL Selection

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

## Summary

US-011 completes workspace selection in the SPA by keeping the selected workspace in the browser URL and restoring that selection on reload.

## Goals / Non-goals

- Render workspace summaries from `@openkit/core-client`.
- Create a workspace through the existing core-client workspace helper.
- Select the created workspace immediately after creation.
- Persist the selected workspace as `/workspaces/:id`.
- Keep routing minimal and avoid adding a full client router for v0.0.1.

## Proposed Design

The SPA reads `/workspaces/:id` during initialization before falling back to local storage.

Whenever `selectWorkspace` succeeds, the SPA writes the selected id to local storage and updates the current path with `history.replaceState`.

The existing workspace sidebar remains the primary navigation surface.

## Testing Strategy

- `apps/web/src/App.test.tsx` covers rendering workspace summaries and creating a workspace.
- The US-011 test creates a workspace, asserts it is selected, checks the URL path, remounts the app, and confirms the same workspace is restored from the URL.
- Browser verification uses nanocore with the internal self-check executor and the Vite dev server.

## Risks & Mitigations

- Risk: The app uses a path convention without a full router.
- Mitigation: Keep the parser narrow to `/workspaces/:id` and fall back to local storage or the first workspace when the path is invalid.

## Open Questions

- Should thread selection also move into the URL before v0.1.0?
