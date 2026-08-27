---
status: Accepted
---
# Permissions Model

This document defines OpenKit permission semantics.

This document owns authorization policy concepts, permission evaluation inputs, permission decisions, enforcement-point semantics, the Assistant disclosure boundary, and the relationship between permissions and approval gates.

This document does not own identity authentication, technical capability declarations, sandbox containment, audit projection shape, App API authorization endpoints, UI permission summaries, vault secret storage, or config-merge policy.

Permission is authorization. It answers whether a subject may perform an action on a resource under current policy and context.

Permission is separate from capability and sandbox.

Identity is authentication and actor identity. Permission consumes identity context but does not define users, auth sessions, tokens, or workspace membership.

## Purpose

OpenKit agents may be able to read files, write files, run commands, access network services, call tools, use credentials, query knowledge, create artifacts, or affect external systems.

The permission model gives Core a stable way to decide whether those actions are allowed.

## Principles

- Permission is separate from identity, capability, sandbox, and audit.
- Authorization decisions should be explainable, immutable, and attributable to a subject, action, resource, context, policy, and enforcement point.
- Approval is a human gate that may satisfy a policy requirement; it is not the entire permission model.
- Multiple layers may enforce the same decision, but Core should remain able to explain the policy result.
- Policy details may evolve, but permission vocabulary should remain stable enough for audit, UI summaries, and agent capability control.
- OpenKit may implement only a subset of NGAC, but every implemented NGAC concept MUST match NGAC definitions, standard terminology, and described semantics. Product adapters MAY expose friendlier names, but Core policy doctrine MUST preserve NGAC as the long-term standard rather than creating a parallel OpenKit-specific authorization model.
- Workspace authorization is deny-by-default and uses current identity, membership, credential, and resource facts on every governed request.

## Boundary

Permission owns policy and authorization decisions.

Capability describes what an actor can technically do.

Sandbox constrains what the runtime can actually reach.

Identity supplies the subject.

Approval is a human decision step that may satisfy or override a permission requirement under policy.

The product UI may display permission summaries, but it should not become the policy engine.

## Concepts

Permission evaluation needs these conceptual parts:

- subject
- action
- resource
- context
- policy
- decision
- enforcement point
- audit record

The policy model decision is settled: OpenKit uses an NGAC-standard-aligned subset model evaluated by the policy kernel. This document stays model-neutral in its concept vocabulary so the conceptual parts above remain stable even if the kernel evolves.

The policy kernel MUST be treated as an NGAC-standard-aligned subset implementation, not a separate OpenKit-designed policy language. Missing NGAC features are acceptable when they are explicitly out of scope, but implemented features MUST NOT redefine NGAC concepts.

## Subject

`Subject` is the actor requesting or causing an action.

Subjects may include:

- user
- workspace member
- deployment administrator
- agent
- profile
- AgentSession
- automation
- runtime mediation service
- external integration

An agent action should usually be evaluated with both the agent identity and the responsible user or automation context.

## Action

`Action` is the operation being requested.

Examples:

- read workspace file
- write workspace file
- delete artifact
- run shell command
- access network endpoint
- call MCP tool
- use vault reference
- read knowledge
- write proposed knowledge
- start AgentSession
- approve escalation

## Resource

`Resource` is what the action affects.

Examples:

- workspace
- thread
- turn
- item
- artifact
- file path
- knowledge entry
- vault reference
- model profile
- `AgentManifest` reference (`docs/core/agent-supply.md`)
- external service
- sandbox backend

Resources should be scoped by workspace unless explicitly global or shared.

## Context

`Context` contains decision inputs that are not just subject, action, or resource.

Examples:

- current workspace
- current membership status and product access level
- token scope and Workspace binding
- agent identity
- AgentSession status
- turn status
- approval state
- requested sandbox mode
- time
- network target
- file path pattern
- sensitivity label
- automation source

## Decision

`PermissionDecision` is the closed product-level result of policy evaluation. Its result is exactly one of:

```text
allow
deny
require_approval
require_escalation
defer
not_applicable
error
```

No other result value is permitted. A decision result combines with other mandatory policy inputs under this deterministic precedence, from strongest to weakest:

```text
error
deny
require_escalation
require_approval
defer
not_applicable
allow
```

Missing mandatory facts or a mandatory evaluation failure produce `error` and fail closed. Before applying the precedence, `not_applicable` inputs are neutral and are omitted when at least one mandatory policy domain applies. The combined result is `not_applicable` only when every input is `not_applicable`; that result blocks the effect because no applicable authority allowed it. The result is `allow` only when every applicable mandatory input is `allow`.

