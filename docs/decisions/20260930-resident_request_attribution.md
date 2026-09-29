---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Resident Runtime Requests Are Attributed To The Turn Bound When They Arrive

## Decision

A resident runtime cannot receive per-Turn route tokens in its environment. Each AgentSession therefore holds session-local loopback credentials: one for the inference route family and one for the capability route family. They are minted for the binding, reach only the in-Sandbox Integration loopback, and are destroyed when the AgentSession closes. Integration forwards a request under the route token of the Turn currently bound to that AgentSession when the request arrives:
- With no Turn bound, every request is refused, so an idle AgentSession holds no authority.
- At the Turn's terminal barrier, Integration drains that AgentSession's in-flight requests within a bound, aborts the rest, and only then clears the Turn's route tokens.
- Upstream route tokens still rotate every Turn, and the native process never holds them.

A request that background work from an earlier Turn sends after a later Turn binds is attributed to, and authorized as, the later Turn. This replaces the earlier requirement that native work from one Turn can never acquire a later Turn's authority.

## Reason

On 2026-09-30 the engineer chose this option from a structured question, translated from Chinese: the request belongs to the Turn bound when it arrives; leftover background work can obtain only the authority the same agent already holds at that moment; narrowing and revocation take effect immediately; there is no authority between Turns; inference and MCP use separate loopback credentials. The accepted cost is that a late request's usage and effect are recorded on the later Turn. The option the engineer chose stated, translated from Chinese, that it fits "full permission inside the Sandbox" and "not affecting a worker that is working". That reasoning is about not stopping legitimate background work to prove generation isolation; it does not restrict authorized cancellation, revocation, or containment.

The independent Consultant had shown that draining in-flight requests at the barrier cannot fence a timer, background process, or queued retry that fires after the next Turn binds, so the scheme was presented as a relaxation rather than as a fence.

## Rejected Alternatives

- **Proving authority quiescence at every Turn end.** This means stopping background processes, or replacing the AgentSession when quiescence cannot be proved. Rejected because it would interrupt long-running background work such as development servers.
- **Per-request generation tokens inside each runtime.** Rejected because Codex App Server has no per-Turn credential field, and a runtime's own delayed retries would send whichever token is current anyway.
- **A single loopback credential for both route families.** Rejected to keep inference and capability authority separable at the native boundary.
- **A session-wide upstream bearer.** Rejected because upstream tokens must still rotate per Turn.

## Revisit When

- Every supported runtime can tag native requests with the originating native Turn.
- A security review requires usage and effect attribution to the originating Turn.
- A runtime cannot keep background work inside its own AgentSession's compromise domain.

## Affected Owners

- docs/specs/20260629-worker_runtime_communication_model.md
- docs/specs/20260703-worker_control_protocol.md
- docs/specs/20260704-agent_session_continuity.md
