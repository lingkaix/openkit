---
status: Accepted
date: "2026-10-15"
decider: Coordinator and Consultant under engineer delegation
---
# Identifier Association And Import Boundaries

## Decision

P14 D2 uses once-only independent Turn allocation only where the existing durable association preserves exact identity through crash, restart and partial effects. A complete association reuses its Turn. Missing association after effects remains `recovery_required`; it does not permit a new Turn or automatic repair. No unspecified alternative UUIDv5 tuple, new timestamp field or closeout registry is accepted.

D6 requires a per-family import examination. An existing owned derivation remains derived. Independent UUIDv7 is permitted only where the accepted import owner admits independent allocation. Absence of a retry promise does not override an owned derivation. Exact remint closure and request reuse retain their existing meaning; no durable import ledger or new request-replay guarantee is added. D1's allocating-owner authority condition also applies to derived import families.

## Reason

Source: P14/coordinator-decisions.md and the adopted independent Consultant conditions in P14/consultant.md, dated 2026-10-15 in the coordinator's backlog-20261015 working record. The coordinator chose conditional D2 Option A and per-family D6. The Consultant agreed with the proof and authority conditions above under the engineer's delegated acceptance. P14/d2-probe.md and P14/import-lifecycle-probe.md supply source and extracted-SQL evidence; they supply no design authority and are not product crash/restart acceptance.

The D2 probe identifies existing publication, delivery and invalidation associations and two file/SQLite partial-publication windows. It defeats an allocator-only claim of crash-safe recovery. Existing partial effects must remain visible and fail closed. The D6 probe identifies an invocation-local staged snapshot and explicit file/SQLite crash gap. A regenerated map cannot prove that an interrupted import completed. Exact complete names remain the allocating owner's responsibility and require its accepted derivation authority.

## Rejected Alternatives

- A fresh clock in a deterministic name cannot preserve identity after restart.
- A new closeout tuple without complete immutable authority would invent recovery semantics.
- Reconstructing a missing association would conceal partial effects and could repeat work.
- Blanket UUIDv7 import reminting would discard accepted deterministic derivations.
- Treating staging, digest equality or a regenerated map as import success would invent cross-store atomicity or request-replay authority.

## Revisit When

Revisit if existing association cannot prove the admitted Turn, or an import family's derivation authority cannot be established. Any required new durable field, registry, cross-store transaction or governing derivation needs separate acceptance. Product crash-window regressions remain required before dependent implementation acceptance.

## Affected Owners

- [Pending Requests](../specs/20260930-pending_requests.md)
- [Workspace Backup, Export And Import](../specs/20260704-workspace_backup_export_import.md)
- [Core Protocol](../core/protocol.md)
