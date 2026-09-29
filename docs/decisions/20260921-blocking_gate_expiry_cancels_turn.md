---
status: Superseded
date: "2026-09-21"
decider: Engineer
superseded-by: docs/decisions/20260930-pending_tool_calls.md
---
# Delayed User Input Is Its Own Design Line

## Decision

User input can arrive long after it was requested, so late input is a design line of its own rather than an isolated guard. Approvals are either blocking, which stop and wait, or non-blocking, which let work continue. A reply is written on the Turn and in the timeline where the user gives it, linked to the request, not back-filled where the request arose. A request that expires or becomes void produces an Item that states the handling and reason, after which the user can no longer act on it. When a blocking gate expires, the Turn ends as cancelled, with the owning workflow withdrawing authorization and the reason on the expiry Item; no fifth terminal state is added. The owner, exact producer, and request lifecycle remain open in the Delayed User Input Draft. Extending the existing Action Center projection rather than adding a second queue owner was the author's adoption of review, not an engineer confirmation.

## Reason

The engineer's observations, translated from Chinese: a Turn may wait on an approval while the user does not respond and keeps working, returning several Turns or even months later; by then "an outdated approval or other message is already outdated information on the product, and late feedback may not have much value." On the terminal state the engineer adopted the recommendation that "when a blocking gate expires the Turn lands in cancelled, without a fifth terminal value," with the concrete reason, such as a task finished another way, an abandoned Goal, or a timeout, written in the expiry Item rather than in the status.

Source: the 2026-09-21 working session summarized in the Delayed User Input draft specification.

## Rejected Alternatives

- A fifth Turn terminal state for expiry. Rejected by the engineer.
- Back-filling a late reply at the place where the request arose. Rejected in the direction.

## Revisit When

When an owner is admitted for delayed input and the exact expiry producer is designed.

## Affected Owners

- docs/specs/20260921-delayed_user_input.md
- docs/core/protocol.md
