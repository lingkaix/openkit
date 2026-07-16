# Durable Scheduler Design

Status: Accepted
Implementation: Partial

## Owns

- The durable record contracts for placement plans, session leases, worker pools, capacity records, target health records, and scheduler admission queue entries.
- Turn admission, queue ordering, per-workspace fairness, priority classes, and starvation avoidance.
- Lease acquisition, renewal, expiry, and takeover semantics across NanoCore restart and worker loss.
- Backpressure and admission-control behavior when capacity is exhausted.
- Target health probing cadence, quarantine, and probation re-entry rules.
- Recovery and crash-consistency rules for scheduler state, including what must be replayable from durable records.
- The scheduler-side interaction with the worker control protocol at lease boundaries.
- The configured single-Cell baseline profile and the scaled profile for scheduler behavior.

## Does Not Own

- The scheduling and scale concept model. `docs/specs/20260703-runtime_scheduling_scale.md` owns runtime target, worker pool, placement plan, session lease, scale policy, capacity record, bounded step, affinity, lease timing baselines, and remote target health check surfaces as concepts.
- Worker control protocol message families, envelopes, sequencing, or verification rules. `docs/specs/20260703-worker_control_protocol.md` owns those.
- Storage layout, ownership trees, or the file-versus-SQLite source-of-truth policy. `docs/specs/20260703-storage_layout_record_ownership.md` owns those; this spec only projects scheduler records into that policy.
- Product workflow progression, turn triggers, goal state, review gates, or item semantics. `docs/core/runtime-model.md` and `docs/core/agent-workflow.md` own those.
- Agent Environment Package resolution, workspace synchronization, or capability routing.
- Warm pool management and multi-node scheduling, which are explicitly deferred.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/deployment.md`
- `docs/core/sandbox.md`
- `docs/core/metering.md`

## Summary

This spec turns the accepted concept model in `docs/specs/20260703-runtime_scheduling_scale.md` into a concrete durable scheduler design for NanoCore.

The clean target is a single-writer scheduler inside NanoCore that admits turns through a durable queue, produces durable placement plans, launches bounded worker steps only under durable session leases, tracks pool capacity and target health as durable records, and can rebuild its full operational state from those records after a crash or restart. Scheduler records are SQLite source-of-truth operational coordination records under server ownership, consistent with `docs/specs/20260703-storage_layout_record_ownership.md`.

The v1 default is a deliberately small configured baseline: one server-owned pool, one local or remote disposable OpenShell Cell target, one concurrent session, FIFO ordering with a small fixed priority set, and no fairness machinery. The scaled profile adds per-workspace fairness, concurrency caps, and multi-target placement without changing the record contracts.

## Goals

- Define field-level and lifecycle-level contracts for the durable scheduler records named as deferred work in the concept spec.
- Make every scheduler decision that has external effect recoverable and replayable from durable records.
- Define admission, queueing, fairness, priority, and starvation-avoidance behavior precisely enough to test.
- Define lease renewal, expiry, and takeover semantics so no worker execution can outlive scheduler knowledge of it.
- Define backpressure so capacity exhaustion produces bounded queues and typed denials instead of unbounded latency.
- Define health probing and quarantine so unhealthy targets stop receiving placements automatically.
- Keep the configured single-Cell baseline small enough to ship first without carving a different contract shape.

## Non-goals

- Do not redefine concepts owned by the concept spec; this spec constrains and concretizes them.
- Do not define SQLite table DDL, migration scripts, or ORM shapes.
- Do not design warm pools, prewarmed sessions, or multi-node scheduler coordination.
- Do not define Web UI scheduler screens beyond naming the records they project.
- Do not implement billing, budget accounting, or full quota enforcement; the scheduler only consumes budget-class decisions.

## Background

`docs/specs/20260703-runtime_scheduling_scale.md` is accepted and defines the concept model: placement is a scheduler decision, leases prevent untracked execution, and the first lease timing baseline is fixed. Its original Deferred / Future Work section called for durable scheduler, placement plan, session lease, worker pool, capacity, and target health records, plus queue ordering, fairness, priority, and per-workspace caps.

At authoring time, placement was a static environment-driven selection in the turn executor factory, worker-control gateway state was process-local, and the only queue-like structures were pending-user-turn rows for busy threads. The V1 implementation has since replaced that static admission path with the durable configured-placement scheduler described in Current Implementation Projection below.

`docs/specs/20260703-storage_layout_record_ownership.md` already assigns scheduler leases, capacity records, and operational recovery checkpoints to SQLite source-of-truth under server ownership. This spec fills in what those records contain and how they behave.

## Decision

NanoCore owns one durable scheduler with these properties:

- All scheduler coordination records are SQLite source-of-truth rows in the server-scope database, keyed to product lineage ids, with no secret material and no backend-native identifiers exposed to product surfaces.
- The scheduler is a single logical writer. Each NanoCore process run holds one monotonic scheduler epoch, and every externally effective scheduler action is fenced by that epoch.
- Intent is written before effect. The scheduler MUST persist a queue entry before admitting a turn, a placement plan before selecting capacity, and a lease in `acquired` state before any worker launch or sandbox token mint.
- v1 ships the configured single-Cell baseline profile by default; the scaled profile is a configuration of the same records and state machines, not a second scheduler.
- Warm pools and multi-node scheduling are deferred and MUST NOT be partially implemented through side channels.

## Contract / Expected Behavior

### Durable record contracts

All records in this section are SQLite source-of-truth operational coordination records in the server-scope database per `docs/specs/20260703-storage_layout_record_ownership.md`. Every record MUST carry the product lineage ids it coordinates (workspace, thread, turn, agent session, package snapshot where applicable) so audit and recovery can link rows to product history. Field lists below are contract fields, not table DDL; implementations MAY add private columns but MUST NOT remove or repurpose contract fields.

#### Admission queue entry

An admission queue entry represents one turn waiting for scheduling. It MUST carry:

- queue entry id
- workspace id, thread id, turn id
- worker turn input captured when the entry is queued
- requested agent and profile reference
- priority class
- enqueue timestamp
- effective priority timestamp (for aging, see starvation avoidance)
- first-cap-deferred timestamp when a scale-policy cap has deferred dispatch (see backpressure)
- required pool constraints derived from AEP backend requirements
- status: `queued`, `admitted`, `denied`, `cancelled`, `expired`
- denial reason when denied

Lifecycle: an entry is created in `queued` when a turn is accepted for scheduling, moves to `admitted` exactly once when a placement plan is created for it, and terminates in `denied`, `cancelled`, or `expired`. Terminal entries MUST record the reason and MUST NOT be reused. A turn MUST NOT have more than one non-terminal queue entry.

Ownership: admission queue entries, like all scheduler coordination records, are server-scope SQLite records even though they carry workspace lineage. Single-writer dispatch, cross-workspace fairness, and pool accounting require one transactional domain, and queue entries are operational coordination state, not product history. Product surfaces MUST read queue state only through workspace-filtered derived read models, never raw server-scope rows. Workspace-visible history of admissions, denials, and completions lives in audit records and Action Center rows homed per `docs/specs/20260703-audit_usage_evidence_records.md`; terminal queue entries referencing a deleted workspace are prunable operational rows because the durable history already lives in those workspace-scoped projections.

#### Placement plan record

A placement plan record persists the decision defined conceptually in the concept spec. It MUST carry:

- plan id
- queue entry id and full turn lineage
- selected pool id and target id
- planned lease duration and heartbeat parameters
- expected control mode and data-plane mode
- degraded optional features accepted at plan time
- failover target id when policy allows one
- policy decision ids consulted
- capacity snapshot reference (the capacity record version the decision was based on)
- status: `planned`, `executing`, `superseded`, `abandoned`, `completed`
- creation timestamp and scheduler epoch

Lifecycle: a plan is created in `planned` before any capacity is claimed. It moves to `executing` when its lease is acquired, `superseded` when a takeover or failover produces a replacement plan (the replacement MUST reference the superseded plan id), `abandoned` when the turn is cancelled or denied before lease acquisition, and `completed` when its lease reaches a terminal state. Plans are immutable in their decision fields after creation; a changed decision is a new plan.

#### Session lease record

The session lease record realizes the lease concept and state set defined in the concept spec (`planned`, `acquired`, `starting`, `active`, `idle`, `stale`, `releasing`, `released`, `lost`, `failed`). This spec adds durable field and transition requirements. The record MUST carry:

- lease id
- plan id and full turn lineage including agent session id and package snapshot id
- pool id and target id
- status (concept-spec state set)
- acquired-at, expires-at, heartbeat-deadline, startup-deadline timestamps
- last-accepted-heartbeat timestamp and last worker sequence observed
- worker process-key hash bound before worker launch
- durable recovery deadline while the original worker process is `awaiting-reconnect`
- renewal count
- scheduler epoch that owns the lease
- sandbox token binding reference (a reference, never token material)
- durable backend anchor state (`unanchored` or `anchored`)
- release reason and recovery state on stale or terminal transitions that require them

Transition requirements:

- The lease MUST be durably in `acquired` before NanoCore mints a sandbox session token or issues any launch request. Timing values MUST default to the First Lease Timing Baseline in the concept spec and MUST be recorded on the lease so recovery does not depend on current configuration.
- `acquired -> starting -> active` follows launch and first accepted heartbeat. If the startup deadline passes without a first heartbeat while the durable backend anchor is still `unanchored`, the lease MUST move to `failed` with release reason `startup-timeout` and release capacity atomically. If the anchor is `anchored`, the lease MUST instead move to `stale` with release reason `startup-timeout` and recovery state `needs-evidence`; it MUST retain its pool and target capacity until the physical backend is causally confirmed cleaned and the normal recovery path terminalizes the lease.
- The sequence-zero `starting` heartbeat MUST atomically bind the SHA-256 hash of the worker's random memory-only process key before NanoCore permits the worker to launch its task process. The hash is immutable for the lease lifetime and is mandatory for restart adoption. Restart recovery also requires `lastWorkerSequence >= 1`, because sequence one is the first durable proof that the shim enabled post-launch recovery and began child execution; a sequence-zero-only supervisor follows existing cleanup. The heartbeat must use the one current worker-control schema literal; a different schema is rejected rather than negotiated or adapted.
- Renewal: each accepted heartbeat within the lease MUST advance the heartbeat deadline. Extending `expires-at` is an explicit scheduler decision before the lease boundary, not a heartbeat side effect. While the same bounded step continues under the lease's existing package snapshot, the scheduler MAY renew before expiry when the lease and heartbeat remain live and no explicit policy stop applies, up to the policy maximum. Same-snapshot renewal MUST NOT require a supply-refresh declaration. Each renewal MUST increment the renewal count and be durably recorded before the new expiry is honored.
- Expiry: when `expires-at` passes without renewal, or the heartbeat deadline is missed, the lease MUST move to `stale`. A stale lease MUST NOT be reused, MUST NOT accept further renewal, and MUST trigger evidence collection per the concept spec.
- Terminal states `released`, `lost`, and `failed` MUST record a release reason. Terminal leases MUST have their capacity contribution removed from the owning pool's usage accounting in the same transaction as the terminal transition.

#### Worker pool record

A worker pool record realizes the pool concept fields from the concept spec (pool id, allowed backend kinds, allowed placements, max concurrent sessions, queue limit, default timeout, allowed workspace scopes, budget class, health summary). This spec adds:

- current admitted-session count, derived transactionally from non-terminal leases and verifiable by recount
- current queue depth, derived from non-terminal queue entries constrained to the pool
- pool status: `active`, `draining`, `disabled`

Lifecycle: pools are server-owned configuration-backed records. A `draining` pool MUST finish existing leases but MUST NOT accept new placement plans. A `disabled` pool MUST NOT hold non-terminal leases; disabling a pool with live leases first moves it through `draining`. The warm-session-target field from the concept spec is reserved and MUST remain unset until warm pools ship (see Deferred / Future Work).

#### Capacity record

A capacity record is the latest known capacity summary for one target, per the concept spec. It MUST carry:

- target id and pool id
- capacity class and concurrency ceiling as last reported or configured
- in-use count as known to the scheduler
- queue depth attributable to the target
- observation timestamp and observation source (`probe`, `report`, `configured`)
- monotonic version, incremented on every write

Lifecycle: capacity records are overwrite-in-place summaries with a monotonic version; placement plans reference the version they used. A capacity record older than the health-probe staleness bound MUST be treated as unknown capacity, which is a placement-denying condition for that target unless the target is the sole configured baseline target.

#### Target health record

A target health record persists the outcome of the health check surfaces defined in the concept spec's Remote Target Health Baseline. It MUST carry:

- target id
- health state: `healthy`, `degraded`, `quarantined`, `probation`, `unavailable`
- per-surface check results with timestamps for the concept-spec required checks
- consecutive failure count and consecutive success count
- quarantine-entered timestamp and probation deadline when applicable
- last probe timestamp and next scheduled probe timestamp

Lifecycle rules are defined under Target Health Probing And Quarantine below. Health state transitions MUST be durably recorded before the scheduler acts on them.

### Turn admission and queueing

Turn admission converts a schedulable turn into a queue entry. Admission MUST validate lineage, resolve the priority class, derive pool constraints from the resolved AEP requirements, and check admission-control limits before writing the entry. A turn that fails admission receives a typed denial and no queue entry other than a terminal `denied` entry recording the reason.

Priority classes are a small closed set in v1:

- `interactive`: turns triggered by direct user input or approval resolution
- `automation`: turns triggered by automation or system input
- `maintenance`: scheduler- or system-originated background turns

Queue ordering: within one pool, dispatch order is priority class first, then effective priority timestamp (oldest first) within a class. In the configured single-Cell baseline profile this degenerates to FIFO within the three classes over a single pool, which is the intended v1 behavior.

Per-workspace fairness (scaled profile only): when more than one workspace has queued entries for the same pool, the scheduler MUST dispatch across workspaces in weighted round-robin order within each priority class, so one workspace's deep queue cannot monopolize dispatch. Weights default to equal and MAY be adjusted by scale policy. Fairness state is in-memory and rebuilt on restart from queue entry timestamps; it is not a durable record.

Starvation avoidance: every queue entry carries an effective priority timestamp. When an entry has waited longer than the class aging threshold (configurable; default 10 minutes for `automation`, 30 minutes for `maintenance`), the scheduler MUST treat it as if it were in the next-higher class for dispatch ordering, without rewriting its declared class. Aging promotes exactly one class: `maintenance` promotes at most to `automation` effective ordering and MUST NOT reach `interactive` effective ordering. `interactive` entries do not age further; instead, an `interactive` entry that exceeds its aging threshold MUST surface a human-actionable Action Center row per the concept spec's failure-handling rules. Aging MUST NOT reorder entries within the same effective class.

Thread serialization: the scheduler MUST NOT dispatch a queue entry for a thread that has a non-terminal lease for another turn, unless the workflow layer explicitly marks the turns parallel-safe. Steering, follow-up, and blocked-gate inputs for a busy thread remain owned by the existing pending-user-turn mechanism and are not admission queue entries.

### Lease acquisition, renewal, expiry, and takeover

Acquisition: to execute a plan, the scheduler MUST atomically (in one transaction) verify pool concurrency headroom, verify the target is placeable (healthy or acceptably degraded), write the lease in `acquired`, and increment pool usage. If the transaction fails on capacity, the plan returns to the queue-driven flow: the entry stays `queued` and the plan is `abandoned` with reason `capacity-lost`.

Renewal and expiry follow the session lease record contract above and the timing baseline in the concept spec.

A `draining` pool and a `quarantined` target MUST NOT by themselves block renewal of a heartbeat-live existing lease; those states gate new placement, not continuation of already admitted work. A `disabled` pool or `unavailable` target still blocks renewal.

Takeover on worker loss: when a lease goes `stale` from a missed heartbeat deadline, the scheduler MUST stop treating the worker as live, mark the agent session not reusable, initiate evidence collection through the data plane, and decide between `lost` (no recoverable evidence path) and `failed`/`released` outcomes based on collected evidence. Lease expiry MUST NOT silently close the canonical turn; turn closeout remains a workflow decision, per the concept spec.

Takeover on NanoCore restart: on startup the scheduler MUST mint a new scheduler epoch strictly greater than every durable scheduler epoch, preserve capacity already held by non-terminal leases, and classify every non-terminal lease before product admission opens:

- A pre-launch lease without an accepted heartbeat is never adopted. It follows the existing pre-anchor failure path, or exact cleanup when a partial backend anchor already exists.
- A `releasing` lease with a durable accepted `final_status` resumes the existing closeout path directly and does not wait for another heartbeat.
- An `active` or `idle` lease with a previously accepted heartbeat becomes `awaiting-reconnect` only after exact lineage, bound process-key hash, deployment, target, backend-session, workspace-handoff, immutable AEP, and read-only backend-restoration checks pass.
- Every other live, stale, expired, mismatched, cleanup-started, or unrecoverable lease enters evidence-preserving exact cleanup without creating a replacement worker.

The recovery deadline is the earlier of absolute lease expiry and 60 seconds after the boot scan arms the lease. NanoCore persists that deadline. A repeated boot preserves an existing deadline exactly and MUST NOT grant another window. If the deadline is already expired, cleanup begins without arming recovery.

An awaiting lease keeps its existing capacity and physical identity but regains no ordinary worker-control authority. Only the heartbeat route may cross an expired normal heartbeat deadline, and only when the request presents the original shim process's memory-only key, its hash equals the immutable lease binding, its complete lineage is exact, and its sequence is `lastWorkerSequence + 1`. In one database transaction, reconnect first compare-and-sets the exact awaiting row back to ordinary authority and then applies the existing exact-next heartbeat update that advances sequence and deadline. The existing lease-maintenance service polls expired reconnect deadlines; there is no reconnect-specific timer. Timeout first compare-and-sets that same exact awaiting lease to `needs-evidence` and clears its reconnect deadline before physical cleanup; either heartbeat reconnect or timeout cleanup ownership wins, never both. If physical cleanup fails, the lease remains fenced in `needs-evidence` with capacity held until the next boot retries the existing cleanup path.

Epoch fencing: delayed work stamped with an older epoch MUST be rejected when it would mutate scheduler or recovery records. An adopted lease immediately regains normal control even while another lease remains awaiting reconnect. A timed-out or terminal lease has its token binding revoked before physical cleanup, and no late heartbeat may recreate authority.

### Backpressure and admission control

Each pool has a durable queue limit. When a pool's queue depth is at its limit, new admissions targeting that pool MUST be denied with typed reason `queue-full` rather than enqueued. When pool concurrency is exhausted but queue space exists, entries queue normally; this is the intended buffering behavior, not an error.

Admission control MUST additionally deny, with distinct typed reasons, when: no pool satisfies the AEP-derived constraints (`no-compatible-pool`), all compatible targets are quarantined or unavailable (`no-healthy-target`), a scale-policy cap has deferred the entry past its class wait bound (`policy-cap`), or the budget class is exhausted (`budget-exhausted`).

Policy caps defer before they deny. Scale-policy caps for the server, workspace, user, or agent are enforced at dispatch time, not at admission: an entry targeting a cap-saturated scope still enqueues normally (subject to the pool queue limit), dispatch skips it while the cap is saturated, and a freed cap slot admits the oldest eligible deferred entry in effective class order. The scheduler MUST record the first-cap-deferred timestamp on the entry when a cap first defers it. When an entry has been cap-deferred longer than its class wait bound, the scheduler MUST deny it with `policy-cap`. Default wait bounds are 2 minutes for `interactive`, 10 minutes for `automation`, and 30 minutes for `maintenance`; scale policy MAY override any bound per scope, including to zero, which makes cap saturation an immediate denial for that scope. Cap-deferred entries count toward pool queue depth, so queue-limit backpressure still applies while entries wait at a cap.

Denials that a human can resolve MUST create Action Center rows and audit records per the concept spec's failure handling. The scheduler MUST NOT retry denied admissions on its own; re-admission is a workflow or user decision. While a pool is saturated, the scheduler SHOULD publish a degraded readiness summary through derived read models so product surfaces can show queue position and expected wait without reading scheduler internals.

### Target health probing and quarantine

The scheduler MUST probe every registered target on a fixed cadence (default 60 seconds for targets with live leases, 5 minutes for idle targets) covering the required check surfaces defined in the concept spec's Remote Target Health Baseline. For the configured single-Cell target, checks already proven by the Cell lifecycle MAY reference that lifecycle evidence instead of invoking a separate external diagnostic command, but launch capability and control relay reachability MUST be genuinely probed.

State transitions:

- `healthy -> degraded` when only optional capabilities fail, per the concept spec's degraded/unavailable rule.
- `healthy|degraded -> quarantined` after N consecutive failures of any required check (default N=3). Quarantine MUST be durably recorded before placement stops.
- A quarantined target MUST NOT receive new placement plans. Existing live leases on it continue under normal heartbeat rules; the scheduler SHOULD NOT preemptively kill live work solely because probes fail while worker heartbeats still arrive.
- `quarantined -> probation` after a backoff interval (default: exponential from 1 minute, capped at 30 minutes). In probation the target receives probes and MUST NOT hold more than one concurrent placement; scale policy MAY further restrict probation to one placement per probation window for expensive remote targets.
- `probation -> healthy` after M consecutive successful probes plus one successfully started lease when demand exists (default M=2); `probation -> quarantined` on any required-check failure, resetting the backoff at the next step.

Quarantine of the only compatible target results in `no-healthy-target` admission denials with Action Center visibility. Pure probe activity stays in scheduler and audit records, not in product history.

### Recovery and crash consistency

The invariant is: every externally effective scheduler action MUST be reconstructible from durable records alone. Concretely:

- Write-ahead intent: queue entry before admission effects, plan before capacity claim, lease `acquired` before launch or token mint, lease terminal transition together with capacity release, health transition before placement behavior change.
- Replayable set: after a crash, the scheduler MUST be able to rebuild the full dispatch state from queue entries, plans, leases, pool records, capacity records, and health records, plus the worker-turn checkpoints and session-file evidence owned by other specs. In-memory-only state (fairness cursors, probe timers, dispatch loops) MUST be derivable from durable timestamps and MUST NOT be required for correctness.
- Idempotent effects: launch requests and takeover actions MUST carry the lease id and scheduler epoch so a repeated effect after recovery is detectable and safely ignorable by the runtime adapter.
- No orphan execution: any worker whose lease cannot be found or re-adopted after restart is untracked execution; NanoCore MUST refuse its control-plane traffic (token binding invalid), attempt evidence collection, and record the incident in audit.
- Transactionality: state transitions that pair a lease change with pool accounting, or a queue entry change with a plan change, MUST commit in one transaction.

### Restart terminal handoff

Adoption MUST NOT recreate the lost in-memory `WorkerGovernanceTurnExecutor` promise and MUST NOT introduce a scheduler-owned workflow engine. The scheduler leaves an adopted lease under its existing durable owners. A restart-discovered accepted final status is closed directly through the existing worker-turn checkpoint, backend-session, worker-control, Agent Session, workspace collection, reconciliation, review, cleanup, lease, and capacity paths.

Direct closeout is recoverable only when the existing records agree on exact workspace, thread, turn, agent-session, package-snapshot, lease, and backend identity. Accepted `final_status`, heartbeat timeout, or absolute expiry establishes one restart terminal input. Ordinary cancellation remains owned by the existing live-turn control path and is not a separate restart-recovery mechanism. Existing deterministic checkpoint, reconciliation, review, evidence, cleanup, and lease identities are the replay keys: same identity plus the same canonical digest is replay success, while a conflict blocks recovery and retains capacity. No settlement table, phase row, restart coordinator, or second workflow state machine is permitted.

Durable records and workspace read models replay exactly. The app-local turn event stream is an ephemeral projection and may be delivered at least once if NanoCore crashes a second time after durable closeout writes but before that projection finishes. Consumers must tolerate duplicate equivalent events; this narrow compromise does not authorize a durable settlement ledger.

An accepted final status from a reconnected worker triggers one process-local asynchronous direct-closeout attempt. If that attempt fails and the worker does not replay final status, the lease remains `releasing` with its accepted terminal record and held capacity until the next boot re-enters the same closeout path. NanoCore adds no durable retry phases, retry-stage table, or background settlement loop for this compromise.

Closeout completes when the worker checkpoint and product turn are terminal, every workspace reconciliation has a safe terminal disposition, the exact backend session is physically and logically cleaned, the lease is terminal, and capacity is released once. Cleanup or identity failure keeps capacity held and the exact lease and backend session fenced; no recovery path may guess a target or release capacity merely to restore availability.

### Interaction with the worker control protocol at lease boundaries

`docs/specs/20260703-worker_control_protocol.md` owns the protocol; this spec binds it to leases:

- Token mint: the sandbox session token for a worker MUST be minted only against a lease in `acquired`, and its lineage scope MUST match the lease lineage exactly. Token expiry MUST NOT exceed lease expiry plus the release grace period.
- Heartbeat: an accepted `heartbeat` is the only input that advances the normal heartbeat deadline. The only restart exception is the process-key-gated exact-next heartbeat for an `awaiting-reconnect` lease before its durable recovery deadline. Heartbeats for cleanup-started, `stale`, `releasing`, or terminal leases cannot revive authority.
- `final_status`: acceptance of `final_status` moves the lease from a live state to `releasing` and durably triggers the existing terminal-handoff owners. The lease reaches `released` only after required data-plane evidence is collected or explicitly marked missing, workspace synchronization reaches a safe terminal disposition, the product turn is projected, and exact physical cleanup succeeds.
- Interrupt at expiry: when a lease approaches expiry without renewal (SHOULD: at the last safe-point opportunity before `expires-at`), the scheduler issues an `interrupt` command so the worker stops at a safe point inside the lease window. A worker that does not stop by expiry follows the stale path.
- Takeover: when a lease is taken over (stale or restart-fenced), the scheduler MUST invalidate the token binding, drain any queued commands for the dead session as undeliverable, and rely on the existing backend session and session-file collection for evidence.
- Supply refresh: same-snapshot renewal is not a supply refresh and does not consult `supply_refresh_ack`. A transition to a different AEP snapshot MAY occur only at a bounded-step boundary after NanoCore has issued an exact refresh request and accepted an `applied` acknowledgement bound to that request, the source and target snapshots, lease lineage, and declared runtime-adapter and shim support. A missing, `rejected`, or `unsupported` acknowledgement blocks the snapshot transition, not renewal under the existing snapshot; without safe refresh, the next bounded step requires a new plan and lease.

### Profiles

Configured single-Cell baseline profile (v1 default): one server-owned pool bound to one local or remote disposable OpenShell Cell target selected by runtime placement; FIFO dispatch within the three fixed priority classes; no per-workspace fairness; pool concurrency 1 and queue limit 20; concept-spec lease timing defaults; target health records and probe cadence active for the selected target. The pool and target ids are `pool_local` and `target_local` for local placement or `pool_remote` and `target_remote` for remote placement. All durable record contracts apply unchanged; the baseline is a configuration, not a schema variant.

Scaled profile: multiple pools and targets, per-workspace weighted round-robin fairness, scale-policy caps per server, workspace, user, and agent, full endpoint-specific health checks, and failover targets in placement plans. Enabling the scaled profile MUST NOT require migrating scheduler records.

Default aging thresholds, cap wait bounds, probe cadences, and baseline pool limits are configurable defaults; tuning them during implementation does not change this contract.

## Accepted Design

The scheduler runs as one NanoCore-internal service with three loops sharing the durable records: a dispatch loop (drains queue entries into plans and leases when capacity and health permit), a lease-watch loop (heartbeat deadlines, startup deadlines, expiry, release grace), and a probe loop (health cadence and quarantine transitions). All three are stateless between iterations relative to SQLite; each iteration reads durable state, decides, and commits transitions transactionally with epoch stamps.

Dispatch evaluates: eligible queue entries (effective class order, fairness order in scaled profile, thread serialization), compatible pools and targets (constraints, health, capacity headroom), then plan creation and lease acquisition in the transactional sequence defined above. Launch proceeds through the existing runtime adapter path; the adapter receives the lease id and epoch and reports launch acceptance, which the scheduler records on the lease (`starting`).

The worker-control gateway is extended to resolve token bindings through lease records instead of process-local registration, which simultaneously satisfies the worker-control spec's deferred durable-persistence requirement at the binding layer.

## Current Implementation Projection

The first durable scheduler slices are implemented for server-scoped admission queue records, placement plan records, acquired session lease records, worker pool records, capacity records, target health records, safe-refresh declarations, orphan-worker restart evidence, and a configured single-Cell dispatch/acquire helper. `apps/nanocore/drizzle/0021_scheduler_admission_entries.sql` creates `scheduler_admission_entries` in `server/db/core.sqlite`, with lineage ids, worker turn input, requested agent/profile fields, priority class, enqueue/effective-priority timestamps, first cap-deferred timestamp, required pool constraints, status, typed denial reason, indexes for queue/workspace reads, and a partial unique index preventing more than one non-terminal admission entry per turn. `apps/nanocore/drizzle/0026_scheduler_admission_user_owner.sql` adds the admission owner `user_id`, captured `workspace_cwd`, and captured `workspace_roots_json` needed for delayed background launch. `apps/nanocore/drizzle/0022_scheduler_placement_plans.sql` creates `scheduler_placement_plans` with queue linkage, full turn lineage, selected pool/target ids, planned lease and heartbeat timing, expected control/data-plane modes, degraded optional features, failover target, policy decision ids, capacity snapshot reference, status, created timestamp, and scheduler epoch. `apps/nanocore/drizzle/0023_scheduler_session_leases.sql` creates `scheduler_session_leases` with plan linkage, full turn and agent-session lineage, package snapshot id, pool/target ids, lease timing, heartbeat/startup deadlines, last heartbeat/sequence fields, renewal count, scheduler epoch, non-secret sandbox binding reference, durable backend anchor state, release reason, recovery state, recovery deadline, and worker process-key hash. `apps/nanocore/drizzle/0024_scheduler_operational_records.sql` creates `scheduler_worker_pools`, `scheduler_capacity_records`, and `scheduler_target_health_records`; capacity writes increment a monotonic per-target version. `apps/nanocore/drizzle/0027_scheduler_supply_refresh_declarations.sql` creates `scheduler_supply_refresh_declarations` with full turn lineage, agent-session id, package snapshot id, refresh id, sequence, status, product-safe message, and accepted timestamp, keyed by `(agent_session_id, package_snapshot_id, refresh_id)`. `apps/nanocore/drizzle/0031_scheduler_orphan_worker_evidence.sql` creates `scheduler_orphan_worker_evidence` with lease lineage, target ids, restart reason, scheduler epoch, heartbeat deadline, last heartbeat timestamp, and recorded time for downtime-expired live leases that cannot be re-adopted. `apps/nanocore/src/scheduler-records.ts` provides the first helper layer for creating queued entries with durable worker turn input, admission owner, captured worker workspace context, listing queued entries in baseline priority/FIFO order, listing workspace-filtered queued and denied admission entries for product read models, recording typed denials, creating a `planned` placement plan from a queued entry while marking that entry `admitted`, creating an `acquired` session lease from a planned placement plan while marking that plan `executing`, deriving the AEP package snapshot id from the selected turn and scheduler-reserved agent session when the caller does not provide one, accepting live lease heartbeats while advancing heartbeat deadlines, renewing live leases by extending `expires_at` and incrementing `renewal_count`, recording worker supply-refresh acknowledgements, exposing an applied-ack query helper reserved for future cross-snapshot protocol work, resolving worker-control sandbox binding references against live lease lineage, moving live leases to `releasing` with recovery state while preserving capacity accounting, marking expired or heartbeat-timeout live leases `stale`, failing proven-unanchored startup timeouts while routing anchored startup timeouts to stale recovery ownership without releasing capacity, completing leases to `released`, `lost`, or `failed` with required release reasons while marking the plan completed and releasing pool/capacity accounting in the same transaction, initializing the selected `pool_local`/`target_local` or `pool_remote`/`target_remote` baseline rows without resetting existing capacity, upserting worker pool, capacity, and target health records, and dispatching the next queued entry into an executing plan plus acquired lease when an active compatible pool has a placeable target with headroom. `packages/app-api-schemas/src/action-center.ts` now includes a strict `scheduler_admission` source shape, and `apps/nanocore/src/action-center.ts` projects queued admissions as `pending_input` rows and denied admissions as `blocked_turn` rows with typed denial reasons. `packages/app-api-schemas/src/dashboard.ts`, `apps/nanocore/src/app.ts`, `packages/core-client/src/app.ts`, and `mcp/src/registry.ts` now expose the workspace-filtered scheduler admission read model through `GET /api/app/workspaces/:workspaceId/scheduler/admissions`, `client.app.listSchedulerAdmissions`, the read-only MCP tool `openkit.read_scheduler_admissions`, and the resource `openkit://workspaces/{workspaceId}/scheduler/admissions`; this projection includes public lineage, priority class, required pool constraints, status, denial reason, and global queue position while excluding raw turn input, user id, captured cwd, and workspace root paths. `apps/nanocore/src/runtime/scheduler-dispatch-loop.ts` runs the first internal dispatch loop by repeatedly dispatching queued entries up to a bounded limit and starting each selected worker turn through the normal orchestrator with the queued turn id, stored turn input, scheduler-reserved agent session id, lease-owned sandbox binding ref, and captured worker workspace context; failed turn startup marks the acquired lease failed and releases capacity. `apps/nanocore/src/runtime/scheduler-dispatch-service.ts` wraps dispatch retry into a periodic service that reopens the admission owner's user-scoped store before starting the worker turn. `apps/nanocore/src/runtime/scheduler-lease-watch-loop.ts` runs the first internal lease-watch iteration by terminally failing proven-unanchored startup timeouts while routing anchored timeouts to stale recovery ownership without releasing capacity, then marking other expired live leases stale. `apps/nanocore/src/runtime/scheduler-lease-renewal-loop.ts` runs the same-AEP renewal iteration by scanning live leases near expiry, requiring unexpired lease and worker deadlines, allowing existing work to continue while its pool is active or draining and while a quarantined target still reports a live worker heartbeat, and extending `expires_at` through the durable renewal helper up to the configured total lease lifetime cap. Same-snapshot renewal does not require or consult a supply-refresh acknowledgement. `apps/nanocore/src/runtime/scheduler-lease-maintenance-service.ts` wraps lease-watch and same-AEP renewal into one periodic service. `apps/nanocore/src/runtime/scheduler-health-probe-loop.ts` probes due target health records, records probe check results and counters, moves required-check failures into degraded or quarantined health, restores successful quarantined targets through probation or healthy state, and schedules the next probe on live versus idle cadences. `apps/nanocore/src/runtime/scheduler-restart-recovery.ts` mints the next process scheduler epoch, fails or requeues pre-launch leases, resumes accepted final status through existing owners, arms eligible heartbeat-live leases as `awaiting-reconnect`, and moves unrecoverable or expired leases through the existing cleanup path without launching replacements. `apps/nanocore/src/index.ts` runs scheduler restart recovery before serving product traffic, then starts scheduler dispatch retry, lease maintenance, and health probe services for real NanoCore server processes and stops them during orderly shutdown before HTTP close. The server lease-maintenance service invokes same-snapshot renewal directly. Accepted supply-refresh acknowledgements are durable protocol evidence for a future cross-snapshot refresh flow and are not a production gate for ordinary lease renewal. `apps/nanocore/src/app.ts` threads the factory-selected local or remote Cell placement into both direct turn routes and internal Goal/Task worker starts, requires the matching `openshell.local` or `openshell.remote` pool constraint, and routes new `POST /api/turns` admissions through durable scheduler queue entries and the dispatch loop when a Core database is configured; instances without `coreDb` reject new product turn starts with `scheduler_unavailable`. `apps/nanocore/src/runtime/worker-control-gateway.ts` can register a scheduler-owned `sandboxBindingRef` as the worker token, enforce an injected durable token-binding resolver for registered worker-control sessions, record supply refresh acknowledgements, and notify the app when terminal canonical events are accepted; `apps/nanocore/src/app.ts` wires the default gateway to the scheduler resolver for `lease-binding:` tokens, exposes `POST /api/worker-control/final-status` and `POST /api/worker-control/supply-refresh-ack` as explicit control-envelope routes, persists accepted supply-refresh acknowledgements into `scheduler_supply_refresh_declarations` when a Core database is available, maps accepted final status into the existing terminal canonical event path, and moves the matching live lease to `releasing` when `turn.completed` or `turn.failed` is accepted; `apps/nanocore/src/runtime/orchestrator.ts` and `apps/nanocore/src/runtime/worker-governance-turn-executor.ts` forward optional turn-start scheduler lineage into backend materialization; and `apps/nanocore/src/runtime/worker-governance-backend.ts` can pass those scheduler binding refs into OpenShell worker-control registration.

