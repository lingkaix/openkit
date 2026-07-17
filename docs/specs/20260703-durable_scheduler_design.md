# Durable Scheduler Design

Status: Accepted
Implementation: Partial

## Owns

- The current single-writer NanoCore scheduler for one configured local or remote worker target.
- Durable admission and lease authority sufficient to prevent untracked or duplicate worker launch.
- One-slot queueing, bounded lease timing, exact same-worker reconnect, terminal release, and safe interruption.
- The scheduler boundary with worker control and the disposable Cell lifecycle.

## Does Not Own

- Product workflow progression, Goal or Task lifecycle, review, Gate, Item, Artifact, or Workspace-apply decisions.
- Worker-control envelopes, process-key transport, message sequencing, or final-status schema.
- Storage layout or table DDL.
- Dynamic multi-target placement, fairness, aging, affinity, warm pools, per-scope scale policy, high availability, multi-process Core, or distributed takeover.
- Automatic reconstruction of every crash boundary or a recovery workflow for incomplete product owners.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/architecture.md`
- `docs/core/sandbox.md`
- `docs/deployment.md`

## Summary

NanoCore uses a durable single-writer scheduler because worker launch crosses from local Core truth into an external runtime effect. The current scheduler serves one configured local or remote disposable OpenShell Cell with one active slot. Its required result is narrow: no unauthorized or duplicate launch, bounded liveness, exact same-worker reconnect when provable, and truthful interruption when it is not.

The scheduler is not a general fleet manager and does not provide distributed-system availability guarantees. Local SQLite transactions can commit admission and lease authority, but they cannot atomically commit a remote process, provider call, repository effect, or sandbox output. Post-launch uncertainty therefore fails safely instead of triggering automatic replacement or settlement.

## Goals / Non-goals

Goals:

- Persist intent before worker launch.
- Authorize at most one live attempt for the configured slot and Turn.
- Bind launch and worker control to exact product and runtime lineage.
- Preserve one bounded same-worker reconnect across NanoCore restart.
- Release the slot only after terminal proof or complete disposable-Cell cleanup.
- Surface denial, interruption, and `recovery_required` truthfully.

Non-goals:

- Do not optimize fairness or throughput for hypothetical contention.
- Do not select among multiple targets or maintain future fleet compatibility.
- Do not promise automatic repair for partial cross-store or Core-to-runtime effects.
- Do not build a scheduler recovery workflow, settlement owner, or acceptance platform.

## Decision

NanoCore owns one logical scheduler writer per data root. Scheduler coordination is server-scope SQLite state because admission, lease ownership, and the one-slot capacity fence must commit atomically with each other.

The V1 contract requires only these durable facts:

- one admission identity bound to Workspace, Thread, Turn, command request, worker input digest, requested Agent, and configured target
- one lease identity bound to that admission, Agent Session, Agent, package snapshot, scheduler epoch, worker-control binding, timing deadlines, and terminal release reason
- proof of whether worker launch has not occurred, is live, is inside the bounded reconnect window, is cleanup-owned, or is terminal
- the last accepted worker sequence and process-key hash needed for exact reconnect

Existing placement-plan, pool, capacity, target-health, priority, and related rows are Private implementation projections. Their current presence does not freeze their shapes, require a scaled profile, or authorize additional states and services. They may be retained, merged, or deleted when the one-slot authority above remains provable.

## Admission And Launch

- Admission MUST validate product lineage, requested Agent, configured target compatibility, and the one-slot bound before launch.
- The accepted worker input and admission identity MUST be durable before any sandbox token is minted or worker launch is requested.
- The lease MUST be durable and uniquely own the configured slot before launch.
- A second live lease for the slot or the same Turn MUST be rejected.
- The baseline queue is bounded and FIFO for eligible work. Existing priority labels may remain Private implementation detail; fairness and aging are not V1 behavior.
- A failure proved to occur before launch MAY release or requeue the same accepted admission without creating a replacement Turn.
- Once launch may have occurred, NanoCore MUST NOT automatically launch a replacement under the same or a different admission until the original attempt is terminally fenced.

## Lease, Reconnect, And Cleanup

The lease uses the timing defaults owned by `docs/specs/20260703-runtime_scheduling_scale.md`. Heartbeats advance liveness; explicit same-snapshot renewal remains bounded by the recorded maximum.

NanoCore restart performs one scheduler scan before serving ordinary work:

1. Proved pre-launch attempts may be failed or requeued through their existing admission owner.
2. A heartbeat-live post-launch attempt with the required process-key hash and worker sequence enters the existing bounded `awaiting-reconnect` lease state.
3. Only the exact process key, lineage, next sequence, deadline, and lease compare-and-set may adopt that same worker.
4. Successful adoption continues the same lease, Agent Session, Turn, and checkpoint.
5. Failed or expired adoption transfers only to existing cleanup ownership. After whole-Cell recycle, the Turn remains interrupted or `recovery_required`; the scheduler does not launch a replacement or decide workflow completion.

The configured slot remains unavailable while the lease is live, reconnecting, releasing, or cleanup-owned. It is reusable only after a terminal lease transition has either accepted the authoritative terminal handoff or proved complete disposable-Cell cleanup.

Wrong reconnect credentials or lineage are rejected without inventing another worker. A reconnect request does not shorten an already armed deadline; only exact adoption or the deadline owner wins the race.

## Terminal Handoff

Worker-control `final_status` is transport evidence, not product completion authority. When its exact accepted record and safety-critical lineage agree, the scheduler may move the lease into release and let the existing worker-turn, Session, checkpoint, evidence, Workspace handoff, backend, and mode owners finish their own transitions.

Only facts that affect authorization, duplicate external work, data loss, product outcome, or physical cleanup may block scheduler release. Audit rows, read models, serialized responses, and events are projections and do not become release authority.

A complete terminal owner tuple may finish through the existing owner transaction. A partial or contradictory tuple remains `recovery_required`; the scheduler does not infer a winner, synthesize a receipt, repeat an external effect, or create a settlement state.

## Backpressure And Failure Semantics

- A busy one-slot target keeps eligible work in the bounded queue or returns the existing typed capacity denial.
- A missing or unready configured target denies new launch with a typed diagnostic.
- A missed heartbeat stops new authorization but does not itself prove the Turn succeeded or failed.
- Target-health summaries may aid diagnostics, but V1 does not require automated quarantine, probation, or multi-target failover.
- Human-actionable denial or interruption may appear through Action Center projections; those projections do not own scheduler state.
- Post-launch uncertainty ends in bounded reconnect, cleanup, and explicit interruption rather than automatic replay.

## Current Implementation Projection

NanoCore currently persists admission entries, placement plans, leases, pool and capacity rows, target-health summaries, worker-control bindings, and scheduler epochs. Dispatch, lease maintenance, health probing, and restart scanning run as in-process services. The implementation selects the configured local or remote one-slot target and prevents a competing lease from dispatching on the same Thread.

The current implementation carries more scale-shaped records and tests than this accepted V1 contract requires. They are retained as current implementation truth while the owning execution program reviews deletion; they are not a reason to extend fairness, caps, health automation, or multi-target placement. The spec remains Partial until the bounded boot classifier, exact reconnect or interruption path, and minimal local-or-remote acceptance agree without additional recovery machinery.

## Alternatives Considered

### Keep The Scaled Profile In The V1 Contract

Rejected. One configured target and one slot do not justify fairness, aging, weighted selection, per-scope caps, or multi-target compatibility. Future need can define the clean current model without preserving the present Private row shapes.

### Guarantee Recovery At Every Admission-To-Launch Crash Point

Rejected. SQLite cannot atomically commit an external worker effect. V1 prevents duplicate launch where authority is provable and otherwise exposes interruption or `recovery_required` instead of building settlement and repair workflows.

### Use Process-Local State Only

Rejected. Durable lease identity and reconnect fencing are necessary to reject stale or duplicate workers after NanoCore restart.

## Testing Strategy / Acceptance Criteria

- L1 covers admission validation, one-slot uniqueness, lease-before-launch, heartbeat and renewal bounds, exact reconnect predicates, wrong-key rejection, and terminal capacity release.
- L2 covers the lease-bound worker-control token, lineage, sequence, and final-status boundary.
- L3 retains one deterministic kill/restart scenario: exact adoption must continue the same worker without duplicate launch, while timeout must reach the documented interrupted fallback after cleanup.
- L5 or opt-in A1 acceptance proves one configured local or remote stock OpenShell path. Existing runners and harnesses must be reused.
- No current test matrix is required for fairness, aging, affinity, multi-target selection, quarantine/probation, multi-process Core, hot failover, or every possible crash instruction boundary.

Acceptance requires one working configured target, no unauthorized or duplicate worker, exact or rejected reconnect, terminal slot release only after proof or cleanup, and truthful interruption when completion is uncertain.

## Risks And Mitigations

- Risk: a stale worker continues after Core restart. Mitigation: exact process-key, lineage, sequence, deadline, epoch, and lease fencing.
- Risk: post-launch uncertainty duplicates an external effect. Mitigation: no automatic replacement; cleanup and explicit interruption precede any new authorized attempt.
- Risk: Private scheduler records become a second workflow engine. Mitigation: they own admission and lease safety only and may be deleted when they do not serve that boundary.

## Deferred / Future Work

- Multiple independently owned targets and dynamic placement after measured demand.
- Fairness, aging, per-workspace or per-user caps, affinity, warm pools, and richer health automation after real contention exists.
- Multi-process Core, shared scheduler state, high availability, and hot failover under a separately accepted design.

Deferred work is non-authorizing and creates no current schema, migration, implementation, compatibility, runner, harness, or test requirement.

## Links

- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/deployment.md`
