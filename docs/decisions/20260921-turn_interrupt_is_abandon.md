---
status: Accepted
date: "2026-09-21"
decider: Engineer, adopting the author's and a Consultant's opinion
---
# The Turn Interrupt Command Is The Abandon Command

## Decision

The private turn interrupt command gains no steer-or-abandon parameter and no sibling command; it is the abandon command. Pausing and continuing is a new Turn under the existing rule that new input without an active Turn starts a new Turn, not revival of the old Turn's identity. Which terminal state an interrupt produces is decided by the owning specification. Scope note by the writer, 2026-09-24: the ruling concerns stopping a Turn at a user's or product's request; the command's human-gate purpose, which already existed and stops only the worker process while the Product Turn waits on its Gate, was not at issue.

## Reason

The author and a Consultant argued that a steer-or-abandon parameter would conflict with Core's statement that an interrupt is already terminal and with the rule that new input without an active Turn starts a new Turn. The engineer adopted that opinion and approved the resulting document changes.

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal, ruling R38.7.

## Rejected Alternatives

- Adding a steer-or-abandon parameter so that a stopped Turn could be revived after a crash. Rejected.
- A separate cancel command. Rejected.

## Revisit When

If the product comes to require that the same Turn resume automatically after a user stop followed by a crash.

## Affected Owners

- docs/specs/20260703-worker_control_protocol.md
- docs/core/protocol.md
