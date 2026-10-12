# Bootstrap

This directory owns NanoCore process startup and shutdown checks around the data root, policy kernel, Vault, readiness, and boot audit trail.

## Boundaries

- Keep boot phases, phase ordering, the data-root lock, boot policy checks, Vault readiness, shutdown deadlines, and boot audit records here.
- `../index.ts` composes the process lifecycle and starts the server after required phases succeed.
- Preserve each phase's critical or non-critical failure semantics and fail closed before unsafe mutation or network exposure.
- Treat authoritative SQLite integrity failure as critical: do not move or replace the original database, initialize local identity, issue bootstrap credentials, or bind the listener.
- The migrations phase rebuilds a Workspace derived index set only when that set is missing or invalid. A completed rebuild records `storage.index-rebuilt` with no blocks on ready storage and does not degrade readiness. A thrown rebuild fails the critical phase.
- Product request handling and the one-time server owner credential flow belong outside this directory.

## Verification

Run the focused phase-order, lock, policy, Vault, readiness, shutdown, and audit tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
