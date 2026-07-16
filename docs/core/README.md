# Core

Status: Accepted

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
- `docs/deployment.md` contains deployment placement, release artifact, container, remote, and managed runtime doctrine. It is deployment guidance that must preserve Core semantics, not a core aspect owner.
- `docs/product-vision.md` contains product-level mission, positioning, audience, and high-level product direction. Module-level principles belong in the relevant core aspect document.
- `docs/specs/` contains implementation-facing decisions, adapter-specific contracts, migration plans, unresolved trade-offs, and future work that must not appear as core doctrine until promoted.
- `docs/app-api.md` contains app-specific endpoints, UI read models, diagnostics, settings, quick chat, and gateway APIs.
- `temp/research/` contains temporary external research evidence packages that are not committed. Durable findings must be promoted into specs, core docs, change records, or other canonical project documents with stable source citations.
- `docs/changes/` contains material change lifecycle records and closeout summaries.

## Canonical Definition Rules

Every core concept must have exactly one canonical definition.

By default, `core-concepts.md` owns shared top-level definitions and naming rules. Aspect documents may own specialized terms inside their aspect, but they must not redefine a term already owned by another core document.

Other documents may project a canonical term into their own aspect. For example, `protocol.md` may describe how `Turn` appears in the protocol, `storage.md` may describe how turn records are persisted, and `work-model.md` may describe how users understand turns. None of those projections should redefine what `Turn` is.

When content repeats a definition already owned elsewhere, replace the repeated definition with a cross-reference and explain only the aspect-specific projection.

Specs that introduce durable concepts must include a core-alignment explanation: which core documents they follow, which canonical terms they use, whether they add a candidate concept, and whether a core document must be updated when the spec is accepted.

Core documents must not depend downward on specs. Specs may cite core documents as stable doctrine, but core documents must not cite specs as authority, implementation detail, related reading, or deferred ownership.

Core documents must not contain unresolved questions. If a candidate decision is not stable enough for core, keep it in the owning spec, change record, roadmap, or working log until it is ready to promote.

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
- `agent-session.md` — runtime continuity, agent sessions, snapshots, resume, fork, and recovery.
- `agent-workflow.md` — Core workflow mechanisms, workflow modes and recipes, default setup, bounded steps, gates, evidence, and graph boundaries.
- `protocol.md` — core protocol semantics.
- `communication.md` — commands, events, streaming, and transport projections.

### Resources And Agent Supply

- `storage.md` — file-system-first storage layout, SQLite roles, indexes, and workspace data partitioning.
- `identity.md` — users, workspace membership, auth sessions, tokens, invitations, automations, integrations, and stable actor references.
- `vault.md` — secret vault references, grants, injection boundaries, and secret handling constraints.
- `knowledge.md` — workspace knowledge, source references, proposals, review, and context injection.
- `agent-supply.md` — agent catalogs, setup contracts, profiles, readiness, capability summaries, and supply model.

### Capability, Governance, And Control

- `agent-capability.md` — runtime capability supply, gateway projection, transformer, vault injection, usage, audit metadata, and rate-limit boundary for worker agents.
- `permissions.md` — authorization, policy, roles, attributes, grants, and enforcement.
- `sandbox.md` — execution isolation, runtime environments, containment, snapshots, and resource boundaries.
- `audit.md` — stable audit projections over items, permission decisions, capability calls, vault use, and runtime events.
- `metering.md` — system-wide measurement principles, current non-gateway usage categories, aggregation boundaries, and future budget and cost direction.

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
| Agent, Runtime, turn assignment, runtime lifecycle | `runtime-model.md` |
| Protocol records, commands, event envelope, item delta kinds, error shape, lifecycle enums | `protocol.md` |
| Client/Core communication, Core/agent communication, transport projections, communication planes | `communication.md` |
| Storage, file-system-first source of truth, SQLite companion store, item log persistence | `storage.md` |
| User, WorkspaceMember, AuthSession, Token, Invitation, AutomationIdentity, IntegrationIdentity, ActorRef | `identity.md` |
| SecretVault, VaultReference, VaultGrant, VaultInjection, VaultAudit | `vault.md` |
| Knowledge Store, Knowledge Page, Knowledge Source, Knowledge Proposal, Knowledge Review, Knowledge Manager, Notebook, Agent-Near Context, Context Package | `knowledge.md` |
| AgentProfile, AgentCatalog, AgentCatalogEntry, AgentSetupContract, catalog readiness, setup materialization | `agent-supply.md` |
| Permission, Subject, Action, Resource, Context, PermissionDecision, enforcement point | `permissions.md` |
| Sandbox, sandbox scope, isolation area, sandbox summary, backend containment | `sandbox.md` |
| AgentCapability, CapabilityCall, gateway projection, gateway routing, transformer pipeline, capability traffic, rate limits | `agent-capability.md` |
| AuditEvent, audit projection, audit producer boundary | `audit.md` |
| UsageRecord, usage unit, attribution, cost projection | `agent-capability.md` |
| System-wide measurement, non-gateway runtime, storage and network consumption, aggregation and cost direction | `metering.md` |
| AgentSession, continuity, snapshot, resume, fork, clone, rollback, crash recovery | `agent-session.md` |
| Agent Workflow, Workflow Mechanism, Workflow Mode, Workflow Recipe, Default Workflow Setup, Goal Mode, Intent, Objective, Phase, Plan, Planning Phase, Plan Approval, Bounded Step, Workflow Loop, Gate, Human Attention Gate, Review Gate, Decision, Checkpoint, Context Compaction, Stop Condition, Workflow Evidence, Workflow Graph, dependency, attempt, branch, join, lineage | `agent-workflow.md` |
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

Do not promote implementation-specific fields before the abstract model is agreed. Keep adapter-native, provider-native, route-specific, schema-specific, database-specific, and UI-specific details in specs, App API docs, package docs, or implementation docs unless they need a stable core abstraction.

Retire or merge a core document only after its canonical terms, principles, invariants, open points, related specs, and incoming references have been migrated to an explicit surviving owner.

Archived `Superseded`, `Retired`, and `Rejected` specs may preserve history, but they are not active decision logs. New durable decisions should either update the relevant core document or be recorded in a current spec at the root of `docs/specs/`.
