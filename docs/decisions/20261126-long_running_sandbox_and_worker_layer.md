---
status: Accepted
date: "2026-11-26"
decider: Engineer
---
# Long-Running Sandbox And Worker Layer

Target: v0.2.0

## Decision

The engineer approved the product model, the control model and the release scope below. v0.2.0 may slip for them: a foundation mechanism lands once, in its final form. Rulings L1 to L5 and L13 give the engineer's statements of 2026-11-26 in the form that the design review settled. Rulings L6 to L12 are the engineer's rulings on the final items of that review.

| Ruling | Accepted scope |
| --- | --- |
| L1 | The base environment is a long-running Sandbox in which several Workers of different Harnesses work together. It is a physical isolation boundary. When it is idle it sleeps and its Volume is retained. It wakes on demand. The first driver is to develop OpenKit inside OpenKit. |
| L2 | A wake is a cold wake from the Volume. Bytes on disk are complete, including dirty and untracked working files, and Workers continue on them. Processes, memory and live authority are not restored. A wake authorizes again before work is admitted. A provider snapshot is an optimization and never continuity truth. |
| L3 | NanoCore keeps all authority and expresses it as desired state. Two delegated roles converge on that state and report what they observe. An environment provider outside the Sandbox creates, deletes, sleeps and wakes it, and owns its edge and its Volume. A Worker Shim inside the Sandbox starts and stops Worker processes and drives the Harness adapters. The shim connects outbound. Its reports are evidence. Safety comes from fences outside the Sandbox, and the deletion of the Sandbox incarnation is the outside fallback. |
| L4 | Scheduling accepts the trade-offs of a distributed system instead of a perfect scheduler. Unknown is not failure. Exclusion stays until proof. One reconciler owns the read-back of the original key, with a bound and an exit. |
| L5 | v0.2.0 is limited in features and final in foundation. It ships one Host slot and one Worker for each Sandbox, with the final identities, contracts and retained formats. Later releases are additive: Workers that share a Sandbox, then more slots, then quota and share controls, then multi-user use. None of them changes a contract or a retained format. |
| L6 | The Worker layer lands in its final form in v0.2.0: the final identity and contract. In v0.2.0 a Worker is replaced by the recycle of its Sandbox. |
| L7 | Identity uses the UUID family, with these prefixes: `host_`, `hepoch_`, `sbx_`, `sbxi_`, `wkr_`. The physical name of a Sandbox incarnation under NanoHost is `nh-` and the 32 hexadecimal digits of the incarnation UUID. The physical name is confirmed after the provider spike proves the round trip. |
| L8 | When the stop of a Worker in a shared Sandbox is not proved, the Sandbox enters a degraded mode that is accepted explicitly and is visible. It admits no new attempt and no new Worker. Sibling attempts that were already admitted may finish inside their own attempt deadline, which is at most 7,200 s and is never extended. Then Core recycles the Sandbox. The Sandbox owner or an administrator may order the recycle at once. Physical release needs its own proof, and an unknown claim stays charged. |
| L9 | The evidence for steer and interrupt is retained. Core keeps the original steer obligation and the interrupt settlement. Non-commit is proved only from authoritative history. The regular exchange between Core and the Worker Shim carries this evidence; there is no separate lookup call. |
| L10 | There is no wire-compatibility promise between Core, the provider and the Worker Shim across 0.2.x releases. A peer with a different version is refused before any effect. Core recycles a mismatched Sandbox once onto the current image. If the mismatch stays, retries stop and a maintenance hold is shown. |
| L11 | A Worker that uses a native Login is a later feature. It enters a shared Sandbox only by an explicit share from the Login owner. The share states that this route has no cap and no meter. On any doubt about its stop, Core recycles the Sandbox at once. |
| L12 | The first cold-wake tolerances are 60 s from the wake order to the first useful Turn with a warm image, and 120 s for readiness. The baseline is agreed again from measured numbers after implementation. |
| L13 | Sharing is open by default. Policy gates and audit stay reasonable. A user who owns an account shares its capability under the user's own control, for example a part of the quota and whether credit may be used. |

### Retained Decisions By Design Consensus

The design review (PRODUCT-ARCH, three rounds with an adversarial reviewer) settled the items below under the engineer's standing delegation. The engineer did not rule on each one.

- The trade-off of L4 is drawn by plane. Decisions, exclusion, effects and receipts choose consistency: a doubt holds. Work in progress, observations and the capacity view choose availability: work continues and a stale view is replaced.
- A Worker ID is issued once for each authorized start order, before the order is sent. The Worker Shim realizes it at most once. A stopped Worker never starts again under its ID.
- Lifecycle operations are keyed by the incarnation ID. A one-shot operation is keyed by the existing Core operation ID, with its target Worker ID and payload digest. No new key kind exists.
- Storage association, attachment generation, work slot and contributor are relations of these IDs, not new ID kinds. The work slot stays stable for a Thread.
- There are three contracts. The execution backend port keeps submit, inspect, cancel and release. The environment provider has keep present, keep absent and report inventory. The Worker Shim has one exchange: inventory, key outcomes and exit evidence go up; desired Workers, desired Turn state, keyed input and keyed steer come down.
- A provider declares its absence proof: exact inside an epoch, or by epoch renewal only. An adapter declares its Worker stop value: exact with a proof kind, or best effort. Both stay beside the existing declarations for intake, read-back and safe steer.
- Every record of a decision, an exclusion claim, an effect or a receipt is retained, and so is each reference that recovery follows after a lifetime ended. A retained record changes only by an additive forward migration. A view can be dropped at any time and causes only a new report. An observation that a decision cites as its proof is retained with that decision.
- Governed abandonment stays an administrator action. A user can place a new Thread on other resources without it.