`apps/nanocore/drizzle/0042_scheduler_session_compatibility_key.sql` now adds nullable `session_compatibility_key` evidence to `scheduler_session_leases`. `apps/nanocore/src/scheduler-records.ts` records that digest on both explicit plan/acquire flows and the single-target dispatch helper, maps it through `SchedulerSessionLeaseRecord`, exposes `requireSchedulerSessionLease()` for scheduler diagnostics and tests, and can complete the non-terminal lease that owns a terminal app-local turn. The single-target dispatch helper also enforces first-slice thread serialization by skipping queued entries whose workspace/thread already has a non-terminal scheduler lease and dispatching the next eligible queued entry instead. The App API uses the turn-level completion helper after app-local approval and user-input responses reach a terminal turn state, releasing scheduler capacity for non worker-control runtimes without relaxing the worker-control final-status path. This is durable selector evidence plus first-slice thread gating and app-local terminal closeout only; it does not yet implement live session reuse or an explicit parallel-safe workflow override.

Safe-refresh acknowledgements are deliberately narrow and have no effect on same-snapshot renewal. The current implementation persists `applied`, `rejected`, and `unsupported` acknowledgements, but no NanoCore-issued cross-snapshot refresh request or target-snapshot binding is implemented, so these rows do not yet authorize a snapshot transition. Scheduler admission rows now expose real Action Center actions for human retry of denied admissions and cancellation of queued or denied admissions through App API, `@openkit/core-client`, and `@openkit/mcp`; accepted App API retry and cancel operations also write workspace-owned `AuditEvent` rows with scheduler admission, thread, turn, and request lineage. Scheduler admission list and Action Center projections are scoped by both the request store owner user id and workspace id. Public retry and cancel require the same owner scope, treat foreign and absent queue-entry ids as the same not-found result, and reject ownership mismatches before status checks, scheduler mutation, workspace audit-database access, or audit writes. Recovery evidence also has Action Center projection through `worker_control_rejection` and `scheduler_orphan_worker` source rows. The default configured baseline probe recognizes the exact local and remote target ids and persists target-registration evidence; endpoint-specific health checks remain an implementation gap, and no OpenShell `doctor` command is part of this design. Relevant current code remains `apps/nanocore/src/runtime/turn-executor-factory.ts` for executor selection, `apps/nanocore/src/runtime/worker-control-gateway.ts` for process-local session state plus durable binding hooks, `apps/nanocore/src/storage/schema/pending-user-turns.ts` for busy-thread steering queues, and `apps/nanocore/src/runtime/worker-turn-loop.ts` for bounded-step execution.

