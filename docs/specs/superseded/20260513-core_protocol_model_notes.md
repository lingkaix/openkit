# Core Protocol Model Notes

Status: Superseded

Superseded: 2026-06-28. This file is retained as historical context and is not an active implementation or release-readiness spec.
Superseded by: `docs/core/core-concepts.md`, `docs/core/protocol.md`, `docs/core/communication.md`, `docs/core/identity.md`, `docs/core/storage.md`, `docs/core/knowledge.md`, `docs/core/permissions.md`, `docs/core/audit.md`, `docs/core/contract-evolution.md`, `docs/specs/20260513-protocol_package_organization.md`
Date: 2026-05-13

This note preserves discussion history that has since been promoted into stable core docs and accepted follow-up specs.

The stable concept model has been promoted to `docs/core/core-concepts.md`.

## Promoted To Core Docs

The following conclusions are now part of the stable core draft set:

- Core concepts are stable semantics; app APIs, host-agent adapters, UI read models, database tables, launch configs, and provider-native payloads are implementation projections.
- `Workspace` is the top-level work environment and the default ownership, namespace, storage, permission, collaboration, and execution boundary.
- OpenKit uses a file-system-first storage model, with SQLite used for structured indexes, search, vector or embedding metadata, materialized views, and operational summaries.
- `Agent`, `Profile`, and `Runtime` are separate concepts.
- OpenKit uses an orchestration-first execution model expressed through the `Thread`, `Turn`, and `Item` backbone, with `AgentSession` used only for Core-to-agent communication and scheduling.
- `Memory` and `Session` are separate concepts.
- `Capability`, `Permission`, and `Sandbox` are separate concepts.
- `AgentManifest` and `AgentCatalog` are the stable agent supply concepts.
- `AgentProfile` is a manifest-local optional section, not a top-level core object.
- The core protocol should be transport-neutral.
- MVP and v0.0.1 product scope belong in `docs/working_logs/2026-05-17-openkit-v0-0-1/prd-v0.0.1.md`, not in `docs/core/core-concepts.md`.
- `docs/core/work-model.md` now owns user-facing work semantics.
- `docs/core/runtime-model.md` now owns execution semantics.
- `docs/core/agent-session.md` now owns runtime continuity.
- `docs/core/agent-supply.md` now owns agent supply and manifest catalog semantics.
- `docs/core/knowledge.md` now owns reusable knowledge semantics.
- `docs/core/permissions.md` now owns authorization semantics.
- `docs/core/sandbox.md` now owns execution isolation semantics.
- `docs/core/architecture.md`, `docs/core/contract-evolution.md`, and `docs/core/agent-workflow.md` now own their high-level core boundaries. `docs/deployment.md` owns deployment doctrine outside the core aspect set.
- `docs/core/identity.md`, `docs/core/vault.md`, `docs/core/agent-capability.md`, `docs/core/metering.md`, `docs/core/audit.md`, and `docs/core/contract-evolution.md` now own thin first-class definitions for cross-cutting areas that are deferred in v0.0.1.
- `protocolVersion`, command `requestId` idempotency, stream cursor semantics, item delta kinds, stable error namespaces, UUIDv7 durable IDs, and agent session naming rules are now promoted to core protocol constraints.
- Stream cursor scopes, discovery response shape, approval status family, no-`cancelling` turn-state rule, concurrent active-turn input ordering, capability-call visibility rules, audit producers, memory supersession fields, item-log invariants, and capability flag governance have been promoted into core docs.
- The old top-level `docs/architecture.md` and `docs/protocol.md` were superseded by core docs and removed.

Do not duplicate those definitions here.

Update the relevant `docs/core/*` file if the stable boundary changes.

## Remaining Design Work

These points remain intentionally open:

- Whether product-facing `Task`, `Job`, or `Deliverable` read models are needed beyond the existing `Thread`, `Turn`, `Item`, and `Artifact` records.
- Whether `AgentSession` should be a first-class public protocol schema or remain a Core-to-agent control-plane schema in the first stable revision.
- The exact agent manifest section names and MVP catalog summary fields.
- The minimum event family and state-machine set required by MVP.
- The minimum cancellation and backpressure semantics required by MVP.
- Exact storage layout details, including data root, SQLite layering, item log layout, and vault backend choice.
- The exact sandbox summary fields that are useful without leaking runtime internals.
- The concrete memory schemas, review workflow, expiration policy, and injection algorithm.
- The concrete permission model, including whether OpenKit adopts RBAC, ABAC, NGAC, or a hybrid model.
- The concrete identity, vault, capability gateway, usage, audit, and conformance fixture implementation plans beyond their thin core boundaries.

