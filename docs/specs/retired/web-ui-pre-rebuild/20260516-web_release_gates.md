# Web Release Gates

Status: Retired
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: None
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

These Web release gates ended with the deliberately removed pre-rebuild UI module and no longer govern a releasable product surface. The document is retired because its bounded verification campaign concluded rather than being replaced by an equivalent gate specification.

## Retention Reason

This document preserves the former accessibility, browser, protocol, and release inspection criteria so maintainers can audit the old release decision without applying obsolete gates to the clean-slate Web rebuild.

## Summary

This spec closes the v0.0.1 web inspection and release-gate slice.

## Scope

- Settings Diagnostics renders product diagnostics, `/api/meta`, latest SSE envelopes capped at 200, event-family filtering, and the active thread turn timeline.
- Thread dashboards render an agent session badge with session id, status, agent id, health, and a refresh action.
- The web package owns a Playwright simulator e2e flow that covers workspace creation, thread creation, turn streaming, approval, question answer, artifact opening, interruption control, memory edit, and reload persistence.
- Each package exposes `test:coverage` with v8 coverage thresholds: lines 70, functions 70, statements 70, branches 60.
- The root package exposes `verify:full` as `pnpm verify && pnpm --filter @openkit/web e2e`.

## Verification

- `pnpm --filter @openkit/web test -- DiagnosticsPanel App.test.tsx`
- `pnpm --filter @openkit/web test -- AgentStatusBadge App.test.tsx`
- `pnpm --filter @openkit/core-client test -- client.test.ts`
- `pnpm --filter @openkit/web e2e`
- `pnpm --filter @openkit/protocol test:coverage`
- `pnpm --filter @openkit/core-client test:coverage`
- `pnpm --filter @openkit/nanocore test:coverage`
- `pnpm --filter @openkit/web test:coverage`