### Conditions Before A Freeze

- The provider spike passes before the identity formats are frozen. It proves the physical name round trip and the absence proof of the provider, including a delete while an accepted create is in flight.
- The kernel probe passes before the kernel baseline is frozen. It uses the real development probe with a lost acknowledgement, and it runs two reservations at a cap across a reopen.
- The Worker stop spike and the cold-wake spike decide scope only: whether a Worker can be replaced in place, and whether replace-by-recycle is acceptable for dogfood. The contracts do not wait for them.

### Decision Refinements

- L1 and L8 refine the shared-Sandbox failure boundary in [User-Selected Workspace-Shared Sandboxes](20261008-user_selected_workspace_shared_sandboxes.md). The shared Sandbox is now the base placement, and a failed stop has a declared exit for the whole Sandbox.
- L3 refines the adapter boundary in [Execution Backend Port In NanoCore](20261006-execution_backend_port_in_nanocore.md) and [Compute And Harness Neutrality](20261020-compute_and_harness_neutrality.md): the backend port is unchanged, and the provider and the Worker Shim are separate contracts behind it.
- L9 keeps rulings E4 and E5 of [Control Kernel And Service Storage](20261120-control_kernel_and_service_storage.md#decision) unchanged on the smaller interface.
- L2 refines [Storage](../core/storage.md): the retained Volume is the only continuity across a wake.

## Reason

The engineer wants OpenKit to be developed and maintained on OpenKit as soon as possible, and wants a complete, isolated environment in which several agents run for a long time. Translated from the engineer: "We keep the data on disk complete, and Workers can continue working on top of it. We do not restore memory contents or processes."

The foundation must be stable before trial use starts. Translated: "The condition is that the foundation, the core architecture and the data itself are stable. That stability must let us improve quickly and ship small releases fast afterwards."

Worker Harnesses are unstable processes, so scheduling is close to resource scheduling in a distributed system. Translated: "We may need to do as well as possible inside an impossibility triangle, not pursue a perfect scheduler."

A work slot inside a Sandbox is not a containment: all Workers run as one user in one filesystem. So an unproved stop cannot be contained below the Sandbox, and the smallest unit that proves absence is the Sandbox incarnation. A bounded drain keeps healthy siblings productive at a known price.

## Rejected Alternatives

- One Worker for each Sandbox as the base model. It stays as the restricted placement, not as the base.
- Exact stop of one Worker as a condition for sharing a Sandbox. The condition is a declared failure domain with a bounded exit.
- Quarantine of a work slot after an unproved stop, with the Thread continuing in a fresh slot. A slot is not a containment and is stable for a Thread.
- Always recycle at once on an unproved stop in a shared Sandbox. It interrupts healthy siblings when a bounded drain is enough.
- Restore of processes or memory on wake. Only the Volume is continuity.
- A retained-format exemption for records scoped to one execution-substrate epoch. Recovery reads such records after the epoch changed.
- A wire-compatibility promise across 0.2.x. A recycle onto the current image is cheaper than a protocol promise.
- A separate lookup call for a keyed operation. No adapter can answer it, and the regular exchange carries the evidence.
- Release of a physical claim by time, by a missed heartbeat, or by an acknowledgement alone.

## Revisit When

- The Worker stop spike or the cold-wake spike fails so that a VM-class provider must move to the near path.
- The kernel probe finds a deciding fact that the attempt, the step or the scoped hold cannot represent.
- The provider spike shows that the physical name cannot carry the incarnation UUID.
- Measured cold-wake numbers differ from the first tolerances.
- The native Login Worker is enabled.

## Affected Owners

- [Fault Tolerance](../core/fault-tolerance.md#planes) owns the planes, the release, replacement, unknown, suspicion and occupancy rules, and the exit of every hold.
- [Sandbox](../core/sandbox.md#long-running-sandbox) owns the long-running Sandbox, its incarnation, draining, sleep and wake, and the restricted placement.
- [Runtime Model](../core/runtime-model.md#execution-substrate-lifecycle) and [Architecture](../core/architecture.md#core) own the components, the trust positions and the three contracts as a model.
- [AgentSession](../core/agent-session.md#lifecycle) owns the relation between an AgentSession and a Worker incarnation.
- [Contract Evolution](../core/contract-evolution.md#retained-data-continuity) owns the retained-or-view rule and the version refusal.
- [Storage](../core/storage.md) owns the retained Volume and its single writer.
