---
status: Accepted
---
# Core Concepts

This document owns the shared root concepts that every OpenKit aspect projects: `CoreServer`, `Workspace`, `Thread`, `Turn`, `Item`, `Artifact`, `ApprovalRequest`, `Channel`, and `TriggerSource`.

It owns their stable relationships, common scope semantics, identifier semantics, and naming boundaries.

It does not own specialized aspect terms, product modes, complete record fields, lifecycle enums, API routes, storage layouts, runtime placement, adapter payloads, provider configuration, or schema-evolution mechanics. Those decisions belong to their aspect owners or implementation-facing design records.

## Principles

- Each concept has one canonical owner. Other documents may project it but must not redefine it.
- The stable work backbone is `Workspace -> Thread -> Turn -> Item[]`.
- Workspace scope is the default boundary for work. Any global, server, user, built-in, or shared scope must be declared by its owning aspect.
- Product, protocol, storage, runtime, and adapter projections must preserve the root model without creating parallel authority.

## Concept Map

```text
CoreServer
  Workspace
    Thread
      Turn
        Item[]
    Artifact
    ApprovalRequest

Channel -- submits work to --> CoreServer
TriggerSource -- causes --> Turn
Artifact and ApprovalRequest -- anchored by --> Item history
```

Identity links actors and members to this model. Runtime assigns Agents and AgentSessions to Turns. Those relationships do not make Identity or Runtime children of Workspace in a competing ownership tree.

## Layer Boundary

Core concepts are product-independent semantics that remain stable across app clients, Core implementations, agent runtimes, local and remote workers, storage backends, and protocol transports.

Concrete endpoints, screens, records, tables, files, caches, adapter methods, launch configuration, provider payloads, and diagnostics are projections. They must not redefine the concepts in this document.

## CoreServer

`CoreServer` is one running OpenKit installation or service instance and one deployment trust domain.

It owns server-level operational state such as configuration, registries, built-ins, background jobs, migrations, and diagnostics. Server indexes and registries may point to workspace records, but they must not silently replace workspace-owned durable truth.

CoreServer is the shared resource and baseline-configuration provider for the deployment. It supplies Provider profiles, logical model routes, built-in and installed Agent supply, internal-role execution profiles, runtime and Sandbox supply, shared catalogs, deployment capabilities, and final fallback defaults. Supplying a resource or default does not make Server configuration the generic maximum-capability envelope for Workspace or User composition.

## Workspace

`Workspace` is the top-level durable work scope inside a Core server.

A Workspace is not a folder, repository, thread, runtime session, tenant, or organization. One deployment is one trust domain; Workspace membership and roles provide authorization inputs evaluated by the permission model rather than claiming separate organizational tenancy.

Workspace is the default scope for threads, artifacts, knowledge, agent supply, vault references, permissions, sandbox policy, runtime resources, audit, and usage. The specialized owner defines the exact records and any justified non-workspace scope.

Workspace ownership and membership are logical identity and authority relationships. Workspace storage must not depend on a user's physical namespace. Identity, Permissions, and Storage own the concrete membership, role, transfer, and storage-independence contracts.

Cross-workspace execution, knowledge sharing, vault sharing, and artifact movement require explicit design and authority. An adapter, runtime session, manifest, or fallback must not cause them implicitly.

Workspace is the durable shared configuration and authored-composition scope for its members. It may consume Server resources, add Workspace-owned resources, bind Workspace Secrets, select shared defaults, and compose Server-supplied Agent or internal-role configuration into the behavior shared by that Workspace. Composition remains subject to the owning resource's runtime support, ordinary authorization, compatibility, and capacity semantics; those constraints do not turn Server defaults into a general product-level ceiling.

User-specific persistent preference is the lightest configuration scope and belongs to the User identity owner. For an applicable setting, ordinary persistent preference resolves User first, then Workspace, then Server. An explicit request or current orchestration choice may be more specific when its owning command permits it. A User preference selects or customizes behavior for that User without mutating Workspace-shared or Server configuration.

