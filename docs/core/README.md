---
status: Accepted
---
# Core

This folder holds the stable OpenKit core model and the governance rules for promoting durable system concepts.

Core documents define the product-independent semantics that should remain stable when implementation modules, package layout, storage details, UI projections, deployment shapes, or runtime adapters change.

The goal is to keep promoted concepts, aspect principles, contracts, lifecycle vocabulary, ownership boundaries, and conformance expectations coherent without mixing core doctrine with implementation plans, lower-level specs, or unresolved questions.

## Core Document Definition

A core document owns one durable aspect of the OpenKit model.

Each aspect document should define:

- the problem area and purpose of the aspect
- the aspect-level principles that guide design decisions
- the canonical terms owned by the aspect
- what the aspect owns and what it does not own
- boundaries, non-goals, and prohibited responsibility leaks
- invariants that implementations and projections must preserve
- relationships to other core aspects
- which implementation details are only projections
- stable relationships to sibling core aspects

Core documents are not implementation plans. They should not define full database schemas, endpoint inventories, UI component structure, native adapter payloads, launch commands, provider-specific config, or one-off migration steps unless the abstract model needs a stable term for them.

## Document Layers

Use these layers when deciding where content belongs:

- `docs/core/` contains the stable core concepts, models, lifecycle vocabulary, protocol semantics, contract-evolution rules, and architecture boundaries. Once promoted, these docs become canonical for their aspect.
- `docs/deployment.md` is a platform reference containing calibrated deployment judgments and a direct link index to owning documents and executable or operator projections; it owns no deployment doctrine.
- `docs/product-vision.md` contains product-level mission, positioning, audience, and high-level product direction. Module-level principles belong in the relevant core aspect document.
- `docs/specs/` contains implementation-facing decisions, adapter-specific contracts, migration plans, unresolved trade-offs, and future work that must not appear as core doctrine until promoted.
- `docs/app-api.md` is a platform reference containing calibrated App API judgments and direct owner and generated-projection link indexes; concrete endpoints, read models, and gateway APIs remain with their accepted specifications and executable owners.
- `temp/research/` contains temporary external research evidence packages that are not committed. Durable findings must be promoted into specs, core docs, change records, or other canonical project documents with stable source citations.
- `docs/changes/` contains material change lifecycle records and closeout summaries.

## Canonical Definition Rules

Every core concept must have exactly one canonical definition.

By default, `core-concepts.md` owns shared top-level definitions and naming rules. Aspect documents may own specialized terms inside their aspect, but they must not redefine a term already owned by another core document.

Other documents may project a canonical term into their own aspect. For example, `protocol.md` may describe how `Turn` appears in the protocol, `storage.md` may describe how turn records are persisted, and `work-model.md` may describe how users understand turns. None of those projections should redefine what `Turn` is.

When content repeats a definition already owned elsewhere, replace the repeated definition with a cross-reference and explain only the aspect-specific projection.

Specs that introduce durable concepts must include a core-alignment explanation: which core documents they follow, which canonical terms they use, whether they add a candidate concept, and whether a core document must be updated when the spec is accepted.

Core documents must not depend downward on specs. Specs may cite core documents as stable doctrine, but core documents must not cite specs as authority, implementation detail, related reading, or deferred ownership.

Core documents must not contain unresolved questions. If a candidate decision is not stable enough for core, keep it in the owning spec, change record, roadmap, or uncommitted working space until it is ready to promote.

## Aspect File Standard

Each core aspect file should move toward this shape:

```md
# <Aspect> Model

Status: Accepted

This document owns ...

This document does not own ...

## Purpose

## Principles

## Canonical Terms

## Boundaries And Non-Goals

## Invariants

## Relationships To Other Core Aspects

## Abstract Realization Notes

```

The exact headings may vary when a document has a good reason, but the information should be present.

## Requirement Keywords

Core documents use RFC 2119 style keywords when a sentence expresses a stable requirement.

`MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, and `MAY` have their ordinary normative meanings.

Descriptive text can explain intent, but stable protocol, model, ownership, and boundary constraints should use these keywords when they are required for conformance.

## Required Core Aspect Set

The current required core aspect set contains 20 documents. Future merge or retirement work should first migrate canonical definitions, update cross-references, and update this inventory.

### Foundation

- `foundation.md` — cross-aspect doctrine, human final authority, execution accountability, durable product truth, governed projections, source-traceable learning, and explicit trust boundaries.
- `core-concepts.md` — shared vocabulary and object boundaries.
- `work-model.md` — user-facing work model.
- `architecture.md` — stable system architecture and layer boundaries.

### Execution And Communication

- `runtime-model.md` — agent execution model.
- `agent-session.md` — AgentSession identity, hidden continuity, exact reconnect, and replacement.
- `agent-workflow.md` — Core workflow mechanisms, workflow modes and recipes, default setup, bounded steps, gates, evidence, and graph boundaries.
- `protocol.md` — core protocol semantics.
- `communication.md` — commands, events, streaming, and transport projections.

### Resources And Agent Supply

- `storage.md` — file-system-first storage layout, SQLite roles, indexes, and workspace data partitioning.
- `identity.md` — users, workspace membership, auth sessions, tokens, invitations, automations, integrations, and stable actor references.
- `vault.md` — secret vault references, grants, injection boundaries, and secret handling constraints.
- `knowledge.md` — workspace knowledge, source references, proposals, review, and context injection.
- `agent-supply.md` — agent catalogs, Agent Manifests, profiles, readiness, capability summaries, and supply model.

### Capability, Governance, And Control

- `agent-capability.md` — runtime capability supply, gateway projection, transformer, vault injection, usage, audit metadata, and rate-limit boundary for worker agents.
- `permissions.md` — authorization, policy, roles, attributes, grants, and enforcement.
- `sandbox.md` — execution isolation, runtime environments, containment, and resource boundaries.
- `audit.md` — stable audit projections over items, permission decisions, capability calls, vault use, and runtime events.
- `metering.md` — system-wide measurement principles, attribution, aggregation, and cost projection boundaries.

### Evolution And Compliance

- `contract-evolution.md` — stability classes, stabilization mechanisms, breaking-change discipline, conformance dimensions, and fixture expectations.

## Canonical Term Index

This index routes readers to the owner of each canonical term family. The owner document defines the term; other documents should cross-reference or project it.

| Term family | Canonical owner |
| --- | --- |
| Human final authority, execution accountability, durable product truth, governed projection, source-traceable learning, explicit trust boundary | `foundation.md` |
| CoreServer, Workspace, Thread, Turn, Item, Artifact, ApprovalRequest, Channel, TriggerSource | `core-concepts.md` |
| Product-facing task, chat mode, quick reply, task mode, goal mode projection, plan mode projection, Action Center projection, human attention projection, steering, review, redo, refinement, handoff projection, context compact projection, deliverable projection | `work-model.md` |
| App, Core, Agent layer boundary, Agent Adapter, workspace service, generative kernel, Internal Core Role, Core Assistant, Workflow Coordinator, Task Evaluator | `architecture.md` |
| Agent, Runtime, turn assignment, execution-substrate lifecycle | `runtime-model.md` |
| Protocol records, commands, event envelope, item delta kinds, error shape, lifecycle enums | `protocol.md` |
| Client/Core communication, Core/agent communication, transport projections, communication planes | `communication.md` |
| Storage, file-system-first source of truth, SQLite companion store, item log persistence | `storage.md` |
| User, WorkspaceMember, AuthSession, Token, Invitation, AutomationIdentity, IntegrationIdentity, ActorRef | `identity.md` |
| SecretVault, VaultReference, VaultGrant, VaultInjection, VaultInjectionPlan, VaultInjectionReceipt, VaultUse, future VaultAudit | `vault.md` |
| Knowledge Store, Knowledge Page, Knowledge Source, Knowledge Proposal, Knowledge Review, Knowledge Manager, Notebook, Agent-Near Context, Context Package | `knowledge.md` |
| AgentManifest, AgentProfile, AgentCatalog, AgentCatalogEntry, catalog readiness, setup materialization | `agent-supply.md` |
| Permission, Subject, Action, Resource, Context, PermissionDecision, enforcement point | `permissions.md` |
| Sandbox, sandbox scope, isolation area, sandbox summary, backend containment | `sandbox.md` |
| AgentCapability, CapabilityCall, gateway projection, gateway routing, transformer pipeline, capability traffic, rate limits | `agent-capability.md` |
| AuditEvent, audit projection, audit producer boundary | `audit.md` |
| UsageRecord, capability-call usage units and attribution | `agent-capability.md` |
| System-wide measurement policy, non-gateway runtime, storage and network consumption, cross-producer aggregation, Cost projection | `metering.md` |
| AgentSession, continuity, exact reconnect, interruption, fresh-session fallback | `agent-session.md` |
| Agent Workflow, Workflow Mechanism, Workflow Mode, Workflow Recipe, Default Workflow Setup, Goal Mode, Intent, Objective, Phase, Plan, Planning Phase, Plan Approval, Bounded Step, Workflow Loop, Gate, Human Attention Gate, Review Gate, Decision, Checkpoint, Context Compaction, Stop Condition, Workflow Evidence | `agent-workflow.md` |
| Stability classes, stabilization mechanisms, contract evolution, strict parsing, conformance dimensions, fixture expectations | `contract-evolution.md` |

## Reading Order

Discuss and promote the core docs in this order:

1. `foundation.md`
2. `core-concepts.md`
3. `work-model.md`
4. `architecture.md`
5. `runtime-model.md`
6. `agent-supply.md`
7. `agent-session.md`
8. `agent-workflow.md`
9. `protocol.md`
10. `communication.md`
11. `storage.md`
12. `identity.md`
13. `vault.md`
14. `agent-capability.md`
15. `permissions.md`
16. `sandbox.md`
17. `knowledge.md`
18. `audit.md`
19. `metering.md`
20. `contract-evolution.md`

## Promotion And Retirement Rules

All core aspect files are accepted as current doctrine for their aspect. Treat each file as authoritative for its aspect at the current design stage.

Promote an idea into `docs/core/` only when the concept is clear enough to become part of the stable model and has an identified aspect owner.

Do not promote implementation-specific fields before the abstract model is agreed. Keep adapter-native, provider-native, route-specific, schema-specific, database-specific, and UI-specific details in accepted specifications, package guides, generated OpenAPI artifacts, or implementation docs unless they need a stable core abstraction.

An engineer-approved decision or accepted surviving authority must authorize a Core retirement before execution. Only an auditor performs the final metadata transition and archive move, after every canonical term, principle, invariant, open point, related specification, and inbound current-guidance link has an explicit disposition.

When historical retention is necessary, the auditor moves the final document under `docs/core/retired/` and produces one non-authorizing audit record in the same change. The audit records the accepted decision, exact source and archive paths, complete authority-criterion receiver inventory, every inbound current-guidance link disposition, and final SHA-256. No archived Core document exists today, so do not create that directory or its validator support until a real retirement requires it.

A retained Core archive uses `status: Retired`, `current-guidance: None`, and `decision-evidence` linking the same-change retirement audit. It includes a substantive `Lifecycle Reason` explaining why its authority ended and how its authority-bearing criteria were disposed, plus a distinct substantive `Retention Reason` naming the historical evidence worth keeping.

The retirement change freezes the archived Core document. It is never edited, renamed, moved again, or deleted; later observations use a new audit record, and renewed authority uses `status: Accepted` in a new active Core document at a different repository-relative path.

Archived `Superseded`, `Retired`, and `Rejected` specs may preserve history, but they are not active decision logs. New durable decisions should either update the relevant core document or be recorded in a current spec at the root of `docs/specs/`.
