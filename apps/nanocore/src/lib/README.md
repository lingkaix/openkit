# Library

This directory contains NanoCore's existing app-local product-state aggregate and deterministic simulator. It is not a general utility directory.

## Boundaries

- `store.ts` presents one request-facing API over workspace, thread, turn, item, artifact, session, knowledge, and event state while canonical record placement and validation remain under `../storage/`. After a Turn is a sealed terminal, `updateTurn`, `createItem`, `emitTurnEvent`, and `updateItem` admit only completion of an already-decided publication or a named field-limited display-projection refresh, judged by identity and content.
- `store.ts` is still a broad aggregate; do not add a new record family or workflow here by default. New behavior belongs with its concrete route, runtime, policy, provider, Vault, or storage owner.
- Process-local turn-event listeners and timers are runtime projections, not durable authorities. Canonical event history remains workspace-owned file state.
- Event envelopes project non-UUID App command ids to stable Workspace/Thread-scoped protocol UUIDs using the existing UUID helper; command receipts, checkpoints, and Worker packages retain the original command identity.
- `store.ts` does not own a Knowledge context materialization path; S61 owns retrieval traces and S39 owns worker Context Package files under `../storage/`.
- Split an existing family only when the new owner receives direct callers and removes a complete responsibility. Do not hide the same aggregate behind a pass-through repository or single-implementation interface.
- `simulator.ts` owns deterministic demo execution only and must use the same public store invariants as production paths.

## Verification

Run the nearest store, reload, canonical-file, event-stream, and simulator tests affected by a change, followed by the package gates in the [NanoCore source guide](../README.md).
