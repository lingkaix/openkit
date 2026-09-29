---
status: Accepted
updated: 2026-09-30
---
# AgentSession Model

This document defines the Core identity and continuity rules for `AgentSession`.

It owns AgentSession meaning, Thread cardinality, durable identity, current selection, replacement, the retained native conversation's association with its Thread, and the boundary between continuity and product-visible work.

It does not own Agent supply, capability routing, permission decisions, Turn or Item history, scheduling capacity, Harness or Sandbox lifecycle, native adapter protocol, transport recovery, or reusable knowledge.

## Canonical Term

`AgentSession` is a proper OpenKit item name. English prose, comments, diagnostics, and test descriptions that refer to this item MUST use `AgentSession` or `AgentSessions`; spaced, bare, and hyphenated prose variants are not synonyms.

Language-conventional identifiers such as `agentSession`, `agentSessionId`, and schema-required `agent_session_id` are allowed. Wire values, route segments, filenames, storage paths, and enum values may retain their syntax-required encoding, but they do not define alternative product terms.

## Definition And Exclusions

`AgentSession` is Core's hidden identity for one authorized active execution binding of a Thread's retained native agent conversation on one admitted runtime host instance ([decision](../decisions/20260929-agent_session_is_an_execution_binding.md)). It is bound to exactly one Workspace and one Thread for its whole life, and it executes that Thread's sequential Turns for as long as the binding lasts. Completing a Turn leaves the binding available for the next Turn; it does not close the AgentSession or stop the runtime.

A runtime host instance is either a dedicated conversation process or a shared server that hosts several native conversations. The binding is the authorized activation of one native conversation on that instance, so it is not an operating-system process: a dedicated process and a native conversation inside a shared server are both bindings.

AgentSession is not a Thread, Turn, Item, user-visible conversation, user-selectable session, physical connection, Agent process, runtime host, Harness Instance, Sandbox, scheduler lease, Runtime Epoch, native conversation, or native provider handle. A transport reconnect to the same surviving binding does not create a new AgentSession. Loss of the runtime host instance ends every binding it hosted, and a later binding is a successor AgentSession. Sharing a runtime host, Harness, or Sandbox does not merge AgentSessions.

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

## Retained Native Conversation

A Thread's retained native conversation is the runtime-maintained conversation state, including messages, compaction state, and other native context, kept in the retained work environment across AgentSessions. The native runtime remains the authority for its content and compaction.

Its native resume reference identifies the runtime kind and the exact native conversation. It is restricted adapter metadata associated with the Thread:
- The raw reference stays inside the retained Sandbox storage boundary.
- Core retains only a non-secret digest, and a successor's resume must match that digest exactly.
- The reference selects context and grants no execution authority. Possession of retained files does not authorize resume.
- It MUST NOT become a Thread identifier, public AgentSession field, authorization input, Workspace truth, or ordinary diagnostic value.

Binding identity is not process identity. Sequential Turns of one AgentSession run in the same live binding. A new runtime host instance, whether it follows a close, a crash, or a host restart, is a new binding and therefore a successor AgentSession. That successor continues the Thread's native context only through native resume of the exact retained reference.

Uniform resume semantics do not imply conversion between runtimes. A Codex conversation resumes only through Codex and a Pi conversation only through Pi. Switching a Thread's runtime is an explicit separate operation, which starts a new native conversation.

## Lifecycle

### Creation

Creation succeeds only after Core binds the exact Workspace and Thread, confirms that the Thread has no current AgentSession, and validates every Agent, authorization, compatibility, and runtime dependency required by the selected path. A missing or conflicting dependency fails closed without creating a usable AgentSession.

### Exact Reconnect

A physical connection may reconnect without changing AgentSession identity only when the runtime proves the same AgentSession, the same surviving runtime host instance and binding, the active Turn when present, scheduler lease, worker identity, authorization lineage, and next protocol sequence under the accepted reconnect contract. A reconnect to a shared host restores only the bindings it validates, never blanket authority over every conversation on that host.

An exact reconnect changes connection generation. It does not create a successor AgentSession, replay a Turn, or replace Core history.

### Sequential Turn Reuse

An idle current AgentSession may receive a later Turn from its bound Thread in the same live binding when compatibility, authorization, binding readiness, and all scheduling gates pass. Each Turn still receives current configuration and authority. A setup change that the live binding cannot apply at the Turn boundary, such as a process-global configuration change or a tool-surface change the adapter cannot refresh, requires a successor AgentSession, which resumes the same native conversation.

Reuse MUST NOT bypass manifest resolution, workspace synchronization, vault, permission, audit, evidence, scheduling, or required-feature checks. Matching configuration or shared placement alone is not proof of reuse safety.

### Replacement

Core creates a successor AgentSession only after the predecessor is terminal and its runtime binding is closed or fenced. The successor is bound to the same Thread, becomes the sole current AgentSession atomically with predecessor retirement, and starts with fresh authorization and compatibility checks.

Replacement may follow an explicit or idle close, loss of the runtime host instance, a setup change the live binding cannot apply, or recovery that cannot prove the surviving binding. The successor opens a new binding, then resumes the Thread's exact retained native conversation, and only after the resume succeeds does it receive work. Resume restores context; it never reruns the predecessor's last Turn, and replaying native history for display MUST NOT append duplicate canonical Items.

