---
status: Superseded
implementation: N/A
status-changed: 2026-07-03
current-guidance: "`docs/specs/20260703-storage_layout_record_ownership.md`, `docs/specs/20260628-nanocore_config_identity_contract.md`"
decision-evidence: "`docs/specs/20260703-storage_layout_record_ownership.md`, `docs/specs/20260628-nanocore_config_identity_contract.md`"
---
# Nano-Core Snapshot Reload Coverage

## Lifecycle Reason

Storage Layout/Record Ownership and NanoCore Config/Identity absorbed persistence source-of-truth, reload, and recovery behavior into current contracts. This snapshot test slice lost authority because durable state no longer has one monolithic file-snapshot owner.

## Retention Reason

This document preserves the original snapshot reload cases, persisted record inventory, and restart expectations so storage regressions can be compared with the early baseline without reinstating its obsolete aggregate ownership.

## Summary

US-006 verifies that `FsStore` JSON snapshots preserve the full local protocol state needed after a restart.

## Goals / Non-goals

- Expose documented `flushSnapshot()` and `loadSnapshot(path)` APIs for explicit persistence tests and future runtime control.
- Verify reload coverage for workspace, memory, thread, turn, items, approval, artifact, agent session, and SSE event envelopes.
- Preserve the existing snapshot file shape and constructor auto-load behavior.
- Do not introduce migrations or a database layer in this story.

## Design

`FsStore.flushSnapshot()` delegates to the existing private persistence writer.

`FsStore.loadSnapshot(path)` is now public and retains the constructor's existing load behavior.

`FsStore.getAgentSession(id)` provides a focused read API so tests can assert agent-session records directly instead of relying on stream events as a proxy.

## Testing Strategy

`apps/nanocore/src/lib/store-reload.test.ts` creates a full turn state, flushes the snapshot, constructs a fresh store from the same file, and deep-equals every relevant record and emitted event envelope.

The existing `store.test.ts` remains as broad persistence smoke coverage.

## Rollout Notes

Future persistence changes should keep `store-reload.test.ts` as the minimum record-level regression gate.
