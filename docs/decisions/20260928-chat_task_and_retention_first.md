---
status: Accepted
date: "2026-09-28"
decider: Engineer
---
# Chat And Task Experience And Retention Stability First

## Decision

The immediate priority is rapid validation, repair, and improvement of Chat Mode and Task Mode toward excellent user experience, together with full stabilization of the retained format of system-operation data. After the underlying capabilities and components mature, Goal Mode will be redesigned and developed as an Agent-driven composition that uses, orchestrates, and schedules them. The engineer explicitly requested recording this execution direction in the roadmap. Goal development remains frozen until that later design is activated.

## Reason

The engineer's direction, translated from Chinese on 2026-09-28, prioritizes dependable everyday interactions and stable retained data before autonomous orchestration of the system as a whole. Component maturity should inform Goal's eventual product design rather than premature Goal structures constraining that work.

## Rejected Alternatives

- Continue Goal development as an immediate parallel priority: inconsistent with the explicit freeze and maturity sequence.
- Follow the earlier first-release deadline and broad batch order as the current priority: superseded by the Chat / Task and retention focus.
- Treat this priority decision as proof of experience quality or data-format stability: those outcomes still require direct evidence.

## Revisit When

The engineer reviews Chat and Task experience and retained-data evidence, judges the supporting components sufficiently mature, and explicitly activates Goal Redesign or changes the priority.

## Affected Owners

- docs/roadmap.md owns the execution priority and capability inventory.
- docs/specs/20260704-chat_mode_assistant.md and docs/specs/20260704-task_mode_worker_delegation.md continue to own mode behavior.
- docs/specs/20260921-work_data_retention_format.md continues to own retained work data.
- docs/specs/20260704-goal_mode_coordination.md retains its development freeze pending Redesign.
