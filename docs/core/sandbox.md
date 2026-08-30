---
status: Accepted
updated: 2026-08-28
---
# Sandbox Model

This document defines OpenKit sandbox semantics.

This document owns execution isolation, sandbox scope, environment constraints, workspace input rules, snapshot and persistence boundaries, resource limits, sandbox summaries, and backend containment projections.

This document does not own permission policy, technical capability declarations, runtime scheduling, agent supply declarations, vault secret storage, storage layout, deployment topology, or backend-native sandbox payloads.

Sandbox is execution isolation and runtime environment design. It answers where work runs and what the runtime can reach.

Sandbox is separate from permission and capability.

Unless a rule explicitly names conversation-context or Workspace-write isolation, a containment rule in this document concerns security and adjudication isolation between the execution environment and the host or another Sandbox. It never implies that co-resident AgentSessions have security and adjudication isolation from each other.

## Principles

- Sandbox constrains what execution can actually reach; permission decides whether an action is allowed.
- Product semantics must be owned by OpenKit records, not backend-native sandbox IDs, YAML, provider payloads, or supervisor logs.
- Workspace inputs should be portable and workspace-relative where applicable.
- Reusable Sandboxes SHOULD use AgentSession-private static and Turn-dynamic slots; this supplies Workspace-write isolation only and is not a security boundary.
- Secret values, temporary credentials, and ephemeral mounts must stay out of any future durable snapshot state.
- Stronger backends may provide security and adjudication isolation beyond a shared Sandbox, but only when their OS-user, namespace, mount, process, credential, and traversal proofs support that named level; backend feature differences must be summarized as capabilities or clear launch failures rather than leaking raw backend state.
- Runtime capacity must not be released until the owning backend teardown boundary has fenced every previously accepted effect; a resource-level delete or point-in-time empty probe is insufficient when the backend cannot prove that an older create has terminated.
- An accepted sandbox create or delete whose completion cannot be proved MUST invalidate the owning execution-substrate epoch. The runtime MUST fence that epoch's capacity until the complete prior effect domain is terminated and a fresh epoch is proved ready and free of prior mutable execution state.
- A Sandbox MAY permit broad ordinary process execution inside its boundary. That freedom MUST NOT relax host-to-Sandbox security and adjudication isolation for filesystem, network, credential, secret, or resource containment; network egress MUST be denied by default and opened only by explicit governed authority.
- Confirmed loss or inability to prove the host-to-Sandbox security and adjudication isolation boundary has the same immediate fail-closed response. Core MUST deny the owning execution-substrate epoch's new admissions, external effects, and egress; interrupt every affected Turn and AgentSession; withhold unaccepted output; revoke runtime control handles; invalidate the complete epoch; route potentially exposed Vault material to its existing revocation or rotation owner; and retain only redacted audit evidence. Cleanup MUST terminate the complete effect-capable failure domain rather than delete one process or Sandbox or reuse the old environment. After cleanup, only inspection or a fresh authorized request is permitted, and reuse requires a fresh epoch with fresh containment proof at that level. This rule does not claim automatic escape detection or authorize an incident-response state machine.

## Backend Ownership Principle

The stable ownership rule is:

- NanoCore owns product state, user-visible workflow, review gates, artifacts, audit lineage, workspace change records, and public API semantics.
- Backend adapters own runtime effects such as Sandbox lifecycle, process launch, filesystem enforcement, network enforcement, credential injection and projection, file transfer, and teardown.
- Backend-native records are evidence and diagnostics, not canonical product records unless NanoCore explicitly normalizes them into OpenKit records.

This lets OpenKit depend on concrete runtime backends without turning backend-native policy files, gateway state, sandbox ids, provider payloads, supervisor logs, or file-transfer primitives into product contracts.

Backend portability does not mean every backend has identical features.

It means NanoCore can reason over stable OpenKit records and declared backend capabilities, then choose an implementation strategy or fail before launch when a required capability is missing.

## Purpose

Agents may execute code, inspect files, call tools, open browsers, use networks, and produce artifacts.

The sandbox model gives Core a stable way to describe and reason about isolation without committing to one backend.

Possible sandbox backend categories include containers, microVMs, remote agent services, managed sandbox providers, and custom controlled runtimes.

## Boundary

Sandbox owns runtime containment and environment constraints.

Permission owns authorization decisions.

Capability owns declared or discovered abilities.

Runtime owns lifecycle management for AgentSessions.

Storage owns durable files and indexes.

