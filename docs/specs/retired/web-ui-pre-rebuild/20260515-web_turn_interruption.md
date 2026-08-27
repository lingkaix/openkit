---
status: Retired
implementation: N/A
status-changed: 2026-06-28
current-guidance: None
decision-evidence: "https://github.com/lingkaix/openkit/commit/fffc107f9b73a8855045435598dcf97ebf2786da"
---
# Web Turn Interruption

## Lifecycle Reason

The pre-rebuild Web UI module and its turn-interruption controls were deliberately removed during the full product-surface reset. This slice is retired because no current Web contract preserves its control placement, optimistic state, or stream reconciliation behavior.

## Retention Reason

This document preserves the former interruption UX and authoritative-turn synchronization assumptions so maintainers can explain deleted behavior without treating that interaction as binding on the clean-slate Web design.

## Context

US-016 requires the thread workbench to stop a running or paused turn while keeping the UI aligned with the authoritative turn stream.

The protocol accepts an optional UUID request correlation id on interrupt requests. The web app sends that id with the stop request and waits for `turn.updated` or `turn.completed` events to move the local turn into a terminal state.

## Behavior

- The workbench renders a Stop turn control when the selected thread has an active non-terminal turn.
- Clicking Stop turn sends `POST /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt` with a fresh UUID `requestId`.
- The app marks the active turn as locally interrupting immediately after the click.
- The workbench shows an `interrupting` badge while the POST is in flight or while the stream has not yet delivered a terminal turn event.
- The app does not replace the local turn from the interrupt POST response.
- `turn.updated` with `interrupted`, `cancelled`, `completed`, or `failed` clears the active turn and local interrupting state.
- `turn.completed` also clears the active turn, local interrupting state, and stream subscription.
- Failed interrupt requests clear the local interrupting state and surface the error message.

## Verification

- `apps/web/src/components/ThreadWorkbench.test.tsx` covers Stop turn, the local interrupting badge, and the terminal interrupted state.
- `apps/web/src/App.test.tsx` covers the interrupt POST request body and asserts a UUID `requestId` is sent.
- Browser verification against the internal self-check executor confirmed Stop turn sent a UUID requestId and the dashboard reached the streamed `interrupted` terminal state.