The current lease record has no durable release timestamp or deadline. Restart recovery directly closes a `releasing` lease only when durable accepted final status exists; the lease-watch loop does not expire a stuck release without that terminal barrier. The accepted release-grace design therefore remains unimplemented and can retain capacity after an interrupted closeout; the roadmap treats its future deadline as a separate prerequisite rather than adding retry stages to this slice.

The V1 durable configured single-Cell scheduler is implemented for local-or-remote admission and target selection, placement, live lease timing, same-snapshot renewal, terminal closeout, and initial restart recovery. The active restart slice replaces blind live-lease adoption with one bounded `awaiting-reconnect` lease state, exact process-key/lineage/sequence adoption, a timeout CAS fence, and direct closeout through existing records; it adds no settlement record. Durable release-grace recovery, the scaled profile, weighted per-workspace fairness, full per-scope cap enforcement, concrete endpoint-level health probes, richer scheduler recovery actions beyond admission retry/cancel, and budget-class accounting integration remain deferred future work.

## Alternatives Considered

- File-backed scheduler records. Rejected: leases, queues, and capacity accounting need transactions and atomic compare-and-set semantics; the storage spec already assigns scheduler leases and capacity records to SQLite source-of-truth.
- Heartbeats extend lease expiry. Rejected: it makes lease duration unbounded under a live-but-stuck worker and removes the bounded-step boundary as a scheduling control point. Renewal is an explicit scheduler decision instead.
- Dynamic numeric priorities instead of fixed classes. Rejected for v1: a closed three-class set with aging is testable and sufficient; numeric priorities invite policy sprawl before scale policy exists.
- Killing live leases on target quarantine. Rejected: worker heartbeats are stronger evidence of session health than probes; quarantine gates new placement only.
- Separate scheduler for the single-Cell baseline. Rejected: two schedulers guarantee divergence; the baseline is a profile of one design.
- Preserving the process-local worker-control registration alongside durable leases. Rejected under the internal development compatibility rule: token binding moves to lease records in the same change, with no fallback path.

