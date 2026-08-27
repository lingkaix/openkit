---
status: Accepted
implementation: Partial
updated: 2026-08-13
---
# Runtime Scheduling And Scale

## Owns

- The current separation between Core mode and worker runtime placement.
- The configured V1 `RuntimeTarget` projecting one NanoHost, fixed open-AgentSession and active-Turn capacity, bounded worker steps, readiness gate, and target-loss fallback.
- NanoCore ownership of capacity grants, Harness-declared `maxOpenSessions` and `maxActiveTurns`, Sandbox aggregate bounds, occupancy derivation, and release barriers.
- The canonical statement of the current small-deployment profile — its process, writer, target, and slot counts — and the boundary beyond which scale work is not authorized.

## Does Not Own

- Product workflow progression, planning, Goal state, review gates, or Item semantics.
- Worker-control message schemas, reconnect authentication, or sequence verification.
- Scheduler table shapes or service implementation.
- AEP resolution, Workspace synchronization, provider billing, or sandbox containment.
- NanoHost identity, transport, Runtime Epoch composition, OpenShell lifecycle, sandbox create or delete, and epoch recovery.
- Dynamic multi-target placement, worker-pool policy, warm pools, cross-workspace fairness, per-user quotas, high availability, multi-process Core, or distributed takeover. These are deferred and non-authorizing.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/sandbox.md`

## Summary

The accepted V1 profile is deliberately small, and this specification is its canonical statement: one NanoCore process per data root, one logical SQLite writer over the local scope-owned databases, one configured `RuntimeTarget` that projects exactly one local or remote NanoHost, one shared Sandbox with one declared Harness for the first shared-runtime slice, fixed `maxOpenSessions` greater than one as proved by that Harness adapter, and `maxActiveTurns = 1` across that Harness. Core mode remains separate from worker placement, but V1 selects the target from deployment configuration rather than a dynamic fleet. Remote worker placement does not change the one-process-per-data-root Core shape into a multi-node Core, a shared-database deployment, or a cluster scheduler.

Another document that needs this profile cites this section instead of restating the counts, and uses `RuntimeTarget` for the configured target rather than a local synonym. The profile is a design and verification target, not an authorization limit: no admission, policy, membership, or licensing decision derives a user or team count from it, and the single-instance data-root lock that enforces one process is owned by `docs/specs/20260704-nanocore_bootstrap_readiness.md`.

The scheduler must prevent untracked or duplicate worker execution and preserve enough identity for one bounded same-worker reconnect after NanoCore restart. It does not promise transparent recovery from every crash point. A healthy NanoHost and its already-authorized worker continue while NanoCore restarts or is briefly unavailable. If the exact worker or terminal outcome cannot be proved after predecessor-fenced NanoHost reconnect, the prior attempt remains interrupted, unknown, or `recovery_required`, and any later execution requires a new authorized request.

## Goals / Non-goals

Goals:

- Keep Core mode separate from worker placement.
- Support one configured local or remote NanoHost without making OpenShell or Runtime Epoch identity part of the product model.
- Retain multiple proved open AgentSessions while authorizing at most one active worker Turn across the first-slice Harness.
- Bind worker launch and control to durable product lineage and a bounded lease.
- Preserve the exact original worker across one bounded NanoCore-restart reconnect when proof succeeds.
- Fail safely and visibly when continuation or terminal outcome cannot be proved.

Non-goals:

- Do not dynamically select among multiple targets.
- Do not implement fairness, aging, affinity optimization, warm reuse, autoscaling, hot failover, or multi-process scheduler coordination.
- Do not guarantee continuous availability or automatic repair after every process, transport, SQLite-to-runtime, or runtime-to-Workspace boundary.
- Do not create records, states, configuration, runners, harnesses, or tests for deferred scale.

## Current Concepts

`RuntimeTarget` is the one configured local or remote governed worker target.

In V1 the `RuntimeTarget` projects one configured NanoHost identity and its readiness. Runtime Epoch identity, Gateway identity, container-runtime identity, and sandbox inventory remain NanoHost-private and are not scheduler target or placement records.

Only NanoCore grants lease time. An execution runtime MUST NOT extend, renew, pause, or otherwise adjust a heartbeat deadline, startup deadline, or lease deadline to absorb its own or NanoCore's unavailability, because a deadline is authority and absorbing an outage locally would make the runtime the grantor.

NanoCore MAY, on restart, grant a renewal that accounts for an outage it can prove from its own durable records — for example by treating a preserved reconnect window as consumed rather than elapsed. That is a NanoCore-side decision made with NanoCore-owned evidence; it is not the runtime reporting how long it waited, and a runtime-supplied elapsed-time claim MUST NOT be the basis for it.

`SessionLease` is the durable claim that one AgentSession owns one active-Turn capacity unit for one bounded attempt. It carries the product and worker-control lineage needed to authorize launch, heartbeat, terminal status, cleanup, and bounded reconnect. It does not claim exclusive ownership of the Sandbox or Harness.

`maxOpenSessions` is the fixed maximum number of retained native AgentSession contexts in one Harness, including idle contexts. `maxActiveTurns` is the fixed maximum number of simultaneously executing Turns across distinct AgentSessions in that Harness. Each AgentSession independently has `maxActiveTurns = 1`.

The Sandbox declares aggregate bounds for Harness count, open AgentSessions, active Turns, CPU, memory, disk, process count, network, and other backend-enforceable resources. Harness capacity MUST NOT exceed those aggregate bounds, and NanoCore admits work only when both the Harness and Sandbox have current capacity.

NanoCore is the sole capacity grantor. A Harness or Sandbox reports bounded capability, occupancy, and liveness facts but MUST NOT admit product work, extend a deadline or lease, manufacture capacity, or return capacity before the owning cleanup barriers settle.

For the first slice, persisted AgentSession runtime bindings plus exact Harness occupancy prove open-session use, and existing scheduler leases plus their scheduler capacity row are the unique active-Turn grant. No separate durable open-session reservation, RuntimeTarget lease claim, or second mutable capacity state is authorized unless a demonstrated race cannot be closed by those existing owners.

`BoundedStep` is one scheduler-controlled worker execution interval with explicit lease, heartbeat, stop, and evidence boundaries.

`WorkerPool`, `PlacementPlan`, `CapacityRecord`, `ScalePolicy`, affinity, fairness, and multi-target selection are not stable V1 product or scheduling concepts. Existing records with those names are private implementation projections of the current scheduler and may be retained, simplified, merged, or deleted without preserving a future scaled shape.

## Decision

- V1 has exactly one configured target: local or remote.
- The configured target has fixed two-dimensional capacity. The first shared-runtime slice requires `maxOpenSessions > 1` and fixes `maxActiveTurns = 1`; increasing active concurrency is a later phase and is not authorized here.
- The target may admit work only while the configured NanoHost reports current ready capacity through its one authoritative predecessor-fenced transport session.
- NanoCore MUST durably bind the exact Workspace, Thread, Turn, AgentSession, Agent, package snapshot, target, and lease before worker launch.
- NanoCore MUST NOT authorize a second live attempt for the same AgentSession, Thread, Turn, or occupied active-Turn unit while the first lease remains live, reconnecting, or cleanup-owned.
- Opening or retaining an idle AgentSession consumes open-session capacity but grants no active-Turn capacity, lease time, inference, capability, provider, Vault, or execution authority.
- Local SQLite transactions own NanoCore coordination state only. They do not make sandbox, provider, repository, or remote worker effects atomic with Core truth.
- A pre-launch failure with proof that no worker effect occurred MAY release or requeue the same accepted intent through the existing admission owner.
- A post-launch failure with uncertain external effect MUST NOT launch a replacement automatically. NanoCore first attempts exact same-worker continuity when the NanoHost remains healthy; failure then preserves an explicit interrupted, unknown, or `recovery_required` outcome and delegates sandbox or epoch cleanup to the NanoHost lifecycle owner.
- A user or workflow retry after interruption is a new authorized attempt and preserves the original Turn and evidence.

## Lease And Reconnect Baseline

The current OpenShell timing defaults are:

- heartbeat interval: 10 seconds
- heartbeat deadline: 30 seconds after the last accepted heartbeat
- startup deadline: 25 minutes after lease acquisition
- initial bounded-step lease: 40 minutes
- explicit renewal increment: 15 minutes
- maximum bounded-step lease without policy override: 2 hours

These values are deployment defaults, not a general scale policy. Same-snapshot renewal requires a live lease and heartbeat and remains within the recorded maximum; it does not require a supply-refresh acknowledgement.

NanoCore restart performs one lease scan before normal serving. A reconnect-eligible lease must have the bound hash of the worker's random memory-only process key and proof that child execution began. The exact worker may adopt only with that process key, the same durable lineage, the exact next sequence, and the unexpired reconnect deadline.

Successful adoption continues the same lease, AgentSession, Turn, checkpoint, Sandbox, backend session, package snapshot, process key, and exact next sequence. It neither creates a Runtime Epoch nor recreates the Sandbox. A wrong key, conflicting lineage, invalid sequence, expired deadline, missing launch proof, or unfenced predecessor NanoHost session never authorizes a compatible replacement. After the bounded window, the owning workflow exposes interruption, unknown outcome, or `recovery_required`; the NanoHost owns any required Sandbox cleanup or epoch invalidation, and no settlement or replacement workflow is created.

## NanoHost Boundary

The target is one configured local or remote NanoHost with fixed scheduler-visible open-session and active-Turn capacity. NanoCore owns admission, claim replay rejection, SessionLease, no-duplicate launch, and capacity grants; the NanoHost owns its Runtime Epoch, stock OpenShell lifecycle, Sandbox and Harness inventory, declared capacity and occupancy evidence, and fresh-empty readiness. NanoCore neither addresses nor stores Runtime Epoch identity.

Ordinary Turn completion releases its active-Turn unit only after existing terminal, output, evidence, route-revocation, and cleanup owners agree. Ordinary AgentSession close releases its open-session unit after exact native-context and AgentSession-local cleanup while a compatible sibling and shared Sandbox may remain ready. Unprovable local cleanup drains and fences the wider Harness, Sandbox, or Runtime Epoch boundary and keeps every affected capacity unit unavailable until that owner proves cleanup and readiness. Epoch or execution-server failure interrupts every attached AgentSession independently; it does not infer a common terminal result, automatic replacement, or successful cleanup.

The Runtime Epoch may structurally contain zero or more Sandboxes. The first shared-runtime slice authorizes multiple open AgentSessions in one compatible Sandbox and Harness but still authorizes only one active Turn across that Harness. This structure does not authorize concurrent active Turns, multiple Harnesses, warm-pool policy, a second target, or fleet state. A future need for a smaller failure blast radius uses multiple independently configured NanoHosts under a separate accepted scale design, not a per-AgentSession Cell or Runtime Epoch.

## Failure Semantics

- Missing configured target or failed readiness denies admission with a typed diagnostic.
- Missing, stale, contradictory, or overcommitted Harness or Sandbox capacity denies admission; NanoCore does not borrow a sibling's slot, trust an unproved occupancy report, or infer capacity from process idleness.
- Missing or conflicting launch authority prevents worker start.
- A missed heartbeat or NanoCore restart never by itself proves Turn failure or success.
- Exact reconnect proof over the successor authoritative NanoHost session preserves the original attempt; failed proof preserves no availability or cleanup claim and follows the owning interruption and NanoHost-lifecycle boundaries.
- NanoHost or effect-capable member failure makes every attached AgentSession independently interrupted or unknown and fences affected capacity until definite cleanup or post-fence fresh-ready proof.
- Restart reconstructs open-session occupancy from exact persisted bindings plus Harness inventory and active-Turn occupancy from exact live leases; any mismatch keeps the disputed capacity fenced and closes or discards an unprovable idle native context.
- Accepted final status may close through existing Turn, checkpoint, evidence, Workspace handoff, backend, lease, and capacity owners when their safety-critical facts agree.
- Partial or contradictory authority remains inspectable as `recovery_required`; NanoCore does not infer completion, repeat an external effect, or create repair state.
- Action Center may project a human-actionable interruption or denial, but it does not become scheduler or workflow authority.

## Current Implementation Projection

NanoCore currently grants the active-Turn slot through scheduler lease and scheduler capacity rows, while AgentSession runtime bindings and Harness occupancy distinguish retained open AgentSessions from active Turns. Ordinary successful Turns release scheduler capacity after exact Turn-local cleanup while retaining the shared Sandbox. Dormant RuntimeTarget `active_lease_id` and mutable `capacity_state` fields and test-only helpers duplicate the active-Turn authority and must be deleted. Scheduler candidate selection also must consume the existing authoritative NanoHost readiness projection as a gate without letting readiness grant capacity.

The configured NanoHost, shared Runtime Epoch, one NanoHost transport session, predecessor fencing, Sandbox-local Integration routes, shared Harness records, and normal Sandbox-preserving Turn close are implemented. Effect-free boot classification, post-listener recovery drain, strict readiness-gated scheduler admission, exact widened-cleanup fencing, and refreshed A1 acceptance remain incomplete. Exact target reconnect and terminal closeout remain Partial until those paths are verified without another recovery platform.

## Testing Strategy / Acceptance Criteria

- L1 covers configured local versus remote target selection, `maxOpenSessions`, `maxActiveTurns`, aggregate Sandbox bounds, duplicate-launch rejection, heartbeat deadline, exact reconnect predicates, and separate open-session and active-Turn release.
- L2 covers worker-control token, lineage, process-key, and sequence enforcement at the lease boundary.
- L3 keeps one deterministic kill/restart scenario that proves either exact same-worker adoption with no duplicate launch or the documented interrupted fallback after timeout.
- L5 or opt-in A1 acceptance proves one local or remote NanoHost path, ordinary Turn release with the shared Sandbox retained, definite physical cleanup, uncertain-cleanup epoch invalidation, and post-fence fresh-ready capacity release. Existing runners must be reused.
- No current test obligation exists for fairness, aging, affinity, multi-target selection, warm pools, multi-process Core, hot failover, or every possible crash instruction boundary.

Acceptance requires no unauthorized or duplicate worker launch, no secret-bearing control state, truthful exact reconnect or interruption, one working configured `RuntimeTarget` projecting one local or remote NanoHost, at least two retained compatible AgentSessions from distinct Threads in the first-slice Harness, exactly one active Turn across them, exact local close before open-session capacity returns, complete Turn barriers before the scheduler-owned active-Turn capacity returns, no second RuntimeTarget capacity owner, and definite cleanup or post-fence fresh-ready proof before wider affected capacity returns after invalidation. Concurrent active Turns and scaled-profile behavior are not acceptance criteria.

## Consequences

- Small deployments retain durable launch fencing and useful same-worker reconnect without carrying a general distributed scheduler contract.
- An interrupted attempt may require human inspection or a new request; this bounded availability compromise is preferred to inferred completion or duplicate external work.
- Existing scale-shaped implementation records may be deleted or simplified without a compatibility obligation.

## Deferred / Future Work

- Multiple independently configured NanoHosts and dynamic target selection after a measured capacity, locality, compliance, or blast-radius need exists.
- Concurrent active Turns after a Harness proves independent routing, interruption, context, output, and cleanup and a later accepted phase raises fixed `maxActiveTurns` above one.
- Multiple Harness Instances, fairness, per-workspace or per-user caps, affinity optimization, and richer target health policy after real contention exists.
- Multi-process Core, shared scheduler state, high availability, and hot failover under a separately accepted deployment design.

Deferred work is non-authorizing and creates no current schema, implementation, migration, runner, harness, or test requirement.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/core/agent-session.md`
- `docs/deployment.md`
