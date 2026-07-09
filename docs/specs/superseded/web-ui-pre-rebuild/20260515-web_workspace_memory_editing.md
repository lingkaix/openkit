# Web Workspace Memory Editing

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

## Context

US-013 requires the web settings memory panel to expose the existing workspace memory endpoints through a focused UI.

The protocol, core-client, and nanocore APIs already support listing, creating, and patching memory entries, so this change keeps the API surface stable and upgrades the web client.

## Behavior

- The settings memory section renders `MemoryPanel`.
- The panel lists memory entries loaded from `GET /api/workspaces/:id/memory` through the existing workspace resources load.
- Creating an entry calls `POST /api/workspaces/:id/memory` through `client.core.createMemory`.
- Editing an entry loads its title and content into the form while preserving the original kind.
- Saving an edit calls `PATCH /api/workspaces/:id/memory/:memoryEntryId` through `client.core.updateMemory`.
- The App applies memory edits optimistically, replaces the optimistic row with the server response on success, and restores the previous entries on failure.
- Failed edits display the server error message in the panel.

## Verification

- `apps/web/src/components/MemoryPanel.test.tsx` covers list, create, and optimistic-update rollback behavior.
- Browser verification created a memory entry, edited it, reloaded the SPA, reopened settings memory, and confirmed the edited value persisted.
