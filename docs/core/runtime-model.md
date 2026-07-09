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

- Turns are the agent-bound execution unit; agent sessions are reusable runtime handles.
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
- process handles, container IDs, SSH sessions, or sidecar wire formats
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

These two relationships meet at `Turn`. A turn is the agent-bound execution unit. An agent session is the reusable communication and scheduling handle that executes one turn at a time unless a specific runtime later declares safe multiplexing semantics.

## Agent

`Agent` is the schedulable supply unit available to Core.

An agent answers what Core can choose for a turn. It provides identity, runtime binding, deployment mode, transport contract, profile set, capability summary, readiness summary, sandbox summary, permission summary, and policy summary.

Agent is not the raw adapter, process, model provider, tool server, sandbox backend, thread, or user-visible conversation.

## AgentProfile

`AgentProfile` is a behavior profile within agent setup.

It can represent a named mode such as coder, reviewer, researcher, browser operator, planner, subagent, handoff target, or tool-oriented agent.

An agent profile can define instructions, model preference within agent policy, skill set, capability subset, routing hints, review preferences, output style, and context injection hints.

Profiles cannot expand the parent agent policy. Core must resolve a selected profile before creating or reusing an agent session.

If setup config declares no profiles, it has one implicit default profile.

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

`AgentSession` is an initialized, reusable communication and scheduling handle between Core and an agent runtime.

An agent session can represent a live child process, local container agent, remote agent connection, provider sandbox session, or resumable runtime handle.

Agent session owns runtime liveness and effective setup identity. It may record:

- workspace affinity
- optional thread affinity
- selected agent and profile
- setup snapshot identity
- runtime kind and deployment mode
- effective capability summary
- effective sandbox summary
- health and readiness state
- resume handle or snapshot reference when supported

Agent session is not the bottom-level agent-running model. It does not require the agent to expose its private internal task graph.

## Turn

`Turn` is one execution unit inside a thread.

A turn is assigned to one agent session when it runs. An agent session may execute multiple turns over time.

A turn may be triggered by user input, system input, automation, retry, handoff, approval resolution, or running-work steering. These map to the closed `TurnTriggerSourceSchema` enum (`user-input`, `system-input`, `automation`, `retry`, `handoff`, `approval-resolution`, `running-work-steering`), which is authoritative; cron-style schedules fold into `automation`, and redo or refinement requests are expressed as `retry` or `user-input` turns rather than distinct trigger kinds.

Turn replaces `AgentRun` in the core model. Execution metadata belongs on the turn, agent session, item payloads, artifact records, approval records, or implementation telemetry.

## Item

`Item` is the append-only observation emitted during a turn.

Agents and adapters translate user-visible or protocol-visible runtime activity into items. Private runtime steps do not need to become items unless they are part of stable communication, replay, audit, approval, artifact lineage, or user-visible history.

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
                |-> awaiting_human -> running
                 |-> interrupted
                 |-> cancelled
                 |-> failed
```

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
- A turn MUST be assigned to one agent session when it executes unless a future runtime model explicitly promotes safe multiplexing semantics.
- Agent sessions MUST NOT replace thread history, item history, knowledge, or artifacts as the durable product record.
- Runtime-private task graphs, process handles, provider sessions, launch commands, and backend IDs MUST NOT leak into the core protocol as stable fields.
- Handoff, review, retry, and refinement MUST map back to thread, turn, item, artifact, approval, agent, and agent session records.

## Non-Core Names

OpenKit does not use `AgentRun` or `TaskRun` as core runtime concepts.

Product surfaces may introduce task-like or job-like read models for user comprehension, but those projections must map back to thread, turn, item, artifact, approval, agent, and agent session records.

Agent-private runtime terms may exist inside adapters. They should not leak into the core protocol unless intentionally promoted.
