---
status: Accepted
date: "2026-11-26"
decider: Engineer
---
# Bound Runaway Work Evidence At Collection

## Decision

Bound runaway evidence at the Turn's observation owner during collection. A cutoff can omit new evidence when keeping it would exceed the Turn's allowance. Record that omission explicitly, including what is known and the unobserved tail. Preserve existing work results and physical release proof.

Use a separate aggregate evidence allowance for each Workspace and for Server work. Refuse new growth visibly before contact when the scope reaches its allowance. Keep authorized reads, interrupts, terminal writes and cleanup available. The Pending Request completion body keeps its current path.

## Reason

A runaway agent can produce more evidence than one Turn can keep safely. When it does so repeatedly, storing larger terminal records would still consume the server's resources and could exhaust storage.

## Rejected Alternatives

- Raise the reap row limit as the release exit. It leaves runaway collection and repeated growth unbounded.
- Drop evidence without an omission record. It makes an incomplete prefix appear complete.

## Revisit When

Measured healthy work regularly reaches the collection bound, or existing physical admission fails to keep space for the cutoff and terminal work.

## Affected Owners

- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md#turn-collection-cutoff)
- [Worker Control Protocol](../specs/20260703-worker_control_protocol.md#observation-cutoff-on-the-worker-channel)
