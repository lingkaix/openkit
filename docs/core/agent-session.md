# Agent Session Model

Status: Accepted

This document defines OpenKit agent session semantics.

This document owns runtime continuity for initialized agent execution.

This document does not own agent supply declarations, agent capability routing, permission decisions, sandbox policy, durable work history, or reusable knowledge.

Agent session is runtime continuity. It is not knowledge, not a thread, not a turn, and not an agent-private task graph.

## Purpose

OpenKit agents may stay alive across many turns, preserve warm runtime state, resume after interruptions, or be replaced after failure.

The agent session model gives Core a stable way to represent that continuity without making it the user-facing work model.

User-visible work is still organized by:

```text
Workspace -> Thread -> Turn -> Item[]
```

Runtime continuity is represented by:

```text
Workspace -> AgentSession -> Turn
```

## Principles

- Agent sessions represent runtime continuity, not user-facing work history.
- Warm runtime state can improve execution, but it must not become hidden knowledge or a hidden product record.
- Session reuse should preserve safety, routing clarity, and item-history coherence.
- Session reuse MUST be decided against a stable compatibility envelope, not by merely finding any idle worker process.
- Resume, snapshot, fork, clone, and rollback are runtime continuity features, not implicit workspace, knowledge, or secret-copy features.
- Replacement of an agent session should preserve thread history through Core records, not hidden agent-private state.

## Agent Session Is Not Knowledge

Knowledge is reusable workspace understanding and learning.

Agent session is live or resumable runtime continuity.

Knowledge may be learned from work, reviewed by humans, edited, indexed, and injected into future relevant tasks.

An agent session may include warm process state, runtime handles, workspace mount state, sandbox state, provider session state, or resume tokens.

An agent session can be deleted without deleting knowledge. Knowledge-derived context can be injected into a new agent session.

## AgentSession

`AgentSession` is the core session concept for agent execution.

It is an initialized communication and scheduling handle between Core and an agent runtime.

It can represent:

- a local container agent
- a remote agent connection
- a managed sandbox session
- a runtime provider session
- a resumable serialized runtime handle

Agent session is a Core-to-agent control-plane concept. It is not the bottom-level model of how the agent internally executes tasks.

## Scope

An agent session belongs to one workspace.

An agent session may optionally be bound to:

- one agent
- one manifest and setup snapshot
- one selected profile
- one thread
- one sandbox instance
- one runtime backend
- one deployment target

Workspace affinity is required. Thread affinity is optional.

Long-lived workspace-scoped sessions can execute turns from multiple threads only if Core can preserve history, safety, and routing clarity. The default assumption is one active turn at a time per agent session.

## Lifecycle

Common agent session states:

```text
created
initializing
ready
busy
idle
degraded
suspended
interrupted
failed
closed
```

These 10 states are the product-visible/protocol projection (`AgentSessionStatus`). Runtime adapters may maintain a finer internal state machine (e.g. `AgentSessionState`: starting/idle/bound/running/awaiting_input/stopping/exited/failed) that maps onto these projected states.

These states describe runtime continuity, not turn completion.

An agent session can be `idle` while a thread has no active turn.

An agent session can be `failed` while the affected turn is retried on another session.

A turn can be `failed` while the session returns to `idle` and remains reusable.

## Turn Assignment

A turn is assigned to one agent session when it executes.

The agent session may be:

- newly created for the turn
- reused from the workspace
- reused from the same thread
- restored from a snapshot or resume handle
- replaced by a new session after failure

The turn records which agent session executed it. The agent session records current assignment and historical assignment summaries as needed by implementation.

## Session Compatibility

Session reuse is allowed only when the existing session's static runtime envelope covers the new turn.

The compatibility envelope includes runtime image, command shape, process identity, base working directory, control endpoint shape, workspace slot layout, static filesystem access envelope, provider attachment envelope, vault injection visibility class, network policy envelope, resource class, backend capability summary, and required features.

The compatibility envelope does not include turn payload digests, generated task content, current output files, transient upload handles, raw host paths, raw secrets, backend-native sandbox IDs, or worker-private cache contents.

Core may model this envelope as a `SessionCompatibilityKey` or equivalent metadata.

If a new turn requires static state that the existing session does not provide, Core should replace the session instead of mutating hidden runtime state.

Replacing a session is normal and must preserve user-visible thread history through Core records.

## Warm State

Agent sessions may keep warm state.

Examples:

- initialized model client
- loaded MCP tools
- local process state
- sandbox filesystem state
- checked-out workspace files
- mounted data
- static workspace slot layout
- dynamic slot contents materialized for recent turns
- authenticated provider session
- browser state
- adapter-specific runtime cache

Warm state is runtime state. It should not become knowledge unless Core explicitly extracts, reviews, and records it as knowledge.

Session-static workspace layout and turn-dynamic slot contents are different kinds of warm state.

The layout may be part of the compatibility envelope for reuse.

The slot contents may accelerate work, but they must not become workspace truth unless NanoCore imports, reviews, applies, or records them through the owning workspace synchronization and storage contracts.

## Snapshot And Resume

Some runtimes support snapshots, resume handles, or serialized state.

Core should model this as agent session capability and agent session metadata, not as a mandatory protocol feature for every agent.

Conceptual resume sources:

- keep the live session
- resume from runtime handle
- restore from snapshot
- start a fresh session from manifest and workspace inputs

Resume must preserve enough identity to explain which agent, manifest, setup snapshot, workspace state, and sandbox state were used.

## Fork, Clone, And Rollback

Fork, clone, and rollback are advanced agent session operations.

They may be useful for experiments, parallel attempts, review branches, reproducible debugging, or sandbox recovery.

If promoted later, they should be defined in terms of agent session state, workspace state, artifact lineage, and item history. They should not copy knowledge or secrets implicitly.

## Crash Recovery

If an agent session crashes, Core should decide whether to:

- mark the current turn failed
- retry the turn on a replacement session
- resume from snapshot
- ask the user for approval or clarification
- keep partial items and artifacts as history

Crash recovery policy belongs to Core and runtime adapters.

The item log should remain coherent even if the agent session fails.

## Replacement

An agent session may be replaced without replacing the thread.

Replacement is normal when a process crashes, a container is recreated, a remote agent is unavailable, a runtime version changes, or setup must be re-materialized.

The replacement agent session should preserve turn and item history by reading the thread, not by inheriting hidden agent-private state unless an explicit resume path exists.

## Invariants

- AgentSession MUST mean runtime continuity and Core-to-agent scheduling, not thread, chat, knowledge, or task.
- An agent session MUST belong to one workspace.
- A turn MUST record which agent session executed it when execution occurs.
- Agent sessions MUST NOT delete, copy, or mutate knowledge implicitly.
- Agent sessions MUST NOT require the agent to expose a private task graph.
- Snapshot, resume, fork, clone, and rollback MUST NOT copy secrets or knowledge implicitly.
- Agent session reuse MUST NOT bypass manifest resolution, AEP compatibility, workspace synchronization, vault, permission, sandbox, audit, or required-feature checks.
- Agent sessions MUST NOT treat unimported sandbox files, backend mounts, provider sessions, or worker-private caches as canonical workspace truth.
