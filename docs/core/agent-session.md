---
status: Accepted
---
# AgentSession Model

This document defines the Core identity and continuity rules for `AgentSession`.

It owns AgentSession meaning, Thread cardinality, durable identity, current selection, replacement, and the boundary between continuity and product-visible work.

It does not own Agent supply, capability routing, permission decisions, Turn or Item history, scheduling capacity, Harness or Sandbox lifecycle, native adapter protocol, transport recovery, or reusable knowledge.

## Canonical Term

`AgentSession` is a proper OpenKit item name. English prose, comments, diagnostics, and test descriptions that refer to this item MUST use `AgentSession` or `AgentSessions`; spaced, bare, and hyphenated prose variants are not synonyms.

Language-conventional identifiers such as `agentSession`, `agentSessionId`, and schema-required `agent_session_id` are allowed. Wire values, route segments, filenames, storage paths, and enum values may retain their syntax-required encoding, but they do not define alternative product terms.

## Definition And Exclusions

`AgentSession` is Core's hidden runtime-continuity identity for one independently governed native agent conversation. It is bound to exactly one Workspace and one Thread for its whole life and may execute multiple sequential Turns from that Thread.

AgentSession is not a Thread, Turn, Item, user-visible conversation, user-selectable session, physical connection, Agent process, Harness Instance, Sandbox, scheduler lease, Runtime Epoch, or native provider handle. A network reconnect or process restart does not by itself create a new AgentSession, and sharing a Harness or Sandbox does not merge AgentSessions.

User-visible work remains:

```text
Workspace -> Thread -> Turn -> Item[]
```

AgentSession is an internal continuity dimension that intersects this model when a worker executes a Turn. It does not contain a Turn and a Turn does not contain an AgentSession.

Internal roles such as Assistant and Goal Orchestrator run no worker runtime and have no AgentSession.

## Product Boundary

Ordinary product surfaces expose continuing the current Thread or creating a new Thread. They MUST NOT expose an AgentSession picker, AgentSession creation action, AgentSession history, AgentSession identifier, or native conversation handle.

The product may expose product-safe runtime availability and the authoritative outcome of a Turn. Operator diagnostics and audit evidence may carry a redacted AgentSession lineage when needed for support, recovery, or accountability, but that lineage is not navigation or user authority.

Replacing an AgentSession is therefore an internal runtime action. It never creates a new user-visible conversation and never changes the identity or history of the bound Thread.

## Cardinality And Current Authority

A Thread may have zero or more historical AgentSessions and at most one current authoritative AgentSession.

The current AgentSession is the only AgentSession that may receive a newly authorized Turn for that Thread. Historical predecessors remain evidence and MUST NOT be reopened or reused.

Before a successor becomes current, the predecessor MUST be terminal and non-reusable, and its runtime binding MUST be closed or fenced against further effects. A temporary state with no current AgentSession is valid. Two current AgentSessions for one Thread are never valid.

A Harness Instance may host multiple AgentSessions only when they belong to distinct Threads. Each retains independent identity, authorization, sequence, cancellation, evidence, native conversation, and terminal outcome.

Each AgentSession has at most one active Turn. The Thread single-flight rule independently permits at most one active Turn for that Thread.

## Durable Authority And Projections

Core's durable AgentSession record is the unique authority for AgentSession identity, Workspace and Thread binding, lifecycle status, and current-or-historical selection. Runtime, scheduler, Harness, Sandbox, transport, and adapter records are projections or dependent authorities for their own concerns; none may create a second current AgentSession or infer continuity from co-location.

`NativeConversationHandle` is restricted adapter metadata for exact native-conversation continuity. It MUST NOT become a Thread identifier, public AgentSession field, authorization input, Workspace truth, or ordinary diagnostic value.

Process identity is not continuity authority. A later Turn may start a new native process and resume the exact restricted handle while keeping the same AgentSession. If exact native continuity cannot be proved, the process cannot claim that AgentSession's continuity.

## Lifecycle

### Creation

Creation succeeds only after Core binds the exact Workspace and Thread, confirms that the Thread has no current AgentSession, and validates every Agent, authorization, compatibility, and runtime dependency required by the selected path. A missing or conflicting dependency fails closed without creating a usable AgentSession.

### Exact Reconnect

A physical connection may reconnect without changing AgentSession identity only when the runtime proves the same AgentSession, active Turn when present, scheduler lease, worker identity, immutable adapter mode, authorization lineage, and next protocol sequence under the accepted reconnect contract.

An exact reconnect changes connection generation. It does not create a successor AgentSession, replay a Turn, or replace Core history.

### Sequential Turn Reuse

An idle current AgentSession may receive a later Turn from its bound Thread when compatibility, authorization, native-handle readiness, and all scheduling gates pass. The later Turn may use a new process that resumes the exact NativeConversationHandle.

