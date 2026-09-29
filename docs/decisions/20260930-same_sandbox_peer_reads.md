---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Workers Can Read Their Same-Sandbox Peers

## Decision

A worker can read, and only read, the other AgentSessions in its own Sandbox through two built-in tools, `work_list_peers` and `work_read_peer` on the `openkit-work` server. NanoCore serves a bounded, product-safe projection of its own records, not data from the Sandbox, and the projection never exposes AgentSession identity. Co-residency does not grant access to another Thread's records beyond that projection, and the existing shared-Sandbox admission requirements are unchanged. The tools create no control edge: they cannot dispatch, steer, answer, or cancel. Relatedness is bounded by the Sandbox for now. That bound is an interim simplification, to be replaced when relatedness must cross Sandboxes or depend on permissions. Asking a peer a question is deferred.

## Reason

The engineer accepted the primary's recommendation on Round 14, question 3, translated from Chinese: "I think Q2 and Q3 are fine now; I agree with your suggestion."

Agent analysis, approved: AgentSessions admitted to one Sandbox already share a compatible trust class, which is what motivates same-Sandbox relatedness as the interim boundary; it is not an authorization grant, which is why the view is a bounded projection. Read-only information creates no dispatch or control edge, so delegated work stays a tree. Serving the reads from Core keeps records and attribution outside the Sandbox.

Source: the 2026-09-30 working session recorded in the agent communication redesign change record.

## Rejected Alternatives

- **Peer messaging or asking a peer.** Deferred, because it would add a control edge that the tree does not admit.
- **Reading peer state inside the Sandbox, such as native session files.** Rejected because attribution and retention would live in the compromise domain and depend on each runtime's private format.
- **Relatedness by Thread lineage or permission now.** Deferred until a need crosses Sandboxes.

## Revisit When

Workers must relate across Sandboxes, relatedness must depend on permissions, or a product need for asking a peer appears.

## Affected Owners

- docs/core/communication.md
- docs/specs/20260703-worker_agent_capability.md
- docs/specs/20260704-worker_mcp_tool_supply.md
