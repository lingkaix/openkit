# Nano-Core Snapshot Reload Coverage

Status: Superseded

Superseded by `docs/specs/20260703-storage_layout_record_ownership.md` and `docs/specs/20260628-nanocore_config_identity_contract.md`.

This document is retained as supporting detail for the original file-snapshot reload coverage slice.

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
