# Runtime Model

Status: Accepted

This document defines OpenKit runtime semantics.

This document owns how agents, profiles, runtimes, agent sessions, turns, and items relate during execution.

This document does not own agent-native protocols, process launch arguments, database tables, app endpoints, complete agent setup fields, agent capability routing, permission policy, sandbox containment, or reusable knowledge semantics.

It explains the execution model without making runtime-native details part of the core product model.

## Purpose

OpenKit must support many concurrent agents for one user, from short interactive tasks to long-running work that may last for days.

A single user request, instruction, automation, or cron trigger may involve one agent, many agents in parallel, agent handoff, implementation and review loops, or later refinement after a deliverable is produced.

The runtime model keeps those workflows inside the stable `Workspace -> Thread -> Turn -> Item[]` backbone instead of introducing a parallel suite of run objects.

## Principles

- Worker-executed Turns are agent-bound execution units; Agent Sessions are reusable runtime handles. Core-local service Turns may remain sessionless only under the narrow protocol exception.
- Runtime details may be observed through items, artifacts, audit, and summaries, but private runtime state is not the user-facing work model.
- Core schedules work at thread and turn boundaries before it reasons over runtime-native task graphs.
- Runtime placement and backend selection are projections; they must not change the stable `Workspace -> Thread -> Turn -> Item[]` backbone.
- Agent sessions may preserve warm state, but warm state is not knowledge unless Core extracts, reviews, and records it through the knowledge boundary.

## Boundary

The runtime model owns:

- the distinction between agent, profile, runtime, and agent session
- how turns are assigned to agent sessions
- how agent sessions are initialized, reused, interrupted, resumed, or replaced
- how runtime observations become items
- how multi-agent work is represented without `AgentRun` or `TaskRun`
- which runtime details remain private implementation data

The runtime model does not own:

- app read models
- agent-native task graphs
- native provider payloads
- process handles, container IDs, SSH sessions, or mediation wire formats
- complete sandbox, permission, knowledge, or storage schemas

## Core Relationship

The execution relationship is:

```text
Agent
  contains AgentProfile[]
  supplied through agent setup config
  selected through AgentCatalog
  executed by Runtime
  connected through AgentSession
  assigned to Turn
  observed through Item[]
```

The communication and storage relationship remains:

```text
Workspace -> Thread -> Turn -> Item[]
```

These two relationships meet at a worker-executed `Turn`. An Agent Session is the reusable communication and scheduling handle that executes one worker Turn at a time unless a specific runtime later declares safe multiplexing semantics. A Core-local workflow or Assistant service that owns no worker, scheduler, sandbox, or runtime-session effect may produce a sessionless Turn under `protocol.md`; that Turn does not enter the runtime relationship above.

## Agent

`Agent` is the schedulable supply unit available to Core.

An agent answers what Core can choose for a turn. It provides identity, runtime binding, deployment mode, transport contract, profile set, capability summary, readiness summary, sandbox summary, permission summary, and policy summary.

Agent is not the raw adapter, process, model provider, tool server, sandbox backend, thread, or user-visible conversation.

## AgentProfile

`agent-supply.md` owns the `AgentProfile` definition. Runtime resolves one selected profile from agent setup before creating or reusing an agent session.

The selected profile may influence runtime inputs but cannot expand the parent agent policy.

## Runtime

`Runtime` is the execution substrate that materializes and manages agent sessions.

A runtime may execute agents:

- in a local container
- in WASM
- in a microVM
- through a remote agent service
- through a managed sandbox provider
- through a future runtime service

Runtime owns execution lifecycle and infrastructure concerns such as startup, liveness, interruption, recovery, sandbox attachment, workspace materialization, artifact collection, and capability-plane connectivity.

Runtime is separate from permission. Runtime may enforce sandbox constraints, but authorization decisions belong to the permission model.

## AgentSession

`agent-session.md` owns the `AgentSession` definition and continuity semantics. Runtime uses an AgentSession as the initialized communication and scheduling handle between Core and an agent runtime.

Runtime observes liveness, effective setup identity, placement, capabilities, sandbox state, and health through that session projection without exposing the agent's private task graph.

## Turn

`Turn` is one execution unit inside a thread.

A Turn run by a schedulable Agent is assigned to one Agent Session, and an Agent Session may execute multiple Turns over time. A Core-local service Turn uses `agentSessionId=null` only under the protocol exception and MUST NOT be presented as worker execution or runtime continuity.