Sandbox does not decide whether an action should be allowed. It limits what execution can actually access.

## Sandbox Scope

A sandbox may be scoped to:

- one AgentSession
- one workspace
- one thread
- one turn
- one remote provider session
- one reusable runtime pool

The default scope when security and adjudication isolation is required remains one AgentSession per Sandbox. A shared Sandbox is an explicitly admitted alternative in which multiple compatibility-keyed Harnesses and AgentSessions from distinct Threads occupy one Sandbox while retaining independent Core identity, authority, Turn lineage, mutable Workspace slots, output staging, sequence, interruption, evidence, and terminal outcome. Historical AgentSessions for one Thread MUST NOT retain a resident binding after a successor becomes current.

Shared-Sandbox admission MUST use one static compatibility envelope that covers Workspace, responsible-user trust class, runtime image and declared Harness set, OS identity and process visibility, filesystem and mount posture, network policy, Provider attachment visibility, Vault injection visibility class, static credential exposure class, aggregate resource class, sensitivity class, and containment policy. Co-resident Harnesses and AgentSessions belong to distinct Threads in one Workspace and one responsible-user trust class. A broader trust class requires an accepted contract proving identical visibility and the required security and adjudication isolation level; it is not implied by spare capacity.

Turn payloads, Thread history, native conversation handles, raw secrets, temporary upload handles, output contents, worker-private caches, and short-lived effect authority MUST NOT enter the static compatibility envelope. They remain independently admitted and bound to the exact AgentSession and Turn.

Multiple AgentSession-scoped Sandboxes MAY also occupy one compatible execution-substrate epoch. Whether AgentSessions share one Sandbox or use separate Sandboxes, the epoch remains one wider failure and cleanup domain and grants no shared AgentSession identity, permission scope, Workspace truth, or continuity record.

Ordinary AgentSession termination in a shared Sandbox MUST close and clean only that AgentSession when exact local cleanup and continued sibling safety are proved. It MUST NOT delete the shared Sandbox or stop a healthy Harness merely because one AgentSession ends. If local cleanup cannot be proved, admission stops and cleanup widens to the Harness, Sandbox, or execution-substrate epoch boundary whose complete effect domain can be fenced.

## Isolation Levels

Every Sandbox isolation claim MUST name exactly one of these levels:

| Isolation level | Contract | Shared Sandbox posture |
| --- | --- | --- |
| Conversation-context isolation | AgentSession-native model history, prompts, tool state, sequence, interruption target, and transcript remain separately bound and routed. | Permitted only when the Harness proves correct multiplexing. |
| Workspace-write isolation | Mutable worktrees, Turn inputs, outputs, transcripts, control slots, and candidate changes use separately addressable namespaces and conflict-checked apply. | Permitted with AgentSession-private mutable slots and no shared writable canonical Workspace tree. |
| Security and adjudication isolation | One execution cannot inspect or influence another execution's memory, credentials, filesystem, model context, or decision evidence. | Not provided by shared-Sandbox co-residency by default; use proved stronger OS isolation or separate Sandboxes. |

Filesystem namespacing under one OS identity provides Workspace-write isolation only. It is logical separation, not a security boundary, and MUST NOT be described as security and adjudication isolation. Shared-Sandbox AgentSessions occupy one compromise domain unless stronger intra-Sandbox isolation is separately proved.

Independent adjudication, adversarial work, incompatible credential visibility, incompatible responsible-user trust, authorization-sensitive work, and strict-risk work MUST use separate ordinary Sandboxes whenever shared process memory, writable state, credentials, context, retained warm state, or model state could undermine security and adjudication isolation.

## Shared-Sandbox Lifecycle And Failure

Shared-Sandbox creation admits the static compatibility envelope and bounded declared Harness set before any AgentSession opens. AgentSession admission rechecks the current Sandbox envelope, exact Harness compatibility key and capacity, one-current-per-Thread rule, required isolation level, and active NanoCore-private scheduling reservation or Goal pin compatibility; a missing or conflicting input blocks admission rather than selecting an approximately compatible Sandbox or Harness. A Goal excluded by an active private scheduling reservation uses another compatible ordinary Sandbox; if no remaining compatible ordinary Sandbox exists, its existing scheduler admission stays queued for normal dispatch retry and the Goal remains non-terminal. This creates no new denial, queue, or attention state.

An update that changes a static compatibility input makes the resident Sandbox stale for new AgentSessions and requires an ordinary drain and replacement. Existing non-security-sensitive Turns MAY finish under their pinned authority; credential compromise, permission revocation, containment uncertainty, or another security-sensitive change follows immediate interruption and the owning cleanup boundary.

