# Protocol Output Delta Target

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/core/protocol.md`, `packages/protocol/README.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Protocol Contract Consolidation absorbed output accumulation, delta payload typing, and command-execution item requirements into the active item/event contract. The target-only slice ceased to be authoritative because output behavior must remain consistent with the complete protocol model.

## Retention Reason

This document preserves the original output-delta target, accumulation rules, and compatibility removal rationale so maintainers can interpret historical payload behavior without restoring an independent output contract.

Superseded note: The 20260529 cleanup spec keeps command output accumulation but removes the `output` default. Current command-execution items must carry explicit `output`.

## Summary

US-001 defines the durable target for command output streaming.

## Motivation

v0.0.1 allowed `output-delta` events but did not define where those chunks accumulated. That left protocol consumers to infer command output state and allowed unrelated item types to receive command output deltas.

## Schema change

`CommandExecutionItemSchema` now includes:

- `output: string` with default `""`.
- `command`, `cwd`, `exitCode`, and `durationMs` unchanged.

`output` is the canonical accumulated full text snapshot. During streaming, clients append each `item-delta.delta` where `deltaKind === 'output-delta'` to that snapshot. At `item-completed` time, the item snapshot is authoritative.

## Delta validation

`ItemDeltaEventSchema` requires `itemType`. `deltaKind: 'output-delta'` is valid only with `itemType: 'command-execution'`.

Runtime code that has the referenced item snapshot can call `validateItemDelta(event, item)` to enforce the same rule without making the event schema depend on item storage.

## Generated schema impact

The generated JSON Schema artifacts are regenerated from Zod so downstream consumers see the new `output` field and optional `itemType` validation context.

## Follow-up

US-002 should wire `validateItemDelta` into the Codex bridge / NanoCore runtime path. US-003 should update the simulator so command output deltas append into `command-execution.output`.
