# Web Release Gates

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

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