## Document Map

`docs/core/core-concepts.md` owns the canonical glossary, core concept definitions, ownership hierarchy, scope boundaries, and naming rules. It should not carry MVP planning, open questions, endpoint sketches, schema recipes, or discussion history.

`docs/working_logs/2026-05-17-openkit-v0-0-1/prd-v0.0.1.md` owns MVP and v0.0.1 product scope.

`docs/core/work-model.md` should own the user-facing work model, including task presentation, product-level goals, deliverables, review, steering, redo, and refinement.

`docs/core/runtime-model.md` should own agent execution semantics, agent sessions, runtime lifecycle, and how the MVP maps the long-term model into a simple turn flow.

`docs/core/protocol.md` should own stable protocol objects, lifecycle vocabulary, event families, schema naming, and compatibility rules.

`docs/core/communication.md` should own commands, events, envelopes, streams, request-response, cancellation, resume, errors, and transport projections.

`docs/core/storage.md` should own the file-system-first storage model, data-root layout, SQLite layering, source-of-truth rules, item log storage, indexes, and storage MVP scope.

`docs/core/identity.md` should own users, workspace members, auth sessions, tokens, invitations, automations, and external integration identities.

`docs/core/vault.md` should own secret references, grants, injection boundaries, and secret handling constraints.

`docs/core/agent-capability.md` should own gateway routing, transformer pipeline boundaries, vault injection contracts, audit metadata, rate-limit hooks, upstream error normalization, gateway usage records, units, attribution, and future gateway cost-model foundations.

`docs/core/audit.md` should own audit event semantics as stable projections over items, permission decisions, capability calls, vault use, and runtime activity.

`docs/core/agent-supply.md` should own agent manifests, agent catalog entries, manifest-local profiles, catalog summaries, and additive manifest section rules.

`docs/core/permissions.md` should own authorization and policy semantics.

`docs/core/sandbox.md` should own execution isolation and runtime environment semantics.

`docs/core/knowledge.md` should own workspace knowledge, learning from work, human review, and context injection.

`docs/core/agent-session.md` should own runtime continuity, snapshots, resume, fork, clone, rollback, and recovery.

`docs/core/agent-workflow.md` should own Core workflow mechanisms, workflow modes and recipes, default workflow setup boundaries, planning, bounded steps, gates, evidence, checkpoints, future workflow graph semantics, lineage, retries, dependencies, and visibility if those concepts need to become stable beyond item causality and runtime-private traces.

`docs/core/architecture.md` and `docs/core/contract-evolution.md` should consolidate system boundaries and additive evolution rules after the focused docs settle. `docs/deployment.md` should consolidate deployment modes outside the core aspect set.

`docs/core/README.md` should own requirement keyword usage, while `docs/core/contract-evolution.md` should own OpenKit compliance levels.

Implementation-specific documents such as `docs/app-api.md` and `docs/specs/20260416-host_agent_adapter.md` should reference the core model instead of redefining it.

Superseded top-level architecture and protocol documents have been deleted after active references were updated.

## Decision Log

### 2026-05-13 — Create `docs/core/` as the stable core-docs layer

- Decision: Use `docs/core/` as the canonical home for stable core concepts, models, protocol semantics, and architecture boundaries.
- Rationale: Core concepts need a stable layer above app APIs, implementation specs, and external research notes.
- Promotes to: `docs/core/README.md`, `docs/core/AGENTS.md`
- Still open: Each placeholder core doc still needs focused discussion before becoming authoritative.

### 2026-05-13 — Split memory from session

