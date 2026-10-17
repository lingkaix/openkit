# Bootstrap

This directory owns NanoCore process startup and shutdown checks around the data root, policy kernel, Vault, readiness, and boot audit trail.

## Boundaries

- Keep boot phases, phase ordering, the data-root lock, boot policy checks, Vault readiness, shutdown deadlines, and boot audit records here.
- The data-root instance lock uses `flock` on an open descriptor for the existing `server/runtime` directory. Node keeps that descriptor until release; the kernel releases it on process death. Keep the directory inode in place while a holder is active. The JSON holder file and heartbeat remain diagnostic and the file is removed on orderly release. Source deployments need the util-linux-compatible `flock` utility that the App image already provides.
- `../index.ts` composes the process lifecycle and starts the server after required phases succeed.
- Preserve each phase's critical or non-critical failure semantics and fail closed before unsafe mutation or network exposure.
- Treat authoritative SQLite integrity failure as critical: do not move or replace the original database, initialize local identity, issue bootstrap credentials, or bind the listener.
- The migrations phase rebuilds a Workspace derived index set only when that set is missing or invalid. A completed rebuild records `storage.index-rebuilt` with no blocks on ready storage and does not degrade readiness. A thrown rebuild fails the critical phase.
- After the fixed critical boot phases, the composition root probes the supervised retrieval service without source access. An unavailable child is contained and dependent retrieval requests fail explicitly; it does not create another critical startup phase. Shutdown closes owned retrieval children under the existing process deadline.
- Product request handling and the one-time server owner credential flow belong outside this directory.

## Verification

Run the focused phase-order, lock, policy, Vault, readiness, shutdown, and audit tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
