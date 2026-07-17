# Runtime Scheduling And Scale

Status: Accepted
Implementation: Partial

## Owns

- The current separation between Core mode and worker runtime placement.
- The configured V1 runtime target, one-slot session lease, bounded worker step, and target-loss fallback.
- The current small-deployment scheduling profile and the boundary beyond which scale work is not authorized.

## Does Not Own

- Product workflow progression, planning, Goal state, review gates, or Item semantics.
- Worker-control message schemas, reconnect authentication, or sequence verification.
- Scheduler table shapes or service implementation.
- AEP resolution, Workspace synchronization, provider billing, or sandbox containment.
- Dynamic multi-target placement, worker-pool policy, warm pools, cross-workspace fairness, per-user quotas, high availability, multi-process Core, or distributed takeover. These are deferred and non-authorizing.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/sandbox.md`
- `docs/deployment.md`

## Summary

The accepted V1 profile is deliberately small: one NanoCore process per data root, one logical SQLite writer, one configured local or remote disposable OpenShell Cell, and one active worker slot. Core mode remains separate from worker placement, but V1 selects the target from deployment configuration rather than a dynamic fleet.

The scheduler must prevent untracked or duplicate worker execution and preserve enough identity for one bounded same-worker reconnect after NanoCore restart. It does not promise transparent recovery from every crash point. If the original worker or its terminal outcome cannot be proved within the reconnect window, NanoCore cleans up the Cell, preserves the attempt as interrupted or `recovery_required`, and requires inspection or a new authorized request.

## Goals / Non-goals

Goals:

- Keep Core mode separate from worker placement.
- Support one configured local or remote stock OpenShell Cell without making OpenShell the product model.
- Authorize at most one active worker attempt on the configured target.
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

`SessionLease` is the durable claim that one Agent Session owns the configured worker slot for one bounded attempt. It carries the product and worker-control lineage needed to authorize launch, heartbeat, terminal status, cleanup, and bounded reconnect.

`BoundedStep` is one scheduler-controlled worker execution interval with explicit lease, heartbeat, stop, and evidence boundaries.

`WorkerPool`, `PlacementPlan`, `CapacityRecord`, `ScalePolicy`, affinity, fairness, and multi-target selection are not stable V1 product or scheduling concepts. Existing records with those names are private implementation projections of the current scheduler and may be retained, simplified, merged, or deleted without preserving a future scaled shape.

## Decision

- V1 has exactly one configured target: local or remote.
- The configured target has one concurrent worker slot.
- NanoCore MUST durably bind the exact Workspace, Thread, Turn, Agent Session, Agent, package snapshot, target, and lease before worker launch.
- NanoCore MUST NOT authorize a second live attempt for the same slot or Turn while the first lease remains live, reconnecting, or cleanup-owned.
- Local SQLite transactions own NanoCore coordination state only. They do not make sandbox, provider, repository, or remote worker effects atomic with Core truth.
- A pre-launch failure with proof that no worker effect occurred MAY release or requeue the same accepted intent through the existing admission owner.
- A post-launch failure with uncertain external effect MUST NOT launch a replacement automatically. NanoCore first attempts the exact bounded reconnect; failure then produces cleanup plus an explicit interrupted or `recovery_required` outcome.
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

Successful adoption continues the same lease, Agent Session, Turn, and checkpoint. A wrong key, conflicting lineage, invalid sequence, expired deadline, or missing launch proof never authorizes a compatible replacement. After the bounded window, existing cleanup recycles the disposable Cell and the owning workflow exposes interruption or `recovery_required`; no settlement or replacement workflow is created.

## Remote Disposable Cell Boundary

The remote target is one single-slot whole Cell controlled through the fixed helper and an operator-managed authenticated SSH transport. NanoCore reaches the Cell host's loopback stock OpenShell Gateway through the accepted local forward and supplies the credential-free HTTP(S) worker-control URL reachable from the sandbox.

A naked or shared Gateway, insecure Gateway mode, custom OpenShell binary, fork, patch, replacement artifact, in-process embedding, resource-delete cleanup, or compatibility selector is not an accepted target. Cleanup recycles the complete Cell into a fresh ready epoch before its single slot is reusable.

## Failure Semantics

- Missing configured target or failed readiness denies admission with a typed diagnostic.
- Missing or conflicting launch authority prevents worker start.
- A missed heartbeat or NanoCore restart never by itself proves Turn failure or success.
- Exact reconnect proof preserves the original attempt; failed proof preserves no availability claim and proceeds to bounded cleanup.
- Accepted final status may close through existing Turn, checkpoint, evidence, Workspace handoff, backend, lease, and capacity owners when their safety-critical facts agree.
- Partial or contradictory authority remains inspectable as `recovery_required`; NanoCore does not infer completion, repeat an external effect, or create repair state.
- Action Center may project a human-actionable interruption or denial, but it does not become scheduler or workflow authority.

## Current Implementation Projection

NanoCore currently represents the configured target through admission, placement, lease, pool, capacity, and health rows and runs dispatch, lease maintenance, health, and restart services over them. Those extra rows and services are current implementation details, not V1 scale commitments; this contract authorizes no further fairness, multi-target, quarantine, or cap machinery, and a later deletion review may simplify them while preserving the one-slot safety invariants above.

The local and remote stock OpenShell `0.0.80` paths, remote worker materialization, whole-Cell recycle, and real Codex worker path have focused and opt-in A1 evidence. Exact reconnect and terminal closeout remain Partial until the bounded boot path and documented fallback are verified without another recovery platform.

## Testing Strategy / Acceptance Criteria

- L1 covers configured local versus remote target selection, one-slot lease acquisition, duplicate-launch rejection, heartbeat deadline, exact reconnect predicates, and terminal capacity release.
- L2 covers worker-control token, lineage, process-key, and sequence enforcement at the lease boundary.
- L3 keeps one deterministic kill/restart scenario that proves either exact same-worker adoption with no duplicate launch or the documented interrupted fallback after timeout.
- L5 or opt-in A1 acceptance proves one local or remote stock OpenShell worker path and whole-Cell cleanup. Existing runners must be reused.
- No current test obligation exists for fairness, aging, affinity, multi-target selection, warm pools, multi-process Core, hot failover, or every possible crash instruction boundary.

Acceptance requires no unauthorized or duplicate worker launch, no secret-bearing control state, truthful reconnect or interruption, and one working configured local or remote target. Transparent recovery and scaled-profile behavior are not acceptance criteria.

## Consequences

- Small deployments retain durable launch fencing and useful same-worker reconnect without carrying a general distributed scheduler contract.
- An interrupted attempt may require human inspection or a new request; this bounded availability compromise is preferred to inferred completion or duplicate external work.
- Existing scale-shaped implementation records may be deleted or simplified without a compatibility obligation.

## Deferred / Future Work

- Multiple independently owned Cells and dynamic target selection after a measured need exists.
- Fairness, per-workspace or per-user caps, warm reuse, affinity optimization, and richer target health policy after real contention exists.
- Multi-process Core, shared scheduler state, high availability, and hot failover under a separately accepted deployment design.

Deferred work is non-authorizing and creates no current schema, implementation, migration, runner, harness, or test requirement.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/core/agent-session.md`
- `docs/deployment.md`