A normal AgentSession close releases only that AgentSession's open-session capacity after its native context, routes, mutable slots, outputs, and evidence staging satisfy their owners. A normal Turn close releases the scheduler-owned active-Turn slot after exact Turn-local quiescence and closeout barriers; neither close requires Sandbox deletion. A normal Sandbox close drains new admission, settles or truthfully interrupts admitted work, revokes all resident route authority, collects required outputs and evidence, and deletes the complete Sandbox effect domain.

Harness or Sandbox failure preserves an independent `interrupted`, `failed`, or `unknown` outcome for every affected Turn from its own evidence. Failure or cleanup uncertainty MUST NOT infer a common result, substitute one AgentSession for another, or return affected capacity before the wider proved boundary is fenced. Restart may adopt only exact surviving bindings under the runtime owner's proof contract; otherwise later work uses fresh admission and no automatic replay.

Observable conformance requires at least two compatibility-distinct Harnesses and AgentSessions for two distinct Threads to coexist in one Sandbox with separate conversation-context and Workspace-write isolation, requires bounded concurrent Turns to retain independent authority and outcomes, requires an exact local close or Harness drain to leave compatible siblings usable, and requires an unprovable local close to fence the wider boundary. A claim of security and adjudication isolation requires separate proof of the stronger OS or Sandbox boundary; path names alone fail this predicate.

## Off-Peak Freshness Rebuild

Off-peak rebuild is a freshness and latency control for a long-resident warm Sandbox, not a security control, correctness mechanism, availability promise, or substitute for per-Turn freshness admission. It is enabled only after measured residency traces establish fixed idleness and age thresholds; until then no schedule or guessed threshold is authorized.

When both thresholds are met and no resident AgentSession holds an active Turn, NanoCore MAY mark the Sandbox draining, close it through the ordinary cleanup path, discard disposable Sandbox-local state, initialize a replacement through ordinary current setup and materialization, prove it ready, and then make it warm. An arriving request during the rebuild starts or selects another freshly admitted compatible Sandbox; it does not wait for the retiring Sandbox or reuse its stale state.

The rebuild MUST NOT start while work is in flight and MUST NOT interrupt a Turn. If drain, close, initialization, materialization, or readiness fails, the old or partial Sandbox remains non-admitting, required cleanup follows the ordinary wider failure boundary, and the Workspace loses only warm latency; later work uses another fresh Sandbox or returns the existing typed unavailable or cleanup-required outcome.

Off-peak rebuild MAY reduce the delta at the next freshness barrier, but it MUST NOT authorize stale reads, replace that barrier, prove credential revocation or security and adjudication isolation, preserve non-canonical local material, justify snapshots or restore, widen warm-pool scope, or become a recovery dependency. Observable conformance requires the trigger to be the configured idleness-plus-age pair, zero active Turns at drain, ordinary re-initialization from current owners, and a failed rebuild to yield no admitted capacity or correctness claim.

## Isolation Areas

The areas below are enforcement surfaces, not isolation claims by themselves. A concrete profile must name conversation-context, Workspace-write, or security and adjudication isolation before claiming an outcome from them.

Sandbox design may constrain:

- filesystem access
- process execution
- network access
- browser access
- display access
- environment variables
- secret injection
- CPU, memory, disk, and time usage
- device access
- mounted storage
- outbound capability endpoints

These constraints should be summarized for Core and product surfaces without exposing backend-private details as stable protocol fields.

## Workspace Contract

Sandbox workspace inputs should be portable and workspace-relative where applicable.

Workspace inputs may include:

- files
- directories
- repository checkout
- mounted local directory
- object-store mount
- generated task files
- attachments
- environment entries

Manifest workspace targets should not rely on absolute local paths or path traversal.

Workspace inputs and environment values may be durable or ephemeral. Secret values, short-lived credentials, and ephemeral mounts must stay out of any future durable snapshot state.

Agents must not receive writable access to Core-managed config or server-control areas unless the runtime is explicitly a trusted Core maintenance agent.

For reusable container and managed-sandbox sessions, the sandbox should expose a stable workspace root and a fixed set of declared slots before worker execution begins.

The slot paths and access envelope are sandbox constraints.

The files, repositories, generated context, object-store snapshots, artifacts, transcripts, and outputs placed inside those slots are workspace synchronization content.

