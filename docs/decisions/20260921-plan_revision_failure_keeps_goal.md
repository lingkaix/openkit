---
status: Accepted
date: "2026-09-21"
decider: Engineer
---
# A Failed Plan Revision Keeps The Goal Alive

## Decision

When the planner fails during a plan revision, the Goal stays awaiting plan approval with its current plan pointer intact, so the user may still approve the previous plan or issue another revision. A revision request neither clears that pointer nor moves the Goal back to planning, and a revision failure must not take the initial-planning failure path that fails the Goal. The Goal Mode Coordination specification owns the rule.

## Reason

The engineer's words, translated from Chinese: "In this case keep the scene, and let the user decide what to do next. Give the user the chance to continue on this Goal's path." The discussion record adds the asymmetry: when initial planning fails there is no plan to fall back on, so a failed Goal is honest; when a revision fails a usable old plan exists, and failing the Goal would discard recoverable state on the user's behalf.

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal, ruling R46.1.

## Rejected Alternatives

- Failing the Goal on a revision failure, as initial planning does. Rejected by the ruling.

## Revisit When

Not recorded.

## Affected Owners

- docs/specs/20260704-goal_mode_coordination.md
