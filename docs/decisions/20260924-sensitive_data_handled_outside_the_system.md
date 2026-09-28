---
status: Accepted
date: "2026-09-24"
decider: Engineer
supersedes: docs/decisions/20260923-credential_residual_post_processing.md
---
# Sensitive Data Is Handled Outside The System Before Each Use

## Decision

Work-data capture and retention do not try to remove the residual credential exposure that the retention credential guard documents: its detection does not cover arbitrary encodings or a credential reassembled across separately stored units. The system keeps the most original and complete data for later use. Export and import do only the processing that is strictly necessary for them, and add no filtering for privacy or sensitive information. Processing sensitive information is extra work done before the data is used for a particular purpose, and it is outside the scope of this system. Export is therefore no longer a moment at which the residual decision is revisited.

## Reason

The engineer's reasons, summarized from Chinese. On 2026-09-23 the engineer ruled that the data's future uses cannot be known at capture time, so no treatment chosen then can be fully reasonable: advance processing may be insufficient for one use and damaging for another. On 2026-09-24 the engineer added that the current purpose is internal use by the team, that the most original and complete data should be kept for later use, and that sensitive information should be processed before each use according to that use, which is outside this system's scope; the system handles only what import and export strictly need.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-001, and the engineer's answer of 2026-09-24 to the landing's report.

## Rejected Alternatives

- Treating the residual at capture, retention, or export time, whether by a stronger guard or by dropping or redacting suspect content. Rejected because it loses original content that later uses need and cannot suit every use.

## Revisit When

The system itself starts serving a use outside internal team use, such as publication, external sharing, or training by a third party.

## Affected Owners

- docs/specs/20260921-work_data_retention_format.md
- docs/specs/20260704-workspace_backup_export_import.md
