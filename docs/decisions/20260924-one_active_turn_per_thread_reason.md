---
status: Accepted
date: "2026-09-24"
decider: Engineer
supersedes: docs/decisions/20260813-one_turn_in_flight_per_thread.md
---
# A Thread Is One Sequence With One Writer

## Decision

A Thread has at most one current AgentSession and one Turn in flight; parallel work uses parallel Threads, not parallel Turns inside one Thread. This reversed accepted Core, which had admitted parallel Turns in one Thread: under the precedence rule the engineer decided that Core yields. Core Concepts, the runtime model, and Core protocol own the rule.

## Reason

The engineer gave the reason on 2026-09-24, summarized here from Chinese. The rule follows the users' pattern of use and the way the system works: a Thread is one sequence of Turns and Items, and two concurrent writers to one sequence would add unnecessary complexity and could cause defects. When several Threads run in one Sandbox, or when several agent runtimes are later packaged into one Sandbox and use different models for different work, each Thread is a separate piece of work with its own worker; they only share an environment. From that view a Thread keeps at most one active Turn.

Source: the engineer's answer of 2026-09-24 to the landing's report, summarized above and noted in change record 202609231611190001-engineering_governance_landing; the original reversal is in change record 202608130741380001-nanocore_agent_function_model.

## Rejected Alternatives

- Parallel Turns assigned to different agents inside one Thread, as earlier Core stated. Rejected because two writers to one sequence add complexity and risk defects, while parallel work already has parallel Threads.

## Revisit When

Not stated by the engineer. The writer's reading, not a supplied trigger: a product need that parallel Threads sharing one environment cannot serve.

## Affected Owners

- docs/core/core-concepts.md
- docs/core/runtime-model.md
- docs/core/protocol.md
- docs/core/work-model.md
