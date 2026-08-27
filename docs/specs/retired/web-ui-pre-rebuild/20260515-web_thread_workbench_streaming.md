---
status: Retired
implementation: N/A
status-changed: 2026-06-28
current-guidance: None
decision-evidence: "https://github.com/lingkaix/openkit/commit/fffc107f9b73a8855045435598dcf97ebf2786da"
---
# Web Thread Workbench Streaming

## Lifecycle Reason

The pre-rebuild Web UI module and its streaming thread workbench were deliberately removed during the full product-surface reset. This slice is retired because the current Web effort begins from stable kernel contracts instead of preserving this workbench implementation.

## Retention Reason

This document preserves the former prompt submission, SSE projection, and streamed-item rendering design so maintainers can interpret deleted code and tests without inheriting its state model in the rebuilt surface.

## Context

US-015 requires the web thread dashboard to submit a prompt, subscribe to the typed turn SSE stream, and render streamed items as the authoritative protocol events arrive.

The protocol now carries optional request correlation IDs on turn submission and completed item snapshots on `item.completed` events. The web app uses those snapshots to replace optimistic delta state once the server emits the final item payload.

## Behavior

- `ThreadWorkbench` owns the prompt composer and conversation item rendering.
- Starting a turn sends `POST /api/turns` with a fresh UUID `requestId`.
- After turn creation, the app subscribes with `core-client.subscribeTurnEvents({ workspaceId, threadId, turnId })`.
- The event subscription is an async iterable and the app stores the cleanup handle per active turn.
- `item-created` inserts the new item in event order.
- `item-delta` appends optimistic assistant text or reasoning content while the stream is active.
- `item-completed` replaces the local optimistic item with the completed protocol snapshot.
- The conversation renders user messages, assistant messages, reasoning, command executions, file changes, approvals, user input, tool calls, artifacts, and handoffs through the same item list.
- `@openkit/core-client` supports relative EventSource URLs so the browser app can run with an empty `VITE_CORE_URL` behind the Vite proxy.

## Verification

- `apps/web/src/components/ThreadWorkbench.test.tsx` covers a scripted SSE sequence with user-message, assistant-message, reasoning, command-execution, and file-change items.
- The component test asserts final `item.completed` snapshots replace optimistic delta text.
- Browser verification against the internal self-check executor confirmed the thread dashboard rendered user-message, assistant-message, reasoning, command-execution, and approval-request items in causal order.