When a backend cannot change mount paths, working directories, provider-visible process environment, or static filesystem policy after sandbox start, Core must choose a replacement sandbox rather than pretending the running sandbox changed.

The sandbox summary may describe stable slot refs and access classes, but it must not expose raw host paths, backend mount handles, upload handles, temporary object-store keys, or provider credential material.

## Deferred Snapshot And Persistence Boundary

Backend snapshot, suspend, resume, rollback, and clone features have no current OpenKit record, lifecycle, or behavior contract. They are future and non-authorizing. Any later owning specification must distinguish:

- materialized files that should be preserved
- mounted external data that should not be copied into snapshots
- runtime cache that can be discarded
- secrets that must not be persisted
- artifacts that should be registered separately

No current workflow may use a backend snapshot as AgentSession continuity or Workspace truth. Knowledge is never Sandbox state.

## Resource Limits

Sandbox may enforce resource limits.

Examples:

- CPU
- memory
- disk
- wall-clock time
- concurrent processes
- network egress
- token or model usage through agent capability gateways

Resource limits may also appear in agent setup config and runtime policy. Permission policy may require approval before using more expensive or risky limits.

## Deployment Modes

Sandbox semantics should work across:

- container mode
- microVM mode
- remote agent mode
- managed sandbox provider mode

Container, microVM, and managed-provider modes can provide stronger security and adjudication isolation when separately proved, but each has different startup, filesystem, network, snapshot, and tool-compatibility trade-offs.

## Sandbox Summary

Core may expose a sandbox summary for product surfaces and audit.

A product-safe sandbox summary may carry:

- access (`none`, `read-only`, `read-write`)
- workspaceRootRefs (Core-relative workspace input references, not absolute local paths)
- summary (a short nullable label)

Backend type, health, and version should remain separate from the sandbox summary unless a future core model intentionally promotes them into sandbox semantics.

The summary should not expose sensitive paths, raw provider handles, secret values, or backend-private payloads.

## Must Not Expose

Sandbox summaries, protocol records, audit records, and product surfaces must not expose:

- absolute local paths
- raw provider handles
- container IDs
- VM IDs
- process IDs
- raw environment variables
- secret values
- temporary credential material
- private network topology
- backend-private sandbox payloads
- unrestricted mount details

Implementations may expose stable summaries, redacted labels, or Core-issued IDs when users need to understand where work ran.

## Invariants

- Sandbox MUST remain separate from permission and capability.
- Sandbox summaries MUST NOT expose absolute local paths, raw provider handles, container IDs, process IDs, environment variables, secret values, temporary credentials, private network topology, or backend-private payloads.
- Workspace inputs SHOULD be workspace-relative or Core-issued references rather than absolute local paths.
- Secret values MUST NOT be persisted in sandbox snapshots.
- Runtime backends MUST NOT become the source of truth for product workflow, artifact lineage, audit lineage, or public API semantics.
- Reusable sandboxes MUST NOT treat dynamic slot contents as canonical workspace truth until NanoCore imports and records them through the owning storage and workspace synchronization contracts.
- Static sandbox layout changes that the backend cannot apply safely MUST require a replacement sandbox or a blocked launch diagnostic.
- Runtime capacity MUST remain cleanup-owned when the backend cannot prove that every accepted create path has been terminated.
- An unprovable accepted sandbox create or delete, or failure of an effect-capable member of the owning execution substrate, MUST invalidate the complete owning epoch and keep capacity fenced until the prior effect domain is terminated and a fresh epoch passes readiness and absence-of-prior-state proof.
- AgentSession-scoped Sandbox deletion MUST NOT force replacement of a compatible shared execution-substrate epoch when exact deletion and continued host-to-Sandbox security and adjudication isolation are proved.
- Shared-Sandbox co-residency MUST name its conversation-context, Workspace-write, or security and adjudication isolation level and MUST NOT derive security and adjudication isolation from logical namespacing.
- Ordinary AgentSession close in a shared Sandbox MUST preserve compatible siblings after exact local cleanup; uncertainty MUST stop admission and widen cleanup before capacity returns.
- Off-peak rebuild MUST remain a zero-active-Turn freshness optimization with measured idleness and age triggers, ordinary replacement, and no security, correctness, recovery, or stale-read authority.
- Confirmed or unexcluded loss of host-to-Sandbox security and adjudication isolation MUST trigger the fail-closed epoch invalidation, interruption, non-publication, credential-protection, audit, and fresh-request boundary above; partial process or Sandbox cleanup and prior environment reuse are prohibited.