- Decision: Treat memory and session as separate core areas.
- Rationale: Memory is reusable workspace knowledge, learning from work, human review, and context injection. Agent session is runtime continuity, warm state, snapshots, resume, fork, rollback, and recovery.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/knowledge.md`, `docs/core/agent-session.md`
- Still open: Exact memory object model, session snapshot model, and context injection rules.

### 2026-05-13 — Split permissions from sandbox

- Decision: Treat permissions and sandbox as separate core areas.
- Rationale: Permissions are authorization and policy semantics, such as RBAC, ABAC, NGAC, grants, enforcement, and approval gates. Sandbox is execution isolation and runtime environment design, such as host execution, containers, WASM, microVMs, remote sandboxes, filesystem and network isolation, snapshots, and resource boundaries.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/permissions.md`, `docs/core/sandbox.md`
- Still open: Permission model choice, sandbox backend abstraction, and the protocol-level summaries exposed to app clients.

### 2026-05-13 — Use a fixed discussion order for core docs

- Decision: Discuss core docs in this order: concepts, product model, runtime model, protocol, communication, agent catalog, permissions, sandbox, memory, session, execution graph, architecture, deployment, compatibility.
- Rationale: Shared vocabulary should come first, then product and runtime models, then communication and agent capability details, then cross-cutting models and architecture.
- Promotes to: `docs/core/README.md`
- Still open: Whether later discussions require adding or reordering any aspect docs.

### 2026-05-13 — Keep core concepts above product implementation

- Decision: Treat the core layer as the source of truth for stable concepts, while product and implementation docs define projections, APIs, storage, UI read models, adapter payloads, and provider-specific details.
- Rationale: The same agent-running model must work across Web UI, desktop app, host agent adapters, local agents, remote agents, ACP, A2A, and managed-agent services.
- Promotes to: `docs/core/core-concepts.md`
- Still open: The exact stable schema set that should appear in the first promoted protocol revision.

### 2026-05-13 — Define workspace as the full work environment

- Decision: Define `Workspace` as the top-level OpenKit work environment and the default scope for threads, turns, items, artifacts, approvals, memory, knowledge, vault references, agent manifests, agent catalog entries, model profiles, skills, permissions, sandbox defaults, agent sessions, audit, usage, and configuration.
- Rationale: Workspace is closer to a Slack workspace than to a folder or single repository. It must be strong enough to support future multi-user sharing, shared memory, shared agents, vault grants, and team policy without changing the lower-level `Thread -> Turn -> Item` model.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/work-model.md`, `docs/core/permissions.md`, `docs/core/knowledge.md`, `docs/core/agent-supply.md`
- Still open: Exact membership model, workspace-local storage layout, cross-workspace sharing rules, and whether the MVP exposes vault and agent-catalog management in the UI.

### 2026-05-13 — Use file-system-first storage with layered SQLite

- Decision: Prefer the file system for most durable data, organized by Core server data root, user directory, and workspace directory. Use SQLite as a companion for structured indexes, full-text search, vector or embedding metadata, materialized read models, constraints, pagination, and operational summaries.
- Rationale: File-system-first storage keeps local development, debugging, backup, import, export, and workspace-level migration simple, while SQLite covers the query and indexing needs that plain files handle poorly.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/storage.md`
- Still open: Exact data root path, whether MVP creates `user.sqlite`, whether item logs are per-turn or per-thread, which FTS or vector strategy to use, and whether secret material is only external or can live in a local encrypted vault.

### 2026-05-13 — Separate agent, agent, and runtime

- Decision: Define `Agent` as the logical autonomous actor, `Agent` as the schedulable supply unit, and `Runtime` as the execution substrate that materializes agent sessions, resources, and isolation.
- Rationale: Agent behavior, agent discovery or scheduling, and runtime execution can vary independently, so collapsing them into one object would make manifests, catalogs, sessions, sandboxing, and protocol events harder to evolve.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/runtime-model.md`, `docs/core/agent-supply.md`, `docs/core/architecture.md`
- Still open: Whether an agent should expose exactly one implicit default profile or named manifest-local profiles.

### 2026-05-13 — Use protocol-aligned orchestration

- Decision: Model long-running and multi-agent work through the `Thread -> Turn -> Item` backbone, with `AgentSession` representing a reusable Core-to-agent communication and scheduling handle.
- Rationale: OpenKit must support many concurrent agents per user, days-long work, cron jobs, parallel sub-agents, handoffs, implementation and review loops, steering during execution, and redo or refinement after delivery, without inventing a parallel suite of core work objects outside the protocol backbone.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/runtime-model.md`, `docs/core/work-model.md`
- Still open: Whether product-facing `Task`, `Job`, or `Deliverable` read models are needed beyond the core protocol records.

