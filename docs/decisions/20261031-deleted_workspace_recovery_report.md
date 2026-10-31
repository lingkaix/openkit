---
status: Accepted
date: "2026-10-31"
decider: Coordinator under engineer delegation
---
# Original-Identity Deleted Workspace Recovery Report

## Decision

The [Workspace sharing owner](../specs/20260715-multi_user_workspace_system.md) and [snapshot owner](../specs/20260704-workspace_backup_export_import.md#deleted-workspace-recovery) require original-identity recovery through the existing operational backup and target-admission owners. The pre-release portability decision makes outward export independent of recovery and removes recovery-by-remint.

Return `WorkspaceSnapshotReport` directly from `workspace.deleted-recover`. Use `command=restore`, the original Workspace identity, the resulting registry revision and the original admission selection. Keep exact deletion, immutable closure and backup lineage in their retained owners. Do not add a wrapper, report family or lineage fields to unrelated snapshot reports. Omit the full capture projection because an ordinary recovering owner need not own every private Thread.

`restored/none` requires both the original deleted-row reactivation and serving activation. A sealed unfinished original admission may report `pending/finish`; the same caller operation and request identity continue it under current recovery authority. This creates no administrator authority, queue, automatic retry or replacement request. An unproved candidate retains inspection/refusal instead of a promise of finishability.

## Reason

The accepted pre-release discontinuity does not carry forward the former export-backed deletion closure. Those analytical bytes are not an operational backup and must not be relabeled or accepted as recovery authority.

The final deletion cut remains fenced through native close, registry deletion and cleanup. That exact backup preserves the final safety state, without implicit lost-safety consent. Restore interrupts captured in-flight work and preserves unknown effects through existing recovery; it never reconstructs live bindings or replays effects.

## Rejected Alternatives

An import-shaped result contradicts original identity. A larger wrapper repeats retained lineage without granting proof. Extending every snapshot report spreads a single operation's correlation fields. None is required. The accepted consultant scrutiny is recorded in the change evidence; this record owns the rationale while the linked specifications own behavior.

## Revisit When

Revisit only if the accepted snapshot report cannot express a required recovery observation, or an accepted authority change changes original-owner recovery. Do not expand this boundary to ordinary import.

## Affected Owners

- [Workspace Sharing](../specs/20260715-multi_user_workspace_system.md).
- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md).
