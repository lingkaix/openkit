---
status: Accepted
date: "2026-09-28"
decider: Engineer
---
# Goal Development Freeze And Export / Backup Separation

## Decision

The engineer freezes further Goal Mode development pending a complete product Redesign. Goal storage structures, execution flows, and associated export structures will be decided during that Redesign. The planning-authority exception and completedOutcome proposals are deferred, not approved or rejected on their technical merits. Preserve the implementation checkpoint cba4e11a and its known failing regression; this freeze neither accepts that implementation nor requests its removal.

Workspace export serves use outside OpenKit, including analysis, evaluation, audit, and ingestion into other analytical software. Lossless re-import into an OpenKit Workspace is not an export requirement. Workspace and whole-server backup / restore require a separately designed mechanism. The engineer's prospective direction is filesystem backup and synchronization to S3 or compatible storage, with OneDrive or Dropbox as possible alternatives; consistent static SQLite snapshots may accompany file backups. Litestream is a possible future incremental database-backup option, not an adopted dependency or implementation task. Snapshot consistency, retention, encryption, recovery validation, and synchronization semantics remain to be designed.

## Reason

This records the engineer's clarification, translated from Chinese on 2026-09-28. Continuing the pending Goal amendments would prematurely settle structures and workflows that the upcoming product Redesign must reconsider. External analytical export and operational recovery have different purposes; requiring a round trip into OpenKit incorrectly couples them.

## Rejected Alternatives

- Approve the two pending Goal amendments merely to finish the existing change: deferred until Redesign instead.
- Treat analytical export as a lossless Workspace backup: explicitly excluded from the export requirement.
- Implement an S3, cloud-drive, or Litestream integration now: the engineer reserved detailed backup design for later.
- Delete existing import code or weaken failing tests as part of this clarification: no such implementation action was requested.

## Revisit When

The engineer explicitly activates Goal product Redesign or detailed export / backup design. The receiving design must reassess the retained proposals and evidence rather than inherit their acceptance criteria automatically.

## Affected Owners

- docs/specs/20260704-goal_mode_coordination.md
- docs/specs/20260704-workflow_coordinator_internal_agent.md
- docs/specs/20260704-workspace_backup_export_import.md
- docs/specs/20260921-work_data_retention_format.md
