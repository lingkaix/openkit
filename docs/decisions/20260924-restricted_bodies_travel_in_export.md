---
status: Accepted
date: "2026-09-24"
decider: Engineer, on the writer's recommendation
---
# Restricted Original Bodies Travel Intact In A Portable Export

## Decision

A portable Workspace export keeps its information as complete as possible, so that a re-imported Workspace keeps what it was exported with. It carries the admitted original bodies of retained work data, including restricted originals such as full model request and response bodies and original tool output, intact, instead of replacing them with expired, reference-free records. Import accepts and restores them intact. Two exclusions stay: other users' private Threads and their content, and system-managed Vault, provider, and runtime secret material. Export does not widen who may read a body: it is collected under the exporting actor's current Thread audience. Content that is on hold, unavailable, or already expired keeps its existing handling, and an imported body keeps its retention class, sensitivity classification, hold state, and original expiry, with no fresh retention window. This is the only exception to the rule that product APIs do not expose raw restricted evidence.

## Reason

The engineer ruled that work-data export does only necessary processing and exports completely, that the most original and complete data is kept for later use, and that processing sensitive information before a particular use is outside the system. An independent review then found that the export owner and implementation still turned restricted original bodies into placeholders, so a conforming export dropped the content the rulings meant to keep. The engineer accepted the writer's recommendation on 2026-09-24 that these bodies travel intact. The engineer added, summarized from Chinese, that export must also consider whether the information stays complete when it is imported again, so everything exported should be kept as complete as possible.

Source: change record 202609231611190001-engineering_governance_landing, finding GOVLAND-FND-015, and the engineer's answer of 2026-09-24 to the landing's report.

## Rejected Alternatives

- Keeping restricted originals out of portable export and narrowing the complete-export statement. Rejected because it loses the original content the rulings keep for later use.

## Revisit When

The system itself starts serving a use beyond internal team use, or a portable export is expected to leave the team.

## Affected Owners

- docs/specs/20260704-workspace_backup_export_import.md
- docs/specs/20260921-work_data_retention_format.md
- docs/specs/20260703-audit_usage_evidence_records.md
