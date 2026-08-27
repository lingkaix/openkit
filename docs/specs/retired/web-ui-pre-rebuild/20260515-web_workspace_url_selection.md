---
status: Retired
implementation: N/A
status-changed: 2026-06-28
current-guidance: None
decision-evidence: "https://github.com/lingkaix/openkit/commit/fffc107f9b73a8855045435598dcf97ebf2786da"
---
# Web Workspace URL Selection

## Lifecycle Reason

The pre-rebuild Web UI module and its URL-based workspace selection were deliberately removed during the full product-surface reset. This slice is retired because the rebuilt product is free to choose a different navigation and persistence model.

## Retention Reason

This document preserves the former route canonicalization, reload restoration, and selection-state behavior so maintainers can understand deleted navigation code without treating its URL scheme as current guidance.

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
