---
status: Accepted
date: "2026-09-21"
decider: Engineer
---
# Export Does Simple Necessary Processing And Then Exports Completely

## Decision

Work-data export uses the simplest design: it does only simple, necessary processing and then exports the data completely, without weighing security and privacy beyond that, because exported data is used for the team's internal backup or outside the system and is not expected to be published or reused elsewhere. On 2026-09-24 the engineer confirmed that the ruling covers all work data, and the Work Data Retention Format specification states it. The ruling left two constraints in the backup specification standing: other users' private Threads stay excluded, and portable import still validates required features.

## Reason

The engineer's words, translated from Chinese: "Make the simplest design. Export does only very simple necessary processing and then exports completely. Do not over-consider security and privacy: exported data is not expected to be published or used for other purposes; its use is internal team backup, or use outside the system."

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal, ruling E2.

## Rejected Alternatives

- Rewriting the backup specification's private-Thread exclusion and exact inventory wholesale. Judged excessive in review; only whether observations are blocked by directory membership needed the owner.
- Applying the portable-import required-features gate to cold backup. Judged excessive for cold backup and kept for portable import.

## Revisit When

Inferred: when the system itself starts serving a use beyond internal team use, such as publication, external sharing, or third-party training. Processing of sensitive information before a particular use happens outside the system, as recorded in docs/decisions/20260924-sensitive_data_handled_outside_the_system.md.

## Affected Owners

- docs/specs/20260704-workspace_backup_export_import.md
- docs/specs/20260921-work_data_retention_format.md
