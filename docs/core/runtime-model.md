---
status: Accepted
---
# Runtime Model

This document defines OpenKit runtime semantics.

This document owns how agents, profiles, runtimes, AgentSessions, turns, and items relate during execution, including the execution-substrate lifecycle that binds runtime effects to those product owners.

This document does not own agent-native protocols, process launch arguments, database tables, app endpoints, complete agent setup fields, agent capability routing, permission policy, sandbox containment, or reusable knowledge semantics.

It explains the execution model without making runtime-native details part of the core product model.

## Purpose

OpenKit must support many concurrent agents for one user, from short interactive tasks to long-running work that may last for days.

A single user request, instruction, automation, or cron trigger may involve one agent, many agents in parallel, agent handoff, implementation and review loops, or later refinement after a deliverable is produced.

The runtime model keeps those workflows inside the stable `Workspace -> Thread -> Turn -> Item[]` backbone instead of introducing a parallel suite of run objects.

## Principles

- Worker-executed Turns are agent-bound execution units; AgentSessions are reusable runtime handles distinct from the private execution-substrate epochs that may host them. Core-local service Turns may remain sessionless only under the narrow protocol exception.
- Runtime details may be observed through items, artifacts, audit, and summaries, but private runtime state is not the user-facing work model.
- Core schedules work at thread and turn boundaries before it reasons over runtime-native task graphs.
- Runtime placement and backend selection are projections; they must not change the stable `Workspace -> Thread -> Turn -> Item[]` backbone.
- AgentSessions may preserve warm state, but warm state is not knowledge unless Core extracts, reviews, and records it through the knowledge boundary.

## Substrate Doctrine

These four rules govern every execution substrate Core will ever admit, not one implementation of one. They exist here because each was previously re-derived in more than one place, and a doctrine that is re-derived is a doctrine that drifts.

**An execution substrate collects execution facts; Core accepts product facts.** Between those two verbs there is a third that must never be silently merged into either: normalization. Turning runtime-native activity into OpenKit record shapes is adaptation, and it happens where the runtime-native detail lives. Normalized output is therefore a candidate claim, and Core's acceptance is a separate act of verification that may reject it. A substrate MUST NOT normalize, and a normalizer MUST NOT accept.

**Push work down, not authority.** A substrate may hold effects, bytes, caches, materializations, and processes that Core no longer touches, and none of that makes it a decision owner. It owns exactly one authority: the truth about its own local effects. Only the substrate can prove that an effect it accepted reached a definite result, so Core MUST accept that proof and MUST NOT infer it — and that authority is non-transferable in the other direction too, because the substrate MUST NOT extend it into product meaning, terminal status, permission, review, or completion. An unprovable local effect is therefore a substrate-level failure, not a product-level guess.

**Move bytes, not truth.** A substrate may move, stage, buffer, and discard bytes freely, and no byte becomes truth by arriving. Evidence is the sharp case, because evidence is bytes that look like truth: evidence MAY explain a decision and MUST NOT make one. No readiness, capacity, recovery, review, or terminal decision may depend on a substrate's private record.

**Buffer what you produce; never cache what you were granted.** A substrate MAY hold bounded quantities of the facts it produces while they await acceptance, because those bytes are not yet truth and holding them costs nothing but space. It MUST NOT cache the authority it received. A cached authorization, policy decision, capability grant, or lease state turns every stale read into a decision made on old truth. Where a substrate legitimately needs to act without asking again, the correct instrument is an immutable grant with an explicit deadline, which is not a cache and MUST NOT acquire invalidation, refresh, or fallback semantics.

## Boundary

The runtime model owns:

- the distinction between agent, profile, runtime, and AgentSession
- how turns are assigned to AgentSessions
- how execution substrates are created, admitted, observed, interrupted, terminated, cleaned, recovered, or replaced
- how one private execution-substrate epoch may host multiple distinct AgentSessions from distinct Threads while retaining one failure and cleanup boundary
- how substrate liveness and assignment relate to AgentSession continuity and Turn execution
- how runtime observations become items, and the separation between collecting, normalizing, and accepting them
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
  supplied through AgentManifest
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

These two relationships meet at a worker-executed `Turn`. AgentSession is the hidden runtime-continuity identity for one independently governed worker conversation, is bound to one Thread, and executes at most one worker Turn at a time. A Thread may retain historical AgentSessions but has at most one current AgentSession. A Core-local workflow or Assistant service that owns no worker, scheduler, Sandbox, or runtime effect may produce a Turn without AgentSession under `protocol.md`; that Turn does not enter the runtime relationship above.

## Agent

`Agent` is the schedulable supply unit available to Core.

