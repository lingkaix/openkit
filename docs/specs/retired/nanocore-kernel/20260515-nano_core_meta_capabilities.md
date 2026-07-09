# Nano-Core Meta Capability Metadata

Status: Superseded

Superseded by `docs/specs/20260628-protocol_contract_consolidation.md`, `docs/specs/20260528-core_client_boundary.md`, and `docs/specs/20260703-worker_agent_capability.md`.

This document is retained as supporting detail for the original meta-capability implementation slice.

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
