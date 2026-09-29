---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Pending Requests Have No Default Deadline And Expire Only By Events

## Decision

A pending approval or input request has no default time deadline. It waits until it is answered, granted, denied, or withdrawn by the user, or until an invalidating event occurs.
- **Invalidating events:**
  - Thread closure, archive, or deletion;
  - Workspace deletion;
  - loss of the requester's membership or authority;
  - denial;
  - user withdrawal;
  - agent withdrawal.
- **Agent withdrawal** follows SEP-2848 `tasks/cancel` and is recorded as design only, not implemented, while the draft is unreleased.
- **Release is not invalidation.** AgentSession release does not invalidate a request.
- **Blocking is derived.** A request is blocking when the agent ended its Turn while the request was outstanding and no later Turn has run.
- **Staleness.** It is guarded by re-evaluation at execution, and the request card shows its age, the Turns run since, and recent changes.
- **Accumulation.** It is bounded by a per-Thread count, not by time.

A configurable deadline policy may be added later.

## Reason

The engineer stated in Round 14 on 2026-09-30, translated from Chinese: there is no need for a default; as with approval, a request should have no deadline, at least not by default, and a configuration policy may be added later. The engineer gave the example of a user on holiday while a critical approval waits. A blocking request, where the agent stopped after its Turn without the key answer, should not expire but should wait for the user to return. It may become invalid for other reasons such as Thread closure; if nothing invalidates it, it waits for the user, or for the user to decline or withdraw it. For agent withdrawal, the design aligns with the unreleased MCP specification, but only the design is recorded and nothing is implemented. The engineer had suggested that a non-blocking request might carry an expiry. In Round 15 the engineer accepted the primary's refinement that neither kind expires by time: blocking is derived from Thread state, and staleness is handled by re-evaluation at execution.

## Rejected Alternatives

- **A one-hour or other default expiry**, the previous MCP approval rule, rejected by the holiday example.
- **An expiry for non-blocking requests**, rejected in favor of re-evaluation at execution, which already prevents a stale grant from acting on changed authority.
- **Invalidating on AgentSession release**, rejected because release is an execution event, not a user decision.

## Revisit When

Accumulated pending requests measurably burden users or storage, or the engineer adds a configurable deadline policy.

## Affected Owners

- docs/core/protocol.md
- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20260531-human_attention_intervention_model.md
- docs/specs/20260704-task_mode_worker_delegation.md
