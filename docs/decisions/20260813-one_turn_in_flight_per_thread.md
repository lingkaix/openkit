---
status: Superseded
superseded-by: docs/decisions/20260924-one_active_turn_per_thread_reason.md
date: "2026-08-13"
decider: Engineer
---
# A Thread Has At Most One Turn In Flight

## Decision

A Thread has at most one current AgentSession and one Turn in flight; parallel work uses parallel Threads, not parallel Turns inside one Thread. This reversed accepted Core, which had admitted parallel Turns in one Thread: under the precedence rule the engineer decided that Core yields. Core Concepts, the runtime model, and Core protocol own the rule.

## Reason

Not recorded. The engineer decided that Core yields and the direction stands, but the design argument was in a temporary proposal deleted during a later cleanup the engineer directed. Ask the engineer before changing this rule, and record the answer in a new record that supersedes this one.

Source: change record 202608130741380001-nanocore_agent_function_model; its originating discussion file was deleted during release cleanup.

## Rejected Alternatives

- Parallel Turns assigned to different agents inside one Thread, as earlier Core stated. Reversed; reason not recorded.

## Revisit When

Not recorded.

## Affected Owners

- docs/core/core-concepts.md
- docs/core/runtime-model.md
- docs/core/protocol.md
- docs/core/work-model.md
