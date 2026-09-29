---
status: Accepted
date: "2026-09-30"
decider: Engineer
supersedes: docs/decisions/20260921-blocking_gate_expiry_cancels_turn.md
---
# Approvals And Input Requests Are Pending Tool Calls Delivered As New Turns

## Decision

Approval-gated tool calls and worker requests for user input use one mechanism, aligned with the unreleased MCP draft SEP-2848:
1. **Capture.** The Gateway captures the call's immutable binding: the tool, the full arguments, and the originating authorization context.
2. **Pending handle.** The call returns a pending handle at once, and the Turn continues without pausing.
3. **Resolution.** The request is resolved out of band by its approver or responsible user.
4. **Execution after approval.** The Gateway re-evaluates the captured call against current authority, credentials, policy, and tool schema, executes it at most once through an atomic claim, and records its disposition: `approved-executed`, `denied-not-executed`, `execution-error`, or `outcome-unknown`. The agent never re-issues the call to claim a grant.
5. **Delivery.** The outcome, or the user's answer, is delivered to the agent as a new Turn on the same Thread. That Turn is queued behind any active Turn. Admission freezes a bounded set of undelivered outcomes into the Turn. An outcome whose native submission is proved is delivered once; one whose submission is unknown is marked delivery-unknown and is never resubmitted automatically.

Every approval uses this one NanoCore mechanism; only the approving actor may vary. A human approves today, and an agent approver for non-sensitive requests is a possible later extension that is not activated. `work_request_input` is the first `openkit-work` tool built on the mechanism.

As a consequence, a direct Task is its Thread and all of its Turns rather than exactly one worker Turn, and worker Turns no longer pause in a human gate.

This replaces the blocking-gate expiry decision of 2026-09-21. There is no blocking gate that pauses a Turn, so no gate expiry cancels one. Two parts of that decision stay in force:
- a reply is written on the Turn and in the timeline where the user gives it, linked to its request, and is not back-filled where the request arose;
- a request that becomes void produces an Item that states the handling and the reason, after which the user can no longer act on it.

## Reason

The engineer's rulings, translated from Chinese:
- **Round 9 (2026-09-29).** SEP-2848's allowance for an agent approver does not conflict with humans approving today, because every operation returns to NanoCore under one mechanism and only the approving actor changes.
- **Round 13 (2026-09-30).** `work_request_input` is accepted as the first implementation, but its design must be reconsidered: the AgentSession lifetime and binding have changed, and a human's answer should no longer attach to the original Turn but should be consistent with the user approval mechanism. The engineer also reminded the primary that asynchronous approval had already been decided to follow the unreleased MCP draft.
- **Round 14.** The user's input can wake the agent again.
- **Round 15.** The engineer agreed that the Gateway executes after approval, noting that the old flow, in which approval required starting a new Task, came from binding AgentSession and Turn lifetimes together, which is unreasonable.

Agent analysis, approved: the approver sees exactly what executes; nothing depends on the model reproducing arguments; at-most-once is enforced by the server.

## Rejected Alternatives

- **The Gate-stop path**, which paused the Turn in `awaiting_human`, interrupted the runtime, closed the AgentSession, and let a later Task claim the grant by re-proposing the call. Rejected as a product of the old lifecycle.
- **Holding a native call open while a human decides**, rejected because it cannot bind an exact effect and ties up a Turn lease for human latency.
- **Ending the Turn as cancelled when a blocking gate expires**, the earlier decision, rejected because the Turn no longer pauses and requests have no default deadline.
- **Native MCP Tasks now**, deferred until a pinned client drives the Tasks extension. The server-side semantics are already aligned, so the later switch changes only the wire.

## Revisit When

SEP-2848 or SEP-2663 is released with different semantics, a pinned runtime client drives the MCP Tasks extension, or an agent approver is activated.

## Affected Owners

- docs/core/protocol.md
- docs/core/communication.md
- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20260703-worker_agent_capability.md
- docs/specs/20260531-human_attention_intervention_model.md
- docs/specs/20260704-task_mode_worker_delegation.md
- docs/specs/20260531-worker_turn_reliability_envelope.md
- docs/specs/20260704-git_write_workflow.md
