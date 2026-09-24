---
status: Superseded
superseded-by: docs/decisions/20260924-sensitive_data_handled_outside_the_system.md
date: "2026-09-23"
decider: Engineer
---
# Credential Residual Is Handled At Use Time

## Decision

Work-data capture and retention do not try to remove the residual credential exposure that the retention credential guard documents: its detection does not cover arbitrary encodings or a credential reassembled across separately stored units. Retained data is post-processed for that residual when a concrete use of it is known. The rule and its guard live in the Work Data Retention Format specification.

## Reason

The engineer ruled that the data's future uses cannot be known at capture time, so no treatment chosen now can be fully reasonable: processing in advance may be insufficient for one use and damaging for another. An independent Auditor had found that accepting this residual in lossless, long-lived data meant for evaluation and training reuse is a strict-risk acceptance that the engineer had not delegated, which is why it needed this ruling.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-001.

## Rejected Alternatives

- Treating the residual at capture or retention time, whether by a stronger guard or by dropping or redacting suspect content. Rejected by the ruling for the reason above: without a known use, advance processing may be insufficient for one use and damaging for another.

## Revisit When

Before any export, training use, external disclosure, or sharing across audiences of retained work data; and whenever a concrete post-processing step is designed.

## Affected Owners

- docs/specs/20260921-work_data_retention_format.md
- docs/specs/20260704-workspace_backup_export_import.md
