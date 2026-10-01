---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# Synchronous Caller Own Failure Cancels Its Admission

## Decision

When a synchronous admission caller that runs dispatch receives its own admission's dispatch failure, including a transient preparation failure that background dispatch would retry, NanoCore cancels that admission while it is still queued and returns the original failure to the caller. A request reported to its caller as failed is therefore not dispatched afterwards. Background dispatch keeps a transient preparation failure queued for retry, a failure after the lease keeps its existing lease handling, and a deferred outcome keeps the caller's requested cancellation behavior. The durable scheduler specification owns the rule.

## Reason

On 2026-10-02 the coordinator reported that a synchronous caller's own transient preparation failure was returned to the caller while its admission stayed queued, and recommended cancelling the admission and returning the error. The engineer accepted the recommendation: 「第一个，采取你的建议，取消它，并把错误返回给调用方。」, translated as “For the first, take your suggestion: cancel it and return the error to the caller.”

The recommendation's reasons were these. The caller has been told that the request failed, so a queued admission that background dispatch later starts would run work the caller believes did not happen. The admission insert is not request-idempotent, so a caller that retries after the failure could not safely reuse or replace the still-queued admission and could end up with a refused retry or a second admission for the same intent.

## Rejected Alternatives

- Keep the admission queued and return the error, the prior behavior. The caller's failure and the admission's later dispatch contradict each other.
- Keep the admission queued and return the deferred outcome instead of the error. This hides the failure cause from the caller and still leaves a retry beside a queued admission.

## Revisit When

Coordinator-proposed revisit conditions, not an Engineer ruling: the admission insert becomes request-idempotent, or the synchronous admission API gains an accepted response that tells the caller its request remains queued after a transient failure.

## Affected Owners

- docs/specs/20260703-durable_scheduler_design.md
