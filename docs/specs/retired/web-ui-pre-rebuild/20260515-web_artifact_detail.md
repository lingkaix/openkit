---
status: Retired
implementation: N/A
status-changed: 2026-06-28
current-guidance: None
decision-evidence: "https://github.com/lingkaix/openkit/commit/fffc107f9b73a8855045435598dcf97ebf2786da"
---
# Web Artifact Detail

## Lifecycle Reason

The pre-rebuild Web UI module and its artifact-detail implementation were deliberately removed during the full product-surface reset. This slice is retired because the current Web design is a clean-slate projection, not a contract-preserving replacement for this route and interaction model.

## Retention Reason

This document preserves the former artifact navigation, detail-route, and read-model expectations so maintainers can interpret the deleted UI and its tests without treating those choices as requirements for the rebuilt product surface.

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
