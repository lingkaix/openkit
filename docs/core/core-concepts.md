# Core Concepts

Status: Accepted

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

Identity links actors and members to this model. Runtime assigns agents and agent sessions to turns. Those relationships do not make Identity or Runtime children of Workspace in a competing ownership tree.

## Layer Boundary

Core concepts are product-independent semantics that remain stable across app clients, Core implementations, agent runtimes, local and remote workers, storage backends, and protocol transports.

Concrete endpoints, screens, records, tables, files, caches, adapter methods, launch configuration, provider payloads, and diagnostics are projections. They must not redefine the concepts in this document.

## CoreServer

`CoreServer` is one running OpenKit installation or service instance and one deployment trust domain.

It owns server-level operational state such as configuration, registries, built-ins, background jobs, migrations, and diagnostics. Server indexes and registries may point to workspace records, but they must not silently replace workspace-owned durable truth.

## Workspace

`Workspace` is the top-level durable work scope inside a Core server.

A Workspace is not a folder, repository, thread, runtime session, tenant, or organization. One deployment is one trust domain; Workspace membership and roles provide authorization inputs evaluated by the permission model rather than claiming separate organizational tenancy.

Workspace is the default scope for threads, artifacts, knowledge, agent supply, vault references, permissions, sandbox policy, runtime resources, audit, and usage. The specialized owner defines the exact records and any justified non-workspace scope.

Workspace ownership and membership are logical identity and authority relationships. Workspace storage must not depend on a user's physical namespace. Identity, Permissions, and Storage own the concrete membership, role, transfer, and storage-independence contracts.

Cross-workspace execution, knowledge sharing, vault sharing, and artifact movement require explicit design and authority. An adapter, runtime session, manifest, or fallback must not cause them implicitly.

## Work Backbone

### Thread

`Thread` is a durable container for related work inside one workspace.

A thread groups turns, items, artifacts, approvals, and agent activity over time. It may involve multiple agents and agent sessions, parallel turns, handoffs, review, redo, and refinement.

Thread is not a runtime session, workflow engine, or scheduling implementation. Runtime and workflow owners decide how work inside a thread is scheduled and coordinated.

### Turn

`Turn` is one execution unit inside a thread.

Runtime governs the assignment of an executing Turn to an Agent and AgentSession. Durable work history preserves that exact relationship rather than inferring it from unrelated thread activity.

Turn replaces the need for default `AgentRun` or `TaskRun` objects. Runtime-private task graphs, retries, and telemetry remain private unless an owning document promotes a stable projection.

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
- Runtime MUST preserve the exact assignment relationship of an executing Turn.
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
