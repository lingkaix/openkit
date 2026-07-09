# Codex Output Delta Bridge

Status: Superseded

Superseded by `docs/specs/20260628-protocol_contract_consolidation.md` and `docs/specs/20260629-worker_runtime_communication_model.md`.

This document is retained as supporting detail for the original command-output delta bridge implementation slice.

Superseded note: The 20260529 cleanup spec keeps the Codex output bridge but requires OpenKit-emitted output deltas to include explicit `itemType: "command-execution"`.

## Summary

US-002 bridges Codex command output streaming into OpenKit protocol item deltas. The host adapter listens to Codex app-server notifications and projects command output chunks as protocol-valid `item.delta` events.

## Wire shape

Codex emits JSON-RPC notifications with:

- `method: "item/commandExecution/outputDelta"`
- `params: { threadId, turnId, itemId, delta }`

`itemId` is the Codex command-execution item id. The adapter resolves it through the existing agent-item to protocol-item mapping created by `item/started`.

## Mapping

`CodexAgentSession` maps the notification to:

- `type: "command-output-delta"`
- local `turnId` resolved from Codex `turnId`, falling back to the active Codex turn
- Codex `itemId`
- raw output `delta`

`CodexHostAdapter` then maps the agent event to protocol:

- `event: "item.delta"`
- `data.type: "item-delta"`
- `data.deltaKind: "output-delta"`
- `data.itemType: "command-execution"`
- `data.itemId` set to the local protocol command item id
- `data.delta` set to the streamed output chunk

The adapter also appends the chunk to `CommandExecutionItemSchema.output` in the in-memory item snapshot.

## Validation

US-001 added required `itemType` validation to `ItemDeltaEventSchema`. Emitting `itemType: "command-execution"` lets the protocol boundary reject invalid `output-delta` pairings.

## Ordering

The bridge depends on Codex's item stream order: `item/started` creates the command-execution item before `outputDelta` chunks, and `item/completed` remains authoritative for terminal status, exit code, and duration. If an output delta arrives before the command item is known locally, nanocore drops it rather than emitting an orphaned protocol delta.