An agent answers what Core can choose for a turn. It provides identity, runtime binding, deployment mode, transport contract, profile set, capability summary, readiness summary, sandbox summary, permission summary, and policy summary.

Agent is not the raw adapter, process, model provider, tool server, sandbox backend, thread, or user-visible conversation.

## AgentProfile

`agent-supply.md` owns the `AgentManifest` and `AgentProfile` definitions. Runtime consumes their resolved projection before creating or reusing an AgentSession.

The selected profile may influence runtime inputs but cannot expand the parent agent policy.

## Runtime

`Runtime` is the execution substrate that materializes and manages AgentSessions.

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

`agent-session.md` owns the `AgentSession` definition, one-current-per-Thread rule, and continuity semantics. Runtime owns how that projection binds runtime liveness and execution to worker Turns.

Runtime observes liveness, effective setup identity, placement, capabilities, sandbox state, and health through that session projection without exposing the agent's private task graph.

## Runtime Placement Boundaries

Runtime placement decomposes into four distinct private projections:

- a Sandbox runtime projection identifies one containment and aggregate-resource boundary whose conversation-context, Workspace-write, or security and adjudication isolation level remains owned by `sandbox.md`;
- a Harness runtime projection identifies one declared native-runtime adapter, its liveness, supported AgentSession operations, and bounded open-session and active-Turn capacity inside that Sandbox;
- an AgentSession runtime binding maps one Core AgentSession to one exact Harness and restricted native conversation handle;
- an execution lease binds one active Turn, its fresh authority and inputs, and one active-Turn capacity unit to that AgentSession, Harness, and Sandbox.

These projections MUST NOT be collapsed into one backend record. A shared Sandbox or Harness MAY host multiple AgentSessions only for distinct Threads, but sharing placement MUST NOT merge Core identity, Thread affinity, native conversation context, authorization, sequence, interruption, output, evidence, or terminal outcome. A Harness is not an Agent, Thread, workflow owner, scheduling authority, or product conversation.

Creation proceeds from Sandbox and Harness readiness, through exact AgentSession binding, to a separately admitted Turn lease. An idle AgentSession may retain continuity and open-session capacity without retaining an execution lease or authority to start work. Each new Turn receives current admission independently of any warm placement.

Normal Turn termination releases its active-Turn capacity only after the Turn's output, evidence, route-revocation, and cleanup barriers settle. Normal AgentSession termination releases its open-session capacity after exact local cleanup and leaves compatible siblings resident. Harness or Sandbox termination drains new admission and settles each resident AgentSession independently before its complete effect boundary is fenced.

A missing, stale, conflicting, or unprovable binding blocks admission or reuse. Restart may adopt only the exact surviving Sandbox, Harness, AgentSession, native conversation, Turn, lease, authority snapshot, and sequence under an accepted proof contract; otherwise cleanup and a fresh authorized request replace continuity without rewriting the prior attempt. Failure to prove local cleanup widens the fence to the Harness, Sandbox, or execution-substrate epoch boundary that can be proved complete.

Observable conformance requires one runtime inventory to distinguish all four projections, an idle AgentSession to hold no active-Turn lease, exact local close to preserve a compatible sibling, and every active Turn to retain its own current authority and terminal outcome.

## Turn

`core-concepts.md` owns the `Turn` definition, and `protocol.md` owns its lifecycle and trigger vocabulary. Runtime owns assignment: a Turn run by a schedulable Agent is assigned to one AgentSession, and one current AgentSession may execute multiple sequential Turns from its bound Thread. A Core-local service Turn uses `agentSessionId=null` only under the protocol exception and MUST NOT be presented as worker execution or runtime continuity.

Turn replaces `AgentRun` in the core model. Execution metadata belongs on the turn, AgentSession, item payloads, artifact records, approval records, or implementation telemetry.

## Item

Runtime observations that require stable communication, replay, audit, approval, artifact lineage, or user-visible history are persisted as `Item` records under the Core Concepts definition.

Agents and adapters translate user-visible or protocol-visible runtime activity into items. Private runtime steps do not need to become items.

Task graphs, tool retries, chain-of-thought internals, process logs, native SDK traces, and scheduler traces remain private unless intentionally projected as item summaries or diagnostics.

## Scheduling Model

Core schedules work at the thread and turn level.

A thread may contain:

- sequential turns by the same agent
- sequential review, retry, redo, or refinement turns by a different agent when responsibility, addressee, and execution classification remain unchanged
- sequential turns by replacement AgentSessions for the same agent
- review turns that inspect artifacts or item history from earlier turns
- refinement or redo turns after user feedback

