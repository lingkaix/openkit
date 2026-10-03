---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on the recorded Goal-cutover findings; no independent analysis is recorded for this entry
---
# Current Goal Records Are Portable

## Decision

The Coordinator decided to retain export of the new Goal records as portable work data and to distinguish them from the retired Goal and steering tables. Import restores no approval authority. [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md) and [Contract Stability Baseline](../specs/20260715-contract_stability_baseline.md) own this distinction, alongside the current records in [Goal](../specs/20261002-goal.md). The Goal implementation status becomes Partial rather than Not Started; that metadata is an implementation observation, not a separate governing decision.

## Reason

The earlier inventory-removal sentences were written for the deleted predecessor tables. The Goal cutover already exports the current Goal records and imports no approval grant. Narrowing those sentences to the retired tables and two steering tables preserves that distinction. The queue records no separate independent Consultant, Researcher, or Reviewer analysis for this decision. It records that no live Goal journey had yet run, which explains the Partial implementation metadata.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Goal portability". Landing commit: 183b58fc384b8f7c5e23ed5d53dfc17b296cf30a, dated 2026-10-03. The queue entry supplies no separate decision date; the date is established by the same-change owner amendment. These are provenance references, not behavioral authority.

## Rejected Alternatives

- Exclude the new Goal records from export. The Coordinator instead retained their export as portable work data; no further reason for rejecting exclusion is recorded.

## Revisit When

None recorded.

## Affected Owners

- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md)
- [Contract Stability Baseline](../specs/20260715-contract_stability_baseline.md)
- [Goal](../specs/20261002-goal.md)
