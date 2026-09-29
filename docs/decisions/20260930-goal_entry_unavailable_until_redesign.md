---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Goal Mode Entry Is Unavailable Until The Goal Redesign

## Decision

The agent communication redesign does not carry Goal Mode onto the new mechanisms. Goal problems are left to the Goal redesign. For the duration of that gap, where the removed mechanisms would leave a Goal path incoherent, the minimal honest handling applies: Goal Mode entry returns an explicit unavailable result, and so does each Goal operation that reaches a removed mechanism. The Goal specification amendment names those operations from the code. Existing Goal data stays readable through the Goal read operations. This follows the Goal development freeze: it neither accepts nor deletes the frozen Goal implementation, and it does not migrate Goal onto the new lifecycle.

## Reason

The engineer's ruling on Round 16, question 4, translated from Chinese: "We will solve the problems in Goal Mode later; after that we will redesign the whole Goal Mode." The unavailable entry and readable data were the handling the primary recommended in that question, and the engineer did not contest it when accepting the plan's order.

Agent analysis: the Goal code reads the Turn-level human gate and the `awaiting_human` state and runs on the adapter paths this redesign replaces. Leaving entry open would run Goal work on removed mechanisms, and making it work would require either rebuilding the old gate stop on the new adapters or migrating Goal, which would break the freeze.

Source: the 2026-09-30 working session recorded in the agent communication redesign change record.

## Rejected Alternatives

- **Rebuild the old gate stop on the new adapters for Goal.** Rejected because it keeps a removed mechanism alive for one mode.
- **Migrate Goal onto pending tool calls and resident AgentSessions now.** Rejected because it would settle Goal structures before the redesign, against the freeze.
- **Delete the Goal implementation.** Not requested; the freeze preserves it.

## Revisit When

The engineer activates the Goal redesign.

## Affected Owners

- docs/specs/20260704-goal_mode_coordination.md
- docs/specs/20260704-workflow_coordinator_internal_agent.md
- docs/specs/20260704-task_mode_worker_delegation.md