The operation attached to each field follows its natural owner: a scalar preference replaces a less-specific default, an identified collection may add, replace, disable, or remove entries through stable IDs, and a resource quantity remains governed by its resource owner. No generic merge rule may invent authority, materialize an unsupported resource, or replace the unique owner of authorization, containment, credentials, scheduling, or external effects.

## Work Backbone

### Thread

`Thread` is one durable narrative for related work inside exactly one workspace.

A conversational Thread is addressed to exactly one conversational counterpart. A worker-execution Thread has no conversational counterpart: it is classified by its execution purpose and remains reachable through lineage and reference Items rather than being presented as an addressed conversation.

A Thread groups sequential Turns, Items, Artifacts, Approvals, and Agent activity over time. It may involve different Agents and historical AgentSessions across those sequential Turns, but it has at most one current AgentSession and one Turn in flight. Parallel work uses parallel Threads rather than parallel Turns in one Thread.

A Thread carries `threadSource` and optional `parentThreadId`. `threadSource` identifies whether the Thread originated as a user conversation, worker execution, or another accepted execution class. `parentThreadId` preserves causal Thread lineage without moving or copying history. These fields are fixed when the Thread is created; a missing or inaccessible parent leaves lineage unresolved and MUST NOT authorize access, execution, or mutation.

A handoff always creates a new Thread in the Workspace that will own the receiving execution. The originating Thread retains an append-only handoff Item referencing the new Thread; it does not change addressee or move history, and neither Thread spans two Workspaces. Review, redo, refinement, retry, and recovery remain in the existing Thread only while its Workspace and addressee remain unchanged; otherwise they create a new linked Thread.

Thread creation fixes its Workspace, addressee or execution classification, and lineage before its first Turn is admitted. Later updates append ordered history. Archive prevents new Turns under its owning contract without rewriting existing history. Restart reconstructs the Thread from Core-owned records, never from an AgentSession or runtime-private conversation. Conflicting, stale, replayed, or mis-scoped mutations MUST be rejected before they append history or start a Turn.

Thread is not a runtime session, workflow engine, scheduling implementation, or container for concurrent writers. Runtime and workflow owners decide how sequential work inside a Thread is admitted and coordinated.

### Turn

`Turn` is one execution unit inside a thread.

Runtime governs the assignment of an executing Turn to an Agent and AgentSession. Durable work history preserves that exact relationship rather than inferring it from unrelated thread activity.

Turn replaces the need for default `AgentRun` or `TaskRun` objects. Runtime-private task graphs, retries, and telemetry remain private unless an owning document promotes a stable projection.

A Turn is created only after its input and exact Thread are accepted while that Thread has no Turn in flight. Its updates are its ordered Items and lifecycle changes. A terminal Turn is immutable and never reopened: retry, recovery, redo, and refinement create a new Turn, preserving the prior Turn and its Items. Missing dependencies block creation; stale, replayed, conflicting, or wrong-Thread commands MUST NOT create, retarget, or update a Turn. Protocol owns the lifecycle states, interruption behavior, and externally observable terminal proof.

### Cardinalities

| Relationship | Cardinality | Stable constraint |
| --- | --- | --- |
| Thread to active Turn | `1 -> 0..1` | A Thread has at most one Turn in flight. |
| Thread to historical Turn | `1 -> 0..N` | Turns remain ordered and sequential. |
| AgentSession to Thread | `N -> 1` | Each AgentSession belongs to exactly one Thread for its whole life. |
| Thread to historical AgentSession | `1 -> 0..N` | Distinct sequential Turns may use distinct replacement AgentSessions over time. |
| Thread to current AgentSession | `1 -> 0..1` | Only the sole current AgentSession may receive a newly authorized worker Turn for the Thread. |
| AgentSession to active Turn | `1 -> 0..1` | One AgentSession never executes concurrent Turns. |
| Worker Turn to AgentSession | `1 -> 1` | A worker-executed Turn has exactly one AgentSession; the accepted Core-local exception has none. |

### Item

`Item` is the ordered communication and storage atom inside a turn.

Items preserve visible inputs, outputs, summaries, decisions, state changes, handoffs, artifact references, and other stable work history. Item identity and lineage are immutable, and ordered Item history must not be replaced by a competing communication log.

