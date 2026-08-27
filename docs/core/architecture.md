---
status: Accepted
---
# Core Architecture

This document owns the stable App/Core/Agent layer boundary, the split between Core coordination and agent execution, the adapter translation boundary, internal Core role boundaries, and the workspace-service boundary.

This document does not own package layout, App API endpoints, protocol or database record shapes, storage backends, communication transports, internal Agent runtime mechanics, runtime session continuity, deployment topology, agent-native protocols, provider mappings, launch commands, or sandbox backend details. The Internal Agent Runtime specification owns the role-agnostic bounded execution substrate used by model-using internal roles.

## Purpose

OpenKit coordinates work across changing product surfaces, agent runtimes, adapters, stores, and deployment shapes. This model fixes which layer may decide, execute, translate, and commit product truth so those implementation choices can evolve without creating competing authorities.

## Principles

- Core coordinates and governs work; agents execute work; adapters translate between Core semantics and runtime-native operations.
- Only Core validates and commits durable product truth. Apps, channels, internal roles, adapters, and runtimes may submit inputs, decisions, candidate records, results, or evidence through an owning Core contract.
- Apps, channels, Skills, CLIs, and API clients are governed projections over Core contracts rather than independent workflow or state owners.
- Runtime-native commands, events, sessions, provider payloads, and diagnostics remain behind the adapter boundary unless another Core aspect deliberately promotes a stable product projection.
- Core storage and an Agent Runtime are separate effect domains. A local transaction can commit Core truth, but it cannot make an external process, provider, sandbox, repository, or network effect atomically commit with that truth.
- Deployment, storage, and release-artifact choices preserve the Core semantic invariant stated below; they select placement and packaging, not product meaning.
- Workspace services expose governed Core contracts rather than raw storage, provider, sandbox, or adapter internals.

## Architecture Shape

OpenKit uses an `App + Core + Agent` architecture.

```text
App / Channel
  <-> Core
      <-> Agent Adapter
          <-> Agent Runtime
```

### App And Channel

An App or Channel is a user, operator, integration, or automation interaction surface. This layer includes user interfaces, API clients, end-user Skills and CLIs, messaging channels, and automation entry points.

Apps and channels submit intent and commands through public Core contracts and render Core-owned records and projections. They must not reach into storage, adapters, or runtimes; redefine Core concepts; or maintain private workflow truth.

### Core

Core is the coordination and governance plane. It owns admission and routing, scheduling, Core-owned product-record lifecycle transitions, policy and approval gates, durable record validation and commit, storage coordination, and product-safe projections.

Core may coordinate context, capabilities, workspace changes, evidence, audit, and usage through their owning aspects. It must not absorb coding, research, browser operation, shell execution, long-running tool loops, or other heavy domain execution merely because it supervises that work.

When Core cannot prove whether an external runtime effect occurred, it may preserve the accepted lineage and expose an interrupted or uncertain outcome that requires inspection or a new authorized attempt. It must not guess, duplicate the effect, or create a settlement workflow solely to hide that boundary.

### Agent Adapter

An Agent Adapter consumes an already authorized and resolved assignment and translates between Core operations and one runtime's native invocation, control, results, and evidence.

An adapter must not choose product policy, schedule work, own review or workspace-apply decisions, allocate canonical product identity, commit or terminalize Core-owned state, or define public product behavior. Runtime-native details must end at this boundary.

Adding an agent runtime must not require runtime-specific branches in Core product behavior, workflow, policy, governance, or canonical record schemas. The concrete profile, adapter, image, process harness, and conformance mechanics remain implementation contracts outside Core.

### Agent Runtime

An Agent Runtime performs bounded heavy execution under the supplied assignment and authority. It may produce candidate output, evidence, native session state, and effect requests through its adapter.

Runtime durability does not make runtime-native state authoritative. A runtime must not write Core-owned product state directly or bypass the adapter and Core validation boundary.

## Workspace Services

Core may expose governed workspace services for knowledge, artifacts, capabilities, vault mediation, audit, usage, and other workspace-scoped facilities. Each service retains the authority of its owning Core aspect and must not become a raw internal-storage or provider escape hatch.

The Generative Kernel is a reserved future workspace-service boundary for governed durable data used by humans through product projections and by agents through governed interfaces. This boundary does not authorize a current implementation, universal data model, generated application framework, or independent policy and storage plane.

