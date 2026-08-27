---
status: Accepted
---
# Foundation Model

This document owns the cross-aspect doctrine that every OpenKit design, implementation, deployment, and product projection must preserve.

This document does not own product positioning, target audiences, aspect-specific object definitions, package or service architecture, implementation contracts, storage schemas, API shapes, UI design, or rollout plans.

## Purpose

OpenKit coordinates human and agent work across many runtimes, adapters, stores, and product surfaces. Those parts need one compact foundation that states who has authority, where durable product truth lives, how execution becomes accountable, and which boundaries cannot be weakened by a local implementation choice.

This model supplies those cross-aspect invariants without replacing the specialized Core aspect documents that define their own concepts and lifecycles.

## Principles

- Humans retain final authority over goals, policy, consequential review decisions, and changes to the system's governing doctrine.
- Agents should execute bounded assignments end to end and remain accountable through explicit lineage, outcomes, evidence, and stop reasons.
- Core owns durable product truth. Runtime-native output, provider responses, sandbox state, logs, and adapter payloads remain evidence or implementation state until Core verifies and imports an accepted projection.
- Material work must remain observable, explainable, and reviewable at the level needed for a human or supervising agent to understand state, ownership, risk, and required intervention.
- Apps, channels, skills, CLIs, adapters, indexes, and caches are projections over Core contracts. A projection must not become an independent workflow or authority source.
- Learning and self-improvement must remain source-traceable, reviewable, and reversible. Derived knowledge must not silently replace human intent or accepted product truth.
- Trust, authorization, credential, execution, data-loss, and external-effect boundaries must be explicit. Missing authority or unverifiable lineage fails closed.
- Reliability and assurance should be proportional to the documented deployment scale, consequence, and trust boundary. Safe interruption, inspection, or a new authorized attempt may be the correct outcome when transparent recovery would require another authority or workflow.
- Future scale, availability, and deployment hypotheses are non-authorizing until an accepted current design promotes them.
- Core should coordinate and govern work while specialized agents and runtimes perform heavy execution.
- External dependencies remain outside OpenKit's authority boundary. `docs/core/contract-evolution.md` owns their contract and missing-capability rules.

## Canonical Terms

`Human final authority` means a human can set or revise governing intent, inspect consequential work, decide required review gates, and stop or redirect delegated execution.

`Execution accountability` means every governed execution can be attributed to its initiating intent, actor, assignment, runtime lineage, policy context, outputs, evidence, and terminal outcome.

`Durable product truth` means the Core-owned records that determine current product state after validation, policy enforcement, and accepted lifecycle transitions.

`Governed projection` means a read, interaction, or adapter surface that presents or operates on Core truth without redefining its authority or lifecycle.

`Source-traceable learning` means a derived preference, evaluation, knowledge claim, or improvement proposal retains the evidence, provenance, confidence, review state, and supersession path needed to inspect or reverse it.

`Explicit trust boundary` means a named boundary where identity, authority, data sensitivity, execution freedom, or external effects change and therefore require validation and enforcement.

## Boundaries And Non-Goals

Foundation owns doctrine shared by every Core aspect. Specialized concepts remain owned by their aspect documents even when they realize a Foundation principle.

Foundation does not define which actions require review, how a permission decision is represented, how evidence is stored, which runtime executes a task, how a projection is transported, or how a user interface presents state.

Foundation does not require every action to wait for a human. Automation may proceed within explicit delegated authority, policy, scope, and stop conditions.

Foundation does not make runtime-native state authoritative merely because it is durable inside a provider, sandbox, repository, or external service.

Foundation does not require every accepted operation to recover transparently after process, transport, or runtime failure. A bounded fallback may preserve the authoritative history, expose an `interrupted` or otherwise explicitly uncertain outcome, and require inspection or a new authorized attempt.

Foundation does not promise compatibility with obsolete internal contracts. Contract evolution follows the clean current model.

## Invariants

- Humans MUST retain final authority over governing intent, policy, and required consequential review decisions.
- Delegated execution MUST remain bounded by explicit scope, authority, and stop conditions.
- Governed work MUST preserve sufficient lineage and evidence to attribute its inputs, actor, execution, outputs, and outcome.
- Runtime-native and external-system state MUST NOT become durable product truth until an owning Core boundary validates and imports it.
- Product projections MUST NOT create a second source of workflow, policy, identity, review, or storage truth.
- Consequential state transitions and external effects MUST be observable and explainable through product-safe records.
- Learning and self-improvement outputs MUST retain source provenance and a reviewable supersession or reversal path.
- Every system responsibility, bounded fallback, and accepted compromise MUST have one accepted owner, an explicit scope, and defined failure behavior; a component MUST NOT expand into parallel product, workflow, orchestration, or authority ownership.
- Assurance depth MUST follow the documented risk and deployment profile. Security, authorization, credential, containment, data-loss, and irreversible-effect boundaries MUST remain strict, while ordinary availability and recovery MAY end in a safe, explicit, inspectable interruption.
- Future scale or availability goals MUST NOT create current entities, states, abstractions, compatibility paths, runners, harnesses, or verification obligations before an accepted current design authorizes them.
- Secret values MUST NOT enter stable product records.
- Private runtime handles and unrestricted native payloads MUST remain private unless an owning Core boundary validates a bounded product-safe projection.
- Missing authority, unverifiable lineage, ambiguous ownership, and unsupported required semantics MUST fail closed.
- Heavy execution SHOULD remain in specialized agents and runtimes while Core coordinates, governs, and records the work.

## Relationships To Other Core Aspects

`core-concepts.md` owns the shared objects and naming boundaries used to express durable product truth.

`work-model.md` owns the user-facing projection of human authority, work state, review, and intervention.

`architecture.md` owns the stable App, Core, Agent, service, and projection boundaries that realize this doctrine.

`runtime-model.md`, `agent-session.md`, and `agent-workflow.md` own bounded execution, continuity, workflow, gates, checkpoints, and stop semantics.

`protocol.md`, `communication.md`, and `storage.md` own the contracts that carry and persist Core truth.

`identity.md`, `permissions.md`, `vault.md`, and `sandbox.md` own the concrete trust, authority, credential, and execution boundaries.

`agent-capability.md`, `audit.md`, and `metering.md` own governed external effects, accountability projections, and measured consumption.

`knowledge.md` owns reusable understanding and reviewed learning records.

`contract-evolution.md` owns how the clean current contract replaces obsolete internal shapes while preserving this doctrine.

## Abstract Realization Notes

An implementation may realize durable product truth through different stores and may expose it through different apps, skills, channels, or APIs. Conformance depends on preserving authority, ownership, lineage, validation, and lifecycle semantics rather than copying one package layout or deployment topology.

Runtime and provider integrations may retain native evidence for diagnosis, but an owning Core boundary should convert accepted facts into bounded product records and keep private payloads outside stable projections.

Automation may be highly autonomous inside an approved scope. Review depth should follow consequence and policy, while the ability to attribute, inspect, stop, and supersede the work remains invariant.
