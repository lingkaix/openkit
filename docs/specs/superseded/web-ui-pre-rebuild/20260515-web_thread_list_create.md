# Web Thread List And Create

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

## Context

US-014 requires the web sidebar to expose workspace threads and create new threads from the selected workspace.

The core-client and nanocore already provide `GET /api/workspaces/:id/threads` and `POST /api/workspaces/:id/threads`, so this change keeps the API surface stable and upgrades the web routing and sidebar UI.

## Behavior

- The sidebar workspace row renders through `ThreadList`.
- The selected workspace shows a collapsible nested thread list from the loaded `listThreads` response.
- The selected workspace can show a nested new-thread form outside the thread dashboard.
- Creating a thread calls `createThread` and appends the returned thread to the sidebar.
- The workspace thread count updates after creation.
- Opening or creating a thread writes `/workspaces/:workspaceId/threads/:threadId` to the browser URL and opens the thread dashboard.
- Initial load accepts both `/workspaces/:workspaceId` and `/workspaces/:workspaceId/threads/:threadId`.

## Verification

- `apps/web/src/components/ThreadList.test.tsx` covers list render and create-then-navigate behavior.
- Browser verification created a thread from the selected workspace sidebar and confirmed the URL and thread dashboard.