### 2026-05-13 — Remove `AgentRun` and `TaskRun` from core concepts

- Decision: Do not use `AgentRun` or `TaskRun` as core concepts. A `Turn` is the agent-bound execution unit, and all communicated or stored observations flow through `Item`.
- Rationale: `AgentRun` duplicates turn lifecycle, while `TaskRun` pulls runtime-private execution graphs into the stable protocol too early. Execution metadata should live on the turn, the agent session, item payloads, or implementation-specific telemetry unless a future requirement proves it must become stable protocol.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/protocol.md`, `docs/core/runtime-model.md`, `docs/core/communication.md`
- Still open: How much `AgentSession` state should be exposed to app clients versus kept inside the Core-to-agent control plane.

### 2026-05-13 — Keep the MVP intentionally minimal

- Decision: Build the current MVP as the smallest workable app and system, then evolve the architecture through dogfooding and real usage.
- Rationale: The core model should stay extensible, but implementing complex orchestration, session management, memory, capability negotiation, permission policy, and hardened sandboxing too early would slow down product learning.
- Promotes to: `docs/working_logs/2026-05-17-openkit-v0-0-1/prd-v0.0.1.md`, `docs/core/architecture.md`, `docs/deployment.md`, `docs/core/contract-evolution.md`
- Still open: Which minimal protocol records must exist in MVP to avoid a later migration cliff.

### 2026-05-13 — Keep remote agents and sidecars out of v0.0.1

- Decision: v0.0.1 does not implement remote agents or bridge sidecars. If a real agent is used, prefer the simplest host-mode integration.
- Rationale: Remote agents and sidecars are important long-term architecture concepts, but they add deployment, networking, security, and recovery complexity that would slow the first product loop.
- Promotes to: `docs/working_logs/2026-05-17-openkit-v0-0-1/prd-v0.0.1.md`, `docs/core/communication.md`, `docs/deployment.md`
- Still open: Exact remote-agent connection establishment strategies for later versions.

### 2026-05-13 — Make sidecar connection direction deployment-specific

- Decision: The long-term logical model is `Core <-> Bridge Sidecar <-> Agent`, but the physical connection direction is deployment-specific. Server-side Core can let sidecar dial Core; desktop-embedded Core may dial agent host or sidecar through SSH, tunnel, tailnet, provider API, or relay; future managed deployments may let both sides dial a relay.
- Rationale: A desktop-embedded Core often has no public domain or IP, so requiring sidecar-initiated connection to Core would make remote agents impossible or force unnecessary public exposure.
- Promotes to: `docs/core/communication.md`, `docs/deployment.md`
- Still open: Which strategies should be implemented first after v0.0.1.

### 2026-05-13 — Simplify agent manifest and catalog concepts

- Decision: Use `AgentManifest` and `AgentCatalog` as the stable agent supply concepts. `AgentManifest` remains the declarative setup file for initializing and operating an agent. `AgentProfile` is a manifest-local optional section, with one implicit default profile when omitted. Resolved setup, materialized setup, launch config, adapter config, readiness probes, and provider-native fields remain implementation-layer records.
- Rationale: The core should preserve a manifest file similar in role to OpenAI sandbox-agent manifests and OpenFang hand or agent manifests, without forcing every implementation pipeline stage or every selectable behavior profile into the top-level protocol model.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/agent-supply.md`
- Still open: Exact manifest section names and the minimum catalog summary needed by the MVP UI.

### 2026-05-13 — Keep MVP protocol objects and communication small

- Decision: The MVP protocol should prioritize `Workspace`, `Thread`, `Turn`, `Item`, `Agent`, `AgentSession`, `Artifact`, and `ApprovalRequest`, with communication expressed as transport-neutral commands, events, and envelopes.
- Rationale: The first app needs request and event-stream semantics for real usage, while `Memory`, `PermissionDecision`, and `SandboxPolicy` can start as concepts or optional future schemas.
- Promotes to: `docs/working_logs/2026-05-17-openkit-v0-0-1/prd-v0.0.1.md`, `docs/core/protocol.md`, `docs/core/communication.md`
- Still open: Exact event family names and the minimum resume, cancellation, and error semantics needed for MVP.

