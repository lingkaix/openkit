# Web Output Delta Reconciliation

Status: Retired
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: None
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The pre-rebuild Web UI module and its output-delta reconciliation implementation were deliberately removed during the full product-surface reset. This slice is retired because no current client contract preserves its buffering or replay algorithm.

## Retention Reason

This document preserves the former delta accumulation, snapshot reconciliation, and protocol-compatibility reasoning so maintainers can interpret deleted streaming code without carrying its algorithm into the rebuilt Web surface.

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
