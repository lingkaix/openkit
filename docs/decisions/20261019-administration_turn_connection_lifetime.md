---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Administration Turn Connection Lifetime

## Decision

The [Administration entry owner](../specs/20260704-chat_mode_assistant.md#administration-entry-path) owns the connection-independent lifetime of an admitted Administration Turn. Explicit interruption and the admitted deadline stop execution. Current authorization and publication checks remain binding. Deadline diagnostics distinguish context preparation from ordinary answer production.

## Reason

The engineer confirmed this boundary on 2026-10-19 while investigating Administration setup failures. The submitting connection is a channel, not the durable execution owner. A client timeout must not cancel already admitted work or determine whether a configuration candidate becomes available.

The existing context guard could report a summary-production deadline after ordinary answer inference. That message incorrectly directed diagnosis toward history pressure. The failure must identify the phase that consumed the admitted budget.

## Rejected Alternatives

- Cancelling the Turn when the submitting connection closes makes execution depend on a transport timeout.
- Increasing the default deadline without phase timing would hide a slow model, stalled Tool, or retry problem.
- A new execution store, submission route, or replay runner duplicates existing Turn and command ownership.

## Revisit When

Revisit if the engineer changes Administration interruption, restart recovery, or command lifetime. A default deadline change requires evidence from the admitted operation; it is not part of this connection ruling.
