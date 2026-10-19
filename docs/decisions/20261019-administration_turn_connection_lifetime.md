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

### Shared Assistant Deadline

The engineer subsequently approved a 600-second current default for the shared Assistant profile, used by Administration and ordinary Assistant admission. Knowledge Manager remains at 300 seconds. Other roles retain their defaults. Explicitly authored limits and both count fuses remain binding.

Read-only retained evidence places about 119.7 seconds of each failed 120.1-second Turn inside model calls. A fresh Thread also fails, with known context capacity and no prior history. Completed calls take 4–83 seconds. Five rounds at the observed maximum take about 413 seconds; 600 seconds leaves about 187 seconds for Tools, publication and variation. This is an operating bound, not a latency guarantee.

Ordinary Assistant uses the same profile and can invoke the Knowledge Manager. A shorter parent default would move the failure to ordinary conversation. The engineer therefore rejected a separate Administration default. No model, retry policy, count fuse, or explicit configured limit changes.

## Rejected Alternatives

- Cancelling the Turn when the submitting connection closes makes execution depend on a transport timeout.
- Increasing the default deadline without phase timing would hide a slow model, stalled Tool, or retry problem.
- A new execution store, submission route, or replay runner duplicates existing Turn and command ownership.

## Revisit When

Revisit if the engineer changes Administration interruption, restart recovery, or command lifetime. Revisit the current deadline default when measured model latency or the required Tool journeys change.

## Affected Owners

- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md#administration-entry-path)
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md#internal-role-execution-profile)