Only a final combined `allow` authorizes the effect. `deny`, `require_approval`, `require_escalation`, `defer`, `not_applicable`, and `error` all block it until an existing owner produces a new authorized evaluation where applicable. The distinct result explains why the effect is blocked; `not_applicable` never grants access.

`PermissionDecision` and its categories define the target bridge between policy evaluation, product workflow, approval, and audit.

A decision should be explainable and auditable.

Typical record areas include:

- permission decision ID
- workspace ID
- subject summary
- action
- resource summary
- context summary
- policy reference
- policy snapshot reference when available
- enforcement point
- decision
- reason code
- approval request ID when required
- timestamp
- request ID when available

Permission decision records should be immutable. A later policy check should create a new decision record rather than rewriting the prior decision.

## Enforcement Points

Permission checks should happen at enforcement points.

Examples:

- centralized Workspace access resolution before a Workspace-addressed handler reads or mutates state
- app API command handler
- Core scheduler
- agent adapter
- agent capability gateway projection
- runtime mediation boundary
- vault access boundary
- filesystem operation boundary
- sandbox startup boundary

The same policy decision may be enforced at multiple layers. Sandbox enforcement is still valuable even when permission policy already denies an action.

## Approval Gates

Approval gates are permission-related but not identical to permission.

The target model is that policy decides an action requires user approval, and after approval Core records which policy requirement the approval satisfied.

Approval strength MUST follow reversibility and blast radius rather than the operation category:

| Effect class | Required decision |
| --- | --- |
| Reversible, low-cost, internally scoped, and unambiguous | One-step commitment that states the exact target and effect, returns the authoritative outcome, and identifies an available correction or undo path. |
| Materially consequential but recoverable | Explicit preview of the exact target and resulting state before commitment. |
| Irreversible, externally visible, credential-bearing, authorization-changing, or cost-material | Distinct explicit confirmation that states what cannot be undone, plus every additional decision required by the owning safety, permission, cost, credential, or external-effect contract. |

Ambiguity about the target or effect raises the required decision by one level. Approval does not bypass current authorization, and an approval that satisfied an earlier evaluation does not authorize a later call after the actor, target, policy, resource, or relevant state changes.

The required decision exists for one proposed effect and terminates when the effect is accepted, rejected, expires, becomes stale, or is replaced. Retry after rejection, expiry, staleness, conflict, restart, or dependency failure requires a new current authorization evaluation and, when still required, a new approval; Core MUST NOT replay the earlier approval as ambient authority.

Conformance is observable when low-consequence reversible effects can complete through the one-step form, materially consequential recoverable effects expose their preview before commitment, and irreversible or authority-changing effects cannot apply without the distinct confirmation and every owner-required additional gate.

## Assistant Disclosure Authorization

`AssistantReadScope` and `OutputAudience` are separate permission decisions for every Assistant answer and every proposed transfer of Assistant-produced material.

`AssistantReadScope` is the exact set of sources and source revisions that the current actor may discover or retrieve for the current request. It is bounded by current identity, Workspace membership, resource visibility, source policy, requested operation, sensitivity, and every other applicable permission input. It grants no write, promotion, publication, notification, worker-context, or external-effect authority.

`OutputAudience` is the exact destination and set of recipients authorized to receive the output. It is resolved independently of the requesting actor's read authority and before output-producing context is assembled. A requester who may read material privately does not thereby authorize that material, its protected metadata, or a derived summary to reach a shared Thread, Artifact, Knowledge record, Worker context, notification, or external destination.

The permission owner is the unique durable authority for both decisions. Assistant role assembly may project the resulting scope and audience into a bounded Turn input, and publication may project the decision into a destination-specific Item or effect, but neither projection may widen the current permission decision or become an authorization cache.

### Evaluation And Publication Lifecycle

For every Assistant request, Core MUST resolve the destination and `OutputAudience` before assembling the output-producing model context. Candidate discovery MUST expose only metadata already eligible for both the current actor and destination. Every concrete source read MUST then create a current authorization evaluation over the actor, source, Workspace, revision, operation, and destination audience before returning material to the model.

Retrieved material MUST retain source identity, provenance, visibility, freshness, and disclosure constraints through context assembly and response generation. Material outside the resolved `OutputAudience` MUST be excluded before generation; post-generation redaction is not the primary confidentiality boundary.