## Consequences

- Every worker launch gains one or two durable writes on the critical path; on localhost SQLite this is negligible relative to container launch cost.
- NanoCore restart stops losing knowledge of running workers; recovery becomes a scan-and-adopt procedure instead of best-effort checkpoint archaeology.
- The worker-control gateway acquires a durable dependency, which also discharges part of that spec's deferred durability work.
- Product surfaces gain typed, auditable denial reasons for capacity problems instead of implicit stalls.
- The scaled profile becomes a configuration change, at the cost of carrying fairness and cap logic that the baseline does not exercise; tests must cover both profiles.

## Rollout / Migration Plan

This is new machinery, not a compatibility migration. Rollout order: (1) durable record layer and lease state machine with the configured single-Cell baseline replacing static admission in the same change (no dual path); (2) restart recovery and takeover; (3) health probing and quarantine for the selected local or remote target; (4) admission-control denials and Action Center projection; (5) scaled-profile fairness and caps behind configuration. Existing in-flight turns at upgrade time are handled by the restart-recovery path itself: absent leases mean their workers are treated as untracked and evidence-collected, which is acceptable in internal development.

## Testing Strategy / Acceptance Criteria

Mapped to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: schema-drift checks for scheduler record shapes exported from the schema packages; repository checks that this spec's record vocabulary matches exported schema names.
- L1: unit tests for the lease state machine (every legal and illegal transition, timing math from durable timestamps), reconnect-versus-timeout claim races, same-snapshot renewal without refresh declarations, continuation under draining pools and quarantined targets with fresh heartbeats, queue ordering (class order, FIFO within class, aging promotion, no intra-class reorder), fairness round-robin selection, quarantine counters and backoff, and epoch fencing predicates.
- L2: contract tests binding scheduler behavior to the worker control protocol: token mint only from `acquired` leases, heartbeat rejection for stale/terminal leases, `final_status` driving `releasing`, token-binding invalidation on takeover.
- L3: NanoCore black-box tests retain the existing scheduler coverage and add one deterministic kill/restart scenario that proves the same lease and worker reconnect at the exact next sequence, no duplicate launch occurs, and accepted final status closes through existing records.
- L4: not applicable until Web UI scheduler projections exist; then queue-position and denial-reason display tests.
- L5: smoke tests that a packaged build admits and completes one turn through the configured local baseline and one turn through a configured remote Cell, with scheduler tables created and populated for the selected placement.
- L6: story acceptance covering a user submitting work while capacity is saturated, seeing queued-then-completed behavior, a NanoCore restart mid-turn that recovers without losing the turn's evidence trail, and a real worker that remains authorized after running beyond its initial lease expiry through at least one same-snapshot renewal.

