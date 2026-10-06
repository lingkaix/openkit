---
status: Accepted
implementation: Partial
kind: topology
updated: 2026-10-06
---
# Runtime Scheduling And Scale

## Owns

- The separation between Core mode and worker backend deployment.
- The current small-deployment profile: one Core process and logical writer per data root, one configured execution backend, and proved bounded native residency and execution.
- The split between Core admission/attempt grants and backend-private Harness/Sandbox limits, occupancy, and release barriers.
- No Goal-to-Sandbox pin; every Turn performs fresh authority, AEP, context, and attempt checks. The legacy `pinnedGoalId` column leaves with the Goal implementation and must not gain a Goal-aware writer.
- The generic absolute execution deadline and the boundary with adapter-owned liveness and exact reconnect.

## Does Not Own

- Product workflow progression, planning, Goal state, the Coordinator wake, review gates, or Item semantics. The scheduler admits worker Turns. It does not wake the Coordinator and does not pin a Sandbox to a Goal. `docs/specs/20261002-goal.md` owns the Goal.
- Worker-control message schemas, reconnect authentication, or sequence verification.
- Scheduler table shapes or service implementation. `docs/specs/20260703-durable_scheduler_design.md` owns admission and attempt records. The legacy `pinnedGoalId` column leaves with the Goal implementation.
- AEP resolution, Workspace synchronization, provider billing, or sandbox containment.
- NanoHost identity, transport, Runtime Epoch composition, OpenShell lifecycle, sandbox create or delete, and epoch recovery.
- Dynamic multi-target placement, generic fleet worker-pool policy, generic warm pools, cross-workspace fairness, per-user quotas, high availability, multi-process Core, or distributed takeover. These remain deferred and non-authorizing. A Goal pin is not a warm pool and is not admitted.
- Recurring cadence, occurrence, retry, expiry, and history semantics. This specification owns only their fit within the current single-process scheduling profile.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/sandbox.md`
- `docs/core/architecture.md`

## Summary

The accepted V1 profile is one NanoCore process per data root, one logical SQLite writer over scope-owned local databases, and one configured execution backend. The first adapter is a NanoCore-process NanoHost module selected by deployment configuration. The same configured backend id is used whether NanoHost is local or remote. Remote execution does not create a multi-node Core, shared-database deployment, or cluster scheduler. The data-root lock remains owned by [NanoCore Bootstrap Readiness](20260704-nanocore_bootstrap_readiness.md).

Core owns the bounded FIFO admission queue and the private execution attempt grant in [Durable Scheduler Design](20260703-durable_scheduler_design.md). The adapter owns Sandbox, Harness, and AgentSession-binding residency in its own tables and enforces their proved bounds. No physical capacity counter grants work in the generic scheduler. The [decision record](../decisions/20261006-execution_backend_port_in_nanocore.md) records why adaptation stays inside NanoCore.

The profile is a design and verification target, not a user/team authorization or licensing limit. Other documents cite this owner rather than restating process or backend counts.

The scheduler prevents duplicate execution and preserves one bounded exact-worker reconnect across transport loss or Core restart. A healthy NanoHost and already-authorized worker may survive within the current proof and deadline boundaries. Failed proof closes or fences the binding; any successor resumes natively for new authorized work. Prior Turn and AgentSession results stay truthful and independent, and interruption never proves no effect. The pre-release cutover uses a fresh data root under [the recorded application](../decisions/20261006-execution_backend_port_in_nanocore.md); later retained-data continuity remains binding.

## Goals / Non-goals

Goals:

- Keep Core mode separate from worker placement.
- Support one configured local or remote NanoHost without making OpenShell or Runtime Epoch identity part of the product model.
- Retain multiple proved open AgentSessions and authorize bounded concurrent worker Turns across distinct AgentSessions when the Harness and Sandbox declare and prove the capacity.
- Run multiple runtime families or differently configured instances in one Sandbox through distinct compatibility-keyed Harnesses without creating another scheduler or product session concept.
- Bind worker launch and control to durable product lineage and a bounded attempt grant.
- Preserve the exact original worker across one bounded reconnect after a transport loss or a NanoCore restart, when the existing proof contract succeeds.
- Fail safely and visibly when continuation or terminal outcome cannot be proved.

Non-goals:

- Do not dynamically select among multiple targets.
- Do not implement fairness, aging, generic affinity optimization, generic fleet warm reuse, autoscaling, hot failover, or multi-process scheduler coordination.
- Do not guarantee continuous availability or automatic repair after every process, transport, SQLite-to-runtime, or runtime-to-Workspace boundary.
- Do not create records, states, configuration, runners, harnesses, or tests for deferred generic scale.

## Current Concepts

The execution backend is the configured execution owner reached through NanoCore's internal port. Its id is the existing configured NanoHost id in the first slice; local/remote placement is deployment information, not a second identity. Runtime Epoch, Gateway, container-runtime identity, and inventory remain NanoHost-private.

The private execution attempt is Core's grant for one bounded Turn. [Durable Scheduler Design](20260703-durable_scheduler_design.md#attempt-reconnect-and-cleanup) owns its three phases, outstanding-operation disposition, exact lineage, exclusion, and cleanup evidence. It replaces SessionLease as execution authority and is not a physical capacity reservation. An idle binding holds no open or closing Turn attempt and grants no right to begin work.

`maxOpenSessions` bounds retained native contexts in a Harness, including idle contexts. `maxActiveTurns` bounds simultaneous Turns across distinct AgentSessions in that Harness; each AgentSession has at most one active Turn. Positive declared Harness bounds must be proved by its adapter and runtime. The Sandbox bounds Harness count, aggregate open contexts and active Turns, CPU, memory, disk, processes, network, and other backend-enforceable resources. The adapter refuses submission when any applicable bound lacks current proved capacity. Counts are backend-private occupancy, not another Core grant.

Only Core grants execution authority. At submit Core fixes one absolute attempt deadline; its current default is 7200 seconds after submit, the existing total cap. Every Core-mediated route checks the attempt, its own credential family, current policy, revocation, and that deadline. No runtime, heartbeat, reconnect, human wait, or adapter observation extends or pauses it. Stepped renewal, its lead time, and renewal counter are deleted. Exact adoption continues the same grant. NanoHost liveness is the adapter's additional refusal rule, owned by [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#nanohost-adapter-liveness).

A bounded step is one Turn on a resident binding with explicit authority, heartbeat, stop, and evidence boundaries, not one native process lifetime. Sharing residency does not share Thread, AgentSession, authorization, sequence, interruption, output, or outcome. Warm retained state is not permission or recovery truth. Every new Turn checks current authority, AEP, context, and attempt ownership.

## Decision

- There is one configured NanoHost backend adapter inside NanoCore. It uses existing NanoHost transport and Rust lifecycle owners; this redesign adds no NanoHost Rust admission API.
- The adapter selects or creates a Harness by the exact compatibility key owned by [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md), including runtime, adapter, governed image, and static process setup but excluding Thread, Turn, logical-model routing, and transient credentials.
- Distinct AgentSessions and Threads may execute concurrently only when the adapter proves independent state roots, routes, interruption, output, credential binding, cleanup, and all applicable Harness/Sandbox bounds. This remains distinct from multiple resident Harnesses or sessions; queueing alone proves no increase in native concurrency. The first slice retains one active Turn per Harness and the currently proved single active-Turn slot; the separately accepted concurrent-Turn target remains unimplemented.
- Submission requires current configured NanoHost readiness through its one authoritative predecessor-fenced connection. Core first persists attempt/immutable launch input, accepts the Workspace baseline, binds exact product and AgentSession lineage, and rechecks authority.
- Unknown or closing attempts preserve exclusion; a second live attempt for that Turn, Thread, or AgentSession is refused. Backend refusal cannot bypass Core authority, and Core admission cannot manufacture physical capacity.
- The small-deployment profile permits the existing serialized Core-local recurring scan, whose current default cadence is five seconds. It may write ordinary admission but grants no execution authority and is not another scheduler.
- Each recurring schedule may retain at most one occurrence whose admission is queued. An earlier occurrence may be admitted/running, and distinct schedules targeting a Thread may each hold their one queued row. Thread single-flight serializes execution. A trigger deadline limits only pre-admission retry and never cancels or reprioritizes accepted queue work.
- No Goal pin or Coordinator wake belongs to the scheduler. A Goal-dispatched Task is ordinary worker work; warm state is never authority, permission, completion proof, or unique progress. Lost warm Sandbox state costs latency only. The legacy pin column leaves with the Goal implementation and gains no Goal-aware writer.
- An idle AgentSession retains native continuity/open-session occupancy and the resident host but no Turn grant, inference, capability, provider, Vault, or execution authority. Ordinary Turn release does not decrement open-session occupancy. The existing no-inactivity-timer criterion remains unchanged.
- Local SQLite coordination cannot make provider, Sandbox, repository, or remote effects atomic with Core truth.
- Definite pre-effect non-acceptance may requeue the same admission only after its attempt closes. Post-effect uncertainty inspects the original and preserves cleanup/exclusion; it never automatically launches a replacement. New user/workflow retry is new authorized work preserving original Turn and evidence.

## Authority And Reconnect Baseline

The attempt has one absolute deadline set at submit and explicit revocation. [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#nanohost-adapter-liveness) owns the NanoHost adapter's unchanged heartbeat/startup/stale/reconnect rule and its current defaults. Liveness is an additional backend rule, never authority to extend the attempt. The heartbeat gate is not relaxed, and this amendment does not fix #108.

Transport loss or Core restart performs one ownership scan before ordinary serving. Exact adoption requires the attempt's Core-held hash of the worker's random memory-only process key, proof of the admitted resident host, exact product/backend/binding/package lineage, next sequence, unexpired deadline, and predecessor-fenced authoritative connection. Core refuses routes until that process is adopted even if its authority deadline remains in the future. A wrong key, conflicting lineage, invalid sequence, expired deadline, missing launch proof, or unfenced predecessor authorizes no replacement and does not shorten an already armed reconnect window.

Successful adoption continues the same attempt, AgentSession, Turn, checkpoint, Sandbox, backend binding, package, process key, and next sequence. It neither creates an epoch nor recreates a Sandbox or resubmits native work. Failed proof closes or fences through existing cleanup ownership; after the window the Turn retains its truthful result and effect/recovery uncertainty stays with its owners. Later execution requires a new authorized request and a successor resumes natively.

## NanoHost Boundary

The NanoHost backend adapter owns Sandbox, Harness, and binding residency in NanoCore-process tables; NanoHost Rust remains the Runtime Epoch, stock OpenShell, process, and physical fencing owner. Core owns request acceptance, immutable launch authority, exact attempt exclusion, and product evidence/outcomes. [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#execution-backend-port) owns the internal submit/inspect/cancel/release port; physical inventory and occupancy do not become generic scheduler grants.

Ordinary Turn completion releases exclusion only after terminal handoff, output, evidence, outside collection, the Integration loopback drain owned by [Worker Agent Capability](20260703-worker_agent_capability.md), route revocation, and safe-resident or cleanup proof. It preserves session loopback credentials and need not destroy the host or shared Sandbox. Ordinary AgentSession close returns open-session occupancy only after exact native-context and local cleanup, preserving compatible siblings. Unknown local cleanup fences the proved wider Harness/Sandbox/epoch boundary until definite cleanup or predecessor-domain fencing followed by fresh readiness. Failure interrupts each attached AgentSession independently and infers no shared result or automatic replacement.

The Runtime Epoch may contain zero or more Sandboxes; compatible Sandboxes may contain distinct compatibility-keyed Harnesses, each retaining multiple Thread-bound sessions within proved bounds. No Goal pin is introduced. A smaller failure blast radius needs a separate accepted scale decision, not a per-AgentSession epoch.

## Failure Semantics

- Missing configured backend or failed readiness prevents launch with a typed diagnostic; queued acceptance and later failure follow the admission owner.
- Missing, stale, contradictory, or overcommitted Harness or Sandbox capacity refuses backend submission; the adapter does not borrow a sibling's slot, trust an unproved occupancy report, or infer capacity from process idleness.
- Lost warm Sandbox state costs latency only and is not a recovery dependency. A missing Goal pin is not a recovery failure because there is no pin.
- Missing or conflicting launch authority prevents worker start.
- A recurring occurrence whose queue row already committed remains accepted even when it has not executed before the trigger's ten-minute deadline. Later denial, delay, failure, interruption, or unknown worker effect is not authority for recurring resubmission.
- A missed heartbeat or NanoCore restart never by itself proves Turn failure or success.
- Exact reconnect proof over the successor authoritative NanoHost session preserves the original attempt; failed proof preserves no availability or cleanup claim and follows the owning interruption and NanoHost-lifecycle boundaries.
- NanoHost or effect-capable member failure makes every attached AgentSession independently interrupted or unknown and fences affected capacity until definite cleanup or post-fence fresh-ready proof.
- Restart reconstructs open-session occupancy from exact persisted bindings plus Harness inventory and execution exclusion from exact open or closing attempts; any mismatch keeps the disputed capacity fenced. Discarding an unprovable idle native context must not delete the retained resume reference and must not discover a replacement by scanning native files. An idle binding with no attempt is not an orphan Turn. A NanoCore restart may adopt a binding that satisfies the attempt proof above. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively.
- Accepted final status may close through existing Turn, checkpoint, evidence, Workspace handoff, backend adapter and attempt owners when their safety-critical facts agree.
- Partial or contradictory authority remains inspectable as `recovery_required`; NanoCore does not infer completion, repeat an external effect, or create repair state.
- Action Center may project a human-actionable interruption or denial, but it does not become scheduler or workflow authority.

## Current Implementation Projection

Before the execution-backend amendment is implemented, NanoCore grants one active-Turn slot through scheduler lease and scheduler capacity rows, while AgentSession runtime bindings and Harness occupancy distinguish retained open AgentSessions from active Turns. Ordinary successful Turns release scheduler capacity after exact Turn-local cleanup while retaining the shared Sandbox. The database, NanoCore placement path, and Sandbox Integration now admit multiple compatibility-keyed Harness Instances in one Sandbox and retain multiple Thread-bound AgentSessions per Harness. Each current Harness still reports `maxActiveTurns = 1`, and the scheduler still grants one active-Turn slot, so bounded concurrent Turns remain unimplemented even though Harness multiplicity is present. That per-Harness cap of one active Turn is this change's rule and the current schema gap relative to the still-accepted concurrent-Turns acceptance, which stays unimplemented. Releasing a Turn lease releases its scheduler-owned active-Turn capacity after the terminal barrier; the exact AgentSession binding and Harness open-session occupancy remain until `session.close` or proved cleanup. Today `SandboxRuntimeRecord` carries placement, cleanup, sandbox binding ref, and a legacy nullable `pinnedGoalId` column whose only production reader protects idle eviction. That column is removed with the Goal implementation and must not gain a Goal-aware writer. `AgentSessionRuntimeBinding` carries Workspace and Thread. A Goal-dispatched Task uses ordinary selection. Dormant RuntimeTarget `active_lease_id` and mutable `capacity_state` fields and test-only helpers duplicate the active-Turn authority and must be deleted. Scheduler candidate selection also must consume the existing authoritative NanoHost readiness projection as a gate without letting readiness grant capacity.

The configured NanoHost, shared Runtime Epoch, one NanoHost transport session, predecessor fencing, Sandbox-local Integration routes, shared Harness records, and normal Sandbox-preserving Turn close are implemented. Effect-free boot classification, post-listener recovery drain, strict readiness-gated scheduler admission, exact widened-cleanup fencing, and refreshed A1 acceptance remain incomplete. Exact target reconnect and terminal closeout remain Partial until those paths are verified without another recovery platform.

## Testing Strategy / Acceptance Criteria

- L1 proves one configured backend id for local and remote deployment, exact Harness compatibility, declared/proved positive open-session and active-Turn bounds, aggregate Sandbox bounds, duplicate rejection, absolute-deadline/revocation gates and unchanged NanoHost heartbeat/startup gates, exact Core process-key adoption, and separate native residency/Turn exclusion release.
- L1 retains recurring queued-occurrence bounds, admitted/running plus one waiting occurrence, distinct schedules sharing a Thread under attempt single-flight, and no trigger-local parallelism or post-acceptance deadline cancellation.
- L1 proves fresh per-Turn authority/AEP/context/attempt checks, no Goal-aware pin writer, and the same worker-side `session.open`/`turn.start` carriage. The port changes Core orchestration, not NanoHost Rust or native protocol behavior.
- L2 proves scoped control credentials, lineage, process hash, and sequence at the attempt boundary and no second Core capacity grant.
- L2 proves queued 202 on a second independent Task, exact replay and changed-input conflict, no native launch until proved release, and honest busy versus unknown acceptance.
- L3 retains one deterministic kill/restart scenario for predecessor-fenced exact adoption without duplicate launch, or failed-proof cleanup followed only by new authorized work and native successor resume.
- L5 or opt-in A1 retains one local or remote NanoHost path, ordinary shared-Sandbox-preserving release, definite physical cleanup, uncertain-cleanup epoch invalidation, and post-fence fresh readiness. Existing runners are reused.

Acceptance requires no unauthorized, duplicate, or secret-bearing control state; one configured backend identity; at least two compatibility-distinct Harnesses and two retained Thread-bound AgentSessions; exact reconnect or truthful interruption; complete Turn output/evidence/collection/drain/revocation barriers before exclusion release; exact local close before residency returns; and wider fencing until definite cleanup or predecessor-fence/fresh-ready proof. Closing one binding preserves compatible siblings unless a proved wider boundary is affected. Concurrent active Turns remain permitted only within proved independent-state and Harness/Sandbox bounds; the current implementation still has one active-Turn slot and that concurrent-Turn acceptance remains unimplemented. Queueing does not claim to satisfy it. No Goal-to-Sandbox pin or new first-party compatibility obligation is introduced.

## Consequences

- Small deployments retain durable launch fencing and useful same-worker reconnect without carrying a general distributed scheduler contract.
- An interrupted attempt may require human inspection or a new request; this bounded availability compromise is preferred to inferred completion or duplicate external work.
- The obsolete pool, placement, capacity, health, renewal, and orphan-capacity scheduling mechanisms are deleted; retained-data continuity remains with Core Contract Evolution.

## Deferred / Future Work

[Durable Scheduler Design](20260703-durable_scheduler_design.md#deferred--future-work) contains the single deferred backend and scale scope statement. It authorizes no current implementation or verification platform.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/core/agent-session.md`
- `docs/specs/20261002-goal.md`
- `docs/specs/20260711-scheduler_recurring_event_triggers.md`
- `docs/deployment.md`
