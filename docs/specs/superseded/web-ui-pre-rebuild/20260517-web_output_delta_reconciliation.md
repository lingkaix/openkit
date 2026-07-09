# Web Output Delta Reconciliation

Status: Superseded

Superseded by: [Web Product Surface Projection](../../20260628-web_product_surface_projection.md)

Superseded: 2026-06-28. This file is retained as historical reference for the pre-rebuild Web UI slice and does not define 0.0.1 release readiness.

Superseded note: The 20260529 cleanup spec removes the historical `command-execution.output` default. Current command-execution items and fixtures must carry explicit `output`.

## Summary

US-004 makes the web timeline reconcile command `output-delta` events before the completed command snapshot arrives.

## Goals

- Show streamed command output during an active turn.
- Keep the rendered text identical after `item-completed` replaces the optimistic item.
- Avoid changing protocol or core-client contracts in this story.

## Proposed Design

`ThreadWorkbench` continues to route `item-delta` events through `appendItemDelta`.

For `command-execution` items, the reducer appends each delta to explicit `item.output`. Fixtures that omit `output` are invalid and must be updated instead of repaired by the reducer.

The command renderer includes non-empty `item.output` after command, cwd, and exit code metadata.

This gives mid-turn and post-completion render parity: mid-turn text comes from the local reducer, while completed text comes from the authoritative snapshot.

## Testing Strategy

- Component coverage scripts `item-created`, `output-delta`, and `item-completed` for one command item.
- The intermediate render must show `streaming chunk` before `exit 0` is present.
- The final render must still show `streaming chunk` after snapshot replacement.
- The Playwright smoke flow asserts `simulator: ok` before approval handling.

## Rollout

No migration is provided for older command fixtures without `output`. Current fixtures and completed snapshots must include the explicit field.
