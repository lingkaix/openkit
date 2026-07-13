# Runtime Scheduling And Scale

Status: Accepted
Implementation: Implemented

## Summary

This spec defines the target scheduling and scale model for governed worker runtimes.

The clean target is that runtime placement is a scheduler decision over declared capacity, policy, affinity, and AEP requirements. Agent manifests may declare scale intent, but they do not directly allocate workers. NanoCore schedules bounded worker steps into local or remote governed container capacity and records leases, placement plans, stale sessions, and recovery state.

## Owns

- Runtime placement, worker pool, placement plan, session lease, capacity, affinity, and scale-policy concepts.
- The separation between Core mode and worker runtime placement.
- Scheduling semantics for bounded worker steps and resumable or stale worker sessions.
- Target failure handling for missing capacity, unhealthy targets, lease expiry, missed heartbeat, policy change, budget exhaustion, and recovery.
- The implementation projection from current static OpenShell placement selection to future scheduler records.

## Does Not Own

- Product workflow progression, planning, goal state, or review gates.
- Worker control protocol details.
- Agent Environment Package field schemas beyond scheduling-relevant use.
- Workspace synchronization protocol details.
- Provider billing, pricing, or full quota enforcement.
- Kubernetes, cloud autoscaler, or backend-native supervisor implementation details.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/metering.md`

## Goals

- Define the scheduler concepts needed before multiple workers and remote placements become normal.
- Keep Core mode separate from worker runtime placement.
- Define worker pools, session leases, placement plans, affinity, and scale policy.
- Support local OpenShell and remote OpenShell first without making OpenShell the product model.
- Make long-running worker steps bounded, resumable, interruptible, and auditable.

## Non-goals

- Do not introduce host execution as a product runtime.
- Do not define a Kubernetes controller or cloud autoscaler.
- Do not implement billing or quota enforcement fully.
- Do not define Web UI worker management screens.
- Do not let worker manifests command exact backend infrastructure.

## Concepts

`RuntimeTarget` is an available backend target such as local OpenShell or remote OpenShell.

`WorkerPool` is a capacity group for compatible runtime targets.

`PlacementPlan` is NanoCore's decision for where a worker session should run.

`SessionLease` is a durable claim that a worker session owns capacity for a bounded period.

`ScalePolicy` is a server or workspace policy that limits concurrency, warm sessions, budgets, and placement.

`CapacityRecord` is the latest known capacity, health, and feature summary for a target or pool.

`BoundedStep` is one scheduler-controlled unit of worker execution inside a turn.

## Current Implementation Projection

The accepted V1 concept model is implemented through the durable scheduler slice owned by `docs/specs/20260703-durable_scheduler_design.md`.

The current NanoCore implementation now schedules product worker turns through durable admission entries, placement plans, session leases, worker pools, capacity records, target health records, lease renewal gates, restart-recovery evidence, and scheduler-owned worker-control token bindings. The localhost baseline uses one server-owned OpenShell pool and durable FIFO dispatch, while the record model already separates runtime placement from Core mode and preserves workspace, thread, turn, agent-session, AEP package, pool, target, lease, heartbeat, and recovery lineage.

`apps/nanocore/src/runtime/scheduler-dispatch-loop.ts`, `scheduler-dispatch-service.ts`, `scheduler-lease-watch-loop.ts`, `scheduler-lease-renewal-loop.ts`, `scheduler-lease-maintenance-service.ts`, `scheduler-health-probe-loop.ts`, and `scheduler-restart-recovery.ts` provide the first runtime services over those records. `apps/nanocore/src/scheduler-records.ts` owns the helper layer for queue admission, baseline priority ordering, placement, lease acquisition, heartbeat, renewal, supply-refresh acknowledgement, stale and terminal lease transitions, capacity release, baseline pool initialization, target health updates, and worker-control binding resolution.

`apps/nanocore/src/app.ts` routes new product turn starts through the durable scheduler when a Core database is configured and rejects product turn starts with `scheduler_unavailable` when scheduler storage is absent. Worker-control routes accept heartbeat, final-status, and supply-refresh acknowledgements against scheduler-owned token bindings, and Action Center projects queued or denied admissions plus selected recovery evidence.

The OpenShell turn executor factory still selects the first concrete backend projection for local or remote container placement, but static environment selection is no longer the scheduling model. It is an input into the durable scheduler baseline and backend materialization path.

## Core Mode And Runtime Placement

Core mode remains:

```text
local | server
```

Worker runtime remains:

```text
runtime: container
placement: local | remote
backend: openshell first
```

Core mode does not imply placement. Local mode may schedule a local container. Server mode may schedule local or remote containers depending on policy and available capacity.

## Runtime Target

A runtime target should carry:

- target id
- backend kind
- placement
- endpoint reference or managed backend-service reference
- feature flags
- capacity class
- health state
- trust boundary
- supported AEP requirements
- supported control mode
- supported data-plane transport
- supported capability routing
- cost class
- last check timestamp

Sensitive endpoint details and tokens are server-private.

## Worker Pool

A worker pool groups targets by scheduling purpose.

Pool fields:

- pool id
- allowed backend kinds
- allowed placements
- max concurrent sessions
- warm session target
- queue limit
- default timeout
- allowed workspace scopes
- budget class
- health summary

Pools may be server-owned first. Workspace-specific pools can come later through policy.

## Placement Plan

NanoCore creates a placement plan before launch.

Plan inputs:

- AEP backend capability requirements
- workspace policy
- user or automation priority
- target health
- capacity
- affinity
- data locality
- cost class
- required secret injection visibility
- required capability routing
- requested scale intent

Plan output:

- selected pool
- selected target
- lease duration
- expected control mode
- expected data-plane mode
- degraded optional features
- failover target if allowed
- policy decision ids

## Session Lease

The session lease prevents untracked worker execution.

Lease fields:

- lease id
- workspace id
- thread id
- turn id
- agent session id
- package snapshot id
- pool id
- target id
- status
- acquired at
- expires at
- heartbeat deadline
- release reason
- recovery state

Lease states:

- `planned`
- `acquired`
- `starting`
- `active`
- `idle`
- `stale`
- `releasing`
- `released`
- `lost`
- `failed`

Leases live in SQLite because they are operational coordination records.

## First Lease Timing Baseline

The first local OpenShell scheduler should use conservative configurable defaults:

- heartbeat interval: 30 seconds
- heartbeat deadline: 90 seconds after the last accepted heartbeat
- startup deadline: 2 minutes after lease acquisition
- default bounded-step lease duration: 30 minutes
- maximum bounded-step lease duration without explicit policy override: 2 hours
- release grace after final status or interrupt: 5 minutes

When a heartbeat deadline is missed, NanoCore should mark the lease `stale`, stop reusing the session, attempt evidence collection, and decide whether the turn can continue from collected evidence. Lease expiry should not silently close the canonical turn; the workflow closeout still depends on item, artifact, evidence, checkpoint, and review state.

## Affinity

Affinity rules:

- Thread affinity is preferred when conversation continuity matters.
- Workspace affinity is preferred when warm workspace materialization saves cost.
- Data locality is preferred when large source inputs are already near a target.
- Policy and capability requirements override affinity.
- A stale or unhealthy session must not be reused for convenience.

Session reuse must bind to compatible AEP snapshots. If the new snapshot changes static supply, secret visibility, backend requirements, or workspace roots, the old session is stale unless the worker shim and runtime adapter support safe refresh.

## Bounded Steps

Every long-running worker turn is decomposed into bounded steps.

A bounded step has:

- max wall-clock duration
- heartbeat deadline
- output collection point
- interruption point
- review or checkpoint policy
- next-step decision

This avoids making one worker process the unbounded owner of a goal.

## Scale Policy

Scale policy may define:

- max concurrent sessions per server
- max concurrent sessions per workspace
- max concurrent sessions per user
- max concurrent sessions per agent
- warm pool size
- max queue depth
- default timeout
- max timeout
- budget class
- remote placement allowlist
- expensive capability approval rule

Agent manifests declare scale intent. Scale policy decides what is allowed.

## Remote OpenShell Strategy

Remote OpenShell targets can be:

- deployment-selected external gateways
- NanoCore-managed local gateway services

The first production-shaped design should prefer deployment-selected external gateways for remote targets and NanoCore-managed gateway services for local development or controlled single-server deployments.

In-process OpenShell embedding is not the default target unless OpenShell exposes a stable embedding API or OpenKit owns that integration boundary.

## Remote Target Health Baseline

Remote target health checks should cover the minimum surfaces needed to launch, control, collect, and audit a bounded worker step.

Required checks:

- gateway reachability and version summary
- authentication or relay credential readiness without exposing secret material
- worker image or sandbox profile availability
- sandbox launch capability or dry-run support
- direct NanoCore `/api/worker-control` reachability from the worker placement
- upload support for AEP, context package, workspace input, and credential injection artifacts
- download support for transcript, artifacts, workspace-change manifests, and evidence bundles
- `capability.local` routing support only when a future AEP explicitly enables capability routes; current disabled projections require no capability endpoint
- routing support for the AEP-resolved LLM endpoint, whether backend-local `inference.local` or the authenticated worker-inference base URL
- workspace synchronization support for the requested backend mode
- clock skew or timestamp sanity check for audit and lease deadlines
- capacity summary for concurrent sessions, queue depth, memory, CPU, and storage class where available

A target can be `degraded` when optional capabilities are unavailable. It must be `unavailable` for a placement plan when required control, upload, download, workspace synchronization, or declared capability routing checks fail.

## Failure Handling

Scheduler failures:

- no capacity
- missing backend capability
- unhealthy target
- lease expired
- heartbeat missed
- control plane lost
- data-plane collection failed
- policy changed
- budget exceeded

Failures should create audit records and Action Center rows when human action can resolve them.

Human-actionable scheduling failures should create Action Center rows. User-visible worker failures that affect the turn outcome should also be represented through item-backed turn history. Pure infrastructure retries or health probes may stay in audit, scheduler, and diagnostic records.

## Resolved Decisions

- Core mode remains only `local` or `server`; worker placement is a separate runtime decision.
- The product runtime path is container-first; host execution is not a product runtime.
- OpenShell is the first backend projection, not the product model.
- Warm pools should not ship before the first multi-worker scheduler release. One-shot or explicitly reused sessions are enough until lease and capacity records exist.
- Agent manifests may declare scale intent, but scale policy and scheduler decisions decide actual concurrency, queueing, placement, and reuse.
- Scheduler queueing should begin with server-owned operational queues that preserve workspace, thread, and turn lineage, then enforce per-workspace and per-user limits through policy.
- A stale or unhealthy session must not be reused for convenience. AEP snapshot incompatibility makes a session stale unless safe refresh is supported.
- The first local OpenShell lease defaults are 30-second heartbeat interval, 90-second heartbeat deadline, 2-minute startup deadline, 30-minute bounded-step lease duration, 2-hour maximum without policy override, and 5-minute release grace.
- Remote target health must cover gateway reachability, auth readiness, image or sandbox availability, launch capability, control relay, upload and download support, capability and inference routing, workspace synchronization, clock sanity, and capacity summary.

## Deferred / Future Work

- Add scaled-profile fairness, weighted round-robin, and richer per-workspace/user caps beyond the localhost baseline.
- Add warm pool support only after leases and capacity health are durable.
- Add richer Action Center queue-position, pool-saturation, and target-health views for scheduler failures.
- Expand target health probing from the minimal localhost baseline into full remote OpenShell gateway, auth, image, relay, upload/download, inference, capability, workspace-sync, clock, and capacity checks.

## Testing Strategy

- Placement fixture tests for local and remote targets.
- Lease acquisition and expiry tests.
- Affinity tests for compatible and stale sessions.
- Capacity denial tests.
- Policy change tests that mark sessions stale or interrupt them.
- Bounded step timeout tests.
- Remote target health degradation tests.
- Recovery tests after NanoCore restart.

## Risks & Mitigations

- Risk: Scheduler becomes a second workflow engine. Mitigation: schedule turns and bounded steps only; product workflow remains thread, turn, item, review, and goal records.
- Risk: Scale fields in manifests bypass policy. Mitigation: manifests express intent; scale policy enforces limits.
- Risk: Warm sessions reuse stale supply. Mitigation: bind reuse to AEP snapshot compatibility.
- Risk: Remote OpenShell details leak into product records. Mitigation: expose target summaries and OpenKit ids only.

## Links

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/deployment.md`
- `docs/core/sandbox.md`
- `docs/specs/20260627-remote_openshell_gateway.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260703-workspace_synchronization.md`