## Internal Core Roles

Core may use lightweight internal roles for coordination. These roles remain inside Core, are not Agent Runtime entries, are not worker-agent supply, and are not user-selectable execution tools.

| Role | Stable responsibility | Prohibited ownership |
| --- | --- | --- |
| Core Assistant | Lightweight reply, clarification, state-query, and triage coordination. | Non-trivial worker execution or long-running workflow progression. |
| Workflow Coordinator | Bounded structured decisions for workflow routing, worker selection, semantic worker-context composition, planning, and stopping. | Durable mode state, workflow side effects, context materialization or delivery, heavy execution, or direct Knowledge Store ownership. |
| Knowledge Manager | Governed knowledge retrieval and maintenance coordination. | Overall workflow progression or final worker-context authority. |
| Task Evaluator | Reserved direction for governed evaluation of outcomes, verification, and improvement proposals. | Current worker execution or an unpromoted concrete evaluation architecture. |

Internal roles may produce decisions or proposals only through normal Core services and records. They must not create private workflow, knowledge, evaluation, or product-state authorities.

## Boundaries And Non-Goals

- Architecture does not prescribe packages, processes, services, endpoints, tables, files, protocols, or deployment units.
- Architecture does not make every runtime capability a stable Core feature; unsupported operations remain unsupported until an owning contract is accepted and implemented.
- Architecture does not make internal roles worker runtimes or require an agent where deterministic Core code is sufficient.
- Architecture does not define workspace object lifecycles, workflow algorithms, storage layout, transport recovery, sandbox containment, or provider behavior; their owning aspects retain those decisions.
- Architecture does not promise cross-domain atomicity, high availability, transparent failover, or automatic recovery for every external effect.
- Future workspace services do not authorize speculative entities, generalized workbenches, or parallel governance systems.

## Invariants

- Only Core MAY validate and commit durable product truth; every other layer MUST submit through an owning Core contract.
- Apps and channels MUST NOT become a second source of workflow, policy, identity, review, storage, or lifecycle truth.
- Agent adapters and runtimes MUST NOT write, terminalize, or reinterpret Core-owned product state directly.
- Runtime-native commands, events, sessions, provider details, and evidence formats MUST remain behind the adapter boundary unless another Core aspect promotes a stable projection.
- Core MUST NOT claim atomic completion across its durable store and an external runtime effect without an owning contract that supplies real proof. An unprovable outcome MUST remain explicit rather than being repaired by inference.
- Adding an agent runtime MUST NOT add runtime-specific product, workflow, policy, governance, or canonical-schema branches to Core.
- Internal Core roles MUST remain inside the coordination plane and MUST NOT maintain private product or workflow state.
- Role, Agent, AgentSession, Harness, and Sandbox MUST remain independent axes; co-location or a shared physical binding transfers no identity or authority among them.
- The NanoCore-user, NanoCore-NanoHost, and NanoCore-Worker-Agent interaction boundaries MUST remain stable while the internal Agent loop, internal-role assembly, Goal scheduling, Goal worker pinning, and placement remain private changeable NanoCore strategies; those strategies MUST NOT leak role or Goal semantics or runtime identities across those edges.
- Workspace services MUST expose governed Core contracts and MUST NOT expose raw storage, credentials, provider clients, sandbox control, or adapter internals.
- Deployment placement, storage backend, and release artifacts MUST NOT change the Core semantics of workspace, thread, turn, item, artifact, approval, agent, AgentSession, knowledge, vault, audit, or usage. This includes their ownership, policy authority, review semantics, trust boundaries, audit meaning, and usage attribution.

## Relationships To Other Core Aspects

Core Concepts owns the shared product objects and identifier semantics; Identity owns actors, authentication, and membership; Work Model owns user-facing work meaning; Agent Workflow owns workflow progression; Runtime Model and AgentSession own execution lifecycle and continuity; Communication owns command, event, streaming, and transport projections; Storage owns persistence and data-source boundaries.

Agent Supply owns selectable agent profiles and readiness; Agent Capability owns governed runtime capability supply; Permissions, Sandbox, and Vault own authorization, containment, and credential boundaries; Knowledge, Audit, and Metering own their respective workspace services and records.

Architecture constrains how those aspects compose. It does not redefine their objects, records, algorithms, or implementation projections.
