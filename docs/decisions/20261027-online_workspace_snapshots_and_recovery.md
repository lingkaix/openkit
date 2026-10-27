---
status: Accepted
date: "2026-10-27"
decider: Engineer; Coordinator for D1-D4
---
# Online Workspace Snapshots And Scoped Recovery

## Decision

The engineer selected backup, restore and MOVE for OpenKit-to-OpenKit preservation. Export serves external consumers. Ordinary portable import and its engine are removed completely. Deleted recovery uses the same scoped operational restore, not analytical import. Knowledge Package and Light App interchange remain separate.

The engineer selected nonwaiting freeze semantics. Running Turns, workers and other unresolved writers block capture, Workspace archive, deletion, restore and MOVE. The operation refuses with a structured authorized blocker list. It neither waits nor interrupts. One quick-action surface offers existing operations; their invocation rechecks current authority and revisions. A stop acknowledgement is not proof of cleanup.

One snapshot owner reuses existing capture, bundle verification, restore, MOVE, capture protection and scope admission. Immutable objects are independently retained and reused; mutable files and online SQLite backups share the target fence. Other Workspaces keep running. Whole-server recovery remains offline. No new daemon, queue, retry, configuration surface or distributed acknowledgement protocol is selected.

The coordinator resolved D1-D4 under the accepted no-blocking rule on 2026-10-27. D1 gives no continuity to completed deletion requests whose only recovery bytes are analytical exports; existing unavailable refusal and retention apply. D2 restores the original Workspace identity and reactivates the exact deleted row. D3 adopts the paper's current-work classifications: ambiguity blocks, and a row without a safe executable stop stays inspect-only (#537). D4 selects Workspace archive, one successful idle capture per UTC day and seven retained daily generations. Holds and active readers retain their independent protection.

A crashed AUTOMATIC unsealed capture auto-abandons its own publication right and releases its pins after restart. Manual captures retain explicit inspect/finish/abandon. Restore/MOVE placement and deletion keep target quarantine. MOVE requires an injective resolved account map, including the owner. Local destinations are the release scope; S3 with client-side encryption is deferred to #536.

## Reason

Operational preservation must keep original identity, complete local authority and truthful recovery. An analytical remint engine duplicates this responsibility and cannot supply the operational consistency boundary. Current work cannot be silently stopped to obtain a snapshot. A complete blocker contract lets users resolve existing work through its owner without a second cancellation protocol.

Independent immutable copies provide incrementality without live-source dependencies. The existing SQLite backup primitive supplies consistent database bytes. Page-level increments, WAL shipping and another scheduler have no measured need. The fixed daily retention default bounds ordinary local growth while preserving existing holds and readers.

## Rejected Alternatives

Ordinary re-import and recovery-by-remint are removed. Global live capture exclusion would stop healthy Workspaces. Waiting for quiescence or automatically interrupting current work violates the engineer's freeze direction. A legacy export recovery reader would contradict D1. Distributed target acknowledgement, automatic repair and remote destinations are not introduced.

## Revisit When

Revisit page-level copying only if measured fence residence requires it. Revisit remote destinations and missing executable blocker actions through their named issues. Any later design must preserve scope isolation, exact identity, current authority, complete closure and truthful uncertainty.

## Affected Owners

Implementation is Partial. Shared schemas, uncomposed snapshot definitions and the dormant nonwaiting gate land before backend activation. Each definition becomes callable only with its complete owned handler. Capture, scoped restore/MOVE, deletion recovery and import retirement follow as separate implementation cuts. The existing cold path is not presented as an online implementation.

[Workspace Backup](../specs/20260704-workspace_backup_export_import.md), [Thread Visibility](../specs/20260909-thread_visibility_and_sharing.md#audit-and-portability), [Multi-User Workspace](../specs/20260715-multi_user_workspace_system.md), [Bootstrap Readiness](../specs/20260704-nanocore_bootstrap_readiness.md) and [Storage](../core/storage.md) own the criteria. This decision supersedes the Workspace cold-operation limitation in the [2026-10-19 decision](20261019-workspace_backup_restore_move.md), while preserving the separate offline whole-server boundary.