The Thread remains one single-flight durable narrative. Handoff creates a linked Thread for the receiving execution rather than changing the writer inside the originating Thread. Historical AgentSessions may have executed its sequential Turns, but only the current AgentSession may receive another worker Turn.

## Parallel Work

Parallel work is represented by multiple Threads, each with at most one Turn in flight. Each concurrently scheduled Goal worker execution receives its own Thread and AgentSession, even when the executions use the same Agent or share a compatible runtime substrate.

The Goal Main Thread remains the narrative addressed to the Goal Orchestrator. It retains one reference Item for each worker execution, naming that execution's Thread and current lineage, and MUST NOT accumulate the worker Thread's Items. Results and evidence remain owned by the worker execution's records and are read through the Goal workflow's authorized mechanisms.

The reference Item is created and finalized only after Core accepts the worker execution's exact Thread and initial Turn lineage. Its identity, target Thread, and named execution lineage are immutable once written; progress, Items, results, and later lifecycle changes remain in the referenced execution records and MUST NOT update or mirror into the Goal Main Thread.

Retry or recovery preserves the prior reference Item and its lineage. Because retry or recovery creates a new Turn under fresh admission, the Goal Main Thread appends a new reference Item for that new worker execution and links it through ordinary causation rather than retargeting the prior Item or reconstructing worker history.

A missing dependency blocks reference-Item creation. After creation, a missing, inaccessible, stale, or contradictory execution-Thread or lineage target leaves the immutable reference unresolved and MUST fail closed in projections as unresolved lineage; Core MUST NOT infer a current execution, copy or reconstruct worker Items, retarget the reference, or claim worker status, evidence, or results from another record. Restart applies the same validation from durable Thread, Turn, and Item records. Observable conformance requires exactly one finalized reference Item for each admitted Goal worker execution and requires that Item either resolve to its exact Thread and lineage or project the unresolved failure explicitly without mirrored worker history.

Runtime-native child or sub-agent activity remains private runtime activity or evidence lineage under the outer governed execution. A native parent-child relationship alone MUST NOT create an OpenKit Agent, AgentSession, or Turn; those owners exist only when Core explicitly schedules a separately governed execution.

## Handoff And Review

Handoff is an Item-backed routing decision between Threads.

When one agent hands work to another, Core preserves the originating Thread, appends its handoff Item, and routes the receiving execution to the new linked Thread in its owning Workspace.

Review is also a normal turn. A reviewer agent reads thread history, artifacts, diffs, or workspace files and emits review items or artifacts.

This keeps implementation-review loops visible without creating a special run model.

## Execution-Substrate Lifecycle

`protocol.md` owns the closed protocol AgentSession and Turn lifecycle enums. AgentSession identity remains hidden from ordinary product navigation and action. `agent-session.md` owns continuity interpretation. Runtime owns the separate execution-substrate lifecycle and must bind every substrate effect to those existing owners without creating another product workflow.

An execution-substrate runtime epoch is the private lifecycle and failure boundary within which a runtime may host zero or more Sandboxes and AgentSessions. It is not a Core product record, protocol lifecycle, public identifier, scheduling object, or replacement for AgentSession identity. Multiple AgentSessions from distinct Threads may share one compatible epoch without sharing identity, lineage, authorization, Workspace truth, or Turn history.

The substrate lifecycle has these responsibilities:

1. Creation and admission resolve the current Agent supply, policy, sandbox, workspace, credential, capability, placement, and capacity requirements before effect-capable execution starts. Missing or failed mandatory dependencies block admission.
2. Liveness and assignment bind the admitted substrate to the exact AgentSession and worker Turn, observe health, and prevent an unproved or incompatible substrate from impersonating the assigned execution.
3. Interruption preserves the existing Turn, AgentSession, evidence, and effect uncertainty when liveness or control is lost. A known stop does not by itself prove whether an external effect occurred, and an unprovable outcome must not be guessed or replayed automatically.
4. Ordinary AgentSession termination revokes that AgentSession's control and removes only its local runtime binding and owned resources. It preserves a compatible shared Sandbox and epoch when exact local cleanup and continued sibling safety are proved.
5. Epoch invalidation interrupts every affected AgentSession, fences all capacity owned by that epoch, terminates the complete effect-capable failure domain, and prevents member-local recovery or reuse. An accepted create or delete whose completion cannot be proved, or failure of any effect-capable member, MUST invalidate the owning epoch.
6. Recovery may adopt only the exact surviving execution under an accepted proof contract. Otherwise it completes existing cleanup and preserves interruption or uncertainty. An invalid epoch may return capacity only after the prior effect domain is fenced and a fresh compatible epoch is proved ready and free of prior mutable execution state. Replacement and retry require a fresh authorized request and do not rewrite the prior attempt.
7. Dependency failure before admission blocks launch. Dependency failure after admission follows the same interruption, evidence, cleanup, and fresh-request boundaries; runtime must not synthesize authority or a successful terminal result.

