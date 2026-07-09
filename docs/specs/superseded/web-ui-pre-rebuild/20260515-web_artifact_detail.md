# Web Artifact Detail

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

## Context

US-019 requires artifacts produced by an agent turn to be visible from the conversation and readable on a dedicated detail route.

The web app now routes artifact references to `/workspaces/:workspaceId/artifacts/:artifactId`, fetches the artifact through `GET /api/workspaces/:id/artifacts/:artifactId`, and renders the returned content.

## Behavior

- Artifact-reference timeline items show title, summary, and a View artifact action.
- Workspace artifact rows also expose View artifact.
- Opening an artifact fetches the artifact detail from the core client before rendering.
- Artifact detail URLs use `/workspaces/:workspaceId/artifacts/:artifactId`.
- `ArtifactView` renders text and markdown bodies as preformatted text.
- `ArtifactView` pretty-prints JSON bodies when parsing succeeds.
- Diff artifacts render as preformatted content using the artifact body.

## Verification

- `apps/web/src/components/ArtifactView.test.tsx` covers text, JSON, and diff rendering.
- App integration coverage opens a produced artifact and verifies the artifact route and body.
- Browser verification against the internal self-check executor opened the protocol summary artifact from the inline timeline.