Runtime-private traces and chain-of-thought are not Items unless an owning design intentionally promotes a safe, product-visible summary.

## Related Root Concepts

### Artifact

`Artifact` is a durable user-visible output associated with a workspace and, when applicable, a thread and turn.

Artifact identity and lineage are anchored by item-backed artifact references. Bytes may use a specialized storage backend, but an artifact index or read model must not become an untraceable source of work history.

### ApprovalRequest

`ApprovalRequest` is a blocking human authorization decision for permission, safety, budget, credential use, an irreversible operation, or an external side effect.

ApprovalRequest does not represent ordinary questions or choices. Human-attention mechanics and concrete item-backed materialization belong to the Work Model and Protocol.

### Channel

`Channel` is a product-facing origin surface and routing context through which work reaches Core.

It is not an actor, agent, or transport. A product may project Channel metadata without requiring Channel to be a peer durable protocol record.

### TriggerSource

`TriggerSource` is the auditable cause that starts a turn or submits input to an active turn.

It is an event cause, not an actor. Identity records who or what acted; Protocol owns the concrete trigger-source values and field shape.

## Relationships To Other Core Aspects

The canonical term index in `docs/core/README.md` routes every specialized concern to its single owning aspect. This document defines only how those aspects project the shared root concepts.

## Identifier Semantics

Durable Core identifiers are stable opaque strings. Consumers must not parse an identifier for time, routing, storage path, ownership, provider identity, or database location.

An external or provider-native identifier must not become Core identity. An owning schema may retain it as an explicit external reference or private implementation projection.

`requestId` is caller-provided command correlation and idempotency input, not a durable object identifier.

The owning protocol schema and accepted design define concrete ID fields, encodings, allocation, and validation. Record writers implement that contract. This document does not impose one universal encoding or maintain a speculative registry of future IDs.

## Naming Rules

- Use `Turn`, not `AgentRun` or `TaskRun`, for the default agent-bound execution unit.
- Never use bare `Session` for an OpenKit-authored concept. Use an explicit name such as `AgentSession`, `AuthSession`, or `SandboxSession`.
- Keep provider-native and adapter-native names under explicit extension namespaces or private implementation projections.
- Product terms such as task, job, goal, and deliverable remain projections unless an owning Core document promotes them.

## Invariants

- The default durable work backbone MUST remain `Workspace -> Thread -> Turn -> Item[]` unless an accepted Core revision replaces it.
- Every durable work record MUST belong to one workspace; any other scope MUST be explicit in its owning aspect.
- CoreServer MUST supply shared resources and fallback defaults without treating those defaults as a generic ceiling on Workspace-authored composition or User preference.
- Ordinary persistent preference MUST resolve User before Workspace before Server, while any more-specific request or orchestration choice MUST remain owned by its command contract.
- Workspace composition and User preference MUST preserve the unique owner, ordinary authorization, compatibility, runtime support, and capacity semantics of every referenced resource.
- Runtime MUST preserve the exact assignment relationship of an executing Turn.
- A Thread MUST have at most one Turn in flight; parallel work MUST use distinct Threads.
- A Thread MUST have at most one current AgentSession; historical predecessors MUST remain terminal and non-reusable.
- A conversational Thread MUST have exactly one addressee for its whole life, while a worker-execution Thread MUST remain classified rather than represented as an addressed conversation.
- A handoff MUST preserve its originating history and create a referenced Thread in the Workspace that owns the receiving execution.
- Thread classification, lineage, archive, retry, and recovery MUST NOT move history across Workspaces or infer continuity from runtime-private state.
- Item identity and lineage MUST remain immutable, and materialized records MUST NOT create a competing communication log.
- Artifact and approval projections MUST remain traceable to item-backed history.
- Approval MUST NOT absorb ordinary questions or user choices.
- No projection may introduce a competing root model.

## Related Docs

- `docs/core/foundation.md`
- `docs/core/work-model.md`
- `docs/core/architecture.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/knowledge.md`
- `docs/core/vault.md`
- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/permissions.md`
- `docs/core/sandbox.md`
- `docs/core/audit.md`
- `docs/core/contract-evolution.md`
