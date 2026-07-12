# Library

This directory contains NanoCore's existing app-local product-state aggregate and deterministic simulator. It is not a general utility directory.

## Boundaries

- `store.ts` presents one request-facing API over workspace, thread, turn, item, artifact, session, knowledge, and event state while canonical record placement and validation remain under `../storage/`.
- `store.ts` is still a broad aggregate; do not add a new record family or workflow here by default. New behavior belongs with its concrete route, runtime, policy, provider, Vault, or storage owner.
- Process-local turn-event listeners and timers are runtime projections, not durable authorities. Canonical event history remains workspace-owned file state.
- Live context-materialization reads and writes currently remain in `store.ts`; portable capture and publication belong to `../storage/workspace-portable-file-state.ts`.
- Split an existing family only when the new owner receives direct callers and removes a complete responsibility. Do not hide the same aggregate behind a pass-through repository or single-implementation interface.
- `simulator.ts` owns deterministic demo execution only and must use the same public store invariants as production paths.

## Verification

Run the nearest store, reload, canonical-file, event-stream, and simulator tests affected by a change, followed by the package gates in the [NanoCore source guide](../README.md).
