---
status: Accepted
date: "2026-10-06"
decider: Engineer, after two independent Consultant reports
supersedes: docs/decisions/20261003-worker_start_returns_on_admission.md
---
# Execution Backend Port In NanoCore

## Decision

The engineer selected route B: one execution backend port inside NanoCore with submit, inspect, cancel, and release. Each adapter is a NanoCore-process module. The NanoHost adapter owns Sandbox, Harness, and binding residency in its own tables; NanoHost Rust keeps its existing epoch and process responsibilities. Core keeps a bounded, checked FIFO admission queue and one private execution attempt replacing SessionLease as the grant, with open, closing, and closed phases and the outstanding operation's exact identity and not_accepted, accepted, or unknown disposition. Unknown and closing hold exclusion. Definite non-acceptance or proved fencing with required handoff closes it. Lost responses are inspected, never resubmitted. The attempt retains the Core-held worker process-key hash and refuses routes until exact process adoption. Outcomes and fences are not duplicated on admissions, and Core keeps no second capacity grant. Worker pools, placement plans, capacity records, target health/probation, renewal scheduling and its cap machinery, orphan-capacity accounting, unused supply-refresh scheduling gates, and fabricated local/remote target identity leave the design. One configured backend id is used throughout. [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md), [Runtime Scheduling And Scale](../specs/20260703-runtime_scheduling_scale.md), and [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md) own these rules.

This record supersedes only the named clauses of [Worker Start Returns On Admission](20261003-worker_start_returns_on_admission.md): lease/placement-before-202 as projected by its owners, pending-as-running, and the claim that no durable state is added. Prompt 202, the ordinary Turn-pointer receipt, exact current-owner replay, independent execution/closeout, and no new polling endpoint or response snapshot survive. A Task on an independent Thread is acknowledged through its pending Turn, idempotent admission, and ordinary receipt before dispatch; it reads queued and may have no AgentSession until dispatch. One nonterminal Turn per Thread remains. Later preparation failure belongs on that same Turn.

This record also supersedes capacity-deferral cancellation in [Synchronous Caller Own Failure Cancels Its Admission](20261002-synchronous_caller_own_failure_cancels_admission.md). Capacity deferral becomes accepted queued work. The rule that a caller told of a real failure receives the original error and has its still-queued admission cancelled survives, including transient preparation failure; foreign failures remain isolated. The two predecessor records retain their bodies and reasons. The singular supersedes field names October 3; both predecessors point here, and these paragraphs define the precise partial supersessions, as the engineer confirmed for this record.

The engineer's follow-up assigns liveness to the execution backend adapter. Core fixes one absolute attempt deadline at submit, with the existing 7200-second total cap as the current default, and explicit revocation. Every mediated route checks the attempt, credentials, current policy, revocation, and deadline. Stepped renewal, lead time, and renewal counter are removed. The NanoHost adapter keeps the existing heartbeat deadline (current default 30 seconds), pre-first-heartbeat startup deadline, stale refusal with needs-evidence exclusion, duplicate replay without liveness renewal, bounded reconnect, and exact process-key adoption. This amendment does not relax the heartbeat gate or fix #108. [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md#nanohost-adapter-liveness) owns that adapter rule. Demand-driven idle-binding eviction is deferred, and the current no-inactivity-timer criterion survives. The single deferred list is in [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md#deferred--future-work).

The [earlier fresh-root ruling](20260930-earlier_version_data_not_carried.md) applies to this pre-release execution-backend cutover. Use a fresh data root, leave prior data offline, and positively fence old effect-capable execution before the new deployment executes. There is no migration, legacy reader, old-session adoption, or deletion authorization. This limited application creates no permanent exemption from [retained-data continuity](../core/contract-evolution.md).

## Reason

The engineer wants NanoCore to obtain resources from different backend shapes while remaining a unified control plane. The user needs prompt honest acknowledgement, visible waiting work, and durable results; physical resource shape should not define the product model. The two Consultant reports agreed on durable intent before effect, exact exclusion, honest unknown without replacement, current authority, and Core-owned product truth, while disagreeing about how much to move before release.

The engineer's first ruling, translated from Chinese, was: “I approve amending the two old rulings. For decision one I choose B. Besides your workload and risk reasons, I add that future backends cannot have their backend code modified as NanoHost can. Those adaptation layers should remain in NanoCore, treating NanoHost the same or similarly.” Source: temp/comm-redesign/engineer-queue.md, Execution backend and scheduling redesign, 2026-10-06. This is provenance, not a behavioral owner. The reason supports a uniform adaptation boundary without moving orchestration into Rust or adding another cross-process admission effect.

The follow-up ruling, translated from Chinese, was: “I agree with your recommendations on #108 and idle reclamation.” The accepted recommendation preserves the heartbeat rule inside the NanoHost adapter and separates it from the absolute grant. Probe evidence did not identify #108's initiating stall or establish inevitable permanent exhaustion from ordinary sequential Tasks. The probe is static source evidence, not a qualification run or a cure. No new diagnostics contract is decided here.

## Rejected Alternatives

- Route A's Rust orchestration move, six-phase attempt, separate admit/start plus describe, and immediate idle eviction: larger pre-release ownership and lost-response scope without a present requirement for this first adapter.
- Wrapping the current pool/plan/lease/capacity graph: preserves duplicate physical scheduling authority instead of removing it.
- Reporting capacity deferral as a failed request while leaving it dispatchable: contradicts the caller's result. Cancelling ordinary deferral instead loses useful accepted waiting work.
- Relaxing heartbeat authority or counting unrelated/duplicate traffic as liveness: the follow-up retains the current gate and provides no evidence-backed #108 cure.
- Inferring success, non-execution, or cleanup from a timeout, missing response, or ready report: permits duplicate effects or unsafe reuse.
- Migrating old execution graphs or retaining a compatibility reader for this pre-release cutover: the fresh-root ruling removes that need while requiring old execution fencing.

## Revisit When

An actual additional backend demonstrates an insufficient submit/inspect/cancel/release boundary; exact queued/lost-response/restart proofs still require generic physical capacity records or a second target identity; proved containment or cleanup cannot be represented truthfully; or measured idle-binding pressure establishes a need for reclamation. A released retained-data shape requires the ordinary accepted migration/retirement decision. None of these observations grants a new feature or weakens a fence by itself.

## Affected Owners

- [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md)
- [Runtime Scheduling And Scale](../specs/20260703-runtime_scheduling_scale.md)
- [Core Protocol](../core/protocol.md) and [Runtime Model](../core/runtime-model.md)
- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md) and [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md)
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md) and [Worker Control Protocol](../specs/20260703-worker_control_protocol.md)
- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md)
- [AgentSession](../core/agent-session.md), [AgentSession Continuity](../specs/20260704-agent_session_continuity.md), and [Sandbox](../core/sandbox.md)
- [NanoCore Bootstrap Readiness](../specs/20260704-nanocore_bootstrap_readiness.md), [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md), and [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Human Attention And Intervention](../specs/20260531-human_attention_intervention_model.md), [Workspace Synchronization](../specs/20260703-workspace_synchronization.md), and [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md)
- [Multi-user Workspace System](../specs/20260715-multi_user_workspace_system.md) and [NanoHost Workspace Data Boundary](../specs/20260801-nanohost_workspace_data_boundary.md)