### 2026-05-13 — Promote cross-cutting audit findings without expanding MVP scope

- Decision: Add first-class thin core docs for identity, vault, capability gateway, usage, audit, and conformance. Also promote protocol hard constraints for `protocolVersion`, command `requestId`, stream cursor, item delta kinds, stable error code namespaces, UUIDv7 durable IDs, item causation, and agent session naming.
- Rationale: These concepts cut across permission, sandbox, communication, memory, storage, and agent execution. Naming and protocol invariants become costly to repair after the MVP starts emitting events, but full subsystem implementation is not required for v0.0.1.
- Promotes to: `docs/core/core-concepts.md`, `docs/core/protocol.md`, `docs/core/communication.md`, `docs/core/storage.md`, `docs/core/knowledge.md`, `docs/core/sandbox.md`, `docs/core/identity.md`, `docs/core/vault.md`, `docs/core/agent-capability.md`, `docs/core/metering.md`, `docs/core/audit.md`, `docs/core/contract-evolution.md`, `docs/working_logs/2026-05-17-openkit-v0-0-1/prd-v0.0.1.md`
- Still open: Concrete identity, vault, capability gateway, usage, audit, and conformance-fixture implementations after the MVP protocol package is built.

### 2026-05-13 — Tighten protocol edge semantics without adding MVP implementation scope

- Decision: Clarify closed item delta kinds, stream cursor scopes, discovery response shape, approval lifecycle statuses, async cancellation state discipline, concurrent input ordering, thread resume semantics, capability-call visibility, audit producer responsibility, memory supersession fields, item-log storage invariants, capability flag governance, and conformance fixture version metadata.
- Rationale: These are small normative edges that prevent UI, adapter, and storage implementations from inventing incompatible behavior during MVP dogfooding.
- Promotes to: `docs/core/protocol.md`, `docs/core/communication.md`, `docs/core/identity.md`, `docs/core/permissions.md`, `docs/core/audit.md`, `docs/core/agent-capability.md`, `docs/core/knowledge.md`, `docs/core/storage.md`, `docs/core/contract-evolution.md`, `docs/core/core-concepts.md`, `docs/specs/20260513-protocol_package_organization.md`
- Still open: Full subsystem implementation details for post-v0.0.1 identity, permission policy, audit retention, usage billing, vault backend, capability gateway routing, and schema generation.

### 2026-05-13 — Adopt Codex app-server-style item delta taxonomy

- Decision: Replace the generic top-level `append` / `replace` / `patch` / `structured` item delta kinds with Codex-style item-specific update families: `text-delta`, `indexed-text-delta`, `part-started`, `output-delta`, `snapshot-updated`, `progress-updated`, `request-started`, `request-resolved`, `interaction-delta`, plus OpenKit-specific `artifact-updated` and `memory-injection-updated`.
- Replaced design: The previous four-kind generic enum was `append`, `replace`, `patch`, and `structured`. That model was simpler but too easy to overload and too far from Codex app-server's item-specific event shape.
- Rationale: Codex app-server models item streaming through `item/started`, item-specific delta or request notifications, and authoritative `item/completed`. Matching that shape gives clients clearer rendering behavior, preserves reasoning parts, aligns adapters, and keeps completed items authoritative.
- OpenKit-only kinds retained: `artifact-updated` and `memory-injection-updated`.
- Promotes to: `docs/core/protocol.md`, `docs/core/communication.md`, `docs/core/contract-evolution.md`, `docs/specs/20260513-protocol_package_organization.md`
- Still open: Exact `packages/protocol` schema names, generated fixture coverage for each item delta kind, binary framing limits, and whether a future fine-grained structured patch delta is needed for very large diffs.

## Immediate Next Steps

Promote or retire the remaining focused designs one document at a time.

The old top-level product, architecture, and protocol docs have been absorbed and removed.

The old UI-first and communication-flow specs have been absorbed and removed.

The remaining specs are implementation-layer specs:

- `docs/specs/20260416-host_agent_adapter.md`
- `docs/specs/20260416-unified_agent_setup_manifest.md`
- `docs/specs/20260507-codex_agent_communication_modes.md`
- `docs/specs/20260513-protocol_package_organization.md`

Keep these remaining specs only while they contain implementation details that should not move into `docs/core/`.
