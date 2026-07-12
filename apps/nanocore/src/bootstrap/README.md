# Bootstrap

This directory owns NanoCore process startup and shutdown checks around the data root, policy kernel, Vault, readiness, and boot audit trail.

## Boundaries

- Keep boot phases, phase ordering, the data-root lock, boot policy checks, Vault readiness, shutdown deadlines, and boot audit records here.
- `../index.ts` composes the process lifecycle and starts the server after required phases succeed.
- Preserve each phase's critical or non-critical failure semantics and fail closed before unsafe mutation or network exposure.
- Product request handling and the one-time server owner credential flow belong outside this directory.

## Verification

Run the focused phase-order, lock, policy, Vault, readiness, shutdown, and audit tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
