---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Workspace Backup, Restore, And Offline Move

## Decision

Each Workspace must be separately backupable, restorable, and movable between OpenKit deployments. The first stable release, `v0.1.0`, includes local hot backup with verification/sealing, same-deployment restore, and an operator-driven offline move. [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md) owns these operations. The control-store design owns the layout and shared snapshot, garbage-collection protection, staged-open, and quarantine primitives.

2026-10-21 amendment: The [v0.1.0 cold-operation exception](../specs/20260704-workspace_backup_export_import.md#current-product-boundary) applies to offline Workspace backup, same-deployment restore and MOVE, including read-only capture from verified data-root backups and the shared Core recovery-admission family.

Move keeps the Workspace and its historical identities. Source sealing commits its moved-out disposition and lineage in the same local control step. The source then remains read-only while the operator transfers the sealed bundle. The target verifies, places, registers, and activates it, refusing identity collisions. No target acknowledgement or cross-server rollback protocol is added. An explicit administrator reactivation resolves an abandoned move, not an uncertain remote execution result.

The importing administrator selects the owner, defaulting to themself, and may explicitly map source member accounts to target accounts. Unmapped members are dropped and reported. Names and contact addresses supply no identity inference. Imported schedules, external triggers, channel bindings, and executable catalog bindings remain disabled until explicitly enabled under current authority. Vault material must be provided again. Worker volumes are excluded by default.

Operational copy/remint, remote S3-compatible synchronization, optional native-volume continuity, and whole-server hot-backup changes are deferred. Copy, remote synchronization, and native-volume continuity are later additive work whose feasibility the layout must preserve. Their constraints must be documented now. Retained model I/O message blobs and native transcripts belong to the Workspace's immutable content store and are part of the backup closure under the parallel retention amendment. Analytical export remains for use outside OpenKit; it does not become the backup format.

## Reason

Source: the engineer's 2026-10-19 direction to the coordinator, translated from Chinese, followed by the same-day scope instruction and explicit engineer confirmation that this minimal capability ships in `v0.1.0`. A Workspace prepared for a real use case on a development deployment must move to production without reconstructing its history. Preserved identities express movement of that Workspace, rather than creation of a different one.

The earlier [export/backup decision](20260928-goal_freeze_and_export_backup_boundary.md) explicitly deferred detailed recovery design until engineer activation. This direction activates that design. It does not reopen Goal design or merge external analytical export with recovery.

A first estimate included a larger transfer workflow and recommended later delivery. The scoped instruction instead selects minimal pre-release operations. Consistent SQLite snapshots, protected immutable content, staged validation, and scoped quarantine are already necessary for the target layout. Reuse those primitives rather than estimate or implement a separate transfer platform.

Offline handoff has a deliberate operator boundary. Source fencing and target collision refusal prevent ordinary local double activation. They do not provide global discovery or remote revocation of copied files. Reactivation therefore applies only to an abandoned move: the operator establishes target absence or fencing and retires transferable copies. An absent acknowledgement cannot prove target absence. The product must state that limit instead of claiming distributed exclusivity.

## Rejected Alternatives

- Defer every operational capability until after `v0.1.0`: rejected by the scoped instruction; the layout already needs most backup/restore primitives.
- Use analytical export as a lossless recovery bundle: rejected because external consumption and operational recovery have different identity, authority, and consistency requirements.
- Remint on MOVE or silently remint a colliding target: rejected because the operation moves one existing Workspace. A collision must refuse; COPY is a separate later purpose.
- Add cross-server acknowledgement, automatic rollback, or reactivation on timeout: rejected because this release uses operator-driven offline handoff and cannot infer remote effects.
- Infer target accounts or transfer source grants and credentials: rejected because source attribution does not establish target authority.
- Add remote synchronization or generic volume transfer now: deferred to keep the first release local and reuse existing owners.

## Revisit When

Revisit when operational evidence requires remote orchestration, concurrent copies, cross-release conversion, or native-volume continuity. Any later design must preserve sealed snapshot closure, truthful lineage, target authority, and explicit unknown effects. Reconsider whole-server hot backup only through its own complete authority and consistency design.

## Affected Owners

- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md)
- [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md)
- [File Storage And Knowledge Packages](../specs/20261018-file_storage_and_knowledge_packages.md)
- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md)
- [Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md)
