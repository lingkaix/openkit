---
status: Accepted
date: "2026-10-20"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence
supersedes: docs/decisions/20261020-control_store_writer_placement.md
---
# Control Store Mixed-Writer Exception

## Decision

[Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md) defines the explicit v0.1.0 mixed-family exception. One worker owns activated native admission/product tuples; current owners retain other families, even in the same WAL database. Preserve one writer per family, one local tuple/receipt transaction, outer FULL acknowledgement, synchronous committed reads, fixed32/5 grouping, the640/s reference configuration, p99<=25ms and32MiB WAL cap. Main writable handles, shared rows, bounded busy handling and activation qualifications follow DX. The exception is not a file fallback, dual writer for one family or authorization to activate public callers during preparation. AgentSession SQL preserves native-owner reference meaning independently of executor placement; no additional field is selected.

The measured Artifact dependency switch assigns Artifact Review, Workspace Material, Material revision and Thread Material binding mutations to the existing database worker as one coherent writer switch. Artifact submission and accepted Material proposal decisions retain their complete local SQL tuple and original receipt transaction. The independently invoked Material commands and verified binding-queue consumption move because they mutate those same row families. Artifact file/capacity owners, separate refinement/redo admission proofs, stopped import phase exclusion and all other family owners remain unchanged. The exact switch boundary is the Write And Space Budget table in DX; no second writer or new settlement mechanism is introduced.

## Reason

The coordinator decided this exception on 2026-10-20 under the engineer's standing delegation, as a reversible choice logged for engineer review, to avoid a speculative all-family conversion before v0.1.0. The earlier measurements establish grouped-worker behavior, not native mixed-family qualification. Main COMMIT can still stall; a busy timeout limits lock wait only. The accepted exception therefore needs native tuple coverage, explicit shared-row ownership and a later mixed-load gate, rather than a claim that unmoved families are cheap. The existing AgentSession representation must not become a false placement-independent meaning when moved to SQL.

## Rejected Alternatives

global main read-only handles while current synchronous writers remain; two writers for one product/receipt family; splitting product and receipt into separate commits; another ledger/ownership column; native seconds-long main busy waiting or automatic retry; compulsory cold-family migration without measured need. Preserve the earlier record as the source of its unchanged all-read-worker and per-Workspace-worker rejections, measurement limits and rationale.

## Revisit When

actual native tuples or mixed-load results fail the existing bounds; a newly measured hot dependency requires a larger atomic tuple; a caller requires unacknowledged state; or an actual native-owner integration needs a new reference representation. Failure does not authorize weaker durability, invented proof or silent scope expansion. Affected owners: DX and Runtime Scheduling Scale, as in the prior record.

## Affected Owners

- [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md).
- [Runtime Scheduling Scale](../specs/20260703-runtime_scheduling_scale.md).
