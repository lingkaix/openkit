---
status: Accepted
date: "2026-10-15"
decider: Coordinator and Consultant under engineer delegation
---
# Assistant Inference Request Lineage

## Decision

Each logical inference invocation in the #144 command-initiated selected-Skills family uses a null per-invocation request ID and a fresh ordinary CapabilityCall. The command request remains command lineage, carried separately by trusted context into the existing AuditEvent request field. Turn linkage cannot replace an available audit request ID. Internal Assistant MCP request lineage remains unchanged.

A null request ID supplies no request-key replay protection. The command owner prevents duplicate or uncertain execution before invocation. Exact command replay returns the original result without Provider contact. A closed call never reopens. Original admission evidence preserves resource selection and grants no permission to repeat completed, interrupted or unknown inference effects.

## Reason

Source: the coordinator's 2026-10-15 22:26Z inference-request-lineage entry in later-routing.md and independent Astra Consultant 23019ddf's AGREED WITH CONDITIONS verdict in consultant-144-request-lineage.md, both in the backlog-20261015 working record. The coordinator accepted the bounded clarification with all conditions. Conditions 5 and 6 provide the exact owner text. The verdict accepts owner placement and preserves existing authority; it does not accept a field-only adapter change or implementation.

Successive model rounds are distinct logical invocations. Reusing one command request as each invocation's ledger key collides with a prior closed call. Null permits ordinary call allocation without inventing a synthetic identity, while separately retaining the available command request preserves audit semantics. Per-call usage equivalence cannot prevent another Provider effect under another call. The command receipt, admission and recovery owners must prevent that duplicate effect before the adapter runs.

## Rejected Alternatives

- Omitting an available command request from audit would weaken existing lineage requirements.
- Treating Turn links or environment evidence as a substitute for that audit field would not preserve the available request value.
- Reopening a closed call would merge distinct inference invocations.
- A derived per-round identity would need separate accepted inputs and recovery semantics; P14 does not authorize it.
- A durable round counter, new replay lifecycle or changed ledger key is outside this acceptance.

## Revisit When

Return for separate acceptance before changing the ledger key, adding durable round state or replay semantics, or omitting available audit lineage. Preserve standalone Quick Chat, pending-outcome admission and the held integrated #144 delivery unit. Implementation acceptance still requires distinct terminal calls, correct usage/audit links, unchanged environment evidence and zero extra Provider calls under duplicate or uncertain command execution.

## Affected Owners

- [Core Audit](../core/audit.md)
- [Capability Usage Gateway Foundation](../specs/20260704-capability_usage_gateway_foundation.md)
- [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md)