A turn may be triggered by user input, system input, automation, retry, handoff, approval resolution, or running-work steering. These map to the closed `TurnTriggerSourceSchema` enum (`user-input`, `system-input`, `automation`, `retry`, `handoff`, `approval-resolution`, `running-work-steering`), which is authoritative; cron-style schedules fold into `automation`, and redo or refinement requests are expressed as `retry` or `user-input` turns rather than distinct trigger kinds.

Turn replaces `AgentRun` in the core model. Execution metadata belongs on the turn, agent session, item payloads, artifact records, approval records, or implementation telemetry.

## Item

Runtime observations that require stable communication, replay, audit, approval, artifact lineage, or user-visible history are persisted as `Item` records under the Core Concepts definition.

Agents and adapters translate user-visible or protocol-visible runtime activity into items. Private runtime steps do not need to become items.

Task graphs, tool retries, chain-of-thought internals, process logs, native SDK traces, and scheduler traces remain private unless intentionally projected as item summaries or diagnostics.

## Scheduling Model

Core schedules work at the thread and turn level.

A thread may contain:

- sequential turns by the same agent
- turns by different agents
- parallel turns assigned to different agents
- handoff turns where control moves from one agent to another
- review turns that inspect artifacts or item history from earlier turns
- refinement or redo turns after user feedback

The thread remains the durable container for the user's work. Agent sessions are runtime resources used to execute turns inside that thread.

## Parallel Work

Parallel work is represented by multiple turns inside one thread when each agent needs an independently observable execution unit.

Nested activity inside one agent may stay agent-private unless Core needs to schedule it, retry it, show it, approve it, audit it, or attach artifacts to it.

If a future feature needs first-class workflow or graph semantics beyond item causality, it belongs in `docs/core/agent-workflow.md`. It should not reintroduce `TaskRun` as a default core object.

## Handoff And Review

Handoff is a turn-level routing decision.

When one agent hands work to another, Core should represent the handoff as item-backed history and then start or route a turn to the next agent.

Review is also a normal turn. A reviewer agent reads thread history, artifacts, diffs, or workspace files and emits review items or artifacts.

This keeps implementation-review loops visible without creating a special run model.

## Lifecycle

Agent session lifecycle is runtime-specific but should map to common states:

```text
created -> initializing -> ready -> busy -> idle
                              |-> interrupted
                              |-> degraded
                              |-> suspended
                              |-> failed
                              |-> closed
```

Turn lifecycle is protocol-level and remains separate:

```text
pending -> running -> completed
          |       |-> interrupted
          |       |-> cancelled
          |       |-> failed
          |-> awaiting_human -> running | completed | cancelled | failed
```

A gate response always attaches to the same Turn, but only the owning accepted contract chooses its next status. Chat clarification may continue that Turn as `running`; a Task or Goal worker gate closes the old execution envelope and any later worker execution uses a new Turn.

An agent session can fail while a turn remains recoverable, and a turn can fail while the agent session remains reusable.

## Runtime Setup

Runtime setup begins from an agent catalog entry and agent setup config.

The conceptual flow is:

```text
AgentCatalogEntry
  -> agent setup config
  -> resolved setup
  -> materialized runtime setup
  -> AgentSession
  -> Turn
  -> Item[]
```

`resolved setup` and `materialized runtime setup` are implementation-layer records unless promoted by a future core document. Core docs should define the abstraction and compatibility rules before locking field names.

Core protocol records may expose only stable agent catalog entries, agent summaries, agent session summaries, capability summaries, readiness, status, and sandbox summaries.

Adapter-native launch config, runtime config snapshots, absolute local paths, worker-private paths, process commands, environment variables, provider wiring, and generated files remain implementation-layer data.

## Invariants

- A turn MUST be represented as the core execution unit instead of introducing `AgentRun` or `TaskRun` as default core objects.
- A worker-executed Turn MUST be assigned to one Agent Session. A Core-local service Turn may be sessionless only under the exact protocol exception; multiplexing remains a separate future runtime concern.
- Agent sessions MUST NOT replace thread history, item history, knowledge, or artifacts as the durable product record.
- Runtime-private task graphs, process handles, provider sessions, launch commands, and backend IDs MUST NOT leak into the core protocol as stable fields.
- Handoff, review, retry, and refinement MUST map back to thread, turn, item, artifact, approval, agent, and agent session records.

## Non-Core Names

OpenKit does not use `AgentRun` or `TaskRun` as core runtime concepts.

Product surfaces may introduce task-like or job-like read models for user comprehension, but those projections must map back to thread, turn, item, artifact, approval, agent, and agent session records.

Agent-private runtime terms may exist inside adapters. They should not leak into the core protocol unless intentionally promoted.
