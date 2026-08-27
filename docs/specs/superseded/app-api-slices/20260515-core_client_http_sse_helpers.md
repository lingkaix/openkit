---
status: Superseded
implementation: N/A
status-changed: 2026-05-28
current-guidance: "`docs/specs/20260528-core_client_boundary.md`"
decision-evidence: "`docs/specs/20260528-core_client_boundary.md`"
---
# Core Client HTTP and SSE Helpers

## Lifecycle Reason

The Core Client Boundary spec absorbed HTTP request behavior, SSE replay, error mapping, and public client ownership into one active package contract. This helper slice lost authority because transport helpers must remain implementation details of that complete client boundary.

## Retention Reason

This document preserves the original HTTP/SSE helper behavior, reconnect assumptions, and focused test cases so client regressions can be compared with the first slice without treating helper layout as current design authority.

## Summary

US-004 adds typed HTTP methods and a reconnecting SSE async iterator to `@openkit/core-client`.

## Goals / Non-goals

- Expose typed helper methods for the v0.0.1 workspace, memory, thread, turn, approval, artifact, and replay routes.
- Validate inbound HTTP and SSE payloads through `@openkit/protocol`.
- Expose the Core protocol route set through the composed `client.core` surface.
- Do not add nanocore routes or change protocol schemas in this story.

## Background

The web app originally used a small core client with flat method names and callback-style SSE helpers.

US-004 moved the hand-rolled fetch and stream handling behind a typed package surface that SPA code can consume directly. The 2026-05-28 core-client boundary repair removed the flat aliases and left the async iterator stream as the only public turn-event subscription shape.

## Proposed design

`createCoreClient` owns base URL normalization and composes sub-clients. Core protocol HTTP routes and turn-event SSE live under `client.core`.

HTTP helpers parse JSON once, validate successful responses with the requested protocol schema, throw `ProtocolValidationError` for schema failures, and throw `ApiCallError` for non-2xx responses.

`client.core.subscribeTurnEvents` returns an `AsyncIterable<SseEventEnvelope>`, tracks `lastSeen`, drops duplicate or stale sequence numbers, and reconnects with `since=<lastSeen>` after stream errors.

## Alternatives considered

The callback-style `subscribeToTurn` API was considered during the initial transition, but it is removed. Validation failures are now surfaced through the async iterator instead of being thrown from an EventSource callback.

## Rollout / Migration plan

Web callers use the composed client surface: `client.core.meta`, `client.core.createMemory`, `client.core.updateMemory`, `client.core.respondApproval`, and `client.core.subscribeTurnEvents`.

## Testing strategy

Core-client tests cover happy-path validation, invalid-payload errors, sequence filtering, and since-cursor reconnects.

Web typecheck and test coverage confirm SPA consumers use the composed `client.core` surface.

## Risks & mitigations

Risk: reconnect loops could keep a stream open after the consumer stops.

Mitigation: the async iterator `return()` closes the active `EventSource` when a `for await` loop breaks.

## Open questions

Future stories should add new protocol methods under `client.core` only after the matching protocol and NanoCore routes exist.
