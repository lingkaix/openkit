# Bootstrap

This directory owns NanoCore process startup and shutdown checks around the data root, policy kernel, Vault, readiness, and boot audit trail.

## Boundaries

- Keep boot phases, phase ordering, the data-root lock, boot policy checks, Vault readiness, shutdown deadlines, and boot audit records here.
- The data-root instance lock uses `flock` on an open descriptor for the existing `server/runtime` directory. Node keeps that descriptor until release; the kernel releases it on process death. Keep the directory inode in place while a holder is active. The JSON holder file and heartbeat remain diagnostic and the file is removed on orderly release. Source deployments need the util-linux-compatible `flock` utility that the App image already provides.
- `../index.ts` composes the process lifecycle and starts the server after required phases succeed.
- Preserve each phase's critical or non-critical failure semantics and fail closed before unsafe mutation or network exposure.
- Server-authority SQLite integrity failure stays critical: do not replace the database, initialize local identity, issue bootstrap credentials or bind the listener. Workspace authority failure instead records a process-local quarantine in `readiness.ts`; storage opens and recovery consumers share that admission result. Keep the original bytes in place and serve healthy siblings. User-private failure blocks only its dependents. Local boot provisions the Personal Workspace only while its existing scope admission permits it; a quarantined Personal Workspace retains its diagnosis and bytes without preventing healthy scopes from serving.
- The migrations phase rebuilds a Workspace derived index set only when that set is missing or invalid. A completed rebuild records `storage.index-rebuilt` with no blocks on ready storage and does not degrade readiness. An isolated rebuild failure records scoped index unavailability without refusing healthy authority. File-backed authority validates before any rebuild or recovery mutation.
- After the fixed critical boot phases, the composition root probes the supervised retrieval service without source access. An unavailable child is contained and dependent retrieval requests fail explicitly; it does not create another critical startup phase. Shutdown closes owned retrieval children under the existing process deadline.
- Product request handling and the one-time server owner credential flow belong outside this directory.

## Verification

Run the focused phase-order, lock, policy, Vault, readiness, shutdown, and audit tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).

All three boot lifecycle Audit publishers emit the shared retained SQL v1 marker for their native phase/readiness JSON. There is no product boot-Audit payload reader; inspection tests read raw SQLite rows. No historical reader or replay mechanism is added for this writer-only boundary. General Audit projection remains with its existing owner.
