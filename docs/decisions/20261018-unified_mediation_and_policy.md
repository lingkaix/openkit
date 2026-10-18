---
status: Accepted
date: "2026-10-18"
decider: Engineer
---
# Unified Mediation And Policy

## Decision

The engineer approved one mediation and permission base on 2026-10-18 at 10:37Z, refining the earlier 09:16Z direction. The 10:46Z direction adds lifetime attributes and agent principals. This decision refines the mediation portion of [BWM Support](20261018-bwm_support_and_information_consolidation.md); its information-consolidation decisions remain unchanged.

A point is an operation at a stage, identified as `<operation>@<stage>`. Stages are propose, decide, commit and completed. Extend the existing operation registry to mediated tool dispatch, model requests, context delivery and result ingress. Do not create another point registry. Admission, disclosure, dispatch, ingress, mutation, administration and decision are crossing attributes on operations. Effect class, sensitivity, risk assessment and authorization remain separate.

Observe, advise, gate and transform are the pre-v0.1.0 modes. Transform precedes advice, advice supplies proposal attributes, gates evaluate next, and the mandatory pure synchronous Kernel evaluates last. Only final allow reaches commit obligations. Credential injection is a Core-only post-allow obligation bound to the approved destination, account and action. Later returning content reaches its own ingress and disclosure checks.

Bindings are Policy statements beside permission and envelope/delegation statements, with one revision and existing Policy/Audit ownership. Gate and Kernel evaluations use PermissionDecision; other invocations share existing Audit evidence. Binding write authorizes participant disclosure. Invocation and investigative calls are Kernel-only and accept no bindings, limiting mediation depth to one. A human-approved envelope roots each authority chain.

Agent approvers run in shadow before authorized activation and return allow, deny or escalation to a human. They cannot widen their own authority or satisfy a human-only decision. A binding declares failure behavior: human escalation by default, non-decisive continuation, or error. Outages do not become substantive denials or allows. Reason codes distinguish not_granted, prohibited and require_approval. The existing Pending Request supplies resolution and Core re-evaluates current facts afterward.

Policy changes use policy.write: exact proposed diff, proposer, scope, lifetime, validation, authorized review, durable result and activation revision. Authorized narrowing can apply directly. Delegated widening stays inside its envelope; envelope/delegation widening and agent-approver activation need the owning human. Adding observe or advise can widen disclosure. Workers suggest changes and never grant themselves authority.

Plan approval creates the Goal's delegated domain, administered by its Coordinator. A Task inherits that domain intersected with its Task card resources. The Coordinator fills an inside-domain gap at the reason's Task or Goal container, then Core re-evaluates. Outside-domain widening goes to the human through the Plan/envelope owner. A Coordinator grant is distinct from an agent approver satisfying an approval condition.

Scope and lifetime are separate statement attributes. Lifetime is `{anchor, notAfter?, uses?}` with any container reference, not a duration enum. Anchor closure, a time bound or exhausted uses ends authority. Once means one use, consumed atomically by the allowing decision. No statement outlives its author's authority; a Coordinator statement ends with its Goal domain at the latest. Longer authority requires promotion approved by the domain's human owner.

A subject records its principal kind and identity, actual process and optional on-behalf-of identity. An agent principal has a responsible human and grants that trace to a human-approved domain; it does not inherit that human's rights. Acting for a user intersects the user's rights with the agent's restrictions and retains both identities and credential kind. Decisions preserve principal, actor, responsible human and process separately.

The engineer confirmed the accountability chain at 10:52Z. Creating an agent principal or granting it a domain is an administration operation recording creator and responsible human. An agent creator passes the human at its own chain's end unless a human explicitly assigns one. The chain must be finite and acyclic. At evaluation the Kernel checks that it still ends at a current human authorized over that domain. A broken chain suspends the agent's grants until a human reassigns responsibility; it never supplies inherited human rights. Decisions retain the agent and the human resolved at decision time.

The rc.11 retained-format work includes these shared formats, policy.write review and the I16 pilot. Other row routing, impact simulation, cached/adaptive review and external participant adapters follow later. React, which changes Policy after successful access under the defining authority, remains deferred in [issue #375](https://github.com/lingkaix/openkit/issues/375). This documentation does not implement or activate any of those mechanisms.

## Reason

A separate mediation registry and binding lifecycle would describe the same authority boundary twice. Operation-by-stage identity follows where Core can hold a proposal or content before release. Crossing attributes classify that operation without making a model's risk assessment an authorization grant.

One Policy owner keeps permissions, participant disclosure, delegation and their revisions attributable. Separating commit obligations prevents pre-authorization credential release. Kernel-only participant invocation bounds recursion while preserving current disclosure authority.

Container references and independent bounds describe lifetimes without predicting every container kind. Agent principals preserve agent-native accountability while human-approved domains bound their authority. Goal-domain administration lets a Coordinator resolve a reason once rather than repeat the same grant for every call.

These are approved conclusions informed by repository Policy concepts and the coordinator's Codex review research. They do not copy an external NGAC reference or claim complete NGAC conformance.

## Rejected Alternatives

- Separate P1-P8 or class/instance point identities: they duplicate operation identity and split binding/decision joins.
- Another binding store, record family or permission engine: existing Policy and Audit already own those facts.
- Risk labels as authorization, hook-first terminal allow or completion-order transforms: each can bypass the final Kernel or evaluate the wrong proposal.
- Credential injection before final allow, recursive approvers or approvers changing their own envelope: these expose authority before its governing decision.
- A closed lifetime list or implicit inheritance of a responsible human's rights: neither expresses the accepted container and agent-principal model.
- React before v0.1.0, predictive cached allows or external adapters in the first pilot: these are not needed to freeze the shared base.

## Revisit When

Revisit a boundary if Core cannot hold its crossing before release, or if the first pilot demonstrates a missing authority or evidence contract. Admit react or another provider through its own owner and qualification. Do not infer enforcement inside an unmediated Worker sandbox.

## Affected Owners

[Permissions](../core/permissions.md) owns stable semantics. [Policy Model](../specs/20260629-openkit_policy_model.md) owns the NGAC subset and domain/process alignment. [Policy Enforcement](../specs/20260703-policy_enforcement_mapping.md) owns statements, decisions, approvals and policy.write. [Operation Definition](../specs/20261002-operation_definition.md) owns the shared registry extension. [Unified Interception](../specs/20261018-nanocore_interception_and_information_consolidation.md) owns integration and migration rows. Existing Pending Request, credential, content and runtime owners retain their lifecycles.
