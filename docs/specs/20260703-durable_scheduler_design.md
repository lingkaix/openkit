---
status: Accepted
implementation: Partial
kind: topology
updated: 2026-10-02
---
# Durable Scheduler Design

## Owns

- The current single-writer NanoCore scheduler for one configured `RuntimeTarget` that projects one local or remote NanoHost.
- Durable admission and lease authority sufficient to prevent untracked or duplicate worker launch.
- Bounded active-Turn units across compatibility-keyed Harnesses, bounded lease timing, exact same-worker reconnect after a transport loss or a NanoCore restart, terminal release, and safe interruption. This change admits one active Turn per Harness.
- The scheduler boundary with end-to-end worker control, NanoHost readiness, sandbox cleanup, and Runtime Epoch invalidation.
- No Goal-to-Sandbox pin. The legacy nullable `pinnedGoalId` column is removed with the Goal implementation. Until then it must not gain a Goal-aware writer.

## Does Not Own

- Product workflow progression, Goal or Task lifecycle, review, Gate, Item, Artifact, or Workspace-apply decisions.
- Goal state and the Coordinator wake. The scheduler admits worker Turns. It does not wake the Coordinator and does not pin a Sandbox to a Goal. `docs/specs/20261002-goal.md` owns the Goal.
- Worker-control envelopes, process-key transport, message sequencing, or final-status schema.
- Storage layout or table DDL.
- Dynamic multi-target placement, fairness, aging, affinity, warm pools, per-scope scale policy, high availability, multi-process Core, or distributed takeover.
- Automatic reconstruction of every crash boundary or a recovery workflow for incomplete product owners.
- Recurring definition, occurrence, cadence, retry, or expiry semantics. This specification owns only the existing admission boundary they must reuse.
- NanoHost identity and transport, Runtime Epoch identity or lifecycle, OpenShell operations, sandbox create or delete, OS supervision, or fresh-empty readiness proof.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/architecture.md`
- `docs/core/sandbox.md`
- `docs/core/permissions.md`

## Summary

NanoCore uses a durable single-writer scheduler because worker launch crosses from local Core truth into an external runtime effect. The scheduler serves one configured `RuntimeTarget`, which projects one local or remote NanoHost and bounded Harness and Sandbox capacity. `scheduler_session_leases` plus `scheduler_capacity_records` are the unique durable authority for active-Turn units. They are not the open-session grant. A released Turn lease leaves a resident binding occupying open-session capacity. NanoHost readiness and Harness active-Turn counts are admission and occupancy projections, not second capacity owners.

The scheduler is not a general fleet manager and does not provide distributed-system availability guarantees. Local SQLite transactions can commit admission and lease authority, but they cannot atomically commit a remote process, provider call, repository effect, or sandbox output. Post-launch uncertainty therefore fails safely instead of triggering automatic replacement or settlement.

## Goals / Non-goals

Goals:

- Persist intent before worker launch.
- Authorize at most one live attempt for each Turn, Thread, and AgentSession. This change admits one active Turn per Harness. Admitting multiple active leases within the exact Harness and Sandbox bounds stays accepted in [Runtime Scheduling And Scale](20260703-runtime_scheduling_scale.md) and unimplemented.
- Bind launch and worker control to exact product and runtime lineage.
- Preserve one bounded same-worker reconnect across a transport loss or a NanoCore restart.
- Release an ordinary Turn lease after terminal handoff, output and evidence barriers, the outside collection, the loopback drain, and revocation of the Turn's upstream route tokens. Session loopback credentials and the open binding remain. Preserve the shared Sandbox.
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

NanoHost identity, connection generation, readiness, predecessor fence, and redacted cleanup result may be referenced only as the current target projection needed to gate admission and preserve a wider cleanup fence. Runtime Epoch identity, Gateway identity, container-runtime identity, host paths, and Sandbox inventory remain NanoHost-private and MUST NOT become scheduler capacity records. NanoCore's existing `SandboxRuntimeRecord` (`sandbox_runtime_records`) is the durable placement and lifecycle projection, not NanoHost inventory. The scheduler does not pin a Sandbox to a Goal. Every worker Turn performs fresh authority, AEP, context, and lease checks. The legacy `pinnedGoalId` column is removed with the Goal implementation. Until then it must not gain a Goal-aware writer.

Existing placement-plan, pool, scheduler capacity, target-health, priority, and related rows are Private implementation projections. The active scheduler leases and scheduler capacity rows are the sole active-Turn grant graph. Each live lease consumes exactly one unit under its selected Harness and Sandbox capacity keys. A RuntimeTarget `active_lease_id` or mutable `capacity_state` duplicates that authority and MUST NOT exist; fixed Harness and Sandbox declarations plus the current readiness projection may remain. `HarnessInstanceRecord.active_turn_count` is a runtime occupancy projection and cannot grant or release a scheduler unit. A writer that sets the whole Harness count as if one `turn.start` filled the only legal slot is the current gap. This change's rule is one active Turn per Harness.

## Admission And Launch

- Admission resolves the immutable Turn/AEP `triggerActor` through the existing product lineage and applies the shared `runtime.launch` current-authority predicate before writing a new admission. Scheduler rows link the Turn, AgentSession, and package snapshot and must not copy another runtime `ActorRef` or use the derived responsible user as storage or capacity scope.
- A recurring occurrence is accepted when its exact scheduler queue row commits, not when dispatch or worker execution begins. Where the occurrence owner and admission row share `core.sqlite`, the occurrence acceptance and queue insert MUST use one transaction and one deterministic request identity. Exact replay returns that row; a conflicting identity fails `recovery_required`. Once committed, later queue denial, dispatch delay, Turn failure, interruption, unknown effect, or approval wait MUST NOT cause the occurrence owner to submit another admission.
- For an interactive human request authenticated by a currently usable administrator credential, the administrator's Web session or an administrator bearer, admission retains only the non-secret reference of that credential, bound to the immutable human triggerActor and exact admission. This credential reference is not a grant, ActorRef extension, AEP field, or Token secret. Null provenance uses the ordinary member/responsible-user path. Internal, automated, and recurring triggers cannot inherit an unpresented administrator credential. Exact replay must preserve the same provenance.
- Dispatch and subsequent Worker launch, inference, tools, credential use and content publication resolve that same admission through existing exact Turn/lease/package lineage and revalidate that credential's current owner, scope, usability, and active canonical User. Invalid recorded provenance, a revoked or expired credential, changed owner or scope, or contradictory lineage denies without membership fallback. Restart reloads the reference and applies the same live checks. It must never reconstruct an administrator grant from actor identity alone. The credential reference, actor, and request lineage remain available for audit. Effect-specific checks remain. Private audience follows the administrator eligibility rule in [Core Permissions](../core/permissions.md). No Token lifecycle or recovery owner is added.
- Acceptance requires a nonmember administrator Task to complete through the real Worker authority chain, and persisted or reloaded admission with a revoked, expired, rebound, or otherwise unusable credential to deny its next governed effect. An ordinary caller remains denied foreign private conversation access. A currently usable administrator credential is eligible for that access under the administrator eligibility rule in [Core Permissions](../core/permissions.md).
- Dispatch applies the same predicate again immediately before minting a sandbox token or requesting worker launch. Authority lost after admission uses the scheduler's existing denied or terminal admission outcome and launches nothing; it adds no lease state, retry, replacement, or recovery owner.
- Admission MUST validate product lineage, requested Agent, configured target compatibility, exact Harness compatibility selection, one-active-Turn-per-Thread and per-AgentSession uniqueness, one active Turn per Harness in this change, and every Harness and Sandbox capacity bound before launch.
- Admission MUST reject a claim while the configured NanoHost identity, predecessor-fenced authoritative connection, or current ready-capacity report is missing, stale, conflicting, or non-ready.
- The accepted worker input and admission identity MUST be durable before any sandbox token is minted or worker launch is requested.
- The lease MUST be durable and uniquely own one selected active-Turn capacity unit before launch.
- A second live lease for the same Turn, Thread, or AgentSession MUST be rejected. A lease for another Thread and AgentSession may proceed concurrently only when the selected Harness and Sandbox retain capacity.
- Within the one NanoCore process that owns a data root, a queued admission MUST be prepared by at most one dispatcher at a time ([decision](../decisions/20261002-scheduler_in_process_preparation_claim.md)). Selection claims the admission in process before preparation, and the claim ends when that attempt leases, defers, is cancelled, or fails. Background dispatch skips an admission another dispatcher is preparing. A synchronous caller whose own admission is being prepared by another dispatcher does not prepare it again: it waits for that attempt and takes its outcome as its own, returning the started Turn when the admission is leased, applying the synchronous-caller failure rule below to a failure, and keeping its requested cancellation behavior for a deferred outcome. The claim is not persisted, recovered, or retried as state; the durable lease remains the only guard against a second launch across restarts.
- The baseline queue is bounded and FIFO for eligible work. Existing priority labels may remain Private implementation detail; fairness and aging are not V1 behavior.
- A failure proved to occur before launch MAY release or requeue the same accepted admission without creating a replacement Turn.
- Once launch may have occurred, NanoCore MUST NOT automatically launch a replacement under the same or a different admission until the original attempt is terminally fenced.

## Lease, Reconnect, And Cleanup

The lease uses the timing defaults owned by `docs/specs/20260703-runtime_scheduling_scale.md`. Heartbeats advance liveness; explicit same-snapshot renewal remains bounded by the recorded maximum.

A transport loss or a NanoCore restart performs one scheduler ownership scan before serving ordinary work and may adopt the exact surviving binding under the proof below. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively. This version starts from a new data root and does not read earlier-version data, as [the engineer decided](../decisions/20260930-earlier_version_data_not_carried.md).

1. Proved pre-launch attempts may be failed or requeued through their existing admission owner.
2. A heartbeat-live post-launch attempt with the required process-key hash and worker sequence enters the existing bounded `awaiting-reconnect` lease state.
3. Only the exact process key, lineage, next sequence, deadline, and lease compare-and-set may adopt that same worker.
4. Successful adoption continues the same lease, AgentSession, Turn, and checkpoint.
5. Failed or expired adoption transfers only to existing cleanup ownership.

A NanoCore restart scan, before the ordinary listener exists, is limited to durable classification, compare-and-set fencing, capacity preservation, and re-derivation of bounded result-only request identities from complete immutable existing owners. Before the successor connection presents the exact process key, the scan does not itself adopt the binding. It MUST NOT await or dispatch NanoHost effects or effectful accepted-final-status closeout. After the listener admits the one authoritative NanoHost connection, the existing ordinary scheduler maintenance owner serially resumes `cleanup-pending`, `cleanup-failed`, and effectful accepted-final-status closeout through the same backend and product owners. A retained successor result may settle only its exact re-derived expectation; no expectation can dispatch or replay an effect. The NanoHost deletes the exact Sandbox when it can prove a definite result; an uncertain accepted create or delete invalidates the complete Runtime Epoch. The Turn retains the truthful result its lifecycle owner determined; effect uncertainty and any recovery requirement are expressed by the effect owner and the recovery owner respectively, and interruption MUST NOT infer that an effect did not happen. The scheduler does not launch a replacement or decide workflow completion.

The lease's active-Turn unit remains unavailable while its Turn lease is live, reconnecting, releasing, or cleanup-owned. Ordinary terminal release requires output, evidence, the outside collection barrier, and revocation of the Turn's upstream route tokens after the Integration loopback drain that [Worker Agent Capability](20260703-worker_agent_capability.md) owns, plus proof the binding is still a safe open resident or is locally cleaned. It does not require the native host to be gone and does not require `session.close`. It does not require `bridge.close`, `sandbox.delete`, or shared Sandbox replacement. Session loopback credentials and the open binding remain.

When cleanup uncertainty widens beyond one Turn or AgentSession, every capacity unit in the affected Harness remains fenced; when it widens to the Sandbox or Runtime Epoch, every unit in that wider boundary remains fenced until the owner proves definite deletion or proves that the predecessor effect domain was terminated before fresh readiness. An ordinary connection generation or repeated ready report alone is not that proof. The ordinary post-listen drain permits at most one process-local cleanup attempt per affected boundary at a time, never replays an accepted effect, and leaves each exact durable owner fenced after failure or uncertainty; it creates no cleanup queue, settlement record, second timer family, or alternate transport.

A short transport loss while NanoCore keeps running does not itself transfer cleanup ownership, recreate the sandbox, or invalidate a healthy NanoHost. The resident host continues across Turns. Scheduler adoption resumes the same lease only through a successor authoritative NanoHost connection whose predecessor has been fenced and whose process key, product lineage, backend session, package snapshot, and exact next sequence all match. A NanoCore restart uses that same proof and does not by itself transfer cleanup ownership, recreate the sandbox, or invalidate a healthy NanoHost. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively.

A durable backend session with no nonterminal scheduler lease owner and no open resident binding is an orphan, not an adoptable worker. An idle resident binding whose Turn lease has ended is not this orphan, and the scan must not delete its retained resume reference. The pre-listen scan compare-and-sets its existing session row to `cleanup-pending`, preserves the current capacity fence, and permits listener bind. The ordinary post-listen maintenance owner validates a retained terminal lease against its own executing placement plan, admission, backend session, and capacity row before physically cleaning that exact session; a missing lease requires one exact executing plan. Definite physical cleanup is recorded on each existing session row independently while its capacity stays fenced. Once every orphan in the verified pool boundary is `physical-cleaned`, one Core transaction retires those session rows as `cleaned`, records one server audit event per session, and releases exactly the proved orphan surplus units in their targets and pool. Unrelated rows and versions remain untouched. An unproved surplus, separate recovery fence, failed or unknown cleanup, or contradictory placement leaves the exact session and capacity fenced for inspection or retry by the same owner. A live lease never enters this orphan path. No lease, receipt, or product outcome is synthesized from the orphan session.

Wrong reconnect credentials or lineage are rejected without inventing another worker. A reconnect request does not shorten an already armed deadline; only exact adoption or the deadline owner wins the race.

## Terminal Handoff

Worker-control `final_status` is transport evidence, not product completion authority. When its exact accepted record and safety-critical lineage agree, the scheduler may move the lease into release and let the existing worker-turn, AgentSession, checkpoint, evidence, Workspace handoff, backend, and mode owners finish their own transitions.

Only facts that affect authorization, duplicate external work, data loss, product outcome, or physical cleanup may block scheduler release. Audit rows, read models, serialized responses, and events are projections and do not become release authority.

A complete terminal owner tuple may finish through the existing owner transaction. A partial or contradictory tuple remains `recovery_required`; the scheduler does not infer a winner, synthesize a receipt, repeat an external effect, or create a settlement state.

## Missing-Turn Checkpoint Maintenance

Boot classification stays fail-closed when a Task checkpoint's product Turn cannot be read. `getTurn` reports one error both when that Turn is absent and when the same Turn id belongs to another Workspace or Thread. Restart recovery MUST NOT treat that error, a null `workerSessionId`, a failed checkpoint, or a `turn-start-failed` lease as proof that no Worker ran, and it MUST NOT delete the checkpoint.

A stopped-NanoCore operator command is the only supported deletion path for that leftover. It MUST hold the existing data-root lock, default to dry-run, accept only explicit checkpoint identities, and, on apply, write a consistent backup of each Workspace database it will change to a destination outside the data root before rechecking the selected row. It then MAY delete only that checkpoint through the existing terminal-checkpoint clearer. Classification and dry-run MUST NOT prune receipts, migrate Thread envelopes, repair approval history, or create missing databases. A matching command receipt, including an expired receipt, contradicts cleanup. Malformed checkpoint diagnostics are unreadable history. Context-assembly diagnostics are execution evidence even when a summary parser cannot reconstruct every field. A placement plan's Workspace, Thread, and Turn MUST match the checkpoint, lease, and admission.

The command admits a row only when every predicate holds:

- The checkpoint stage is `failed`, `stopReason` is `error`, `workerSessionId` is null, `goalId` is null, `taskId` is null, and `iteration` is 0.
- The checkpoint has no context digest, context-assembly diagnostics, item or artifact evidence, runtime-evidence row, evidence bundle, environment package, worker-control record, backend session, or AgentSession for that Turn.
- Published Turn files show that the Turn id is absent under every Workspace and Thread. A Turn present under any owner, including a lineage mismatch, refuses cleanup. Unreadable or corrupt history, including malformed checkpoint diagnostics, refuses cleanup for the invocation and deletes nothing.
- The Workspace and Thread records match the selected identity.
- No lease for the Turn is live, and the Turn does not have more than one lease.
- No command receipt, placement plan, package, control record, session, or admission contradicts the single proof below.

Proof is exactly one of these tuples. Anything else, including a missing or ambiguous owner, leaves the row for inspection:

- Exactly one admission for that Workspace, Thread, Turn, and command request has status `cancelled`, and that Turn has no placement plan and no lease.
- Exactly one lease for that Workspace, Thread, and Turn is `failed` with release reason `turn-start-failed` and recovery state `needs-evidence`, its backend anchor is `unanchored`, and it has no accepted heartbeat, worker sequence, process key, or route-token hash. That lease's admission is the only admission for the request and Turn, its status is `admitted`, and its request id is the checkpoint request id. Its single placement plan uses that same Workspace, Thread, Turn, plan id, and admission queue entry.

The command does not create, update, or synthesize a Turn, receipt, lease, admission, or capacity row. It does not retry work, repair product history, clean runtime state, or release scheduler capacity. Deletion removes only the proved checkpoint. A later apply that no longer finds that checkpoint is a no-op. A row that changes between classification and deletion is left in place. Lock loss, backup failure, or an unreadable dependency refuses the invocation before deletion.

This exception does not apply to nonterminal checkpoints, checkpoints with a durable Turn, or any boot path. Goal-affiliated checkpoints are closed or dropped with the Goal implementation, not by this exception.

## Backpressure And Failure Semantics

- A synchronous admission caller that runs dispatch receives only its own admission's outcome. Another admission's dispatch failure keeps that admission's existing failure handling, is never returned or disclosed to this caller, and leaves the caller's response to follow its own admission's state. A failure not proved to belong to the caller's own admission, including any failure of the shared lease acquisition that rechecks every queued admission, is treated the same way.
- A synchronous caller's own dispatch failure cancels the caller's admission while it is still queued and is then returned to the caller unchanged, so a request reported as failed is not dispatched afterwards ([decision](../decisions/20261002-synchronous_caller_own_failure_cancels_admission.md)). This includes a transient preparation failure; background dispatch keeps such a failure queued for retry. A failure after the lease keeps its lease handling, and a deferred outcome keeps the caller's requested cancellation behavior.
- A target with no compatible Harness or Sandbox capacity keeps eligible work in the bounded queue or returns the existing typed capacity denial.
- A missing or unready configured target denies new launch with a typed diagnostic.
- A missed heartbeat stops new authorization but does not itself prove the Turn succeeded or failed.
- NanoHost, Gateway, container-runtime, execution-server, or uncertain-cleanup failure stops affected authorization and preserves each attached AgentSession independently as interrupted, unknown, or cleanup-owned; it does not synthesize one shared product outcome.
- Target-health summaries may aid diagnostics, but V1 does not require automated quarantine, probation, or multi-target failover.
- Human-actionable denial or interruption may appear through Action Center projections; those projections do not own scheduler state.
- Post-launch uncertainty ends in bounded reconnect, cleanup, and explicit interruption rather than automatic replay.

## Current Implementation Projection

NanoCore currently persists admission entries, placement plans, leases, pool and scheduler capacity rows, target-health summaries, worker-control bindings, and scheduler epochs. Dispatch, lease maintenance, health probing, and restart scanning run as in-process services. Ordinary successful NanoHost Turns release scheduler capacity after Turn-local backend cleanup while retaining the shared Sandbox. The current path admits multiple compatibility-keyed Harness records inside one Sandbox and retains one active-Turn unit per Harness; scheduler authorization for concurrent active Turns across those Harnesses remains unimplemented. That per-Harness cap of one is this change's rule and the implementation gap versus the still-accepted concurrent-Turns acceptance, which stays. The duplicate RuntimeTarget `active_lease_id`, mutable `capacity_state`, and test-only claim or settle helpers have been deleted through the strict current migration; scheduler leases and capacity rows remain the only active-Turn grant. The legacy nullable `sandbox_runtime_records.pinned_goal_id` column is removed with the Goal implementation. Until then it must not gain a Goal-aware writer, and no Goal pin behavior is implemented.

The current admission insert is not request-idempotent, and `startProductTurn` may return `scheduler_admission_deferred` after its queue row already committed. The recurring occurrence transaction above is therefore unimplemented. Synchronous and background dispatch share the in-process preparation claim in Admission And Launch: the dispatch loop keeps one claim set per Core data root, so a synchronous caller joins an in-flight attempt for its own admission and background dispatch skips a claimed one.

The pre-listen restart scan now performs only durable classification, fencing, read-only restoration, and deterministic result-only expectation registration. The existing post-listener single-flight maintenance service resumes exact cleanup and fail-closed accepted-final-status recovery through ordinary transport. Worker-governance preparation consumes the sole configured NanoHost readiness projection before any fresh, reused, or replacement AgentSession can acquire a lease; runtime-binding and Sandbox uncertainty remain non-reusable and preserve the existing capacity fence. Real restart, reconnect, cleanup, and saturation acceptance remains outstanding.

Boot Task checkpoint classification still refuses a missing Turn. The stopped-server `task-checkpoint:clean` command implements the missing-Turn maintenance exception above: dry-run is the default, apply requires explicit checkpoint identities and an external Workspace-database backup, and deletion is limited to one proved failed Task checkpoint.

## Alternatives Considered

### Keep The Scaled Profile In The V1 Contract

Rejected. One configured target with bounded local capacity does not justify fairness, aging, weighted selection, per-scope caps, or multi-target compatibility. Future need can define those mechanisms without preserving the present Private row shapes.

### Guarantee Recovery At Every Admission-To-Launch Crash Point

Rejected. SQLite cannot atomically commit an external worker effect. V1 prevents duplicate launch where authority is provable and otherwise exposes interruption or `recovery_required` instead of building settlement and repair workflows.

### Use Process-Local State Only

Rejected. Durable lease identity and reconnect fencing are necessary to reject stale or duplicate workers after NanoCore restart.

## Testing Strategy / Acceptance Criteria

- L1 covers synchronous admission outcome isolation: another Workspace and User's preparation or post-lease Turn start failure retains its existing admission and lease handling, discloses no foreign error to the caller, and returns the caller's own deferred outcome with its requested cancellation behavior; the caller's own preparation and post-lease failures still reach it unchanged, a failure of the shared lease acquisition, including the caller's own expected-entry race or lease write, returns the caller's deferred outcome with its requested cancellation behavior, and background error reporting keeps every original error.
- L1 covers synchronous and background dispatch of the same queued admission: preparation runs once; when background dispatch leases it, the synchronous caller returns that started Turn rather than an error; when the shared attempt fails transiently, the caller receives the original error, the admission is cancelled, and no later dispatch starts it; a deferred shared attempt keeps the caller's requested cancellation behavior; background dispatch skips an admission another dispatcher is preparing; and no claim is persisted.
- L1 covers the caller's own transient preparation failure for both cancellation settings: the caller receives the original error, its admission is cancelled, and a later dispatch run does not start it, while the same failure in background dispatch leaves the admission queued and reports the original error.
- L1 covers admission validation, per-Turn, per-Thread, and per-AgentSession uniqueness, Harness and Sandbox capacity bounds, lease-before-launch, heartbeat and renewal bounds, exact reconnect predicates, wrong-key rejection, ordinary terminal unit release without Sandbox deletion, and Harness-, Sandbox-, and Runtime-Epoch-width cleanup fencing.
- L1 covers the missing-Turn checkpoint command: a proved cancelled admission and a proved pre-persistence `turn-start-failed` lease are reported by dry-run, removed only on explicit apply, and unchanged by a repeated apply. Lineage mismatch, unreadable history, a live or multiple lease, a non-null session, a nonterminal checkpoint, Goal ownership, runtime evidence, and missing provenance preserve the checkpoint. Boot classification of a missing Turn stays fail-closed.
- L1 covers atomic recurring-occurrence acceptance with the exact deterministic admission row, idempotent exact replay, and conflicting replay rejection.
- L2 covers the lease-bound worker-control token, lineage, sequence, and final-status boundary.
- L3 retains one deterministic NanoCore kill/restart scenario: a transport loss while NanoCore keeps running uses predecessor-fenced exact adoption and must continue the same worker without duplicate sandbox creation or launch, while failed proof must reach the documented fallback in which the Turn retains the truthful result its lifecycle owner determined and effect uncertainty and any recovery requirement are expressed by those owners. A NanoCore restart uses the same predecessor-fenced exact adoption, and failed proof closes or fences the binding and a successor resumes natively, with no duplicate launch.
- L5 or opt-in A1 acceptance proves one configured local or remote NanoHost path, ordinary Turn release with the shared Sandbox retained, definite physical cleanup, uncertain-cleanup Runtime Epoch invalidation, and post-fence fresh-ready capacity release. Existing runners and harnesses must be reused.
- No current test matrix is required for fairness, aging, affinity, multi-target selection, quarantine/probation, multi-process Core, hot failover, or every possible crash instruction boundary.

Acceptance requires one working configured `RuntimeTarget` projecting one local or remote NanoHost, one scheduler-owned active-Turn grant graph with bounded units across at least two compatibility-distinct Harnesses in one Sandbox, no duplicate RuntimeTarget capacity owner, concurrent leases only for distinct Threads and AgentSessions, no unauthorized or duplicate worker, exact or rejected reconnect after a transport loss or a NanoCore restart, ordinary Turn release after the outside collection, the loopback drain, and revocation of the Turn's upstream route tokens, with the shared Sandbox and the resident binding retained, boundary-correct capacity fencing until definite cleanup or post-fence fresh-ready proof, and, when completion is uncertain, truthful independent outcomes in which each Turn retains the result its lifecycle owner determined, each AgentSession retains its independent result, and effect uncertainty and any recovery requirement are expressed by the effect owner and the recovery owner respectively, with no inference from interruption that an effect did not happen. This change keeps one active Turn per Harness, so concurrent leases across bindings stay accepted and unimplemented. A NanoCore restart may adopt the exact surviving binding under that proof. A binding that cannot be proved exactly is closed or fenced, and a successor resumes natively.

## Risks And Mitigations

- Risk: a stale worker continues after Core restart. Mitigation: exact process-key, lineage, sequence, deadline, epoch, and lease fencing.
- Risk: post-launch uncertainty duplicates an external effect. Mitigation: no automatic replacement; cleanup and explicit interruption precede any new authorized attempt.
- Risk: Private scheduler records become a second workflow engine. Mitigation: they own admission and lease safety only and may be deleted when they do not serve that boundary.
- Risk: a missing-Turn error hides a Turn that belongs to another Workspace or Thread, and deleting that checkpoint discards recovery evidence for a Worker that may have run. Mitigation: boot never deletes on that error, and the operator command deletes only an explicit row whose durable history and global Turn index both prove absence together with exact cancellation or pre-persistence start-failure evidence.

## Deferred / Future Work

- Multiple independently owned targets and dynamic placement after measured demand.
- Fairness, aging, per-workspace or per-user caps, affinity, warm pools, and richer health automation after real contention exists.
- Multi-process Core, shared scheduler state, high availability, and hot failover under a separately accepted design.

Deferred work is non-authorizing and creates no current schema, migration, implementation, compatibility, runner, harness, or test requirement.

## Links

- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260711-scheduler_recurring_event_triggers.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260529-test_strategy.md`