A gate response always attaches to the same Turn, but only the owning accepted contract chooses its next status. Chat clarification may continue that Turn as `running`; a Task or Goal worker gate closes the old execution envelope and any later worker execution uses a new Turn.

An execution substrate can fail while a Turn remains inspectable or eligible for a separately authorized retry, and a Turn can fail while an AgentSession remains reusable only when the owning runtime can prove that reuse is safe. Failure of one shared epoch may interrupt multiple AgentSessions, but it MUST NOT merge their identities, lineages, evidence, or terminal outcomes.

## Runtime Setup

`agent-supply.md` owns the authored `AgentManifest`. Runtime setup begins only after Core selects that manifest through an agent catalog entry.

The conceptual flow is:

```text
AgentCatalogEntry
  -> selected AgentManifest
  -> resolved setup
  -> materialized runtime setup
  -> AgentSession
  -> Turn
  -> Item[]
```

`resolved setup` and `materialized runtime setup` are implementation-layer records unless promoted by a future core document. Core docs should define the abstraction and compatibility rules before locking field names.

Core protocol records may expose stable Agent catalog entries, product-safe runtime availability, capability summaries, readiness, status, and Sandbox summaries. AgentSession identity and lineage may appear only in authorized internal protocol, audit, or operator diagnostics and not as ordinary product navigation or action.

Adapter-native launch config, runtime config snapshots, absolute local paths, worker-private paths, process commands, environment variables, provider wiring, and generated files remain implementation-layer data.

## Invariants

- A turn MUST be represented as the core execution unit instead of introducing `AgentRun` or `TaskRun` as default core objects.
- A worker-executed Turn MUST be assigned to one AgentSession. A Core-local service Turn may omit AgentSession only under the exact protocol exception.
- Runtime MUST NOT admit more than one in-flight Turn in a Thread or AgentSession; concurrent work MUST use distinct Threads and AgentSessions.
- Runtime MUST keep Sandbox, Harness, AgentSession binding, and active Turn lease as distinct private projections; placement sharing MUST NOT become identity, authority, lineage, or outcome sharing.
- An idle AgentSession MAY consume open-session capacity but MUST NOT retain an active-Turn lease or authority to begin another Turn.
- Concurrent Goal worker Items MUST remain in their execution Threads; the Goal Main Thread MUST retain references rather than copied worker history.
- AgentSessions MUST NOT replace Thread history, Item history, Knowledge, or Artifacts as the durable product record.
- Runtime-private task graphs, process handles, provider sessions, launch commands, and backend IDs MUST NOT leak into the core protocol as stable fields.
- An execution substrate MUST NOT normalize runtime-native activity into product records, accept a candidate record, or store canonical product truth.
- Normalized runtime output MUST be treated as a candidate claim subject to Core verification, including verification that it was produced by the exact adapter the launch authority named.
- An execution substrate MUST NOT cache a received authorization, policy decision, capability grant, or lease state, and MUST NOT let a bounded buffer of facts it produced become authority, durable history, or a recovery input.
- A substrate MAY hold bounded produced-fact buffers only when overflow or expiry is a truthful failure through the owning record's contract rather than silent loss.
- Handoff, review, retry, and refinement MUST map back to Thread, Turn, Item, Artifact, ApprovalRequest, Agent, and AgentSession records.
- Runtime MUST NOT release capacity, reuse a substrate, or claim replacement until its owning cleanup and continuity proofs succeed.
- Ordinary AgentSession termination MAY clean only that AgentSession's native binding and local resources, MUST preserve a compatible shared Sandbox and sibling AgentSessions when exact cleanup and continued safety are proved, and MUST NOT force replacement of a compatible shared execution-substrate epoch.
- An unprovable accepted create or delete, or failure of an effect-capable member of an execution-substrate epoch, MUST invalidate the complete owning epoch and fence its capacity until the prior effect domain is terminated and a fresh epoch is proved ready.
- A shared execution-substrate epoch MUST NOT merge the identity, lineage, authorization, workspace truth, evidence, or terminal outcome of the AgentSessions it hosts.

## Non-Core Names

OpenKit does not use `AgentRun` or `TaskRun` as core runtime concepts.

Product surfaces may introduce task-like or job-like read models for user comprehension, but those projections must map back to Thread, Turn, Item, Artifact, ApprovalRequest, Agent, and AgentSession records without exposing AgentSession as a conversation or user action.

Agent-private runtime terms may exist inside adapters. They should not leak into the core protocol unless intentionally promoted.
