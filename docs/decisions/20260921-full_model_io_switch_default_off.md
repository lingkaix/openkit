---
status: Accepted
date: "2026-09-21"
decider: Engineer
---
# Full Model I/O Is Covered By The Architecture Behind A Default-Off Switch

## Decision

The work-data architecture must be able to hold complete model input and output, behind a user switch resolved at server, Workspace, and task grain that defaults to off. Required metadata is collected independently of the switch. On 2026-09-22 the engineer added that complete admitted content, including runtime-internal children, must actually be collected and retained when capture is enabled; the switch and its default were kept. The Work Data Retention Format specification owns the rule and Core protocol owns when the resolved setting is fixed.

## Reason

The engineer's words, translated from Chinese: "Keeping complete model I/O costs too much to process and store. The architecture and model of the current design must fully consider and cover this case, but this round does not implement it. When it is implemented, give the user a switch so the user decides whether to collect the more complete data set, at the grain of one task, one Workspace, or the whole server." Fine-tuning needs lossless I/O, which is why the architecture must cover it; cost is why it is off by default. The 2026-09-22 clarification made retention of complete admitted content an implementation requirement because metadata and summaries are insufficient for inspection, audit, evaluation, knowledge extraction, and training.

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal, ruling E1. The 2026-09-22 clarification that complete admitted content is retained is in change record 202609220200000001-runtime_child_retention, Intent Epoch 2.

## Rejected Alternatives

- Shipping a first format that cannot later hold full I/O. Rejected by the requirement that the architecture cover it.
- Treating digest-only capture as meeting the fine-tuning need. Rejected for the same reason.
- Freezing digest byte boundaries or leaving every digest slot empty in the first version. These were author derivations beyond the ruling, later narrowed in review.

## Revisit When

When the cost of storing complete I/O changes materially, or when a use requires a different default.

## Affected Owners

- docs/specs/20260921-work_data_retention_format.md
- docs/core/protocol.md
