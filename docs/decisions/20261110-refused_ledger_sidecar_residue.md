---
status: Accepted
date: "2026-11-10"
decider: Coordinator under engineer standing authority
---
# Refused Ledger Opens And Disposable Sidecars

## Decision

The delegated coordinator accepted bounded SQLite sidecar residue on 2026-11-10 for a typed refusal of future or unsupported migration history. Refusal precedes DatabaseOwner admission and database writes. The base database, definitions, snapshots and existing committed WAL remain unchanged. A newly created WAL has zero bytes; a derived SHM index may remain. Core Storage owns this exception. Accepted and normal database lifecycles keep their no-WAL/SHM-at-rest requirement.

## Reason

A read-only SQLite inspection can create cache sidecars even though it changes no retained data. An empty new WAL contains no data, and SHM is a rebuildable index. The upgrade rehearsal records this residue and verifies that the newer supported binary's normal open and close leaves none.

## Rejected Alternatives

- Blind sidecar deletion can affect active handles or committed WAL.
- An immutable-URI fallback can miss committed WAL records.
- Opening a writer for cleanup can checkpoint unsupported history and changes read-only admission and unavailable-writer behavior.

## Revisit When

[Refused read-only sidecar cleanup](https://github.com/lingkaix/openkit/issues/709), related to [the physical owner work](https://github.com/lingkaix/openkit/issues/374), is implemented after v0.1.0 with proved ownership and retained-byte preservation.

## Affected Owners

- [Core Storage](../core/storage.md#sqlite-layers)
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md#release-scoped-sqlite-migrations)
- [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md)