When the Thread has no retained native conversation, as on its first binding or after an explicit runtime switch, the successor starts a new native conversation, whose context comes from Core-owned Thread history. A missing, corrupt, incompatible, or mismatched retained conversation is an explicit resume failure. It MUST NOT be silently replaced by a new empty conversation or by reconstruction from visible messages, and the successor MUST NOT inherit unproved native state. Absence of an expected reference is a resume failure, never permission to start fresh.

An active Turn is never moved, resumed, or replayed through a successor AgentSession. If continuity is lost during an active Turn, that Turn retains the truthful result its lifecycle owner determined. Effect uncertainty and any recovery requirement are expressed by the effect owner and the recovery owner respectively, and interruption MUST NOT infer that an effect did not happen. Only a new authorized Turn may run on the successor.

### Termination

Closing or terminal failure ends AgentSession reuse and its binding without deleting the Thread, Turns, Items, accepted outputs, the retained native conversation, or a compatible shared Sandbox. Ordinary termination closes only the AgentSession-local binding and resources owned by that binding:
- **Dedicated process.** Closing stops the bound work and terminates that conversation process.
- **Shared host.** Closing stops the conversation's admitted work, revokes its routes and callbacks, and detaches or unloads it where the runtime supports that, while the host and sibling AgentSessions continue. An unsubscribe response alone is not evidence that work stopped. The adapter MUST prove that the released binding can produce no further effect under the old authority.
- **Late events.** A delayed event from a released binding MUST NOT be attributed to a successor merely because the native conversation identity is the same. Attribution uses a drained event boundary or native request correlation, and ambiguous attribution stays unresolved rather than becoming success.

NanoCore MAY close an idle AgentSession under an explicit idle-reclamation policy. Time away from the browser is not proof of idleness, and active Turns, compaction, and owned background work MUST be considered first. No idle threshold is defined yet. Closing an AgentSession does not end the Thread's pending requests.

Sandbox or Runtime Epoch invalidation may affect several AgentSessions at once, but their identities and outcomes remain independent. Shared failure does not create shared continuity or let one AgentSession's cleanup proof stand for another.

### Retry And Recovery

An operation may retry only through its existing owner and immutable identity. Retrying connection establishment may preserve the AgentSession only through exact reconnect proof; retrying a new user request may create a successor only after the predecessor retirement rule holds.

After Core restart, recovery derives current selection from durable AgentSession records and validates every dependent runtime binding before use. Missing, stale, conflicting, duplicated-current, or dependency-failed state is fenced from execution. Recovery never chooses a winner from two purported current AgentSessions by recency or runtime liveness.

When exact continuity cannot be proved, Core preserves the prior Turn's truthful outcome, retires or fences the affected AgentSession, and may create one successor for a new authorized Turn. Snapshot restore, generic resume selection, fork, clone, and rollback are not authorized mechanisms.

## Retained Files Across Execution Replacement

AgentSession termination revokes its live binding and native continuation authority; it MUST NOT erase its associated retained working volumes. [Storage](storage.md) owns whole-volume persistence, including native histories, memory and configuration without a file-type allowlist. A successor in the same authorized work environment may access retained files as data after predecessor writers are fenced. Reattachment alone does not establish exact native continuity, authorize last-session discovery, move an active Turn, or promote native memory to Core Knowledge. Runtime-generated credentials and control material remain request-private and are refreshed separately.

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
- two consecutive Turns of one AgentSession run in the same live binding and native conversation, and the second model request uses the first Turn's context
- a later Turn can reuse the current AgentSession only after binding readiness and existing authorization and scheduling gates pass
- a close releases the binding while preserving native context and files; in a shared host, the host and sibling AgentSessions keep working
- a successor AgentSession resumes the exact retained native conversation, and missing or corrupt resume data produces an explicit failure rather than an empty conversation presented as continued
- late output or requests from a released binding never attach to its successor
- active-Turn continuity loss preserves a truthful terminal or uncertain outcome and does not replay that Turn through a successor
- two distinct Threads can retain independent AgentSessions in one compatible Harness without sharing authority, native state, cancellation, evidence, or outcome
- missing, stale, conflicting, duplicate-current, restart, and dependency-failure cases fail closed without inferred continuity
- ordinary AgentSession close removes its local binding without requiring deletion of a compatible shared Sandbox

## Invariants

- AgentSession MUST mean the hidden Core execution-binding identity defined here.
- An AgentSession MUST remain bound to exactly one Workspace and one Thread.
- A Thread MUST have at most one current AgentSession and MAY retain historical predecessors.
- An AgentSession MUST have at most one active Turn, and an active Turn MUST execute through exactly one AgentSession.
- A connection, process, native handle, Harness, Sandbox, Runtime Epoch, or lease MUST NOT replace AgentSession identity.
- A successor MUST NOT become current before its predecessor is terminal, non-reusable, and runtime-fenced.
- An active Turn MUST NOT move between AgentSessions or be replayed as continuity.
- A successor MUST continue a Thread's native context only through native resume of the exact retained reference, and a failed resume MUST NOT be silently replaced by a new conversation.
- Sharing runtime infrastructure MUST NOT merge AgentSession identity, authority, context, cancellation, evidence, or outcome.
- AgentSession reuse MUST NOT bypass existing authorization, compatibility, scheduling, workspace, vault, permission, audit, or evidence owners.
- Ordinary product surfaces MUST NOT expose AgentSession as a conversation or user action.