Reuse MUST NOT bypass manifest resolution, workspace synchronization, vault, permission, audit, evidence, scheduling, or required-feature checks. Matching configuration or shared placement alone is not proof of reuse safety.

### Replacement

Core creates a successor AgentSession only after the predecessor is terminal and its runtime binding is closed or fenced. The successor is bound to the same Thread, becomes the sole current AgentSession atomically with predecessor retirement, and starts with fresh authorization and compatibility checks.

Replacement may follow continuity loss, incompatible runtime requirements, explicit close, or recovery that cannot prove exact continuity. The successor reconstructs user-visible context from Core-owned Thread history and MUST NOT inherit unproved native state.

An active Turn is never moved, resumed, or replayed through a successor AgentSession. If continuity is lost during an active Turn, that Turn remains interrupted, failed, unknown, or `recovery_required` under its existing owner. Only a new authorized Turn may run on the successor.

### Termination

Closing or terminal failure ends AgentSession reuse and its restricted native conversation without deleting the Thread, Turns, Items, accepted outputs, or a compatible shared Sandbox. Ordinary termination closes only the AgentSession-local runtime binding and resources owned by that binding.

Sandbox or Runtime Epoch invalidation may affect several AgentSessions at once, but their identities and outcomes remain independent. Shared failure does not create shared continuity or let one AgentSession's cleanup proof stand for another.

### Retry And Recovery

An operation may retry only through its existing owner and immutable identity. Retrying connection establishment may preserve the AgentSession only through exact reconnect proof; retrying a new user request may create a successor only after the predecessor retirement rule holds.

After Core restart, recovery derives current selection from durable AgentSession records and validates every dependent runtime binding before use. Missing, stale, conflicting, duplicated-current, or dependency-failed state is fenced from execution. Recovery never chooses a winner from two purported current AgentSessions by recency or runtime liveness.

When exact continuity cannot be proved, Core preserves the prior Turn's truthful outcome, retires or fences the affected AgentSession, and may create one successor for a new authorized Turn. Snapshot restore, generic resume selection, fork, clone, and rollback are not authorized mechanisms.

## Warm State And Knowledge

AgentSession may retain warm process, provider, tool, browser, filesystem, or adapter state. Warm state is runtime state, not Core work history or reusable knowledge.

Only Core-owned import, review, storage, and knowledge mechanisms may turn accepted outputs into Workspace truth or reusable knowledge. Closing an AgentSession neither deletes knowledge nor silently promotes its private state.

## Runtime-Internal Child Activity

A worker may create private child processes, tool loops, provider sessions, or sub-agents beneath one AgentSession and Turn. They remain private provenance while they need no independent permission, budget, scheduling, retry, recovery, review, user-visible ownership, or terminal status.

When child activity needs any of those responsibilities, NanoCore MUST prospectively admit separately governed work. Concurrent governed work requires a distinct Thread and therefore a distinct AgentSession.

## Observable Acceptance

The AgentSession model is accepted only when observable evidence proves all of the following:

- ordinary user surfaces offer continue-Thread and new-Thread behavior without exposing AgentSession selection, identity, history, or native handles
- one Thread can accumulate historical AgentSessions but can never have more than one current AgentSession
- successor admission atomically retires and fences its predecessor before the successor becomes current
- exact transport reconnect preserves AgentSession, active-Turn, lease, worker, mode, and sequence identity
- a later Turn can reuse the current AgentSession only after exact native-handle readiness and existing authorization and scheduling gates pass
- active-Turn continuity loss preserves a truthful terminal or uncertain outcome and does not replay that Turn through a successor
- two distinct Threads can retain independent AgentSessions in one compatible Harness without sharing authority, native state, cancellation, evidence, or outcome
- missing, stale, conflicting, duplicate-current, restart, and dependency-failure cases fail closed without inferred continuity
- ordinary AgentSession close removes its local binding without requiring deletion of a compatible shared Sandbox

## Invariants

- AgentSession MUST mean the hidden Core runtime-continuity identity defined here.
- An AgentSession MUST remain bound to exactly one Workspace and one Thread.
- A Thread MUST have at most one current AgentSession and MAY retain historical predecessors.
- An AgentSession MUST have at most one active Turn, and an active Turn MUST execute through exactly one AgentSession.
- A connection, process, native handle, Harness, Sandbox, Runtime Epoch, or lease MUST NOT replace AgentSession identity.
- A successor MUST NOT become current before its predecessor is terminal, non-reusable, and runtime-fenced.
- An active Turn MUST NOT move between AgentSessions or be replayed as continuity.
- Sharing runtime infrastructure MUST NOT merge AgentSession identity, authority, context, cancellation, evidence, or outcome.
- AgentSession reuse MUST NOT bypass existing authorization, compatibility, scheduling, workspace, vault, permission, audit, or evidence owners.
- Ordinary product surfaces MUST NOT expose AgentSession as a conversation or user action.
