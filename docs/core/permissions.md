# Permissions Model

Status: Accepted

This document defines OpenKit permission semantics.

This document owns authorization policy concepts, permission evaluation inputs, permission decisions, enforcement-point semantics, and the relationship between permissions and approval gates.

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
- agent
- profile
- agent session
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
- start agent session
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
- agent setup contract
- external service
- sandbox backend

Resources should be scoped by workspace unless explicitly global or shared.

## Context

`Context` contains decision inputs that are not just subject, action, or resource.

Examples:

- current workspace
- user role
- agent identity
- agent session status
- turn status
- approval state
- requested sandbox mode
- time
- network target
- file path pattern
- sensitivity label
- automation source

## Decision

`PermissionDecision` is the result of policy evaluation.

Common decision categories:

```text
allow
deny
require_approval
require_escalation
defer
not_applicable
error
```

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
