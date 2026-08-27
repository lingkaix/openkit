---
status: Superseded
implementation: N/A
status-changed: 2026-07-03
current-guidance: "`docs/core/protocol.md`, `docs/specs/20260528-core_client_boundary.md`, `docs/specs/20260703-worker_agent_capability.md`"
decision-evidence: "`docs/core/protocol.md`, `docs/specs/20260528-core_client_boundary.md`, `docs/specs/20260703-worker_agent_capability.md`"
---
# Nano-Core Meta Capability Metadata

## Lifecycle Reason

Protocol Consolidation, Core Client Boundary, and Worker Agent Capability absorbed metadata, client projection, and capability ownership into current contracts. The meta endpoint slice lost authority because capability truth now comes from those owners instead of an executor-shaped metadata response.

## Retention Reason

This document preserves the original `/api/meta` capability projection, executor coupling, and test expectations so maintainers can interpret historical clients without treating that endpoint slice as current capability authority.

## Summary

US-005 keeps `/api/meta` aligned with the active turn executor by publishing the executor's protocol-visible capability flags, SSE event families, item types, and item delta kinds.

## Goals / Non-goals

- Return `MetaResponseSchema` with the current `PROTOCOL_VERSION` from `/api/meta`.
- Derive capability flags from the active executor's `RuntimeCapabilities`.
- Let each executor advertise the item types and item delta kinds it can emit.
- Do not change protocol schemas or add new route shapes in this story.

## Design

`TurnExecutor` now exposes optional `itemTypes` and `itemDeltaKinds` metadata beside its existing `capabilities` and `eventFamilies`.

`createApp` copies those values into `/api/meta`, then validates the whole payload through `MetaResponseSchema` before returning it.

The default `CodexHostAdapter` advertises the currently implemented item surface: user messages, assistant messages, command executions, and text deltas.

## Testing Strategy

`apps/nanocore/src/meta.test.ts` covers the default host adapter and a stubbed executor with different capability flags, event families, item types, and item delta kinds.

The existing nanocore route suite continues to cover `/api/meta` as part of the broader endpoint regression set.

## Rollout Notes

Future executor work should update `itemTypes` and `itemDeltaKinds` at the same time it adds new emitted stream payloads.
