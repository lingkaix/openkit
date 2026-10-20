---
status: Accepted
date: "2026-10-20"
decider: Engineer
---
# Harness Carriage Uses Its Existing Request Allowance

## Decision

Private Harness poll and result response headers and bodies share the existing monotonic request outage allowance. Do not cancel an admitted command response at a fresh one-second header timer. Caller cancellation, allowance expiry, exact serial progress, immutable request and result replay, and Core's independent operation and uncertain-delivery fences remain unchanged. This change adds no allowance or transported deadline; authenticated operation-deadline propagation remains separate work.

## Reason

Source: the engineer's 2026-10-20 request to fix dropped `session.open` responses. The requested outcome is reliable delivery of an admitted `session.open` response that takes more than one second but remains inside its existing allowance. A short header cutoff can reset a response after Core has committed dispatch and turn an otherwise admissible delivery into an unknown outcome. The real Core H2 regression establishes that path; native execution is outside that regression's effect domain.

## Rejected Alternatives

- Raising the one-second constant retains a second competing allowance and moves the failure threshold instead of composing the existing deadline.
- Increasing the outage or Core result budget changes the accepted bound and is not required.
- Replaying an uncertain open as a new operation, adopting another binding, or weakening serial proof would violate the existing effect fences.

## Revisit When

Revisit when accepted authenticated parent-deadline propagation replaces the local request allowance. That work must narrow remaining time without renewing authority or changing command identity.

## Affected Owners

[Worker Control Protocol: Harness Pull And Result Envelopes](../specs/20260703-worker_control_protocol.md#harness-pull-and-result-envelopes).