Immediately before a durable or shared output is published, Core MUST reauthorize the destination and material as a defense-in-depth publication guard. The guard may publish the eligible answer, require an explicit typed promotion or sharing decision, redirect the result to an authorized owner-private destination, or fail closed. It MUST NOT silently remove a material restriction and publish the remainder as though the original answer had been authorized.

A Tool's presence means only that the model may request its operation. It is never evidence that the current actor, source, target, audience, or effect is authorized. Every Tool call MUST perform the current owning permission and resource checks, including after approval, warm-provider reuse, retry, or restart. A present Tool whose call is refused returns a product-safe typed refusal reason through its owning Tool result; permission denial MUST NOT be represented by removing that Tool from an otherwise reachable entry path.

Any transfer from an owner-private or otherwise restricted source into a durable or broader audience MUST use an explicit typed promotion that identifies the selected source material, destination, audience, provenance, required confirmation, and authoritative outcome. A generated summary is not declassification, and the actor's authority to read the source is not authority to promote it.

### Conflict, Failure, And Recovery

Missing actor, source, destination, audience, membership, revision, visibility, or mandatory policy facts fail closed. Authorization loss, source deletion, audience change, policy change, or a stale source revision invalidates the affected read or publication decision immediately for later calls.

If the source or destination changes during generation, the publication guard evaluates current truth and refuses, redirects, or requires a new explicit promotion; it never relies on the earlier model-input decision to publish. A dependency failure or indeterminate authorization result produces `error` or the applicable blocking `PermissionDecision`, not a partially authorized answer.

Restart and retry reconstruct `AssistantReadScope` and `OutputAudience` from current durable owners. Cached provider context, cached summaries, prior Tool results, and prior permission or approval records cannot restore access after revocation or supply missing authority. An already published Item follows its own accepted visibility and retention owner; the permission model does not rewrite history to simulate revocation.

Conflicting human requests remain separate attributed requests. Permission evaluates the current actor and state for each request and does not decide which human is socially correct; ordinary command ordering, stale-state rejection, and the owning resource lifecycle decide whether a later authorized command can change current state.

### Acceptance Predicates

- The same request MAY produce a richer answer in an owner-private Thread than in a shared Thread, and the difference is explainable from the resolved scope and audience.
- Material, protected metadata, or a derived summary from a source unavailable to the destination audience MUST NOT enter that audience's model output, Item, Artifact, Knowledge record, Worker context, notification, or external effect.
- Tool presence, an earlier approval, a warm provider context, or a successful prior call MUST NOT bypass current per-call authorization.
- A restricted-to-broader transfer MUST leave one explicit typed promotion outcome with source, destination, audience, provenance, actor, and request lineage.
- Revocation, stale revision, missing policy input, restart, or publication-time conflict MUST fail closed without publishing a success-shaped result.

## Audit

Permission-sensitive actions should leave audit records.

Audit records should preserve:

- subject
- action
- resource
- context summary
- decision
- enforcement point
- approval reference when present
- timestamp
- outcome

Audit records must not leak secret values.

Detailed audit semantics belong to `docs/core/audit.md`.

## Invariants

- Permission MUST NOT be collapsed into capability, sandbox, identity, or approval.
- Implemented policy-kernel concepts MUST remain semantically consistent with NGAC. If product vocabulary needs different names, the mapping belongs in adapters rather than in the kernel concept definitions.
- Permission decisions SHOULD preserve subject, action, resource, context, policy reference, enforcement point, outcome, reason, and request correlation when those fields are available.
- Permission-sensitive actions SHOULD leave audit records or enough metadata for future audit projection.
- Approval records MUST NOT be treated as a complete permission engine unless a policy requirement explicitly links the approval to an authorization decision.
- Product UI summaries MUST NOT become the policy source of truth.
- Workspace product roles MAY be convenient adapter inputs, but their permissions MUST be projected into the policy kernel rather than enforced by a second handler-local role engine.
- Invitation state, filesystem presence, owner-nested paths, and token scope alone MUST NOT grant Workspace access.
- Deployment-administrator authority MUST NOT imply ordinary Workspace content authority; explicit audited recovery changes membership or ownership before normal authorization applies.
- Missing actor, responsible-user, membership, resource, token-binding, or required policy facts MUST fail closed.
- `AssistantReadScope` MUST NOT imply `OutputAudience`, and `OutputAudience` MUST NOT imply source-read authority.
- Assistant source reads and publication MUST be reauthorized at their enforcement points; Tool presence and prior approval MUST NOT be treated as authority.
