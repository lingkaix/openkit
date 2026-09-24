---
status: Accepted
date: "2026-09-21"
decider: Engineer, with one part selected by an independent reviewer
---
# Turns Have Four Terminal States

## Decision

The complete Turn terminal-state set is completed, interrupted, cancelled, and failed, used directly without a second classification layer. The engineer chose that the schema was right and Core was stale, and vetoed a sealed equivalence layer that would have mapped cancelled into interrupted. Not adding a Turn unknown status was an independent reviewer's selection that the engineer then included in an agreement on Core wording. Which path writes which terminal is decided by each owning specification. Core protocol owns the set.

## Reason

The engineer's choice, as recorded in the discussion, translated from Chinese: adopt option (b), in the form "use TurnStatus values directly, no second layer". The sealed layer was vetoed on the spot; the author recorded that it had no consumers and that its real motive was to avoid admitting that a Core document was stale. Turn unknown was refused because it withdrew an unimplemented increment and the effect axis already had an owner that states uncertainty better.

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal, rulings R35 and R36, with R41.4 and R42 refusing a Turn unknown state.

## Rejected Alternatives

- Option (a): Core right, schema wrong; delete cancelled and map it to interrupted. Rejected.
- A sealed equivalence layer above the Turn status. Vetoed by the engineer.
- An eight-value status set with a sticky unknown. Withdrawn in review.

## Revisit When

Not recorded. AgentSession uncertainty is a separate, undecided axis.

## Affected Owners

- docs/core/protocol.md
- docs/core/agent-session.md
- docs/specs/20260921-work_data_retention_format.md
