---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# Tool-Surface Changes Happen At Turn Boundaries

## Decision

A change to the tools an agent can see (adding, removing, or re-schematizing a tool, or changing its effect or granted authority) takes effect at the next Turn boundary through a new admitted tool snapshot. At a call, the Gateway allows only an implementation-equivalent backend change behind an unchanged admitted contract, and it may always deny or narrow a call immediately under current authorization.

## Reason

In Round 8 the engineer hoped dynamic tool loading would let NanoCore extend, control, or change a worker's tools without interrupting work. In Round 9 the engineer approved the primary's proposal to apply tool changes at Turn boundaries, translated from Chinese: "the suggestion to change tools at Turn boundaries is very good." Agent analysis, approved by the engineer: the audit must show which tools the agent could see, and a list change mid-Turn invalidates prompt caching and the plan the model has already made.

## Rejected Alternatives

- Applying every tool change immediately mid-Turn, rejected for the audit and prompt-caching reasons above.
- Freezing the tool surface for the whole AgentSession, rejected because it would force replacement for every supply change even when the runtime can list tools again at the next Turn.

## Revisit When

A pinned runtime client supports progressive tool discovery with an audit trail of the tools visible at each model request, making mid-Turn changes attributable.

## Affected Owners

- docs/specs/20260629-worker_runtime_communication_model.md
- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20260704-agent_session_continuity.md
