---
status: Accepted
date: "2026-10-18"
decider: Engineer
---
# BWM Support And Information Consolidation

## Decision

The engineer approved the BWM support direction on 2026-10-18, including its later refinement to one NanoCore interception mechanism. The [implementation specification](../specs/20261018-nanocore_interception_and_information_consolidation.md) records the contract and migration phases. Implementation of that unified design is **Not Started**; existing specialized mechanisms do not establish completion.

Solidified reusable procedures belong in Skills; other reusable understanding belongs in the owner-scoped OKF Knowledge Base under the Knowledge Manager. Claim becomes an OKF page, without a separate claims ledger. Confidence keeps its numeric 0..1 meaning. Rule, Effect and business Objective pages use Scope Schema types and applicability metadata; a business Objective page is not a work-model Goal.

Light App record data stays in the Generative Kernel: entity state the work tracks, cross-system identifiers, match basis and progress. Reusable domain meaning moves to Knowledge and solidified procedures move to Skills. This does not move application records into the notebook, replace external systems of record or require a Light App for every working model.

Decision Trace is a later derived, read-only view over retained identifier edges, with current permission checks per node and explicit missing links. Missing provenance is added to existing owners before v0.1.0; it is never reconstructed from text, time or model rationale.

Policy is agent-native: a responsible supervising agent may author fine-grained per-agent and per-action policy inside its current delegated envelope. Human-required decisions remain human-required. Risk tiers and confidence are inputs, not grants. Agent approvers run in shadow before explicit Policy activation.

NanoCore owns mediation points, policy-written bindings and observe, advise, gate and transform modes. Participants are replaceable providers, including internal or external agents, decision models, deterministic engines, third parties and humans. Gate and transform need explicit Policy authority; transforms retain safe references to both versions. Execution orders transform, advise, gate, then the final Policy Kernel check. Every invocation has durable evidence in existing owners; timeout and an open circuit mean unavailable, not deny or allow.

## Reason

The engineer's 03:58Z through 04:44Z directions require reusable understanding to have one home while operational records retain their own authority. The later unified-mechanism approval refines the earlier rejection of generic hooks: unify actual NanoCore mediation boundaries without arbitrary plugin execution or another workflow engine. The coordinator confirmed that tracked Light App record data remains in the Kernel and that confidence does not change scale.

Narrow-job participants can independently inspect the system of record and supply useful assessments without being agents or gaining authority from their output. An injectable decision model permits a different implementation; its probability thresholds must be fitted on relevant local traffic before decisive use. No vendor or numerical benchmark is part of this decision.

Existing Policy, Audit, Pending Request, Knowledge, capability and version records already provide the needed owners. Reusing them avoids a new truth store, interception ledger or fabricated cross-domain atomicity. Additive trace links do not require conversion of unknown history.

## Rejected Alternatives

- Separate reusable truth in claims JSONL, schema prose or private instruction stores: this duplicates Knowledge or Skill authority.
- Moving Light App entity records into Knowledge: record state and reusable domain meaning have different owners.
- Treating an assessment, confidence or prior approval as current authorization: only admitted Policy and the exact effect owner decide.
- Arbitrary executable hooks, vendor-specific requirements or a new trace graph store: none is needed for the approved mediation contract.
- Replacing numeric confidence with an ordinal scale or inferring historical provenance: neither is approved.

## Revisit When

Revisit the implementation choice if a real owner boundary cannot retain safe invocation/version references through existing records, or if observed provider behavior defeats an activated binding. Any change to the governing authority or retained meaning requires its own accepted decision.

## Affected Owners

[Architecture](../core/architecture.md), [Permissions](../core/permissions.md), [Knowledge](../core/knowledge.md), [Audit](../core/audit.md), [Generative Apps](../core/generative-apps.md), [Agent Capability](../core/agent-capability.md) and [Agent Supply](../core/agent-supply.md) retain their respective responsibilities. The linked specification owns the detailed consolidation and interception contract.