Acceptance criteria: all L1-L3 behaviors above pass deterministically; a crash at any single point in the admission-to-launch sequence is recoverable with no orphan execution and no double launch; either configured single-Cell placement runs with zero scaled-profile configuration; no scheduler record exposes secret material or backend-native ids to product surfaces.

## Risks & Mitigations

- Risk: durable writes on the dispatch path become a throughput bottleneck in the scaled profile. Mitigation: batch dispatch iterations per transaction; capacity records are versioned summaries, not per-event ledgers.
- Risk: epoch or adoption fencing bugs cause split-brain between an old in-flight action and the recovered scheduler. Mitigation: L1 tests exercise each CAS predicate and one deterministic L3 proves the complete kill/restart boundary.
- Risk: aging-based starvation avoidance interacts badly with fairness weights. Mitigation: aging changes effective class only, never intra-class order; both mechanisms are tested together at L1.
- Risk: quarantine flaps on a marginal target. Mitigation: consecutive-failure thresholds, exponential probation backoff, and single-placement probation.
- Risk: the scheduler drifts into a second workflow engine. Mitigation: it schedules queue entries, plans, and leases only; turn outcome and closeout remain workflow-owned, restated as a contract rule here.

## Resolved Decisions

Previously blocking questions are resolved in the contract above: scale-policy caps defer at dispatch up to class wait bounds before a typed `policy-cap` denial (with per-scope policy override down to immediate denial), and admission queue entries are confirmed as server-scope coordination records read by product surfaces only through workspace-filtered derived read models. Aging promotion caps at `automation` effective ordering, and probation holds at most one concurrent placement.

## Deferred / Future Work

- Scaled-profile fairness, full per-scope cap enforcement, and multi-target placement beyond the configured single-Cell baseline.
- Warm pools and warm-session targets: the pool record reserves the field, but no warm-session lifecycle, prewarm scheduling, or warm-reuse placement ships until leases and capacity health are proven durable, per the concept spec's resolved decision.
- Multi-node scheduling: multiple NanoCore instances sharing scheduler state, distributed epochs, and cross-node takeover are out of scope; the single-writer epoch design is chosen so a future multi-node design can replace the epoch source without changing record contracts.
- Backend push delivery of lease-boundary commands, following the worker control protocol's own deferred push work.
- Web UI scheduler read models (queue position, pool saturation, target health dashboards) beyond the derived readiness summaries named here.
- Budget-class accounting integration once metering enforcement exists.

## Links

- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/core/runtime-model.md`
- `docs/deployment.md`
- `docs/core/agent-session.md`
