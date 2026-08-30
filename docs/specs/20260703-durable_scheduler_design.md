---
status: Accepted
implementation: Partial
updated: 2026-08-31
---
# Durable Scheduler Design

## Owns

- The current single-writer NanoCore scheduler for one configured `RuntimeTarget` that projects one local or remote NanoHost.
- Durable admission and lease authority sufficient to prevent untracked or duplicate worker launch.
- Bounded active-Turn units across compatibility-keyed Harnesses, bounded lease timing, exact same-worker reconnect, terminal release, and safe interruption.
- The scheduler boundary with end-to-end worker control, NanoHost readiness, sandbox cleanup, and Runtime Epoch invalidation.
- The physical home of nullable `pinnedGoalId` on the existing `SandboxRuntimeRecord` / `sandbox_runtime_records` placement and lifecycle projection.

## Does Not Own

- Product workflow progression, Goal or Task lifecycle, review, Gate, Item, Artifact, or Workspace-apply decisions.
- Goal pin semantics and lifecycle. `docs/specs/20260703-runtime_scheduling_scale.md` owns those; this specification owns only the physical home of `pinnedGoalId` on the existing `SandboxRuntimeRecord`.
- Worker-control envelopes, process-key transport, message sequencing, or final-status schema.
- Storage layout or table DDL.
- Dynamic multi-target placement, fairness, aging, affinity, warm pools, per-scope scale policy, high availability, multi-process Core, or distributed takeover.
- Automatic reconstruction of every crash boundary or a recovery workflow for incomplete product owners.
- NanoHost identity and transport, Runtime Epoch identity or lifecycle, OpenShell operations, sandbox create or delete, OS supervision, or fresh-empty readiness proof.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/architecture.md`
- `docs/core/sandbox.md`

## Summary

NanoCore uses a durable single-writer scheduler because worker launch crosses from local Core truth into an external runtime effect. The scheduler serves one configured `RuntimeTarget`, which projects one local or remote NanoHost and bounded Harness and Sandbox capacity. `scheduler_session_leases` plus `scheduler_capacity_records` are the unique durable authority for active-Turn units. NanoHost readiness and Harness active-Turn counts are admission and occupancy projections, not second capacity owners.

The scheduler is not a general fleet manager and does not provide distributed-system availability guarantees. Local SQLite transactions can commit admission and lease authority, but they cannot atomically commit a remote process, provider call, repository effect, or sandbox output. Post-launch uncertainty therefore fails safely instead of triggering automatic replacement or settlement.

## Goals / Non-goals

Goals:

- Persist intent before worker launch.
- Authorize at most one live attempt for each Turn, Thread, and AgentSession while admitting multiple active leases only within the exact Harness and Sandbox bounds.
- Bind launch and worker control to exact product and runtime lineage.
- Preserve one bounded same-worker reconnect across NanoCore restart.
- Release an ordinary Turn lease after terminal handoff, output and evidence barriers, route revocation, and exact Turn-local quiescence; preserve the shared Sandbox.
- Keep affected capacity fenced after cleanup or Runtime Epoch uncertainty until definite deletion or post-fence fresh-ready proof.
- Surface denial, interruption, and `recovery_required` truthfully.

Non-goals:

- Do not optimize fairness or throughput for hypothetical contention.
- Do not select among multiple targets or maintain future fleet compatibility.
- Do not promise automatic repair for partial cross-store or Core-to-runtime effects.
- Do not build a scheduler recovery workflow, settlement owner, or acceptance platform.

## Decision

NanoCore owns one logical scheduler writer per data root. Scheduler coordination is Server-scope SQLite state because admission, lease ownership, and bounded capacity-unit fencing must commit atomically with each other.

The V1 contract requires only these durable facts:

- one admission identity bound to Workspace, Thread, Turn, command request, worker input digest, requested Agent, configured target, Sandbox, and exact Harness compatibility key
- one lease identity bound to that admission, AgentSession, Agent, package snapshot, scheduler epoch, worker-control binding, one active-Turn capacity unit, timing deadlines, and terminal release reason
- proof of whether worker launch has not occurred, is live, is inside the bounded reconnect window, is cleanup-owned, or is terminal
- the last accepted worker sequence and process-key hash needed for exact reconnect

NanoHost identity, connection generation, readiness, predecessor fence, and redacted cleanup result may be referenced only as the current target projection needed to gate admission and preserve a wider cleanup fence. Runtime Epoch identity, Gateway identity, container-runtime identity, host paths, and Sandbox inventory remain NanoHost-private and MUST NOT become scheduler capacity records. NanoCore's existing `SandboxRuntimeRecord` (`sandbox_runtime_records`) is the durable placement and lifecycle projection, not NanoHost inventory. Its nullable `pinnedGoalId` is the physical durable home of the Goal-to-ordinary-Sandbox pin: the field survives between ordinary worker AgentSessions until ordinary terminal release, grants no capacity, effect, or execution authority, and its semantics and lifecycle are owned by `docs/specs/20260703-runtime_scheduling_scale.md`.

Existing placement-plan, pool, scheduler capacity, target-health, priority, and related rows are Private implementation projections. The active scheduler leases and scheduler capacity rows are the sole active-Turn grant graph. Each live lease consumes exactly one unit under its selected Harness and Sandbox capacity keys. A RuntimeTarget `active_lease_id` or mutable `capacity_state` duplicates that authority and MUST NOT exist; fixed Harness and Sandbox declarations plus the current readiness projection may remain. `HarnessInstanceRecord.active_turn_count` is a runtime occupancy projection and cannot grant or release a scheduler unit.

## Admission And Launch

- Admission resolves the immutable Turn/AEP `triggerActor` through the existing product lineage and applies the shared `runtime.launch` current-authority predicate before writing a new admission. Scheduler rows link the Turn, AgentSession, and package snapshot and must not copy another runtime `ActorRef` or use the derived responsible user as storage or capacity scope.
- Dispatch applies the same predicate again immediately before minting a sandbox token or requesting worker launch. Authority lost after admission uses the scheduler's existing denied or terminal admission outcome and launches nothing; it adds no lease state, retry, replacement, or recovery owner.
- Admission MUST validate product lineage, requested Agent, configured target compatibility, exact Harness compatibility selection, one-active-Turn-per-Thread and per-AgentSession uniqueness, and every Harness and Sandbox capacity bound before launch.
- Admission MUST reject a claim while the configured NanoHost identity, predecessor-fenced authoritative connection, or current ready-capacity report is missing, stale, conflicting, or non-ready.
- The accepted worker input and admission identity MUST be durable before any sandbox token is minted or worker launch is requested.
- The lease MUST be durable and uniquely own one selected active-Turn capacity unit before launch.
- A second live lease for the same Turn, Thread, or AgentSession MUST be rejected. A lease for another Thread and AgentSession may proceed concurrently only when the selected Harness and Sandbox retain capacity.
- The baseline queue is bounded and FIFO for eligible work. Existing priority labels may remain Private implementation detail; fairness and aging are not V1 behavior.
- A failure proved to occur before launch MAY release or requeue the same accepted admission without creating a replacement Turn.
- Once launch may have occurred, NanoCore MUST NOT automatically launch a replacement under the same or a different admission until the original attempt is terminally fenced.

## Lease, Reconnect, And Cleanup

The lease uses the timing defaults owned by `docs/specs/20260703-runtime_scheduling_scale.md`. Heartbeats advance liveness; explicit same-snapshot renewal remains bounded by the recorded maximum.

NanoCore restart performs one scheduler ownership scan before serving ordinary work:

1. Proved pre-launch attempts may be failed or requeued through their existing admission owner.
2. A heartbeat-live post-launch attempt with the required process-key hash and worker sequence enters the existing bounded `awaiting-reconnect` lease state.
3. Only the exact process key, lineage, next sequence, deadline, and lease compare-and-set may adopt that same worker.
4. Successful adoption continues the same lease, AgentSession, Turn, and checkpoint.
5. Failed or expired adoption transfers only to existing cleanup ownership. Before the ordinary listener exists, this transfer is limited to durable classification, compare-and-set fencing, capacity preservation, and re-derivation of bounded result-only request identities from complete immutable existing owners; it MUST NOT await or dispatch NanoHost effects or effectful accepted-final-status closeout. After the listener admits the one authoritative NanoHost connection, the existing ordinary scheduler maintenance owner serially resumes `cleanup-pending`, `cleanup-failed`, and effectful accepted-final-status closeout through the same backend and product owners. A retained successor result may settle only its exact re-derived expectation; no expectation can dispatch or replay an effect. The NanoHost deletes the exact Sandbox when it can prove a definite result; an uncertain accepted create or delete invalidates the complete Runtime Epoch. The Turn remains interrupted, unknown, or `recovery_required`, and the scheduler does not launch a replacement or decide workflow completion.

The lease's active-Turn unit remains unavailable while its Turn lease is live, reconnecting, releasing, or cleanup-owned. Ordinary terminal release requires the authoritative terminal handoff and exact Turn-local quiescence: child absence, route revocation, required output and evidence settlement, and local AgentSession binding cleanup or proved safe reuse. It does not require `bridge.close`, `sandbox.delete`, or shared Sandbox replacement.

When cleanup uncertainty widens beyond one Turn or AgentSession, every capacity unit in the affected Harness remains fenced; when it widens to the Sandbox or Runtime Epoch, every unit in that wider boundary remains fenced until the owner proves definite deletion or proves that the predecessor effect domain was terminated before fresh readiness. An ordinary connection generation or repeated ready report alone is not that proof. The ordinary post-listen drain permits at most one process-local cleanup attempt per affected boundary at a time, never replays an accepted effect, and leaves each exact durable owner fenced after failure or uncertainty; it creates no cleanup queue, settlement record, second timer family, or alternate transport.

NanoCore restart or a short NanoCore outage does not itself transfer cleanup ownership, recreate the sandbox, or invalidate a healthy NanoHost. The NanoHost and already-authorized worker continue locally. Scheduler adoption resumes the same lease only through a successor authoritative NanoHost connection whose predecessor has been fenced and whose process key, product lineage, backend session, package snapshot, and exact next sequence all match.

Wrong reconnect credentials or lineage are rejected without inventing another worker. A reconnect request does not shorten an already armed deadline; only exact adoption or the deadline owner wins the race.

## Terminal Handoff

Worker-control `final_status` is transport evidence, not product completion authority. When its exact accepted record and safety-critical lineage agree, the scheduler may move the lease into release and let the existing worker-turn, AgentSession, checkpoint, evidence, Workspace handoff, backend, and mode owners finish their own transitions.

Only facts that affect authorization, duplicate external work, data loss, product outcome, or physical cleanup may block scheduler release. Audit rows, read models, serialized responses, and events are projections and do not become release authority.

A complete terminal owner tuple may finish through the existing owner transaction. A partial or contradictory tuple remains `recovery_required`; the scheduler does not infer a winner, synthesize a receipt, repeat an external effect, or create a settlement state.

## Backpressure And Failure Semantics

- A target with no compatible Harness or Sandbox capacity keeps eligible work in the bounded queue or returns the existing typed capacity denial.
- A missing or unready configured target denies new launch with a typed diagnostic.
- A missed heartbeat stops new authorization but does not itself prove the Turn succeeded or failed.
- NanoHost, Gateway, container-runtime, execution-server, or uncertain-cleanup failure stops affected authorization and preserves each attached AgentSession independently as interrupted, unknown, or cleanup-owned; it does not synthesize one shared product outcome.
- Target-health summaries may aid diagnostics, but V1 does not require automated quarantine, probation, or multi-target failover.
- Human-actionable denial or interruption may appear through Action Center projections; those projections do not own scheduler state.
- Post-launch uncertainty ends in bounded reconnect, cleanup, and explicit interruption rather than automatic replay.

## Current Implementation Projection

NanoCore currently persists admission entries, placement plans, leases, pool and scheduler capacity rows, target-health summaries, worker-control bindings, and scheduler epochs. Dispatch, lease maintenance, health probing, and restart scanning run as in-process services. Ordinary successful NanoHost Turns release scheduler capacity after Turn-local backend cleanup while retaining the shared Sandbox. The current path configures and grants only one active-Turn unit, enforces one Harness per Sandbox, and therefore does not implement the bounded multi-Harness grant graph accepted above. The duplicate RuntimeTarget `active_lease_id`, mutable `capacity_state`, and test-only claim or settle helpers have been deleted through the strict current migration; scheduler leases and capacity rows remain the only active-Turn grant. The nullable `sandbox_runtime_records.pinned_goal_id` column now exists as this specification's physical home; current scheduler and placement code has no Goal-aware reader, writer, or selector for it, and no Goal pin behavior is implemented.

The pre-listen restart scan now performs only durable classification, fencing, read-only restoration, and deterministic result-only expectation registration. The existing post-listener single-flight maintenance service resumes exact cleanup and fail-closed accepted-final-status recovery through ordinary transport. Worker-governance preparation consumes the sole configured NanoHost readiness projection before any fresh, reused, or replacement AgentSession can acquire a lease; runtime-binding and Sandbox uncertainty remain non-reusable and preserve the existing capacity fence. Real restart, reconnect, cleanup, and saturation acceptance remains outstanding.

## Alternatives Considered

### Keep The Scaled Profile In The V1 Contract

Rejected. One configured target with bounded local capacity does not justify fairness, aging, weighted selection, per-scope caps, or multi-target compatibility. Future need can define those mechanisms without preserving the present Private row shapes.

### Guarantee Recovery At Every Admission-To-Launch Crash Point

Rejected. SQLite cannot atomically commit an external worker effect. V1 prevents duplicate launch where authority is provable and otherwise exposes interruption or `recovery_required` instead of building settlement and repair workflows.

### Use Process-Local State Only

Rejected. Durable lease identity and reconnect fencing are necessary to reject stale or duplicate workers after NanoCore restart.

## Testing Strategy / Acceptance Criteria

- L1 covers admission validation, per-Turn, per-Thread, and per-AgentSession uniqueness, Harness and Sandbox capacity bounds, lease-before-launch, heartbeat and renewal bounds, exact reconnect predicates, wrong-key rejection, ordinary terminal unit release without Sandbox deletion, and Harness-, Sandbox-, and Runtime-Epoch-width cleanup fencing.
- L2 covers the lease-bound worker-control token, lineage, sequence, and final-status boundary.
- L3 retains one deterministic NanoCore kill/restart scenario: predecessor-fenced exact adoption must continue the same worker without duplicate sandbox creation or launch, while failed proof must reach the documented interrupted or unknown fallback.
- L5 or opt-in A1 acceptance proves one configured local or remote NanoHost path, ordinary Turn release with the shared Sandbox retained, definite physical cleanup, uncertain-cleanup Runtime Epoch invalidation, and post-fence fresh-ready capacity release. Existing runners and harnesses must be reused.
- No current test matrix is required for fairness, aging, affinity, multi-target selection, quarantine/probation, multi-process Core, hot failover, or every possible crash instruction boundary.

Acceptance requires one working configured `RuntimeTarget` projecting one local or remote NanoHost, one scheduler-owned active-Turn grant graph with bounded units across at least two compatibility-distinct Harnesses in one Sandbox, no duplicate RuntimeTarget capacity owner, concurrent leases only for distinct Threads and AgentSessions, no unauthorized or duplicate worker, exact or rejected reconnect, ordinary Turn release after exact local quiescence with the shared Sandbox retained, boundary-correct capacity fencing until definite cleanup or post-fence fresh-ready proof, and truthful independent interruption or unknown outcomes when completion is uncertain.

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
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260529-test_strategy.md`
